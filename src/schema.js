import { isUnknown } from './normalize.js'

// 每张来源表的字段集合。运营人员提交记录时以这里为准：
// 字段必须完全一致（不允许多列、少列或改名），值一律是字符串。
export const TABLE_SPECS = Object.freeze({
  households: {
    columns: ['family', 'student', 'app', 'proof', 'region'],
  },
  proofs: {
    columns: ['proof', 'at', 'status', 'mode'],
  },
  service: {
    columns: ['app', 'at', 'site', 'event', 'reference'],
  },
  capacity: {
    columns: ['site', 'window', 'team', 'mode', 'slots', 'shared'],
  },
  publication: {
    columns: ['report', 'channel', 'max_minutes', 'min_sample', 'as_of', 'state'],
  },
  commitment: {
    columns: ['app', 'accepted', 'deadline', 'report'],
  },
  period_observations: {
    columns: [
      'period',
      'family',
      'app',
      'region',
      'channel',
      'ready',
      'arrived',
      'accepted',
      'completed',
      'observed_until',
    ],
  },
  queue_receipts: {
    columns: ['reservation', 'app', 'site', 'at', 'kind', 'previous'],
  },
})

export const TABLE_NAMES = Object.freeze(Object.keys(TABLE_SPECS))

export class ValidationError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ValidationError'
    this.details = details
  }
}

function sameKeys(left, right) {
  return left.length === right.length && left.every((key, index) => key === right[index])
}

export function validateRows(table, rows) {
  const spec = TABLE_SPECS[table]
  if (!spec) {
    throw new ValidationError(`未知的来源表：${table}`, { table })
  }
  if (!Array.isArray(rows)) {
    throw new ValidationError(`${table} 必须是记录数组`, { table })
  }
  rows.forEach((row, index) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new ValidationError(`${table}[${index}] 必须是对象`, { table, index })
    }
    const keys = Object.keys(row)
    if (!sameKeys(keys, spec.columns)) {
      throw new ValidationError(
        `${table}[${index}] 的字段必须依次为 ${spec.columns.join(', ')}，实际为 ${keys.join(', ')}`,
        { table, index, expected: spec.columns, actual: keys },
      )
    }
    for (const column of spec.columns) {
      if (typeof row[column] !== 'string') {
        throw new ValidationError(
          `${table}[${index}].${column} 必须以字符串保存（缺少来源时写 "?"）`,
          { table, index, column },
        )
      }
    }
  })
  return rows
}

// 提交校验比读取校验更严格：标识字段不允许为 "?"，数值字段必须可解释。
const REQUIRED_IDENTITY = {
  households: ['family', 'student', 'app', 'proof', 'region'],
  proofs: ['proof', 'status', 'mode'],
  service: ['app', 'site', 'event', 'reference'],
  capacity: ['site', 'window', 'team', 'mode', 'shared'],
  publication: ['report', 'channel', 'max_minutes', 'min_sample', 'as_of', 'state'],
  commitment: ['app', 'accepted', 'deadline', 'report'],
  period_observations: ['period', 'family', 'app', 'region', 'channel', 'observed_until'],
  // previous 允许为 "?"：表示这条预约没有前序预约。
  queue_receipts: ['reservation', 'app', 'site', 'kind'],
}

const NUMERIC_FIELDS = {
  proofs: ['at'],
  service: ['at'],
  capacity: ['slots'],
  publication: ['max_minutes', 'min_sample', 'as_of'],
  commitment: ['accepted', 'deadline'],
  period_observations: ['ready', 'arrived', 'accepted', 'completed', 'observed_until'],
  queue_receipts: ['at'],
}

const ALLOWED_VALUES = {
  proofs: { status: ['有效', '撤销', '断报'] },
  capacity: { shared: ['yes', 'no'] },
  publication: { state: ['已送', '待签', '停用'] },
  queue_receipts: { kind: ['待接受', '已接受', '申请失败'] },
}

export function validateSubmission(table, rows) {
  validateRows(table, rows)
  const identity = REQUIRED_IDENTITY[table] ?? []
  rows.forEach((row, index) => {
    for (const column of identity) {
      if (isUnknown(row[column])) {
        throw new ValidationError(`${table}[${index}].${column} 不能为空`, { table, index, column })
      }
    }
    for (const column of NUMERIC_FIELDS[table] ?? []) {
      if (isUnknown(row[column])) continue
      if (!/^-?\d+(\.\d+)?$/.test(row[column])) {
        throw new ValidationError(
          `${table}[${index}].${column} 必须为数字字符串或 "?"`,
          { table, index, column, value: row[column] },
        )
      }
    }
    const allowed = ALLOWED_VALUES[table] ?? {}
    for (const [column, values] of Object.entries(allowed)) {
      if (!values.includes(row[column])) {
        throw new ValidationError(
          `${table}[${index}].${column} 必须为 ${values.join('/')} 之一`,
          { table, index, column, value: row[column] },
        )
      }
    }
  })
  return rows
}
