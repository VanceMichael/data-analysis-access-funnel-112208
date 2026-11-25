import { TABLE_NAMES } from './schema.js'
import { Model } from './model.js'
import { applicationLifecycle, familyLifecycle } from './lifecycle.js'
import { round } from './normalize.js'

// 资料自检：每张表非空、字段一致、引用能对上。
// 只报告问题，不修改原始记录。
export function submissionReport(store) {
  const issues = []
  for (const name of TABLE_NAMES) {
    const rows = store.get(name)
    if (rows.length === 0) issues.push({ table: name, issue: '表为空' })
  }

  const model = new Model(store)
  const apps = new Set(model.households.map(row => row.app))
  for (const row of model.service) {
    if (!apps.has(row.app)) {
      issues.push({ table: 'service', app: row.app, issue: '申请不在 households 中' })
    }
  }
  for (const row of model.commitments) {
    if (!apps.has(row.app)) {
      issues.push({ table: 'commitment', app: row.app, issue: '申请不在 households 中' })
    }
    if (!model.publicationByReport.has(row.report)) {
      issues.push({ table: 'commitment', report: row.report, issue: '报表不存在' })
    }
  }
  const proofIds = new Set(model.proofs.map(row => row.proof))
  for (const row of model.households) {
    for (const proofId of model.proofIdsOf(row.app)) {
      if (!proofIds.has(proofId)) {
        issues.push({ table: 'households', app: row.app, proof: proofId, issue: '证明不存在' })
      }
    }
  }
  // 预约号可能先在平台事件里出现（例如到场的 J6），再在回执里被引用。
  const reservationIds = new Set([
    ...model.receipts.map(row => row.reservation),
    ...model.service.map(row => row.reference),
  ])
  for (const row of model.receipts) {
    if (row.previous !== '?' && !reservationIds.has(row.previous)) {
      issues.push({
        table: 'queue_receipts',
        reservation: row.reservation,
        previous: row.previous,
        issue: '指向的旧预约不存在',
      })
    }
  }

  // 每户的最终状态摘要，便于运营核对。
  const families = [...new Set(model.households.map(row => row.family))].map(family => {
    const life = familyLifecycle(model, family)
    return {
      family,
      status: life.status,
      completed: `${life.completedCount}/${life.studentCount}`,
      keepOpenFor: life.keepOpenFor,
      proofUnits: life.proofUnits,
    }
  })

  return {
    ok: issues.length === 0,
    tables: Object.fromEntries(TABLE_NAMES.map(name => [name, store.get(name).length])),
    issues,
    families,
  }
}

// 一页式运营摘要：每个申请的时间线与当前卡点。
export function operationsSummary(store, { asOf = null } = {}) {
  const model = new Model(store)
  const apps = model.households.map(row => {
    const life = applicationLifecycle(model, row.app, asOf)
    return {
      app: row.app,
      family: row.family,
      student: row.student,
      proof: life.stages.proof.status,
      window: life.stages.window.status,
      completion: life.stages.completion.status,
      next: life.nextActionable,
      completed: life.completed,
    }
  })
  const families = [...new Set(model.households.map(row => row.family))].map(family => {
    const life = familyLifecycle(model, family, asOf)
    return {
      family,
      status: life.status,
      completedCount: life.completedCount,
      studentCount: life.studentCount,
      keepOpenFor: life.keepOpenFor,
    }
  })
  const completed = apps.filter(item => item.completed).length
  return {
    asOf,
    apps,
    families,
    completionRate: apps.length === 0 ? null : round(completed / apps.length, 4),
  }
}
