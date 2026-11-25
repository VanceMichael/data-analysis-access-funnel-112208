import { createServer } from 'node:http'
import { DataStore } from './store.js'
import { Model } from './model.js'
import { ValidationError } from './schema.js'
import { applicationLifecycle, familyLifecycle } from './lifecycle.js'
import { waitBreakdown } from './waiting.js'
import { monthlyReport } from './reporting.js'
import { submissionReport, operationsSummary } from './ops.js'
import {
  checkPublication,
  compareRemoteBeforeAfter,
  dutyView,
  eligibleCustomers,
  reassignmentEstimate,
  shiftAssistance,
} from './planning.js'
import { tableReport } from './cli.js'

// 轻量 HTTP 接口，供每期运营人员提交记录与查询结论。
// 没有第三方依赖；请求体为 JSON 数组或对象。

const MAX_BODY = 5 * 1024 * 1024

export function createAppServer({ directory, store = null, persist = true } = {}) {
  let current = store
  let loading = null

  async function getStore() {
    if (current) return current
    if (!loading) loading = DataStore.load(directory).then(value => { current = value; return value })
    return loading
  }

  async function handler(request, response) {
    try {
      const url = new URL(request.url, 'http://localhost')
      const segments = url.pathname.split('/').filter(Boolean)
      const method = request.method ?? 'GET'

      if (method === 'GET' && url.pathname === '/health') {
        return send(response, 200, { ok: true })
      }
      if (method === 'GET' && url.pathname === '/tables') {
        return send(response, 200, tableReport())
      }

      const activeStore = await getStore()
      const model = new Model(activeStore)

      if (method === 'GET' && segments[0] === 'summary') {
        return send(response, 200, operationsSummary(activeStore, queryOptions(url)))
      }
      if (method === 'GET' && segments[0] === 'check') {
        return send(response, 200, submissionReport(activeStore))
      }
      if (method === 'GET' && segments[0] === 'apps' && segments[1]) {
        const asOf = queryNumber(url, 'asOf')
        return send(response, 200, {
          lifecycle: applicationLifecycle(model, segments[1], asOf),
          waiting: waitBreakdown(model, segments[1], asOf),
        })
      }
      if (method === 'GET' && segments[0] === 'families' && segments[1]) {
        return send(response, 200, familyLifecycle(model, segments[1], queryNumber(url, 'asOf')))
      }
      if (method === 'GET' && segments[0] === 'reports' && segments[1] === 'monthly') {
        return send(response, 200, monthlyReport(model, {
          period: url.searchParams.get('period'),
          asOf: queryNumber(url, 'asOf'),
        }))
      }
      if (method === 'GET' && segments[0] === 'compare') {
        return send(response, 200, compareRemoteBeforeAfter(model, {
          before: url.searchParams.get('before'),
          after: url.searchParams.get('after'),
          asOf: queryNumber(url, 'asOf'),
        }))
      }
      if (method === 'GET' && segments[0] === 'publications' && segments[1]) {
        return send(response, 200, checkPublication(model, segments[1]))
      }
      if (method === 'GET' && segments[0] === 'duty') {
        return send(response, 200, dutyView(model, {
          team: url.searchParams.get('team'),
          asOf: queryNumber(url, 'asOf'),
        }))
      }
      if (method === 'GET' && segments[0] === 'eligible') {
        return send(response, 200, eligibleCustomers(model, {
          site: url.searchParams.get('site'),
          mode: url.searchParams.get('mode') ?? '窗口',
          asOf: queryNumber(url, 'asOf'),
        }))
      }
      if (method === 'GET' && segments[0] === 'reassign') {
        return send(response, 200, reassignmentEstimate(model, {
          apps: url.searchParams.getAll('app'),
          asOf: queryNumber(url, 'asOf'),
        }))
      }
      if (method === 'GET' && segments[0] === 'shift') {
        return send(response, 200, shiftAssistance(model, {
          site: url.searchParams.get('site'),
          fromMode: url.searchParams.get('from'),
          toMode: url.searchParams.get('to'),
        }))
      }
      if (method === 'GET' && segments[0] === 'commitments') {
        return send(response, 200, dutyView(model, { asOf: queryNumber(url, 'asOf') }).commitments)
      }

      if (method === 'POST' && segments.length === 1) {
        const body = await readJson(request)
        const rows = Array.isArray(body) ? body : [body]
        const next = activeStore.clone()
        for (const row of rows) next.add(segments[0], row)
        if (persist) await next.save(directory)
        current = next
        return send(response, 201, { table: segments[0], added: rows.length, total: next.get(segments[0]).length })
      }
      if (method === 'PUT' && segments.length === 1) {
        const body = await readJson(request)
        const rows = Array.isArray(body) ? body : [body]
        const next = activeStore.clone()
        next.replace(segments[0], rows)
        if (persist) await next.save(directory)
        current = next
        return send(response, 200, { table: segments[0], rows: rows.length })
      }

      return send(response, 404, { error: '未找到该资源' })
    } catch (error) {
      if (error instanceof ValidationError) {
        return send(response, 400, { error: error.message, details: error.details })
      }
      if (error instanceof SyntaxError) {
        return send(response, 400, { error: `请求体不是合法 JSON：${error.message}` })
      }
      return send(response, 500, { error: error.message })
    }
  }

  const server = createServer(handler)
  return {
    server,
    handler,
    getStore,
    async listen(port = 0) {
      await new Promise(resolve => server.listen(port, resolve))
      return server.address().port
    },
    async close() {
      await new Promise(resolve => server.close(resolve))
    },
  }
}

function queryNumber(url, key) {
  const raw = url.searchParams.get(key)
  if (raw === null) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function queryOptions(url) {
  return { asOf: queryNumber(url, 'asOf') }
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY) {
      const error = new Error('请求体过大')
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') throw new SyntaxError('空请求体')
  return JSON.parse(text)
}

function send(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const directory = process.env.DATA_DIR ?? new URL('../data/', import.meta.url).pathname
  const port = Number(process.env.PORT ?? 3000)
  const app = createAppServer({ directory })
  app.listen(port).then(actual => {
    console.log(`access-funnel listening on http://localhost:${actual}`)
  })
}
