import {
  WAIT_STATUS,
  applicationLifecycle,
  proofStage,
  windowStage,
} from './lifecycle.js'
import { clampAtZero, minDefined, round, toMinutes } from './normalize.js'

// 等待分段。每段都有自己的起止依据，绝不把计划预约时间当成开始等待。
// - proof：家长开始签署 -> 首个有效凭证（窗口签署并入到校办理，复用记 0）
// - toArrival：首个可办分钟（已含远程凭证门槛）-> 实际到场
// - queue：实际到场 -> 实际受理
// - service：实际受理 -> 办结
export function waitBreakdown(model, app, asOf = null) {
  const household = model.householdOf(app)
  const observation = model.observationOf(app)
  const proof = proofStage(model, app, asOf)
  const window = windowStage(model, app, asOf)
  const parentStart = minDefined(model.eventTimes(app, '家长开始'))
  const arrived = observation ? toMinutes(observation.arrived) : null
  const accepted = observation ? toMinutes(observation.accepted) : null
  const completed = observation ? toMinutes(observation.completed) : null
  const observedUntil = observation ? toMinutes(observation.observed_until) : null
  const firstActionable = window.effectiveReady ?? window.ready

  const segments = []

  // 签署段的结束时间和开始时间。
  const proofStart = parentStart ?? proof.firstValidAt ?? null
  if (proof.reused) {
    segments.push(makeSegment('proof', 0, WAIT_STATUS.SKIPPED, {
      start: null,
      end: proof.firstValidAt,
      note: '复用家庭共用证明，不重复签署',
    }))
  } else if (proof.status === WAIT_STATUS.BLOCKED || proof.status === WAIT_STATUS.INTERRUPTED) {
    segments.push(makeSegment('proof', null, proof.status, {
      start: proofStart,
      end: null,
      note: proof.reason,
    }))
  } else if (proof.windowSigned) {
    // 窗口签署没有独立的等待区间：签署与到校办理在同一趟完成。
    // 不强行用签署时间戳减去到场时间（两者可能来自不同系统、顺序不一致）。
    segments.push(makeSegment('proof', 0, WAIT_STATUS.SKIPPED, {
      start: null,
      end: null,
      signedAt: proof.firstValidAt,
      note: '窗口签署在到校办理过程中完成，不单独形成排队',
    }))
  } else if (proof.firstValidAt !== null && parentStart !== null) {
    segments.push(makeSegment('proof', proof.firstValidAt - parentStart, WAIT_STATUS.DONE, {
      start: parentStart,
      end: proof.firstValidAt,
    }))
  } else if (proof.firstValidAt !== null) {
    segments.push(makeSegment('proof', 0, WAIT_STATUS.ZERO, {
      start: proof.firstValidAt,
      end: proof.firstValidAt,
      note: '未记录签署开始，以首个可核对凭证为起点',
    }))
  } else {
    segments.push(makeSegment('proof', null, proof.status, {
      start: proofStart,
      end: null,
      note: proof.reason ?? '尚未观察到有效签署',
    }))
  }

  // 到场前段：首个可办分钟 -> 实际到场。若只有计划预约，不能计时。
  if (arrived !== null && firstActionable !== null && arrived >= firstActionable) {
    segments.push(makeSegment('toArrival', arrived - firstActionable, WAIT_STATUS.DONE, {
      start: firstActionable,
      end: arrived,
    }))
  } else if (arrived !== null && firstActionable !== null) {
    // 已到场早于首个可办分钟：到场前没有可计入的等待。
    segments.push(makeSegment('toArrival', 0, WAIT_STATUS.ZERO, {
      start: firstActionable,
      end: arrived,
      note: '实际到场早于首个可办分钟，到场前不产生等待',
    }))
  } else if (arrived !== null) {
    segments.push(makeSegment('toArrival', null, WAIT_STATUS.UNKNOWN, {
      start: null,
      end: arrived,
      note: '缺少首个可办分钟',
    }))
  } else {
    segments.push(makeSegment('toArrival', null, WAIT_STATUS.UNFINISHED, {
      start: firstActionable,
      end: null,
      censored: firstActionable === null || observedUntil === null
        ? null
        : clampAtZero(observedUntil - firstActionable),
      note: firstActionable === null ? '缺少可办时间与实际到场' : '只有计划预约，没有实际到场',
    }))
  }

  // 排队段：实际到场 -> 实际受理
  if (arrived !== null && accepted !== null) {
    segments.push(makeSegment('queue', accepted - arrived, WAIT_STATUS.DONE, {
      start: arrived,
      end: accepted,
    }))
  } else if (arrived !== null) {
    segments.push(makeSegment('queue', null, WAIT_STATUS.UNFINISHED, {
      start: arrived,
      end: null,
      censored: observedUntil !== null ? clampAtZero(observedUntil - arrived) : null,
      note: '截至观察止点仍未受理',
    }))
  } else {
    segments.push(makeSegment('queue', null, WAIT_STATUS.UNKNOWN, {
      start: null,
      end: null,
    }))
  }

  // 办理段：受理 -> 办结
  if (accepted !== null && completed !== null) {
    segments.push(makeSegment('service', completed - accepted, WAIT_STATUS.DONE, {
      start: accepted,
      end: completed,
    }))
  } else if (accepted !== null) {
    segments.push(makeSegment('service', null, WAIT_STATUS.UNFINISHED, {
      start: accepted,
      end: null,
      censored: observedUntil !== null ? clampAtZero(observedUntil - accepted) : null,
      note: '受理后截至观察止点仍未办结',
    }))
  } else {
    segments.push(makeSegment('service', null, WAIT_STATUS.UNKNOWN, {
      start: null,
      end: null,
    }))
  }

  const measured = segments.filter(item => item.minutes !== null)
  const totalMeasured = measured.length === 0
    ? null
    : measured.reduce((sum, item) => sum + item.minutes, 0)
  const endToEndStart = proof.windowSigned ? null : (parentStart ?? firstActionable)
  const endToEnd = endToEndStart !== null && completed !== null && completed >= endToEndStart
    ? completed - endToEndStart
    : null

  return {
    app,
    family: household?.family ?? null,
    firstActionable,
    parentStart,
    arrived,
    accepted,
    completed,
    observedUntil,
    segments,
    totalMeasured: totalMeasured === null ? null : round(totalMeasured, 2),
    endToEnd: endToEnd === null ? null : round(endToEnd, 2),
    bottleneck: pickBottleneck(segments),
    incompleteReason: explainIncomplete({ segments, completed, proof }),
    proofStatus: proof.status,
    windowStatus: window.status,
  }
}

function makeSegment(key, minutes, status, extra = {}) {
  return {
    key,
    status,
    minutes: minutes === null ? null : round(clampAtZero(minutes), 2),
    ...extra,
  }
}

// 找最长的已完成段作为“卡点”；没有已完成段时指出未完成/中断段。
function pickBottleneck(segments) {
  const done = segments.filter(item => item.minutes !== null
    && item.minutes > 0
    && (item.status === WAIT_STATUS.DONE))
  if (done.length > 0) {
    return [...done].sort((a, b) => b.minutes - a.minutes)[0]
  }
  return segments.find(item => ![WAIT_STATUS.DONE, WAIT_STATUS.ZERO, WAIT_STATUS.SKIPPED]
    .includes(item.status)) ?? null
}

function explainIncomplete({ segments, completed, proof }) {
  if (completed !== null) return []
  const reasons = []
  if (proof.status === WAIT_STATUS.BLOCKED || proof.status === WAIT_STATUS.INTERRUPTED) {
    if (proof.reason) reasons.push(proof.reason)
  }
  for (const item of segments) {
    if (item.status === WAIT_STATUS.UNFINISHED || item.status === WAIT_STATUS.UNKNOWN) {
      reasons.push(`${item.key}: ${item.note ?? '尚未完成'}`)
    }
  }
  return reasons
}

// 一个家庭“究竟少等了多久”。以共用证明为单位处理共同依赖：
// 同一家庭两个孩子的观测不是两份独立证据，节省量按证明份数而不是申请条数计。
export function timeSavedByRemote(model, family) {
  const apps = model.studentsOf(family).map(row => row.app)
  if (apps.length === 0) return null
  const breakdowns = apps.map(app => waitBreakdown(model, app))
  const proofSegments = breakdowns.map(item => item.segments.find(segment => segment.key === 'proof'))
  const reusedChildren = proofSegments.filter(item => item?.status === WAIT_STATUS.SKIPPED).length
  const signedMinutes = minDefined(
    proofSegments.filter(item => item.status === WAIT_STATUS.DONE).map(item => item.minutes),
  )
  const queueMinutes = minDefined(
    breakdowns
      .map(item => item.segments.find(segment => segment.key === 'queue'))
      .filter(item => item && item.status === WAIT_STATUS.DONE && item.minutes > 0)
      .map(item => item.minutes),
  )
  const avoidedSigning = signedMinutes ?? 0
  const avoidedQueue = queueMinutes ?? null
  const proofIds = [...new Set(apps.flatMap(app => model.proofIdsOf(app)))]
  return {
    family,
    apps,
    proofUnits: proofIds.length,
    reusedChildren,
    signedMinutes: avoidedSigning,
    windowQueueMinutes: avoidedQueue,
    // 远程让每个孩子省掉一次窗口签署排队；共用证明本身只签一次。
    estimatedMinutesSaved: round(avoidedSigning + (avoidedQueue ?? 0) * apps.length, 2),
    caveat: avoidedQueue === null
      ? '没有可核的窗口排队观测，节省仅含签署段，不含可能被避免的排队'
      : `节省按“签署段 + 每个孩子一次窗口排队”估计；${apps.length} 个孩子共用 ${proofIds.length} 份证明，不是 ${apps.length} 份独立证据`,
  }
}

export function timeSavedAllFamilies(model) {
  return [...new Set(model.households.map(row => row.family))]
    .map(family => timeSavedByRemote(model, family))
}
