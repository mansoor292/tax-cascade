import { test, expect } from '@playwright/test'
import { testEmail, deleteUserByEmail, signUpViaApi } from './helpers'

/**
 * The unhappy paths.
 *
 * Every bug found on SOPs 01 and 02 was reported by a person hitting an
 * ordinary path we had never exercised. This file exercises the OTHER half
 * on purpose: missing required fields, malformed ids, wrong types — the
 * input a real form, a stale link, or an LLM tool call actually produces.
 *
 * Two rules, applied to every endpoint:
 *
 *  1. No 5xx. A 500 says the SERVER broke, which for a caller (including
 *     Claude driving the MCP tools) means "retry" — so bad input that
 *     answers 500 invites an infinite retry of the same bad input.
 *  2. No database internals in the response. Column names, constraint
 *     names and PostgREST syntax leaked to any authenticated caller, and
 *     they tell a user nothing they can act on.
 */

const DB_LEAK = /violates|invalid input syntax|relation "|column "|constraint|duplicate key|PGRST|syntax error at/i
const CRASH = /Cannot read propert|undefined is not|is not a function|TypeError|ReferenceError/i

const FAKE = '00000000-0000-0000-0000-000000000000'
const JUNK = 'not-a-uuid'

test.describe('API robustness against malformed input', () => {
  const email = testEmail('robust')
  let token = ''
  let entityId = ''

  test.beforeAll(async ({ request, baseURL }) => {
    token = await signUpViaApi(email)
    const res = await request.post(`${baseURL}/api/entities`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: 'Robustness Entity', form_type: '1040' },
    })
    entityId = (await res.json())?.entity?.id
    expect(entityId, 'setup: entity must be created').toBeTruthy()
  })

  test.afterAll(async ({ request, baseURL }) => {
    if (entityId) {
      await request.delete(`${baseURL}/api/entities/${entityId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    }
    await deleteUserByEmail(email)
  })

  // [label, method, path, body?]
  const PROBES: Array<[string, 'get' | 'post' | 'put' | 'patch' | 'delete', string, any?]> = [
    // Missing required fields — what an LLM or a partly-filled form sends.
    ['create entity with no form_type', 'post', '/api/entities', { name: 'No Form' }],
    ['create entity with nothing', 'post', '/api/entities', {}],
    ['create scenario with nothing', 'post', '/api/scenarios', {}],
    ['compute with nothing', 'post', '/api/returns/compute', {}],
    ['compute with an unknown form', 'post', '/api/returns/compute', { entity_id: '__ENTITY__', tax_year: 2024, form_type: '9999' }],
    ['record a fact with nothing', 'post', '/api/documents/fact', {}],
    ['create an obligation with nothing', 'post', '/api/calendar', {}],
    ['register a document with nothing', 'post', '/api/documents/register', {}],
    ['gap-fill with nothing', 'post', '/api/intake/gap-fill', {}],
    ['file an extension with nothing', 'post', '/api/returns/extension', {}],

    // Malformed and absent ids — a stale bookmark, an id an LLM invented.
    ['get an entity by junk id', 'get', `/api/entities/${JUNK}`],
    ['update an entity by junk id', 'put', `/api/entities/${JUNK}`, { name: 'x' }],
    ['delete an entity by junk id', 'delete', `/api/entities/${JUNK}`],
    ['get a return by junk id', 'get', `/api/returns/${JUNK}`],
    ['pdf a return by junk id', 'get', `/api/returns/${JUNK}/pdf`],
    ['pdf a return that does not exist', 'get', `/api/returns/${FAKE}/pdf`],
    ['compare by junk entity', 'get', `/api/returns/compare/${JUNK}`],
    ['compute a scenario by junk id', 'post', `/api/scenarios/${JUNK}/compute`, {}],
    ['patch an obligation by junk id', 'patch', `/api/calendar/${JUNK}`, { status: 'done' }],
    ['download a document by junk id', 'get', `/api/documents/${JUNK}/download`],
    ['rearchive a document by junk id', 'post', `/api/documents/${JUNK}/rearchive`, {}],
    ['qbo status for a junk entity', 'get', `/api/qbo/${JUNK}/status`],
    ['qbo reports for a junk entity', 'get', `/api/qbo/${JUNK}/reports`],
    ['qbo financials for a junk entity', 'get', `/api/qbo/${JUNK}/financials`],
    ['stripe revenue for a junk entity', 'get', `/api/stripe/${JUNK}/revenue`],
    ['schema for an unknown form', 'get', '/api/schema/9999/2024'],
    ['presign with no filename', 'get', '/api/documents/presign'],
  ]

  for (const [label, method, path, body] of PROBES) {
    test(`${label} is answered, not crashed`, async ({ request, baseURL }) => {
      const url = baseURL + path.replace('__ENTITY__', entityId)
      const data = body ? JSON.parse(JSON.stringify(body).replace('__ENTITY__', entityId)) : undefined
      const res = await request[method](url, {
        headers: { Authorization: `Bearer ${token}` },
        ...(data !== undefined ? { data } : {}),
      })
      const text = await res.text()

      expect(res.status(), `${label} -> ${res.status()}: ${text.slice(0, 200)}`).toBeLessThan(500)
      expect(DB_LEAK.test(text), `leaked database internals: ${text.slice(0, 200)}`).toBe(false)
      expect(CRASH.test(text), `unhandled crash surfaced: ${text.slice(0, 200)}`).toBe(false)
    })
  }

  /**
   * The one that mattered most. A digit string in a numeric field turned the
   * income summation from addition into concatenation, so wages of $150,000
   * produced an AGI of $150 trillion — HTTP 200, no warning, saved.
   */
  test('a numeric field given a string does not inflate the return', async ({ request, baseURL }) => {
    const compute = (wages: unknown) =>
      request.post(`${baseURL}/api/returns/compute`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { entity_id: entityId, tax_year: 2024, form_type: '1040', inputs: { wages, filing_status: 'single' } },
      })

    const asNumber = await (await compute(150000)).json()
    const asString = await (await compute('150000')).json()

    expect(asString.computed?.agi, 'a digit string must compute the same as the number')
      .toBe(asNumber.computed?.agi)
    expect(asString.computed?.total_tax).toBe(asNumber.computed?.total_tax)
    expect(asString.computed?.agi).toBe(150000)
  })

  test('a numeric field given a word is refused rather than computed', async ({ request, baseURL }) => {
    const res = await request.post(`${baseURL}/api/returns/compute`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { entity_id: entityId, tax_year: 2024, form_type: '1040', inputs: { wages: 'lots', filing_status: 'single' } },
    })
    expect(res.status(), 'nonsense input must be a 400, not a 200 or a 500').toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/wages/i)
  })
})
