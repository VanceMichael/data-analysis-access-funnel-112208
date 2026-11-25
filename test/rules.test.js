import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { DataStore, storeFromObject } from '../src/store.js'
import { Model } from '../src/model.js'
import {
  WAIT_STATUS,
  applicationLifecycle,
  classifyWait,
  familyLifecycle,
  occupiedReservations,
  preservedArrivalFacts,
  proofStage,
  rebookingReceipts,
} from '../src/lifecycle.js'
import { timeSavedByRemote, waitBreakdown } from '../src/waiting.js'
import { completionReport, monthlyReport, UNFINISHED_REASONS } from '../src/reporting.js'
import {
  channelEvidenceChange,
  checkPublication,
  commitmentForApp,
  compareRemoteBeforeAfter,
  dutyView,
  eligibleCustomers,
  reassignmentEstimate,
  shiftAssistance,
} from '../src/planning.js'
import { submissionReport } from '../src/ops.js'

const dataUrl = name => new URL(`../data/${name}.json`, import.meta.url)

async function fixtureStore() {
  const names = ['households', 'proofs', 'service', 'capacity', 'publication', 'commitment', 'period_observations', 'queue_receipts']
  const object = {}
  for (const name of names) object[name] = JSON.parse(await readFile(dataUrl(name), 'utf8'))
  return storeFromObject(object)
}

const store = await fixtureStore()
const model = new Model(store)

test('资料引用自检通过', () => {
  const report = submissionReport(store)
  assert.equal(report.ok, true, JSON.stringify(report.issues))
})

test('真实零等待只给在首个可办分钟即受理的申请', () => {
  // A3：ready=2，实际 1 分钟到场、4 分钟受理，不是零等待。
  const a3 = applicationLifecycle(model, 'A3', 60)
  assert.equal(a3.stages.window.status, WAIT_STATUS.DONE)
  assert.equal(a3.stages.window.wait, 3)

  const synthetic = storeFromObject({
    ...blankTables(),
    households: [row.household('H9', 'S9', 'A9', 'K9', 'R1')],
    proofs: [row.proof('K9', '1', '有效', '窗口')],
    period_observations: [{
      period: 'W1', family: 'H9', app: 'A9', region: 'R1', channel: '窗口',
      ready: '5', arrived: '5', accepted: '5', completed: '9', observed_until: '20',
    }],
  })
  const zero = applicationLifecycle(new Model(synthetic), 'A9', 20)
  assert.equal(zero.stages.window.status, WAIT_STATUS.ZERO)
  assert.equal(zero.stages.window.wait, 0)
})

test('计划预约时间不能当作开始等待，实际到场与受理才是事实', () => {
  // A2 只有预约/改约，没有到场。等待必须保持未完成，不能用 19 或 30 起算。
  const a2 = waitBreakdown(model, 'A2', 50)
  const toArrival = a2.segments.find(item => item.key === 'toArrival')
  assert.equal(toArrival.status, WAIT_STATUS.UNFINISHED)
  assert.equal(toArrival.censored, 38) // 50 - 首个可办 12
  const queue = a2.segments.find(item => item.key === 'queue')
  assert.equal(queue.status, WAIT_STATUS.UNKNOWN)
  assert.equal(a2.arrived, null)
})

test('跨点改派保留原到达与实际受理时间', () => {
  const facts = preservedArrivalFacts(model, 'A2')
  // A2 尚无实际到达；计划预约只作参考，不替代事实。
  assert.equal(facts.arrival, null)
  assert.equal(facts.accepted, null)
  assert.deepEqual(facts.plannedOnly.map(item => item.site), ['校甲', '校乙', '校乙'])

  // A1 的到场与受理来自归档。
  const a1 = preservedArrivalFacts(model, 'A1')
  assert.equal(a1.arrival, 21)
  assert.equal(a1.accepted, 22)
})

test('被撤销的共用证明堵住未办妥的关联申请，撤销前的办结仍可复核', () => {
  const a1 = applicationLifecycle(model, 'A1', 60)
  // A1 在 22 受理、27 办结，撤销发生在 37，故仍为完成。
  assert.equal(a1.completed, true)
  assert.equal(a1.stages.proof.shielded, true)
  assert.equal(a1.stages.proof.revokedAt, 37)

  const a2 = applicationLifecycle(model, 'A2', 60)
  assert.equal(a2.stages.proof.status, WAIT_STATUS.BLOCKED)
  assert.equal(a2.completed, false)
  assert.equal(a2.nextActionable.stage, 'proof')
})

test('撤销发生在业务确认之后才保护；确认之前撤销则堵住', () => {
  const synthetic = storeFromObject({
    ...blankTables(),
    households: [
      row.household('HF', 'S1', 'AX', 'KX', 'R1'),
      row.household('HF', 'S2', 'AY', 'KX', 'R1'),
    ],
    proofs: [
      row.proof('KX', '5', '有效', '远程'),
      row.proof('KX', '10', '撤销', '远程'),
    ],
    service: [
      row.service('AX', '11', '校甲', '受理', 'JX'),
    ],
  })
  const life = new Model(synthetic)
  // AX 的受理(11)晚于撤销(10)，不获保护。
  assert.equal(proofStage(life, 'AX', 30).status, WAIT_STATUS.BLOCKED)
  // AY 是复用方，没有自身签署事件，同样被堵。
  assert.equal(proofStage(life, 'AY', 30).status, WAIT_STATUS.BLOCKED)
})

test('两个孩子只有一份结果时不关闭整户', () => {
  const family = familyLifecycle(model, 'H1', 60)
  assert.equal(family.studentCount, 2)
  assert.equal(family.completedCount, 1)
  assert.equal(family.closed, false)
  assert.deepEqual(family.keepOpenFor, ['A2'])
  assert.equal(family.proofUnits, 1) // 共用一份证明，只算一个独立证据单位
})

test('复用家庭证明的第二个孩子标记为无需此步', () => {
  const proof = model.proofs.filter(row => row.proof === 'K1')
  assert.equal(proof.length, 2)
  // A1 发起签署，A2 复用。
  const a1 = proofStage(model, 'A1', 60)
  const a2 = proofStage(model, 'A2', 20)
  assert.equal(a1.reused, false)
  assert.equal(a2.reused, true)
})

test('状态有真实零等待、尚未走完、观测中断、无需此步，分别对待', () => {
  const a3 = applicationLifecycle(model, 'A3', 60) // 窗口签署，无需预审
  assert.equal(a3.stages.proof.status, WAIT_STATUS.ZERO)
  assert.equal(a3.stages.window.arrived, 1)

  const a4 = applicationLifecycle(model, 'A4', 50) // 到场但未受理，观察止点 50
  assert.equal(a4.stages.window.status, WAIT_STATUS.UNFINISHED)
  assert.equal(a4.completed, false)

  const a5 = applicationLifecycle(model, 'A5', 50) // 观测中断
  assert.equal(a5.stages.window.status, WAIT_STATUS.INTERRUPTED)

  const a2 = applicationLifecycle(model, 'A2', 20) // 复用证明 = 签署步骤无需此步
  assert.equal(a2.stages.proof.reused, true)
})

test('观测中断不产生一个伪造的已办结等待', () => {
  const breakdown = waitBreakdown(model, 'A5', 60)
  const queue = breakdown.segments.find(item => item.key === 'queue')
  assert.equal(queue.status, WAIT_STATUS.UNFINISHED)
  assert.equal(queue.minutes, null)
  assert.equal(breakdown.completed, null)
  // 中断后不能把 19 分钟当成已完成的排队。
  assert.equal(breakdown.totalMeasured === null || breakdown.totalMeasured === 0, true)
})

test('中断前已记录的受理仍是既成事实，可复算该段等待', () => {
  // 即使之后观测中断，已发生的受理不能被改成“中断”。
  const classified = classifyWait({
    start: 10,
    accepted: 16,
    observedUntil: 30,
    asOf: 40,
    interrupted: true,
  })
  assert.equal(classified.status, WAIT_STATUS.DONE)
  assert.equal(classified.wait, 6)
})

test('截止后受理的记录只供下一期', () => {
  const synthetic = storeFromObject({
    ...blankTables(),
    households: [row.household('H8', 'S8', 'A8', 'K8', 'R1')],
    proofs: [row.proof('K8', '2', '有效', '远程')],
    period_observations: [{
      period: 'W1', family: 'H8', app: 'A8', region: 'R1', channel: '远程',
      ready: '2', arrived: '3', accepted: '45', completed: '?', observed_until: '30',
    }],
  })
  const report = completionReport(new Model(synthetic), { period: 'W1', asOf: 30 })
  // 受理 45 晚于截至 30，只供下一期。
  assert.deepEqual(report.deferred, [{ app: 'A8', accepted: 45 }])
  assert.equal(report.studentCompletion.total, 0)
  assert.deepEqual(report.completedStudents, [])
})

test('整户与单个学生的办结分布分别给出', () => {
  const report = completionReport(model, { period: 'W1', asOf: 50 })
  // H1 两个孩子只办结一个：整户未办结，但学生层面已办结 2 个。
  assert.equal(report.familyCompletion.total, 4)
  assert.equal(report.familyCompletion.completed, 1)
  assert.equal(report.studentCompletion.total, 5)
  assert.equal(report.studentCompletion.completed, 2)
  assert.equal(report.independentSamples, 4) // 按家庭计，不是按申请计
})

test('未完成原因区分证明撤销、排队、断报与中断', () => {
  const report = completionReport(model, { period: 'W1', asOf: 50 })
  const reasons = new Map(report.unfinishedReasons.map(item => [item.reason, item.count]))
  assert.equal(reasons.get(UNFINISHED_REASONS.PROOF_BLOCKED), 1)
  assert.equal(reasons.get(UNFINISHED_REASONS.QUEUING), 1)
  assert.equal(reasons.get(UNFINISHED_REASONS.PROOF_INTERRUPTED), 1)
})

test('归档有观测但不在当期登记表的家庭，不误报为等待证明', () => {
  const report = completionReport(model, { period: 'W0', asOf: 60 })
  const reasons = new Map(report.unfinishedReasons.map(item => [item.reason, item.count]))
  assert.equal(reasons.get(UNFINISHED_REASONS.NOT_REGISTERED), 1)
  assert.equal(reasons.get(UNFINISHED_REASONS.AWAITING_PROOF) ?? 0, 0)
})

test('月报按入口给出首个可办时间与状态分桶', () => {
  const report = monthlyReport(model, { period: 'W1', asOf: 50 })
  const channels = new Map(report.availability.channels.map(item => [item.channel, item]))
  assert.equal(channels.get('远程').firstReady, 12)
  assert.equal(channels.get('窗口').firstReady, 2)
  assert.deepEqual(report.statusBuckets.interrupted, ['A5'])
  assert.deepEqual(report.statusBuckets.skipped.sort(), ['A2'])
})

test('远程开放前后比较以共享证明为单位，同一家庭不算两份证据', () => {
  const synthetic = storeFromObject({
    ...blankTables(),
    households: [
      row.household('HP', 'S1', 'P1', 'KP', 'R1'),
      row.household('HP', 'S2', 'P2', 'KP', 'R1'),
    ],
    proofs: [row.proof('KP', '4', '有效', '远程')],
    period_observations: [
      { period: 'W1', family: 'HP', app: 'P1', region: 'R1', channel: '远程', ready: '4', arrived: '10', accepted: '14', completed: '20', observed_until: '30' },
      { period: 'W1', family: 'HP', app: 'P2', region: 'R1', channel: '远程', ready: '4', arrived: '12', accepted: '16', completed: '22', observed_until: '30' },
    ],
  })
  const comparison = compareRemoteBeforeAfter(new Model(synthetic), { before: 'W0', after: 'W1' })
  // 两个孩子共用 KP，独立单位只有 1 份证明。
  assert.equal(comparison.independentAfter, 1)
  const cluster = comparison.clusters.find(item => item.proof === 'KP')
  assert.equal(cluster.after.count, 2)
  assert.equal(cluster.after.families.length, 1)
})

test('被改派的人估值时区分已知准备状态与未成熟结局', () => {
  const estimates = reassignmentEstimate(model, { asOf: 40 })
  const a2 = estimates.find(item => item.app === 'A2')
  assert.equal(a2.matureOutcome, false)
  assert.equal(a2.pendingOutcome, true)
  assert.equal(a2.knownReadiness.proofStatus, WAIT_STATUS.BLOCKED)
  assert.match(a2.note, /结局尚未成熟/)
})

test('协助时段切给窗口时不假设名额兼顾两边', () => {
  const shift = shiftAssistance(model, { site: '校甲', fromMode: '远程', toMode: '窗口' })
  assert.equal(shift.feasible, true)
  // 校甲同一 team 同窗 shared=yes：名额是同一批人，净增为 0。
  assert.equal(shift.shared, true)
  assert.equal(shift.netNewCapacity, 0)
  assert.equal(shift.from.after, shift.to.after)
})

test('不同点的容量不被当作共享', () => {
  const shift = shiftAssistance(model, { site: '校乙', fromMode: '窗口', toMode: '远程' })
  assert.equal(shift.feasible, false)
})

test('跨点再预约由新点接受后才释放旧点占用', () => {
  const receipts = rebookingReceipts(model, 'A2')
  const release = receipts.releases[0]
  assert.equal(release.previous, 'J2')
  assert.equal(release.releasedAt, 42)
  assert.equal(release.site, '校乙')

  // 在 42 之前，旧点校甲仍被占用。
  const before = occupiedReservations(model, 41)
  assert.ok(before.some(item => item.app === 'A2' && item.site === '校甲'))
  const after = occupiedReservations(model, 43)
  assert.ok(!after.some(item => item.app === 'A2' && item.site === '校甲'))
  assert.ok(after.some(item => item.app === 'A2' && item.site === '校乙'))
})

test('申请失败不释放旧点，也不构成可接纳客群', () => {
  const eligible = eligibleCustomers(model, { site: '校乙', asOf: 50 })
  const a5 = eligible.excluded.find(item => item.app === 'A5')
  assert.ok(a5)
  assert.ok(a5.reasons.some(reason => reason.includes('跨点改约失败')))
  assert.ok(!eligible.eligible.some(item => item.app === 'A5'))
})

test('拟议客群必须当前可进入流程，不用失败与提前退出填充', () => {
  const eligible = eligibleCustomers(model, { site: '校乙', asOf: 50 })
  assert.deepEqual(eligible.eligible.map(item => item.app), ['A4'])
  assert.ok(!eligible.eligible.some(item => item.app === 'A2')) // 证明撤销
  assert.ok(!eligible.eligible.some(item => item.app === 'A3')) // 已办结
})

test('承诺核对：按公开规则检查观察覆盖与办结上界', () => {
  const report = checkPublication(model, 'R01')
  assert.equal(report.channel, '远程')
  assert.equal(report.maxMinutes, 40)
  // 按独立家庭计样本，W1 远程有两个家庭。
  assert.equal(report.familySamples, 2)
  assert.equal(report.withinLimit, true)
  assert.equal(report.state, '已送')
  assert.equal(report.ok, true)
  // 各期分开核对，不把 W0 与 W1 混成一个样本。
  assert.equal(report.periods.length, 1)
  assert.equal(report.periods[0].period, 'W1')
})

test('截止前未办结的观测让上界无法完全核对', () => {
  const report = checkPublication(model, 'R01')
  assert.deepEqual(report.periods[0].incomplete, ['A2', 'A4'])
  // 覆盖的最小样本按家庭计，不以办结条数充数。
  assert.equal(report.periods[0].familySamples, 2)
})

test('样本不足时不能对外承诺', () => {
  const report = checkPublication(model, 'R03')
  assert.equal(report.sampleShortfall, true)
  assert.equal(report.ok, false)
  assert.ok(report.periods[0].familySamples < 3)
})

test('未签发报表不能对外承诺', () => {
  const report = checkPublication(model, 'R03')
  assert.equal(report.state, '待签')
  assert.equal(report.ok, false)
  assert.match(report.reason, /尚未签发/)
})

test('改派不能把既有预约换成新期限', () => {
  const commitment = commitmentForApp(model, 'A2', { reassignedTo: '校乙' })
  assert.equal(commitment.deadline, 55)
  assert.equal(commitment.preservedDeadline, 55)
  assert.match(commitment.note, /沿用原承诺期限/)
})

test('资料更正停掉后续新承诺，既有预约显示风险，其他渠道照常', () => {
  const change = channelEvidenceChange(model, '远程', { corrected: true })
  assert.equal(change.stopNewCommitments, true)
  assert.deepEqual(change.atRisk.sort(), ['A2'])
  assert.ok(change.otherChannelsUnaffected.some(item => item.channel === '窗口'))
})

test('值班组按实际队列统计未完成人数', () => {
  const view = dutyView(model, { asOf: 50 })
  const queues = new Map(view.byQueue.map(item => [item.key, item.count]))
  // A2 尚未到场，仍在远程/平台一侧；A4、A5 已到各自窗口。
  assert.equal(queues.get('校乙/远程'), 1)
  assert.equal(queues.get('校丙/窗口'), 1)
  assert.equal(queues.get('校甲/窗口'), 1)
  assert.equal(view.unfinished.length, 3)
})

test('调人先损及的是观测覆盖事实', () => {
  const view = dutyView(model, { team: 'E1' })
  const remote = view.riskOfReallocation.find(item => item.mode === '远程')
  const window = view.riskOfReallocation.find(item => item.mode === '窗口')
  assert.match(remote.firstThingLost, /远程线路的观察覆盖/)
  assert.match(window.firstThingLost, /排队/)
  // shared=yes 同窗取上界，不相加。
  assert.equal(remote.effectiveSlots, 3)
  assert.equal(window.effectiveSlots, 4)
})

test('换一批家庭和日历后规则仍然成立', () => {
  // 另一批合成家庭：换名字、换时间、换站点，验证没有写死。
  const synthetic = storeFromObject({
    ...blankTables(),
    households: [
      row.household('F1', 'X1', 'B1', 'M1', 'Z1'),
      row.household('F1', 'X2', 'B2', 'M1', 'Z1'),
      row.household('F2', 'X3', 'B3', 'M2', 'Z2'),
    ],
    proofs: [
      row.proof('M1', '6', '有效', '远程'),
      row.proof('M1', '50', '撤销', '远程'),
      row.proof('M2', '9', '断报', '远程'),
    ],
    service: [row.service('B1', '15', '新站', '受理', 'Q1')],
    capacity: [row.capacity('新站', '10-30', 'F9', '窗口', '6', 'no')],
    period_observations: [
      { period: 'V1', family: 'F1', app: 'B1', region: 'Z1', channel: '远程', ready: '6', arrived: '14', accepted: '15', completed: '40', observed_until: '60' },
      { period: 'V1', family: 'F1', app: 'B2', region: 'Z1', channel: '远程', ready: '6', arrived: '?', accepted: '?', completed: '?', observed_until: '60' },
      { period: 'V1', family: 'F2', app: 'B3', region: 'Z2', channel: '远程', ready: '9', arrived: '20', accepted: '28', completed: '?', observed_until: '45' },
    ],
  })
  const other = new Model(synthetic)
  const family = familyLifecycle(other, 'F1', 60)
  assert.equal(family.closed, false)
  assert.equal(family.keepOpenFor.length, 1)
  assert.equal(applicationLifecycle(other, 'B1', 60).completed, true)
  assert.equal(applicationLifecycle(other, 'B2', 60).stages.proof.status, WAIT_STATUS.BLOCKED)
  assert.equal(applicationLifecycle(other, 'B3', 45).stages.proof.status, WAIT_STATUS.INTERRUPTED)
  const report = monthlyReport(other, { period: 'V1', asOf: 45 })
  assert.ok(report.studentCompletion.total >= 1)
  const shift = shiftAssistance(other, { site: '新站', fromMode: '窗口', toMode: '远程' })
  assert.equal(shift.feasible, false) // 该点没有远程容量
})

test('远程签署让第二个孩子少等一次窗口排队', () => {
  const saved = timeSavedByRemote(model, 'H1')
  assert.equal(saved.proofUnits, 1)
  assert.ok(saved.reusedChildren >= 0)
  assert.ok(saved.estimatedMinutesSaved > 0)
  assert.match(saved.caveat, /不是 2 份独立证据|不是 \d+ 份独立证据/)
})

function blankTables() {
  return {
    households: [], proofs: [], service: [], capacity: [],
    publication: [], commitment: [], period_observations: [], queue_receipts: [],
  }
}

const row = {
  household: (family, student, app, proof, region) => ({ family, student, app, proof, region }),
  proof: (proof, at, status, mode) => ({ proof, at, status, mode }),
  service: (app, at, site, event, reference) => ({ app, at, site, event, reference }),
  capacity: (site, window, team, mode, slots, shared) => ({ site, window, team, mode, slots, shared }),
}
