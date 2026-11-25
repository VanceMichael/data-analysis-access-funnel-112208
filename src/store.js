import { readFile, writeFile } from 'node:fs/promises'
import { TABLE_NAMES, validateRows, validateSubmission } from './schema.js'

// 一期运营的原始记录集合。store 只负责存取与校验，不解释业务含义。
export class DataStore {
  constructor(tables = {}) {
    this.tables = {}
    for (const name of TABLE_NAMES) {
      this.tables[name] = tables[name] ? structuredClone(tables[name]) : []
    }
  }

  get(name) {
    const rows = this.tables[name]
    if (!rows) throw new Error(`未知的来源表：${name}`)
    return rows
  }

  replace(name, rows) {
    validateSubmission(name, rows)
    this.tables[name] = structuredClone(rows)
    return this
  }

  add(name, row) {
    validateSubmission(name, [row])
    this.tables[name].push(structuredClone(row))
    return this
  }

  clone() {
    return new DataStore(this.tables)
  }

  static async load(directory, { readJson = defaultReadJson } = {}) {
    const tables = {}
    for (const name of TABLE_NAMES) {
      const rows = await readJson(`${directory.replace(/\/$/, '')}/${name}.json`)
      validateRows(name, rows)
      tables[name] = rows
    }
    return new DataStore(tables)
  }

  async save(directory, { writeJson = defaultWriteJson } = {}) {
    const base = directory.replace(/\/$/, '')
    for (const name of TABLE_NAMES) {
      validateSubmission(name, this.tables[name])
      await writeJson(`${base}/${name}.json`, this.tables[name])
    }
    return this
  }
}

async function defaultReadJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function defaultWriteJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

// 从已解析的对象构造，便于测试和导入。
export function storeFromObject(object) {
  const tables = {}
  for (const name of TABLE_NAMES) {
    const rows = object[name] ?? []
    validateRows(name, rows)
    tables[name] = rows
  }
  return new DataStore(tables)
}
