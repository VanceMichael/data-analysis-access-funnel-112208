import { EVENTS, PLATFORM_SITE } from './model.js'
import {
  WAIT_STATUS,
  applicationLifecycle,
  familyLifecycle,
  occupiedReservations,
  proofStage,
  rebookingReceipts,
} from './lifecycle.js'
import { maxDefined, minDefined, round, toMinutes } from './normalize.js'

// 把“协助时段”从一种办理方式切给另一种时比较效果。
// 硬约束：
// - 各点名额由不同服务队列共用；同一 team 同窗的 shared=yes 名额不相加。
// - 不能假设等候名额仍同时兼顾两边；切走后来源方式就少一边。
export function shiftAssistance(model, { site, fromMode, toMode }) {
  const fromRows = model.capacityRows(site).filter(row => row.mode === fromMode)
  const toRows = model.capacityRows(site).filter(row => row.mode === toMode)
  if (fromRows.length === 0 || toRows.length === 0) {
    return { feasible: false, reason: `站点 ${site} 没有同时提供 ${fromMode} 与 ${toMode} 的容量` }
  }
  const source = fromRows[0]
  const target = toRows[0]
  const sourceSlots = toMinutes(source.slots) ?? 0
  const targetSlotsBefore = toMinutes(target.slots) ?? 0

  const sharedSameTeam = source.shared === 'yes' && target.shared === 'yes'
    && source.team === target.team && source.window === target.window
  // 共用窗口时，两边看到的是同一批名额，上界不因改标注而增加。
  const sharedTotal = sharedSameTeam ? Math.max(sourceSlots, targetSlotsBefore) : null

  return {
    feasible: true,
    site,
    shared: sharedSameTeam,
    from: {
      mode: fromMode,
      window: source.window,
      team: source.team,
      slots: sourceSlots,
      // 切走后来源方式不再保留独立等候名额。
      after: sharedSameTeam ? sharedTotal : 0,
    },
    to: {
      mode: toMode,
      window: target.window,
      team: target.team,
      slots: targetSlotsBefore,
      after: sharedSameTeam ? sharedTotal : targetSlotsBefore + sourceSlots,
    },
    // 共用窗口时净增为 0：同一批人，只是改了入口。
    netNewCapacity: sharedSameTeam ? 0 : sourceSlots,
    warning: sharedSameTeam
      ? '这两个方式同属一个 team 的共用窗口，名额是同一批人，不能相加；切走等于此消彼长'
      : '等候名额不会同时兼顾两边：转移后来源方式的可用名额相应减少',
    // 只有实际到场并实际受理的观测才能用于估计排队效果。
    evidence: queueEvidence(model),
  }
}

function queueEvidence(model) {
  return model.observations
    .filter(row => toMinutes(row.arrived) !== null && toMinutes(row.accepted) !== null)
    .map(row => ({
      app: row.app,
      channel: row.channel,
      queueMinutes: toMinutes(row.accepted) - toMinutes(row.arrived),
    }))
}

// 拟议的客群：必须“当前可进入对应流程”。
// 不能用跨点失败（申请失败）或提前退出（观测中断）去充实可接纳数量。
export function eligibleCustomers(model, { site, mode, asOf = null } = {}) {
  const occupied = occupiedReservations(model, asOf)
  const eligible = []
  const excluded = []
  for (const row of model.households) {
    const app = row.app
    const lifecycle = applicationLifecycle(model, app, asOf)
    const failedTransfer = model.receiptsOf(app).some(receipt => receipt.kind === '申请失败')
    const earlyExit = model.eventsOf(app).some(event => event.event === EVENTS.INTERRUPTED)
    const alreadyDone = lifecycle.completed
    const held = occupied.find(item => item.app === app && item.site !== site)
    const reasons = []
    if (lifecycle.stages.proof.status === WAIT_STATUS.BLOCKED) {
      reasons.push('家庭证明被撤销，当前不能进入流程')
    }
    if (failedTransfer) reasons.push('跨点改约失败，不能计入可接纳')
    if (earlyExit) reasons.push('提前退出/观测中断，不能计入可接纳')
    if (alreadyDone) reasons.push('已办结，不属于待接纳客群')
    if (held) reasons.push(`在 ${held.site} 仍占用排队（${held.reservation}），未释放`)
    if (reasons.length > 0) {
      excluded.push({ app, family: row.family, reasons })
    } else {
      eligible.push({
        app,
        family: row.family,
        region: row.region,
        proofIds: model.proofIdsOf(app),
      })
    }
  }
  // 可接纳数量按家庭计，避免共用证明的两个孩子被算成两份需求。
  const families = new Set(eligible.map(item => item.family))
  return {
    site,
    mode,
    asOf,
    eligible,
    excluded,
    eligibleFamilies: [...families],
    eligibleCount: eligible.length,
    eligibleFamilyCount: families.size,
  }
}

// 远程开放前后比较。以“共享证明”为单位处理共同依赖：
// 同一家庭的两个观测共用一份证明，不能当两份独立证据。
export function compareRemoteBeforeAfter(model, { before, after, asOf = null } = {}) {
  if (!before || !after) throw new Error('需要同时给出开放前后的期次')
  const beforeByProof = groupByProof(model, model.observationsFor(before))
  const afterByProof = groupByProof(model, model.observationsFor(after))
  const proofKeys = new Set([...beforeByProof.keys(), ...afterByProof.keys()])

  const clusters = [...proofKeys].map(key => ({
    proof: key,
    before: aggregateCluster(beforeByProof.get(key) ?? []),
    after: aggregateCluster(afterByProof.get(key) ?? []),
  }))
  const paired = clusters.filter(item => item.before.count > 0 && item.after.count > 0)
  const waitBefore = paired.map(item => item.before.meanWait).filter(value => value !== null)
  const waitAfter = paired.map(item => item.after.meanWait).filter(value => value !== null)

  return {
    before,
    after,
    asOf,
    unit: 'proof',
    clusters,
    pairedProofs: paired.map(item => item.proof),
    // 以证明为单位，而不是以申请条数为单位。
    independentBefore: beforeByProof.size,
    independentAfter: afterByProof.size,
    waitBefore: average(waitBefore),
    waitAfter: average(waitAfter),
    change: average(waitBefore) !== null && average(waitAfter) !== null
      ? round(average(waitAfter) - average(waitBefore), 2)
      : null,
    sharedDependencyNote: paired.some(item => item.before.count > 1 || item.after.count > 1)
      ? '同一家庭的两个观测共用一份证明，已按证明合并，未作为两份独立证据'
      : null,
  }
}

function groupByProof(model, rows) {
  const map = new Map()
  for (const row of rows) {
    const proofIds = model.proofIdsOf(row.app)
    // 没有登记证明的观测用自己的 app 作为独立单位。
    const key = proofIds.length > 0 ? [...proofIds].sort().join('+') : `app:${row.app}`
    const list = map.get(key) ?? []
    list.push(row)
    map.set(key, list)
  }
  return map
}

function aggregateCluster(rows) {
  const waits = []
  for (const row of rows) {
    const accepted = toMinutes(row.accepted)
    const ready = toMinutes(row.ready)
    const arrived = toMinutes(row.arrived)
    const start = ready === null ? arrived : arrived === null ? ready : Math.max(ready, arrived)
    if (start === null || accepted === null) continue
    waits.push(accepted - start)
  }
  return {
    count: rows.length,
    apps: rows.map(row => row.app),
    families: [...new Set(rows.map(row => row.family))],
    meanWait: average(waits),
    // 同一证明下的多个孩子只算一个观测证据。
    evidenceUnits: rows.length > 0 ? 1 : 0,
  }
}

function average(values) {
  if (values.length === 0) return null
  return round(values.reduce((sum, value) => sum + value, 0) / values.length, 2)
}

// 在被改派的人中估值时，明确“已知道的准备状态”和“仍未成熟的结局”。
export function reassignmentEstimate(model, { apps = null, asOf = null } = {}) {
  const targetApps = apps ?? [...new Set(model.receipts
    .filter(row => row.previous !== '?')
    .map(row => row.app))]
  return targetApps.map(app => {
    const lifecycle = applicationLifecycle(model, app, asOf)
    const observation = model.observationOf(app)
    const completed = observation ? toMinutes(observation.completed) : null
    const arrived = observation ? toMinutes(observation.arrived) : null
    return {
      app,
      knownReadiness: {
        proofStatus: lifecycle.stages.proof.status,
        proofAt: lifecycle.stages.proof.at,
        firstActionable: observation ? toMinutes(observation.ready) : null,
        arrived,
        scheduled: toMinutes(model.receiptsOf(app).at(-1)?.at),
      },
      matureOutcome: completed !== null && (asOf === null || completed <= asOf),
      pendingOutcome: completed === null || (asOf !== null && completed > asOf),
      note: completed === null
        ? '结局尚未成熟：只报告已知准备状态，不能把未完成当成已完成'
        : null,
    }
  })
}

// 服务承诺核对：按公开报表规则检查试用线路的观察覆盖和办结上界。
// 时间按每期开门时重置，所以默认把各期分开核对，避免把 W0 与 W1 混成一个样本。
export function checkPublication(model, reportId, { period = null } = {}) {
  const publication = model.publicationByReport.get(reportId)
  if (!publication) return { report: reportId, ok: false, reason: '没有该报表' }
  const cutoff = toMinutes(publication.as_of)
  const maxMinutes = toMinutes(publication.max_minutes)
  const minSample = toMinutes(publication.min_sample)
  const allRows = model.observations.filter(row => row.channel === publication.channel
    && (period === null || row.period === period))

  // 逐期核对；总体结论取最差的一期，而不是把各期相加充数。
  const byPeriod = new Map()
  for (const row of allRows) {
    const list = byPeriod.get(row.period) ?? []
    list.push(row)
    byPeriod.set(row.period, list)
  }
  const periodChecks = [...byPeriod.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, rows]) => checkPeriodRows(model, reportId, publication, rows))
  const blocking = periodChecks.find(item => !item.ok) ?? null
  const allOverLimit = periodChecks.flatMap(item => item.overLimit.map(entry => ({ period: item.period, ...entry })))
  return {
    report: reportId,
    channel: publication.channel,
    state: publication.state,
    cutoff,
    maxMinutes,
    minSample,
    periods: periodChecks,
    // 汇总口径：覆盖率取各期中最差的一期；上界违例只要出现一次即不通过。
    sampleShortfall: periodChecks.length === 0
      || periodChecks.some(item => item.familySamples < (minSample ?? 0)),
    familySamples: periodChecks.length === 0
      ? 0
      : Math.min(...periodChecks.map(item => item.familySamples)),
    overLimit: allOverLimit,
    withinLimit: allOverLimit.length === 0,
    committed: model.commitments
      .filter(row => row.report === reportId)
      .map(row => ({ app: row.app, deadline: toMinutes(row.deadline) })),
    ok: publication.state === '已送' && blocking === null,
    reason: publication.state !== '已送'
      ? `报表状态为 ${publication.state}，尚未签发`
      : blocking === null
        ? null
        : blocking.reason,
  }
}

function checkPeriodRows(model, reportId, publication, rows) {
  const cutoff = toMinutes(publication.as_of)
  const maxMinutes = toMinutes(publication.max_minutes)
  const minSample = toMinutes(publication.min_sample)
  // 观察覆盖的最小样本按“相互独立的家庭”计：计入该期内出现过的家庭，
  // 而不是只数已办结的；办结上界仍只对截至 as_of 已办结的观测成立。
  const perFamily = new Map()
  for (const row of rows) {
    const list = perFamily.get(row.family) ?? []
    list.push(row)
    perFamily.set(row.family, list)
  }
  const completedWaits = []
  const incomplete = []
  for (const row of rows) {
    const accepted = toMinutes(row.accepted)
    const completed = toMinutes(row.completed)
    if (completed === null || (cutoff !== null && completed > cutoff)) {
      incomplete.push(row.app)
      continue
    }
    if (accepted === null) continue
    completedWaits.push({ app: row.app, family: row.family, minutes: completed - accepted })
  }
  const overLimit = completedWaits.filter(item => item.minutes > maxMinutes)
  const familySamples = perFamily.size
  return {
    report: reportId,
    period: rows[0]?.period ?? null,
    channel: publication.channel,
    cutoff,
    maxMinutes,
    minSample,
    // 观察覆盖以家庭为独立样本。
    familySamples,
    covered: completedWaits.length,
    incomplete,
    overLimit,
    withinLimit: overLimit.length === 0,
    ok: overLimit.length === 0 && familySamples >= (minSample ?? 0),
    reason: familySamples < (minSample ?? 0)
      ? '独立家庭样本不足，不能据此对外承诺'
      : overLimit.length > 0
        ? '存在超过承诺上界的已办结观测'
        : null,
  }
}

// 改派不能把上周已接受的承诺换成新期限。
export function commitmentForApp(model, app, { reassignedTo = null } = {}) {
  const commitment = model.commitmentByApp.get(app)
  if (!commitment) return null
  const publication = model.publicationByReport.get(commitment.report)
  const observation = model.observationOf(app)
  const completed = observation ? toMinutes(observation.completed) : null
  const deadline = toMinutes(commitment.deadline)
  return {
    app,
    accepted: toMinutes(commitment.accepted),
    deadline,
    report: commitment.report,
    channel: publication?.channel ?? null,
    // 既有预约沿用原承诺期限，改派不产生新期限。
    preservedDeadline: deadline,
    reassignedTo,
    atRisk: completed !== null && deadline !== null && completed > deadline,
    note: reassignedTo
      ? '改派沿用原承诺期限，未换成新期限'
      : null,
  }
}

// 资料更正使某渠道不再有证据报原时限时：停掉后续新承诺，
// 既有预约显示失约风险，其他渠道照常。
export function channelEvidenceChange(model, channel, { corrected = false } = {}) {
  const publications = model.publication.filter(row => row.channel === channel)
  const commitments = model.commitments.filter(row => {
    const publication = model.publicationByReport.get(row.report)
    return publication?.channel === channel
  })
  const existing = commitments.map(row => {
    const observation = model.observationOf(row.app)
    const completed = observation ? toMinutes(observation.completed) : null
    const deadline = toMinutes(row.deadline)
    return {
      app: row.app,
      deadline,
      completed,
      atRisk: corrected && (completed === null || deadline === null || completed > deadline),
    }
  })
  return {
    channel,
    corrected,
    // 有证据 = 存在已送且未超限的报表。
    evidenceAvailable: publications.some(row => row.state === '已送'),
    stopNewCommitments: corrected,
    existingCommitments: existing,
    atRisk: existing.filter(item => item.atRisk).map(item => item.app),
    otherChannelsUnaffected: model.publication
      .filter(row => row.channel !== channel)
      .map(row => ({ report: row.report, channel: row.channel, state: row.state })),
  }
}

// 值班组视图：按约查承诺、未完成人数所属的实际队列，
// 以及把某班人员调到另一边会先损及哪类事实。
export function dutyView(model, { asOf = null, team = null } = {}) {
  const commitments = model.commitments.map(row => commitmentForApp(model, row.app))
  const unfinished = []
  for (const family of new Set(model.households.map(row => row.family))) {
    const life = familyLifecycle(model, family, asOf)
    for (const child of life.children) {
      if (child.completed) continue
      unfinished.push({ app: child.app, family, queue: actualQueue(model, child.app) })
    }
  }
  return {
    asOf,
    commitments,
    unfinished,
    // 按实际队列汇总，不按“申请类别”汇总。
    byQueue: countBy(unfinished, item => `${item.queue.site}/${item.queue.mode}`),
    riskOfReallocation: reallocationRisk(model, team),
  }
}

function actualQueue(model, app) {
  const observation = model.observationOf(app)
  const arrivalEvent = model.eventsOf(app).find(event => event.event === EVENTS.ARRIVE)
  const site = arrivalEvent?.site ?? null
  const { timeline } = rebookingReceipts(model, app)
  // 尚未到场时，实际排队所属点取“已被新点接受”的那条预约；
  // 仅仅申请改约（待接受）或申请失败，都不算在新点排队。
  const acceptedReservation = [...timeline].reverse().find(row => row.kind === '已接受') ?? null
  const pendingQueue = acceptedReservation?.site ?? null
  const isPlatform = site === null || site === PLATFORM_SITE
  return {
    site: isPlatform ? (pendingQueue ?? PLATFORM_SITE) : site,
    // 只有真正到窗口才算窗口队；尚未到场无论预约在哪都仍是远程/平台一侧。
    mode: isPlatform ? '远程' : '窗口',
    arrived: observation ? toMinutes(observation.arrived) : null,
    accepted: observation ? toMinutes(observation.accepted) : null,
    // 明确区分“已到场”与“尚未到场、仅预约在新点”。
    onSite: !isPlatform,
    plannedSite: site === null ? pendingQueue : null,
    pendingReservation: acceptedReservation?.reservation ?? null,
  }
}

function countBy(list, keyFn) {
  const counts = new Map()
  for (const item of list) {
    const key = keyFn(item)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
}

// 调人“先损及”的事实：先损失两边的观测覆盖，再谈承诺。
function reallocationRisk(model, team) {
  const affected = model.capacity.filter(row => team === null || row.team === team)
  const byMode = new Map()
  for (const row of affected) {
    const list = byMode.get(row.mode) ?? []
    list.push(row)
    byMode.set(row.mode, list)
  }
  return [...byMode.entries()].map(([mode, rows]) => {
    const sharedRows = rows.filter(row => row.shared === 'yes')
    const effective = sharedRows.length > 0
      // shared=yes 同一 team 同窗取上界，不相加。
      ? maxDefined(sharedRows.map(row => toMinutes(row.slots)))
      : rows.reduce((sum, row) => sum + (toMinutes(row.slots) ?? 0), 0)
    return {
      mode,
      sites: [...new Set(rows.map(row => row.site))],
      slots: rows.map(row => ({
        site: row.site,
        window: row.window,
        slots: toMinutes(row.slots),
        shared: row.shared,
      })),
      effectiveSlots: effective,
      firstThingLost: mode === '远程'
        ? '远程线路的观察覆盖：调走先损失远程观测，再影响窗口承诺'
        : '窗口的当日排队观测：调走先损失排队长度的事实',
    }
  })
}
