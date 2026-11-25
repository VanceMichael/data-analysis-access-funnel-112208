import assert from 'node:assert/strict'
import { mkdtemp, copyFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { test, before, after } from 'node:test'

import { createAppServer } from '../src/server.js'

const dataDir = fileURLToPath(new URL('../data/', import.meta.url))
let directory
let app
let base

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'access-funnel-'))
  for (const file of await readdir(dataDir)) {
    if (file.endsWith('.json')) await copyFile(join(dataDir, file), join(directory, file))
  }
  app = createAppServer({ directory, persist: true })
  const port = await app.listen(0)
  base = `http://127.0.0.1:${port}`
})

after(async () => {
  await app.close()
})

async function get(path) {
  const response = await fetch(`${base}${path}`)
  return { status: response.status, body: await response.json() }
}

async function send(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

test('健康检查', async () => {
  const result = await get('/health')
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { ok: true })
})

test('查询单个申请返回生命周期与等待分段', async () => {
  const result = await get('/apps/A1?asOf=60')
  assert.equal(result.status, 200)
  assert.equal(result.body.lifecycle.completed, true)
  assert.ok(result.body.waiting.segments.some(segment => segment.key === 'queue'))
})

test('未登记申请不会崩溃，返回无法判断', async () => {
  const result = await get('/apps/NOPE')
  assert.equal(result.status, 200)
  assert.equal(result.body.lifecycle.stages.proof.status, 'unknown')
})

test('月报与比较可查询', async () => {
  const month = await get('/reports/monthly?period=W1&asOf=50')
  assert.equal(month.status, 200)
  assert.equal(month.body.studentCompletion.total, 5)
  const compare = await get('/compare?before=W0&after=W1')
  assert.equal(compare.status, 200)
  assert.equal(compare.body.unit, 'proof')
})

test('提交的新记录参与后续查询', async () => {
  const created = await send('POST', '/queue_receipts', {
    reservation: 'J9',
    app: 'A4',
    site: '校甲',
    at: '33',
    kind: '已接受',
    previous: '?',
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.added, 1)

  // 新记录显示 A4 在别处仍占用排队，因此不再计入校乙的可接纳客群。
  const eligible = await get('/eligible?site=校乙&asOf=50')
  assert.equal(eligible.status, 200)
  const excluded = eligible.body.excluded.find(item => item.app === 'A4')
  assert.ok(excluded)
  assert.ok(excluded.reasons.some(reason => reason.includes('校甲')))
})

test('非法字段被拒绝并给出可读原因', async () => {
  const bad = await send('POST', '/queue_receipts', {
    reservation: 'J10',
    app: 'A1',
  })
  assert.equal(bad.status, 400)
  assert.ok(bad.body.error.includes('字段'))
})

test('未知资源返回 404', async () => {
  const result = await get('/nope')
  assert.equal(result.status, 404)
})

test('写入后重新从磁盘加载仍然一致', async () => {
  const check = await get('/check')
  assert.equal(check.status, 200)
  assert.equal(check.body.ok, true)
})
