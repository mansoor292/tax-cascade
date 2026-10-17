/**
 * /api/facts over real HTTP, with the database replaced by an in-memory fake.
 *
 * Route handlers in this package have historically had no tests ("a green run
 * does not validate changes there"), so this one exercises the parts that are
 * the route's own job: who may call, whose entity it is, and refusing writes
 * the registry does not allow — with the status codes a client (and Claude,
 * through the MCP tools) acts on. The gap logic itself is covered in
 * services/facts.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const h = vi.hoisted(() => {
  const fixtures: Record<string, Array<Record<string, any>>> = {
    tax_entity: [
      { id: 'e1', name: 'S Co', form_type: '1120S', user_id: 'u1' },
      { id: 'e2', name: 'Someone else', form_type: '1120S', user_id: 'u2' },
    ],
    document: [
      { id: 'd1', user_id: 'u1' },
      { id: 'd2', user_id: 'u2' },
    ],
    tax_fact: [],
  }
  const writes: Array<{ table: string; op: string; payload: any }> = []
  const client = {
    from(table: string) {
      const state = { op: 'select', eqs: [] as Array<[string, unknown]>, single: false, payload: undefined as any }
      const b: any = {}
      b.select = () => b
      b.eq = (col: string, val: unknown) => { state.eqs.push([col, val]); return b }
      for (const m of ['is', 'in', 'or', 'order']) b[m] = () => b
      b.maybeSingle = () => { state.single = true; return b }
      b.single = () => { state.single = true; return b }
      b.insert = (row: any) => { state.op = 'insert'; state.payload = row; return b }
      b.update = (patch: any) => { state.op = 'update'; state.payload = patch; return b }
      b.then = (resolve: any, reject: any) => {
        let data: any
        if (state.op === 'insert') {
          writes.push({ table, op: 'insert', payload: state.payload })
          data = { id: 'new-fact', recorded_at: '2026-10-17T12:00:00Z', superseded_by: null, ...state.payload }
        } else if (state.op === 'update') {
          writes.push({ table, op: 'update', payload: state.payload })
          data = []
        } else {
          const rows = (fixtures[table] || []).filter(r => state.eqs.every(([c, v]) => r[c] === v))
          data = state.single ? (rows[0] ?? null) : rows
        }
        return Promise.resolve({ data, error: null }).then(resolve, reject)
      }
      return b
    },
  }
  return { client, writes }
})

vi.mock('../lib/supabase.js', () => ({
  lazyServiceClient: () => h.client,
  // The /api auth middleware sets req.userId; the test stands in for it.
  requestUserId: (req: any) => req.headers['x-test-user'] || null,
}))

let server: Server
let base = ''

beforeAll(async () => {
  delete process.env.TAX_API_KMS_KEY
  const { default: factRoutes } = await import('./facts.js')
  const app = express()
  app.use(express.json())
  app.use('/api/facts', factRoutes)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

async function call(method: string, path: string, opts: { user?: string; body?: any } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.user) headers['x-test-user'] = opts.user
  const resp = await fetch(`${base}${path}`, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
  return { status: resp.status, body: await resp.json() as any }
}

describe('GET /api/facts/:entity_id/gaps', () => {
  it('requires a caller', async () => {
    expect((await call('GET', '/api/facts/e1/gaps?year=2024')).status).toBe(401)
  })

  it('requires a year', async () => {
    const r = await call('GET', '/api/facts/e1/gaps', { user: 'u1' })
    expect(r.status).toBe(400)
    expect(r.body.field).toBe('year')
  })

  it('answers 404 for an entity the caller does not own', async () => {
    expect((await call('GET', '/api/facts/e2/gaps?year=2024', { user: 'u1' })).status).toBe(404)
  })

  it('refuses an unsupported form type', async () => {
    expect((await call('GET', '/api/facts/e1/gaps?year=2024&form_type=990', { user: 'u1' })).status).toBe(400)
  })

  it('returns the full list for the entity\'s return type', async () => {
    const r = await call('GET', '/api/facts/e1/gaps?year=2024', { user: 'u1' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ entity_id: 'e1', form_type: '1120S', tax_year: 2024 })
    expect(r.body.gaps.length).toBe(r.body.summary.total)
    expect(r.body.summary.missing).toBeGreaterThan(30)
    expect(r.body.gaps.map((g: any) => g.key)).toContain('scorp.election_effective_date')
  })
})

describe('GET /api/facts/:entity_id', () => {
  it('lists the caller\'s facts and refuses a bad year', async () => {
    expect((await call('GET', '/api/facts/e1?year=2024', { user: 'u1' })).body).toMatchObject({ entity_id: 'e1', facts: [] })
    expect((await call('GET', '/api/facts/e1?year=24', { user: 'u1' })).status).toBe(400)
    expect((await call('GET', '/api/facts/e2', { user: 'u1' })).status).toBe(404)
  })
})

describe('POST /api/facts', () => {
  const good = {
    entity_id: 'e1', fact_key: 'scorp.election_effective_date', value: '2021-10-25',
    status: 'answered', source: 'document', source_note: 'IRS CP261',
  }

  it('requires a caller and an owned entity', async () => {
    expect((await call('POST', '/api/facts', { body: good })).status).toBe(401)
    expect((await call('POST', '/api/facts', { user: 'u1', body: { ...good, entity_id: 'e2' } })).status).toBe(404)
  })

  it('refuses keys outside the registry, or for another return type', async () => {
    const unknown = await call('POST', '/api/facts', { user: 'u1', body: { ...good, fact_key: 'scorp.election' } })
    expect(unknown.status).toBe(400)
    expect(unknown.body.similar).toContain('scorp.election_effective_date')
    expect(unknown.body.ok).toBeUndefined()
    const wrongForm = await call('POST', '/api/facts', {
      user: 'u1', body: { ...good, fact_key: 'k1.material_participation', tax_year: 2024, subject: 'S Co', value: 'test_1_over_500_hours' },
    })
    expect(wrongForm.status).toBe(400)
  })

  it('refuses a value of the wrong type', async () => {
    const r = await call('POST', '/api/facts', { user: 'u1', body: { ...good, value: '10/25/2021' } })
    expect(r.status).toBe(400)
    expect(r.body.field).toBe('value')
  })

  it('refuses evidence that is not the caller\'s document', async () => {
    const r = await call('POST', '/api/facts', { user: 'u1', body: { ...good, evidence_document_id: 'd2' } })
    expect(r.status).toBe(400)
    expect(r.body.field).toBe('evidence_document_id')
  })

  it('records a valid answer under the caller, and never echoes user_id', async () => {
    const before = h.writes.length
    const r = await call('POST', '/api/facts', { user: 'u1', body: { ...good, evidence_document_id: 'd1' } })
    expect(r.status).toBe(200)
    expect(r.body.fact).toMatchObject({ id: 'new-fact', fact_key: 'scorp.election_effective_date', value: '2021-10-25', tax_year: null })
    expect(r.body.fact).not.toHaveProperty('user_id')
    expect(r.body.superseded).toEqual([])
    const insert = h.writes.slice(before).find(w => w.op === 'insert')!
    expect(insert.payload).toMatchObject({ user_id: 'u1', entity_id: 'e1', recorded_by: 'user:u1', evidence_document_id: 'd1' })
  })
})

describe('mounting', () => {
  it('server.ts mounts /api/facts ahead of the SPA fallback', () => {
    const src = readFileSync(fileURLToPath(new URL('../server.ts', import.meta.url)), 'utf8')
    const mount = src.indexOf("app.use('/api/facts', factRoutes)")
    const fallback = src.indexOf("app.get('*'")
    expect(mount).toBeGreaterThan(0)
    expect(fallback).toBeGreaterThan(mount)
  })
})
