import {
  WAIT_STATUS,
  applicationLifecycle,
  familyLifecycle,
  proofStage,
  rebookingReceipts,
} from './lifecycle.js'
import { maxDefined, minDefined, round, toMinutes } from './normalize.js'

// 未完成原因分组。按截至时间分别对待：
// 真实零等待、尚未走完、观测中断、无需此步都不算失败，也不互相抵消。
export const UNFINISHED_REASONS = Object.freeze({
  AWAITING_PROOF: '等待家庭证明',
  PROOF_BLOCKED: '共用证明撤销',
  PROOF_INTERRUPTED: '签署结果断报',
  NOT_ARRIVED: '尚未到场',
  QUEUING: '到场后仍在排队',
  IN_SERVICE: '受理后尚未办结',
  OBSERVATION_ENDED: '观测中断',
  NOT_REGISTERED: '未在当期登记表内',
  UNKNOWN: '资料不足',
})

export function classifyUnfinishedReason(lifecycle) {
  // 归档里有观测，但当期登记表没有这户：不能算成“在等家庭证明”。
  if (lifecycle.family === null) return UNFINISHED_REASONS.NOT_REGISTERED
  const { proof, window, completion } = lifecycle.stages
  if (proof.status === WAIT_STATUS.BLOCKED) return UNFINISHED_REASONS.PROOF_BLOCKED
  if (proof.status === WAIT_STATUS.INTERRUPTED) return UNFINISHED_REASONS.PROOF_INTERRUPTED
  if (![WAIT_STATUS.ZERO, WAIT_STATUS.DONE, WAIT_STATUS.SKIPPED].includes(proof.status)) {
    return UNFINISHED_REASONS.AWAITING_PROOF
  }
  if (window.status === WAIT_STATUS.INTERRUPTED || completion.status === WAIT_STATUS.INTERRUPTED) {
    return UNFINISHED_REASONS.OBSERVATION_ENDED
  }
  if (window.arrived === null) return UNFINISHED_REASONS.NOT_ARRIVED
  if (window.accepted === null) return UNFINISHED_REASONS.QUEUING
  if (!lifecycle.completed) return UNFINISHED_REASONS.IN_SERVICE
  return null
}

// 按家庭汇总，但整户与单个学生的办结分布分别给出。
export function completionReport(model, { period = null, asOf = null, channel = null } = {}) {
  const rows = model.observations.filter(row => {
    if (period !== null && row.period !== period) return false
    if (channel !== null && row.channel !== channel) return false
    return true
  })
  const cutoff = asOf ?? (period !== null
    ? model.periodCutoff(period)
    : maxDefined(rows.map(row => toMinutes(row.observed_until))))

  // 截止后受理的只供下一期：本期分布不含它们。
  const deferred = rows.filter(row => {
    const accepted = toMinutes(row.accepted)
    return accepted !== null && cutoff !== null && accepted > cutoff
  })
  const eligible = rows.filter(row => !deferred.includes(row))

  const byFamily = new Map()
  for (const row of eligible) {
    const list = byFamily.get(row.family) ?? []
    list.push(row)
    byFamily.set(row.family, list)
  }

  const studentRecords = eligible.map(row => studentOutcome(model, row, cutoff))
  const families = [...byFamily.entries()].map(([family, familyRows]) => {
    const outcomes = familyRows.map(row => studentOutcome(model, row, cutoff))
    const closed = outcomes.length > 0 && outcomes.every(item => item.completed)
    return {
      family,
      outcomes,
      closed,
      proofIds: [...new Set(familyRows.flatMap(row => model.proofIdsOf(row.app)))],
      observationCount: outcomes.length,
    }
  })

  return {
    period,
    asOf: cutoff,
    channel,
    // 独立样本按家庭计，最少样本规则以此为准。
    independentSamples: families.length,
    studentsObserved: studentRecords.length,
    familyCompletion: distribution(families.map(item => item.closed)),
    studentCompletion: distribution(studentRecords.map(item => item.completed)),
    completedFamilies: families.filter(item => item.closed).map(item => item.family),
    completedStudents: studentRecords.filter(item => item.completed).map(item => item.app),
    unfinishedReasons: summarizeReasons(studentRecords.filter(item => !item.completed)),
    zeroWait: studentRecords.filter(item => item.zeroWait).map(item => item.app),
    skipped: studentRecords.filter(item => item.skippedStep).map(item => item.app),
    interrupted: studentRecords.filter(item => item.interrupted).map(item => item.app),
    details: studentRecords,
    families,
    deferred: deferred.map(row => ({ app: row.app, accepted: toMinutes(row.accepted) })),
  }
}

function studentOutcome(model, row, cutoff) {
  const lifecycle = applicationLifecycle(model, row.app, cutoff)
  const completedAt = toMinutes(row.completed)
  const acceptedAt = toMinutes(row.accepted)
  const firstActionable = toMinutes(row.ready)
  const completed = completedAt !== null && (cutoff === null || completedAt <= cutoff)
  // 与等待分段一致：以实际到场为排队起点，没有实际到场时才退回首个可办分钟。
  const start = toMinutes(row.arrived) ?? firstActionable
  const zeroWait = completed && acceptedAt !== null && start !== null && acceptedAt - start === 0
  const interrupted = model.eventsOf(row.app).some(event => event.event === '观测中断')
    || (cutoff !== null && toMinutes(row.observed_until) !== null
      && toMinutes(row.observed_until) < cutoff && completedAt === null)
  // 只有复用他人证明才算“无需此步”；缺少可办时间不等于无需办理。
  const skippedStep = isProofReused(model, row.app)
  return {
    app: row.app,
    family: row.family,
    channel: row.channel,
    completed,
    completedAt,
    acceptedAt,
    firstActionable,
    zeroWait,
    skippedStep,
    interrupted,
    reason: classifyUnfinishedReason(lifecycle),
    proofStatus: lifecycle.stages.proof.status,
    windowStatus: lifecycle.stages.window.status,
  }
}

import { isProofReused } from './lifecycle.js'

function distribution(flags) {
  const completed = flags.filter(Boolean).length
  const total = flags.length
  return {
    total,
    completed,
    open: total - completed,
    rate: total === 0 ? null : round(completed / total, 4),
  }
}

function summarizeReasons(records) {
  const counts = new Map()
  for (const record of records) {
    const reason = record.reason ?? UNFINISHED_REASONS.UNKNOWN
    counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
}

// 首个可办时间：按入口（channel）和实际可用办理方式（mode）分别给出。
// 只统计到 cutoff 前有可核依据的观测；没有容量或没有观测的方式不冒充可办。
export function firstAvailableTimes(model, { period = null, asOf = null } = {}) {
  const cutoff = asOf ?? (period !== null
    ? model.periodCutoff(period)
    : maxDefined(model.observations.map(row => toMinutes(row.observed_until))))
  const rows = model.observations.filter(row => period === null || row.period === period)

  const byChannel = new Map()
  for (const row of rows) {
    const ready = toMinutes(row.ready)
    const list = byChannel.get(row.channel) ?? { channel: row.channel, observations: [] }
    list.observations.push({
      app: row.app,
      ready,
      arrived: toMinutes(row.arrived),
      accepted: toMinutes(row.accepted),
    })
    byChannel.set(row.channel, list)
  }
  const channels = [...byChannel.values()].map(entry => {
    const covered = entry.observations.filter(item => cutoff === null
      || (item.ready !== null && item.ready <= cutoff))
    return {
      channel: entry.channel,
      firstReady: minDefined(entry.observations.map(item => item.ready)),
      observations: entry.observations.length,
      covered: covered.length,
      // 入口口径：有多少观测在截止前就具备可办条件。
      coveredRate: entry.observations.length === 0
        ? null
        : round(covered.length / entry.observations.length, 4),
    }
  })

  // 容量按 (点, 队) 给出；shared=yes 同窗取上界而非相加。
  const capacity = model.capacity.map(row => ({
    site: row.site,
    window: row.window,
    team: row.team,
    mode: row.mode,
    slots: toMinutes(row.slots),
    shared: row.shared === 'yes',
  }))
  return { cutoff, channels, capacity }
}

// 每周月报：入口 + 实际可用办理方式的首个可办时间、整户与单个学生办结分布、未完成原因。
export function monthlyReport(model, { period = null, asOf = null } = {}) {
  const completion = completionReport(model, { period, asOf })
  const availability = firstAvailableTimes(model, { period, asOf: completion.asOf })
  return {
    period,
    asOf: completion.asOf,
    availability,
    familyCompletion: completion.familyCompletion,
    studentCompletion: completion.studentCompletion,
    unfinishedReasons: completion.unfinishedReasons,
    // 分别列出四类“看起来没办结但不是失败”的状态。
    statusBuckets: {
      zeroWait: completion.zeroWait,
      skipped: completion.skipped,
      interrupted: completion.interrupted,
      deferred: completion.deferred,
    },
    independentSamples: completion.independentSamples,
  }
}

export function rebookingReport(model, app) {
  const { timeline, releases, failed, pending } = rebookingReceipts(model, app)
  const proof = proofStage(model, app)
  return {
    app,
    timeline,
    releases,
    failed,
    pending,
    // 旧点只有在“改约接受”才真正释放；申请失败不释放，也不构成可接纳。
    blockingNote: pending.length > 0 ? '改约尚未被新点接受，旧点占用仍保留' : null,
    proofStatus: proof.status,
  }
}
