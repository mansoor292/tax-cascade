import { test, expect } from '@playwright/test'
import { testEmail, deleteUserByEmail, signUpViaApi, authed, createEntityViaApi } from './helpers'

/**
 * The auth guardrail, table-driven across every mounted router.
 *
 * Two invariants, one per table:
 *
 *  1. Unauthenticated → 401. Never 200 (data leak), never 5xx (crash), and
 *     never HTML (the SPA fallback swallowing an API route — the exact bug
 *     that once made /auth/api-keys return index.html with a 200).
 *  2. Account A's token against account B's resource → 404 or 403, and
 *     for writes, B's data must be unchanged afterwards.
 *
 * QBO and Stripe appear here ONLY as auth checks — their data paths need
 * external credentials and live client connections are not test targets.
 */

type M = 'get' | 'post' | 'put' | 'patch' | 'delete'

// Representative route per router × method-class. __ID__ is replaced with a
// real resource id owned by the victim account.
const UNAUTHENTICATED: Array<[M, string]> = [
  ['get',    '/api/entities'],
  ['post',   '/api/entities'],
  ['get',    '/api/entities/__ID__'],
  ['put',    '/api/entities/__ID__'],
  ['delete', '/api/entities/__ID__'],
  ['get',    '/api/returns'],
  ['post',   '/api/returns/compute'],
  ['get',    '/api/returns/compare/__ID__'],
  ['get',    '/api/documents'],
  ['get',    '/api/documents/presign?filename=x.pdf'],
  ['post',   '/api/documents/ingest'],
  ['post',   '/api/documents/fact'],
  ['get',    '/api/scenarios'],
  ['post',   '/api/scenarios'],
  ['get',    '/api/calendar'],
  ['post',   '/api/calendar/refresh'],
  ['get',    '/api/schema'],
  ['get',    '/api/scratch'],
  ['put',    '/api/scratch/somekey'],
  ['post',   '/api/intake/gap-fill'],
  ['get',    '/api/qbo/__ID__/status'],
  ['get',    '/api/qbo/__ID__/financials'],
  ['post',   '/api/qbo/__ID__/recategorize'],
  ['get',    '/api/stripe/__ID__/revenue'],
  ['get',    '/api/stripe/__ID__/status'],
]

test.describe('auth matrix', () => {
  const victimEmail = testEmail('authm-victim')
  const attackerEmail = testEmail('authm-attacker')
  let victimToken = ''
  let attackerToken = ''
  let victimEntity = ''

  test.beforeAll(async () => {
    victimToken = await signUpViaApi(victimEmail)
    attackerToken = await signUpViaApi(attackerEmail)
    victimEntity = (await createEntityViaApi(victimToken, {
      name: 'Auth Matrix Victim Entity', form_type: '1120S',
    })).id
  })

  test.afterAll(async ({ request, baseURL }) => {
    await request.delete(`${baseURL}/api/entities/${victimEntity}`, { headers: authed(victimToken) }).catch(() => {})
    await deleteUserByEmail(victimEmail)
    await deleteUserByEmail(attackerEmail)
  })

  for (const [method, path] of UNAUTHENTICATED) {
    test(`unauthenticated ${method.toUpperCase()} ${path} is a clean 401`, async ({ request, baseURL }) => {
      const res = await request[method](baseURL + path.replace('__ID__', victimEntity), {
        data: method === 'get' ? undefined : {},
      })
      expect(res.status(), 'must be 401 — not a leak, not a crash, not the SPA').toBe(401)
      const type = res.headers()['content-type'] || ''
      expect(type, 'a 401 must be JSON, not the SPA fallback').toContain('application/json')
    })
  }

  test.describe('cross-tenant: an attacker token against the victim entity', () => {
    const CASES: Array<[M, string, any?]> = [
      ['get',    '/api/entities/__ID__'],
      ['put',    '/api/entities/__ID__', { name: 'HIJACKED' }],
      ['delete', '/api/entities/__ID__'],
      ['get',    '/api/returns/compare/__ID__'],
      ['get',    '/api/qbo/__ID__/status'],
      ['get',    '/api/stripe/__ID__/status'],
      ['post',   '/api/scenarios', { name: 'x', entity_id: '__ID__', tax_year: 2024 }],
    ]

    for (const [method, path, body] of CASES) {
      test(`${method.toUpperCase()} ${path} is denied`, async ({ request, baseURL }) => {
        const res = await request[method](baseURL + path.replace('__ID__', victimEntity), {
          headers: authed(attackerToken),
          data: body ? JSON.parse(JSON.stringify(body).replace('__ID__', victimEntity)) : undefined,
        })
        expect([403, 404], `got ${res.status()} — must deny, not serve`).toContain(res.status())
      })
    }

    test('calendar refresh with a foreign entity_id generates nothing', async ({ request, baseURL }) => {
      // refresh scopes to the caller's own entities, so a foreign id is a
      // no-op rather than a 404. The invariant worth holding: zero generated,
      // nothing about the victim's calendar disclosed.
      const res = await request.post(`${baseURL}/api/calendar/refresh`, {
        headers: authed(attackerToken), data: { entity_id: victimEntity },
      })
      expect(res.status()).toBe(200)
      const body = await res.json()
      expect(body.generated ?? 0).toBe(0)
      expect(body.entities ?? 0).toBe(0)
    })

    test('after all of that, the victim entity is unchanged', async ({ request, baseURL }) => {
      const res = await request.get(`${baseURL}/api/entities/${victimEntity}`, { headers: authed(victimToken) })
      expect(res.status()).toBe(200)
      const e = (await res.json()).entity
      expect(e.name, 'the PUT above must not have landed').toBe('Auth Matrix Victim Entity')
    })
  })
})
