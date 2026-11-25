import { EVENTS, MODES, PROOF_STATUS } from './model.js'
import {
  clampAtZero,
  distinctReferences,
  minDefined,
  toMinutes,
} from './normalize.js'

// 等待状态的分类。它们描述“截至某个时间点，这一段到底处在什么位置”，
// 而不是申请整体是否办结。几类状态必须分开对待，不能互相抵消。
export const WAIT_STATUS = Object.freeze({
  ZERO: 'zero_wait', // 真实零等待
  DONE: 'done', // 已走完且有实际等待
  UNFINISHED: 'unfinished', // 尚未走完
  INTERRUPTED: 'interrupted', // 观测中断
  SKIPPED: 'skipped', // 无需此步
  BLOCKED: 'blocked', // 被关联依赖堵住
  UNKNOWN: 'unknown', // 资料不足以判断
})

export const STATUS_LABEL = Object.freeze({
  zero_wait: '真实零等待',
  done: '已完成',
  unfinished: '尚未走完',
  interrupted: '观测中断',
  skipped: '无需此步',
  blocked: '被关联依赖堵住',
  unknown: '无法判断',
})

export const STAGE = Object.freeze({
  PROOF: 'proof',
  WINDOW: 'window',
  COMPLETION: 'completion',
})

export const STAGE_LABEL = Object.freeze({
  proof: '家庭证明签署',
  window: '学生窗口办理',
  completion: '办结',
})

// 把等待区间分类。start 是真正开始等待的分钟（已考虑 ready/arrived），
// accepted 是实际被受理（或办结）的分钟。
// 绝不能用计划预约时间代替 arrived，也不把 "?" 当成 0。
//
// 顺序很重要：已经记录下来的受理/办结是既成事实，即使之后观测中断，
// 这段等待仍然可以复算。中断只影响“尚未发生的下一段”。
export function classifyWait({ start, accepted, observedUntil, asOf, interrupted }) {
  if (start === null) {
    return {
      status: interrupted ? WAIT_STATUS.INTERRUPTED : WAIT_STATUS.UNKNOWN,
      wait: null,
      censored: null,
    }
  }
  if (accepted === null) {
    if (interrupted) {
      return {
        status: WAIT_STATUS.INTERRUPTED,
        wait: null,
        censored: clampAtZero((observedUntil ?? asOf ?? start) - start),
      }
    }
    const censor = observedUntil ?? asOf
    if (censor !== null && censor < start) {
      return { status: WAIT_STATUS.UNFINISHED, wait: null, censored: 0 }
    }
    return {
      status: WAIT_STATUS.UNFINISHED,
      wait: null,
      censored: censor === null ? null : clampAtZero(censor - start),
    }
  }
  if (asOf !== null && accepted > asOf) {
    // 截止之后才受理/办结，只供下一期，不计入本期。
    return { status: WAIT_STATUS.UNFINISHED, wait: null, censored: clampAtZero(asOf - start) }
  }
  const wait = clampAtZero(accepted - start)
  return {
    status: wait === 0 ? WAIT_STATUS.ZERO : WAIT_STATUS.DONE,
    wait,
    censored: null,
  }
}

// 某份证明被哪些申请依赖（同一家庭共用一份证明时会有多条）。
export function proofDependents(model, proofId) {
  return model.households
    .filter(row => model.proofIdsOf(row.app).includes(proofId))
    .map(row => row.app)
}

// 谁是这份证明的发起签署方。
// 平台“签署成功”事件指向该证明的申请即发起方；窗口模式下没有平台事件，
// 由唯一依赖方在窗口当场签署，也算发起方。
export function proofInitiator(model, proofId) {
  const signers = []
  for (const household of model.households) {
    if (!model.proofIdsOf(household.app).includes(proofId)) continue
    const signed = model.eventsOf(household.app)
      .some(event => event.event === EVENTS.SIGNED
        && distinctReferences(event.reference).includes(proofId))
    if (signed) signers.push(household.app)
  }
  if (signers.length > 0) return signers[0]
  const dependents = proofDependents(model, proofId)
  return dependents.length === 1 ? dependents[0] : null
}

// 复用 = 这份证明被多个申请共用，且本申请不是发起签署方。
// 两个孩子可以复用一份家庭证明，第二个孩子不需要再签。
export function isProofReused(model, app) {
  return model.proofIdsOf(app).some(proofId => {
    const dependents = proofDependents(model, proofId)
    return dependents.length > 1 && proofInitiator(model, proofId) !== app
  })
}

// 证明的办理方式。远程签署是“免去到校”的路径，窗口签署发生在到校办理过程中。
export function proofModes(model, app) {
  const modes = new Set()
  for (const proofId of model.proofIdsOf(app)) {
    for (const row of model.proofRows(proofId)) modes.add(row.mode)
  }
  return [...modes]
}

// 得出一个申请截至 asOf 的家庭证明阶段。
// 关键业务规则：
// - 复用的第二个孩子无需再次签署（无需此步），但仍共同依赖该证明。
// - 共用证明被撤销会堵住仍未办妥的关联申请。
// - 撤销前业务已确认受理/办结的申请仍可复核，不因后来撤销而回退。
//
// 日期参数 `completionAt` 表示业务确认下一步资格的时间；用来判断撤销先后。
export function proofStage(model, app, asOf = null) {
  const household = model.householdOf(app)
  if (!household) {
    return stage(STAGE.PROOF, WAIT_STATUS.UNKNOWN, {
      reason: '资料中没有该申请的家庭记录',
    })
  }
  const credential = model.credentialState(app, asOf)
  const reused = isProofReused(model, app)
  const modes = proofModes(model, app)
  const base = {
    proofIds: credential.proofIds,
    modes,
    reused,
    firstValidAt: credential.firstValidAt,
    revokedAt: credential.revokedAt,
    lastStatus: credential.lastStatus,
    evidence: credential.events.map(event => ({
      at: event.at,
      status: event.status,
      proof: event.proof,
      mode: event.mode,
    })),
  }

  if (credential.proofIds.length === 0) {
    return stage(STAGE.PROOF, WAIT_STATUS.SKIPPED, {
      ...base,
      reason: '该家庭没有登记的共用证明依赖',
    })
  }

  if (credential.firstValidAt === null) {
    if (credential.brokenAt !== null) {
      return stage(STAGE.PROOF, WAIT_STATUS.INTERRUPTED, {
        ...base,
        at: credential.brokenAt,
        reason: '签署结果断报，来源未提供有效凭证',
      })
    }
    if (credential.lastStatus === PROOF_STATUS.REVOKED) {
      return stage(STAGE.PROOF, WAIT_STATUS.BLOCKED, {
        ...base,
        at: credential.lastAt,
        reason: '共用证明在首次有效之前已被撤销',
      })
    }
    return stage(STAGE.PROOF, WAIT_STATUS.UNFINISHED, {
      ...base,
      reason: '截至当前尚未观察到有效签署',
    })
  }

  const revoked = credential.revokedAt !== null && credential.lastStatus === PROOF_STATUS.REVOKED
  if (!revoked) {
    if (reused) {
      return stage(STAGE.PROOF, WAIT_STATUS.SKIPPED, {
        ...base,
        at: credential.firstValidAt,
        wait: 0,
        reason: '复用家庭已签署的共用证明，不需要再次签署',
      })
    }
    // 窗口方式在到校办理时签署，签署等待并入窗口段，不单独计一段排队。
    const windowSigned = modes.length > 0 && modes.every(mode => mode === MODES.WINDOW)
    return stage(STAGE.PROOF, WAIT_STATUS.ZERO, {
      ...base,
      at: credential.firstValidAt,
      wait: 0,
      windowSigned,
      reason: windowSigned
        ? '窗口签署在到校办理过程中完成，签署不构成额外等待'
        : '家长远程签署已取得有效凭证',
    })
  }

  // 证明已撤销：看业务是否在撤销前已确认下一步资格。
  const confirmedAt = confirmedMoment(model, app)
  if (confirmedAt !== null && confirmedAt < credential.revokedAt) {
    return stage(STAGE.PROOF, WAIT_STATUS.DONE, {
      ...base,
      at: credential.firstValidAt,
      wait: 0,
      shielded: true,
      shieldedBy: {
        at: credential.revokedAt,
        confirmedAt,
        reason: '撤销前业务已确认受理/办结，仍可复核',
      },
      reason: '证明后来被撤销，但业务确认发生在撤销之前',
    })
  }

  return stage(STAGE.PROOF, WAIT_STATUS.BLOCKED, {
    ...base,
    at: credential.revokedAt,
    reason: '共用家庭证明已被撤销，关联申请仍未办妥',
  })
}

export function confirmedMoment(model, app) {
  return minDefined(
    model.eventsOf(app)
      .filter(event => event.event === EVENTS.ACCEPT || event.event === EVENTS.COMPLETE)
      .map(event => toMinutes(event.at)),
  )
}

// 学生窗口阶段。开始等待取“实际到场”这一真实时刻；
// 计划预约时间（预约/改约申请/改约接受）从不作为开始等待的依据。
// 没有实际到场时才退回首个可办分钟（此时只能给出尚未走完的截尾）。
// 首个可办分钟另以 ready/effectiveReady 暴露，用于判断“本可更早被受理”。
//
// 远程签署是到校的前置条件，因此首个可办分钟不早于远程凭证生效；
// 窗口签署本来就发生在到校办理过程中，不把签署时间当成到校门槛。
export function windowStage(model, app, asOf = null) {
  const observation = model.observationOf(app)
  const proof = proofStage(model, app, asOf)
  const proofReady = proofGate(proof)

  const archivedReady = observation ? toMinutes(observation.ready) : null
  const ready = minDefined([archivedReady, proofReady])
  const arrived = observation ? toMinutes(observation.arrived) : null
  const accepted = observation ? toMinutes(observation.accepted) : null
  const observedUntil = observation ? toMinutes(observation.observed_until) : null

  const interrupted = isObservationInterrupted(model, app, asOf)
  // 真实等待从实际到场开始；从未到场则不开始计时。
  const start = arrived ?? ready

  const base = {
    ready: archivedReady,
    effectiveReady: ready,
    arrived,
    accepted,
    observedUntil,
    // 实际到场、实际受理与“本可更早受理”的参照点。
    start,
    avoidable: accepted !== null && ready !== null && accepted > ready ? accepted - ready : 0,
    scheduledOnly: arrived === null && hasScheduledBooking(model, app),
    evidence: windowEvidence(model, app),
  }

  if (proof.status === WAIT_STATUS.BLOCKED) {
    return stage(STAGE.WINDOW, WAIT_STATUS.BLOCKED, {
      ...base,
      reason: '家庭证明已被撤销，窗口不再具备受理条件',
    })
  }

  const classified = classifyWait({
    start,
    accepted,
    observedUntil,
    asOf,
    interrupted,
  })

  if (interrupted && classified.status !== WAIT_STATUS.DONE) {
    return stage(STAGE.WINDOW, WAIT_STATUS.INTERRUPTED, {
      ...base,
      at: interruptedAt(model, app),
      wait: null,
      censored: classified.censored,
      reason: '观测在受理/办结前中断，之后没有可核事实',
    })
  }

  return stage(STAGE.WINDOW, classified.status, {
    ...base,
    at: accepted,
    wait: classified.wait,
    censored: classified.censored,
    // 记录仅用于说明“计划时间没有被当成等待起点”。
    bookingNote: base.scheduledOnly ? '只有计划预约，没有实际到场，不能开始计时' : null,
  })
}

function proofGate(proof) {
  if (proof.status === WAIT_STATUS.BLOCKED || proof.status === WAIT_STATUS.INTERRUPTED) return null
  if (proof.windowSigned || proof.reused) return null
  return proof.firstValidAt ?? proof.at ?? null
}

// 办结阶段。受理之后到办结之间的等待。
export function completionStage(model, app, asOf = null) {
  const observation = model.observationOf(app)
  const accepted = observation ? toMinutes(observation.accepted) : null
  const completed = observation ? toMinutes(observation.completed) : null
  const observedUntil = observation ? toMinutes(observation.observed_until) : null
  const interrupted = isObservationInterrupted(model, app, asOf)
  const proof = proofStage(model, app, asOf)
  const blocked = proof.status === WAIT_STATUS.BLOCKED

  const base = { accepted, completed, observedUntil, evidence: windowEvidence(model, app) }

  if (blocked) {
    return stage(STAGE.COMPLETION, WAIT_STATUS.BLOCKED, {
      ...base,
      reason: '家庭证明撤销后关联申请仍未办妥',
    })
  }
  const classified = classifyWait({
    start: accepted,
    accepted: completed,
    observedUntil,
    asOf,
    interrupted,
  })
  if (interrupted && classified.status !== WAIT_STATUS.DONE) {
    return stage(STAGE.COMPLETION, WAIT_STATUS.INTERRUPTED, {
      ...base,
      at: interruptedAt(model, app),
      censored: classified.censored,
      reason: '办结前观测中断',
    })
  }
  return stage(STAGE.COMPLETION, classified.status, {
    ...base,
    at: completed,
    wait: classified.wait,
    censored: classified.censored,
  })
}

export function isObservationInterrupted(model, app, asOf = null) {
  const interrupted = model.eventsOf(app).some(event => event.event === EVENTS.INTERRUPTED)
  if (interrupted) return true
  const observation = model.observationOf(app)
  if (!observation) return false
  const observedUntil = toMinutes(observation.observed_until)
  if (observedUntil === null || asOf === null) return false
  const completed = toMinutes(observation.completed)
  return observedUntil < asOf && completed === null
}

function interruptedAt(model, app) {
  return minDefined(
    model.eventsOf(app)
      .filter(event => event.event === EVENTS.INTERRUPTED)
      .map(event => toMinutes(event.at)),
  )
}

function hasScheduledBooking(model, app) {
  return model.receiptsOf(app).length > 0
    || model.eventsOf(app).some(event => event.event === EVENTS.BOOK
      || event.event === EVENTS.REBOOK_REQUEST
      || event.event === EVENTS.REBOOK_ACCEPT)
}

export function windowEvidence(model, app) {
  return model.eventsOf(app).map(event => ({
    at: event.at,
    event: event.event,
    site: event.site,
    reference: event.reference,
  }))
}

function stage(key, status, extra = {}) {
  return {
    key,
    label: STAGE_LABEL[key],
    status,
    statusLabel: STATUS_LABEL[status] ?? status,
    at: extra.at ?? null,
    wait: extra.wait ?? null,
    censored: extra.censored ?? null,
    reason: extra.reason ?? null,
    ...extra,
  }
}

// 完整的申请生命周期：三个阶段 + 真正具备下一步条件的阶段。
export function applicationLifecycle(model, app, asOf = null) {
  const household = model.householdOf(app)
  const proof = proofStage(model, app, asOf)
  const window = windowStage(model, app, asOf)
  const completion = completionStage(model, app, asOf)
  const next = nextActionableStage({ proof, window, completion })
  return {
    app,
    family: household?.family ?? null,
    student: household?.student ?? null,
    region: household?.region ?? null,
    asOf,
    stages: { proof, window, completion },
    // 真正已具备下一步条件的阶段；null 表示整条链已办结。
    nextActionable: next,
    completed: completion.status === WAIT_STATUS.DONE || completion.status === WAIT_STATUS.ZERO,
    blocked: [proof, window, completion].some(item => item.status === WAIT_STATUS.BLOCKED),
    interrupted: [proof, window, completion].some(item => item.status === WAIT_STATUS.INTERRUPTED),
  }
}

export function nextActionableStage({ proof, window, completion }) {
  if (completion.status === WAIT_STATUS.DONE || completion.status === WAIT_STATUS.ZERO) return null
  if (proof.status === WAIT_STATUS.BLOCKED) {
    return { stage: STAGE.PROOF, label: STAGE_LABEL.proof, status: proof.status, earliest: null }
  }
  const proofReady = [WAIT_STATUS.ZERO, WAIT_STATUS.DONE, WAIT_STATUS.SKIPPED].includes(proof.status)
  if (!proofReady) {
    return {
      stage: STAGE.PROOF,
      label: STAGE_LABEL.proof,
      status: proof.status,
      earliest: proof.at ?? null,
    }
  }
  if (![WAIT_STATUS.DONE, WAIT_STATUS.ZERO].includes(window.status)) {
    return {
      stage: STAGE.WINDOW,
      label: STAGE_LABEL.window,
      status: window.status,
      earliest: window.effectiveReady ?? window.ready ?? null,
    }
  }
  return {
    stage: STAGE.COMPLETION,
    label: STAGE_LABEL.completion,
    status: completion.status,
    earliest: completion.accepted ?? null,
  }
}

// 整户视图：一个孩子办结不能关闭整户；只拿到一份结果时保留其他孩子状态。
export function familyLifecycle(model, family, asOf = null) {
  const children = model.studentsOf(family).map(row => applicationLifecycle(model, row.app, asOf))
  const completed = children.filter(child => child.completed)
  const open = children.filter(child => !child.completed)
  const blocked = children.filter(child => child.blocked)
  const interrupted = children.filter(child => child.interrupted)
  const proofIds = [...new Set(children.flatMap(child => model.proofIdsOf(child.app)))]
  return {
    family,
    asOf,
    children,
    // 整户的独立证据单位是共用的证明份数。
    proofUnits: proofIds.length,
    studentCount: children.length,
    completedCount: completed.length,
    openCount: open.length,
    blockedCount: blocked.length,
    interruptedCount: interrupted.length,
    // 只有全部孩子都办结，整户才算办结。
    closed: children.length > 0 && completed.length === children.length,
    status: children.length === 0
      ? 'empty'
      : completed.length === children.length
        ? 'closed'
        : blocked.length > 0
          ? 'partially_blocked'
          : completed.length > 0
            ? 'partially_open'
            : interrupted.length === children.length
              ? 'interrupted'
              : 'open',
    // 明确列出仍未办妥的关联申请，避免用一份结果关闭整户。
    keepOpenFor: open.map(child => child.app),
  }
}

// 跨点再预约：旧点的排队占用只有在新点“已接受”时才释放。
export function rebookingReceipts(model, app) {
  const rows = model.receiptsOf(app)
  const timeline = rows.map(row => ({
    reservation: row.reservation,
    site: row.site,
    at: toMinutes(row.at),
    kind: row.kind,
    previous: row.previous === '?' ? null : row.previous,
    accepted: row.kind === '已接受',
  }))
  const releases = []
  for (const row of timeline) {
    if (row.kind !== '已接受' || !row.previous) continue
    const previous = timeline.find(candidate => candidate.reservation === row.previous)
    releases.push({
      previous: row.previous,
      previousSite: previous?.site ?? null,
      releasedAt: row.at,
      releasedBy: row.reservation,
      site: row.site,
    })
  }
  const failed = timeline.filter(row => row.kind === '申请失败')
  const pending = timeline.filter(row => row.kind === '待接受')
  return { timeline, releases, failed, pending }
}

// 截至 asOf，某点某队仍被占用的预约（未被新点接受释放的旧占用）。
export function occupiedReservations(model, asOf = null) {
  const occupied = []
  for (const app of new Set(model.receipts.map(row => row.app))) {
    const { timeline, releases } = rebookingReceipts(model, app)
    for (const row of timeline) {
      const released = releases.find(item => item.previous === row.reservation)
      if (asOf !== null && row.at !== null && row.at > asOf) continue
      if (row.kind === '申请失败') continue
      if (released && (asOf === null || released.releasedAt <= asOf)) continue
      occupied.push({
        app,
        reservation: row.reservation,
        site: row.site,
        from: row.at,
        kind: row.kind,
        releasedAt: released?.releasedAt ?? null,
      })
    }
  }
  return occupied
}

// 用平台事件还原“实际到达”和“实际被受理”，用于跨点改派时保留原始事实。
export function preservedArrivalFacts(model, app) {
  const observation = model.observationOf(app)
  const arrived = observation ? toMinutes(observation.arrived) : null
  const accepted = observation ? toMinutes(observation.accepted) : null
  const arrivalEvent = model.eventsOf(app).find(event => event.event === EVENTS.ARRIVE)
  const acceptEvent = model.eventsOf(app).find(event => event.event === EVENTS.ACCEPT)
  return {
    app,
    arrival: arrived ?? (arrivalEvent ? toMinutes(arrivalEvent.at) : null),
    accepted: accepted ?? (acceptEvent ? toMinutes(acceptEvent.at) : null),
    arrivalSite: arrivalEvent?.site ?? null,
    acceptedSite: acceptEvent?.site ?? null,
    // 计划预约时间只作参考，不替代上面两个事实。
    plannedOnly: model.receiptsOf(app).map(row => ({
      reservation: row.reservation,
      site: row.site,
      at: toMinutes(row.at),
      kind: row.kind,
    })),
  }
}
