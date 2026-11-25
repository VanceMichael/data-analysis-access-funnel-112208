import { TABLE_NAMES, TABLE_SPECS } from './schema.js'
import { DataStore } from './store.js'
import { Model } from './model.js'
import { applicationLifecycle, familyLifecycle } from './lifecycle.js'
import { waitBreakdown } from './waiting.js'
import { monthlyReport } from './reporting.js'
import {
  checkPublication,
  compareRemoteBeforeAfter,
  dutyView,
  eligibleCustomers,
  reassignmentEstimate,
  shiftAssistance,
} from './planning.js'

// 运营人员每期提交记录、核对等待、比较方案、决定承诺的入口。
// 除 submit 外所有命令只读取数据目录，不写回。

export function usage() {
  return [
    '用法：node src/cli.js <命令> [参数]',
    '',
    '命令：',
    '  check                                   校验资料可读取、引用一致',
    '  tables                                  打印各来源表字段规范',
    '  app <申请号> [--as-of N]                 单个申请的阶段、等待分段、卡点',
    '  family <家庭号> [--as-of N]              整户视图（一个孩子办结不关闭整户）',
    '  month [--period W1] [--as-of N]         每周月报：首个可办时间、办结分布、未完成原因',
    '  compare --before W0 --after W1         远程开放前后比较（以共用证明为单位）',
    '  shift --site 校甲 --from 远程 --to 窗口    把一个协助时段从一边切给另一边',
    '  eligible --site 校乙 [--as-of N]         当前真正可进入流程的客群',
    '  reassign [--app A2] [--as-of N]         被改派人的已知准备状态与未成熟结局',
    '  publication <报表号>                     按公开规则核对观察覆盖与办结上界',
    '  commitments [--channel 远程]             承诺清单与失约风险',
    '  duty [--team E1] [--as-of N]            值班组视图：实际队列与调人风险',
    '  submit <表名> <文件.json>                校验并写回一期原始记录',
  ].join('\n')
}

export function parseArgs(argv) {
  const [command, ...rest] = argv
  const positional = []
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const key = token.slice(2)
    const value = rest[index + 1]
    if (value === undefined || value.startsWith('--')) {
      options[key] = true
    } else {
      options[key] = value
      index += 1
    }
  }
  return { command, positional, options }
}

export function tableReport() {
  return TABLE_NAMES.map(name => ({ table: name, columns: [...TABLE_SPECS[name].columns] }))
}

function numberOption(options, key) {
  const value = options[key]
  if (value === undefined || value === true) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function dispatch({ command, positional, options }, model) {
  const asOf = numberOption(options, 'as-of')
  switch (command) {
    case 'app':
      return {
        lifecycle: applicationLifecycle(model, positional[0], asOf),
        waiting: waitBreakdown(model, positional[0], asOf),
      }
    case 'family':
      return familyLifecycle(model, positional[0], asOf)
    case 'month':
      return monthlyReport(model, { period: options.period ?? null, asOf })
    case 'compare':
      return compareRemoteBeforeAfter(model, {
        before: options.before,
        after: options.after,
        asOf,
      })
    case 'shift':
      return shiftAssistance(model, {
        site: options.site,
        fromMode: options.from,
        toMode: options.to,
      })
    case 'eligible':
      return eligibleCustomers(model, {
        site: options.site,
        mode: options.mode ?? '窗口',
        asOf,
      })
    case 'reassign':
      return reassignmentEstimate(model, {
        apps: positional[0] ? [positional[0]] : null,
        asOf,
      })
    case 'publication':
      return checkPublication(model, positional[0])
    case 'commitments':
      return dutyView(model, { asOf }).commitments
        .filter(item => !options.channel || item.channel === options.channel)
    case 'duty':
      return dutyView(model, { team: options.team ?? null, asOf })
    case 'check':
      return model.store.tables
    default:
      return null
  }
}

export async function run(argv, { directory = new URL('../data/', import.meta.url).pathname, write = console.log } = {}) {
  const parsed = parseArgs(argv)
  const { command } = parsed
  if (!command || command === 'help' || command === '--help') {
    write(usage())
    return 0
  }
  if (command === 'tables') {
    write(JSON.stringify(tableReport(), null, 2))
    return 0
  }
  if (command === 'submit') {
    return submit(parsed.positional, directory, write)
  }
  if (!['app', 'family', 'month', 'compare', 'shift', 'eligible', 'reassign',
    'publication', 'commitments', 'duty', 'check'].includes(command)) {
    write(`未知命令：${command}\n\n${usage()}`)
    return 1
  }
  const store = await DataStore.load(directory)
  const model = new Model(store)
  const result = command === 'check'
    ? await checkStore(store)
    : dispatch(parsed, model)
  write(JSON.stringify(result, null, 2))
  return 0
}

async function submit(positional, directory, write) {
  const [table, file] = positional
  if (!table || !file) {
    write('用法：submit <表名> <文件.json>')
    return 1
  }
  const { readFile } = await import('node:fs/promises')
  const store = await DataStore.load(directory)
  const rows = JSON.parse(await readFile(file, 'utf8'))
  store.replace(table, rows)
  await store.save(directory)
  write(JSON.stringify({ table, rows: store.get(table).length, saved: true }, null, 2))
  return 0
}

async function checkStore(store) {
  const { submissionReport } = await import('./ops.js')
  return submissionReport(store)
}

// 允许直接 `node src/cli.js ...` 运行。
if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2))
    .then(code => { process.exitCode = code })
    .catch(error => {
      console.error(error.stack ?? String(error))
      process.exitCode = 1
    })
}
