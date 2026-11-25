import { distinctReferences, isUnknown, maxDefined, minDefined, parseWindow, toMinutes } from './normalize.js'

// 平台事件词表。任何未登记的事件名都视为来源系统的未知事件，
// 由调用方决定是否要提示，而不是静默忽略。
export const EVENTS = Object.freeze({
  PARENT_START: '家长开始',
  SIGNED: '签署成功',
  ARRIVE: '到场',
  ACCEPT: '受理',
  COMPLETE: '已办结',
  BOOK: '预约',
  REBOOK_REQUEST: '改约申请',
  REBOOK_ACCEPT: '改约接受',
  NO_PREREVIEW: '无需预审',
  PENDING: '待办',
  INTERRUPTED: '观测中断',
})

export const PROOF_STATUS = Object.freeze({
  VALID: '有效',
  REVOKED: '撤销',
  BROKEN: '断报',
})

export const RECEIPT_KIND = Object.freeze({
  PENDING: '待接受',
  ACCEPTED: '已接受',
  FAILED: '申请失败',
})

export const MODES = Object.freeze({ REMOTE: '远程', WINDOW: '窗口' })
export const PLATFORM_SITE = '平台'

// 把一期资料整理成可查询的索引。索引只做归并，不改变原始值。
export class Model {
  constructor(store) {
    this.store = store
    this.households = store.get('households')
    this.proofs = store.get('proofs')
    this.service = store.get('service')
    this.capacity = store.get('capacity')
    this.publication = store.get('publication')
    this.commitments = store.get('commitment')
    this.observations = store.get('period_observations')
    this.receipts = store.get('queue_receipts')

    this.householdByApp = new Map()
    this.studentsByFamily = new Map()
    for (const row of this.households) {
      this.householdByApp.set(row.app, row)
      const list = this.studentsByFamily.get(row.family) ?? []
      list.push(row)
      this.studentsByFamily.set(row.family, list)
    }

    this.proofEvents = new Map()
    for (const row of this.proofs) {
      const list = this.proofEvents.get(row.proof) ?? []
      list.push(row)
      this.proofEvents.set(row.proof, list)
    }
    for (const list of this.proofEvents.values()) {
      list.sort((a, b) => (toMinutes(a.at) ?? Infinity) - (toMinutes(b.at) ?? Infinity))
    }

    this.serviceByApp = new Map()
    for (const row of this.service) {
      const list = this.serviceByApp.get(row.app) ?? []
      list.push(row)
      this.serviceByApp.set(row.app, list)
    }
    for (const list of this.serviceByApp.values()) {
      list.sort((a, b) => (toMinutes(a.at) ?? Infinity) - (toMinutes(b.at) ?? Infinity))
    }

    this.receiptsByApp = new Map()
    for (const row of this.receipts) {
      const list = this.receiptsByApp.get(row.app) ?? []
      list.push(row)
      this.receiptsByApp.set(row.app, list)
    }
    for (const list of this.receiptsByApp.values()) {
      list.sort((a, b) => (toMinutes(a.at) ?? Infinity) - (toMinutes(b.at) ?? Infinity))
    }

    this.observationsByApp = new Map()
    this.observationsByPeriod = new Map()
    for (const row of this.observations) {
      const byApp = this.observationsByApp.get(row.app) ?? []
      byApp.push(row)
      this.observationsByApp.set(row.app, byApp)
      const byPeriod = this.observationsByPeriod.get(row.period) ?? []
      byPeriod.push(row)
      this.observationsByPeriod.set(row.period, byPeriod)
    }

    this.commitmentByApp = new Map()
    for (const row of this.commitments) this.commitmentByApp.set(row.app, row)

    this.publicationByReport = new Map()
    for (const row of this.publication) this.publicationByReport.set(row.report, row)
  }

  householdOf(app) {
    return this.householdByApp.get(app) ?? null
  }

  familyOf(app) {
    return this.householdOf(app)?.family ?? null
  }

  studentsOf(family) {
    return this.studentsByFamily.get(family) ?? []
  }

  appsOf(family) {
    return this.studentsOf(family).map(row => row.app)
  }

  proofIdsOf(app) {
    const household = this.householdOf(app)
    return household ? distinctReferences(household.proof) : []
  }

  // 某个申请关联的全部签署事件，按时间排序。
  proofTimeline(app) {
    const events = []
    for (const proofId of this.proofIdsOf(app)) {
      for (const row of this.proofEvents.get(proofId) ?? []) events.push(row)
    }
    return events.sort((a, b) => (toMinutes(a.at) ?? Infinity) - (toMinutes(b.at) ?? Infinity))
  }

  // 共用同一份证明的其他申请（含跨家庭的异常情况）。
  appsSharingProof(app) {
    const proofIds = new Set(this.proofIdsOf(app))
    if (proofIds.size === 0) return []
    return this.households
      .filter(row => row.app !== app && this.proofIdsOf(row.app).some(id => proofIds.has(id)))
      .map(row => row.app)
  }

  proofRows(proofId) {
    return this.proofEvents.get(proofId) ?? []
  }

  eventsOf(app) {
    return this.serviceByApp.get(app) ?? []
  }

  eventTimes(app, eventName) {
    return this.eventsOf(app)
      .filter(row => row.event === eventName)
      .map(row => toMinutes(row.at))
      .filter(value => value !== null)
  }

  receiptsOf(app) {
    return this.receiptsByApp.get(app) ?? []
  }

  observationOf(app, period = null) {
    const rows = this.observationsByApp.get(app) ?? []
    if (period) return rows.find(row => row.period === period) ?? null
    return rows[0] ?? null
  }

  observationsFor(period) {
    return this.observationsByPeriod.get(period) ?? []
  }

  periods() {
    return [...this.observationsByPeriod.keys()].sort()
  }

  // 某一期所有观测的观察止点最大值，作为默认的截至时间。
  periodCutoff(period) {
    return maxDefined(this.observationsFor(period).map(row => toMinutes(row.observed_until)))
  }

  // 某个申请的最早可办分钟：优先用归档的 ready，其次用有效凭证时间。
  firstActionable(app, asOf = null) {
    const observation = this.observationOf(app)
    const archived = observation ? toMinutes(observation.ready) : null
    if (archived !== null && (asOf === null || archived <= asOf)) return archived
    const credentialAt = this.credentialState(app, asOf).firstValidAt
    return credentialAt
  }

  // 凭证状态：首次有效、最后撤销、断报。只看到 asOf 为止的事件。
  credentialState(app, asOf = null) {
    const events = this.proofTimeline(app).filter(row => {
      const at = toMinutes(row.at)
      return at !== null && (asOf === null || at <= asOf)
    })
    let firstValidAt = null
    let revokedAt = null
    let brokenAt = null
    for (const row of events) {
      const at = toMinutes(row.at)
      if (row.status === PROOF_STATUS.VALID && firstValidAt === null) firstValidAt = at
      if (row.status === PROOF_STATUS.REVOKED) revokedAt = at
      if (row.status === PROOF_STATUS.BROKEN && brokenAt === null) brokenAt = at
    }
    const last = events.at(-1) ?? null
    return {
      proofIds: this.proofIdsOf(app),
      events,
      firstValidAt,
      revokedAt,
      brokenAt,
      lastStatus: last?.status ?? null,
      lastAt: last ? toMinutes(last.at) : null,
      // 截至 asOf 仍有有效凭证：至少出现过有效，且最后一次事件不是撤销/断报。
      valid: firstValidAt !== null && last !== null
        && last.status === PROOF_STATUS.VALID,
    }
  }

  siteMode(site) {
    const rows = this.capacity.filter(row => row.site === site)
    if (rows.length === 0) return null
    const modes = [...new Set(rows.map(row => row.mode))]
    return modes.length === 1 ? modes[0] : modes
  }

  capacityRows(site = null) {
    return site === null
      ? [...this.capacity]
      : this.capacity.filter(row => row.site === site)
  }

  capacityWindow(site, mode, minute = null) {
    const rows = this.capacity.filter(row => row.site === site && row.mode === mode)
    if (rows.length === 0) return null
    if (minute === null) return rows[0]
    return rows.find(row => {
      const window = parseWindow(row.window)
      return window && minute >= window.from && minute <= window.to
    }) ?? null
  }
}

export function buildModel(store) {
  return new Model(store)
}

export { isUnknown, toMinutes, minDefined, maxDefined }
