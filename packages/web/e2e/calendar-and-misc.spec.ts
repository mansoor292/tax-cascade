import { test, expect } from '@playwright/test'
import { testEmail, deleteUserByEmail, signUpViaApi, authed, createEntityViaApi } from './helpers'

/**
 * The supporting surfaces nothing else covers: the tax calendar's generate/
 * complete/delete cycle, the self-describing schema endpoints (clients are
 * told to read these instead of hardcoding forms), and the scratch KV store
 * the MCP server uses for context offload.
 */

test.describe('calendar obligations', () => {
  const email = testEmail('cal')
  let token = ''
  let entityId = ''

  test.beforeAll(async () => {
    token = await signUpViaApi(email)
    entityId = (await createEntityViaApi(token, { name: 'Calendar Corp', form_type: '1120S' })).id
  })
  test.afterAll(async ({ request, baseURL }) => {
    if (entityId) await request.delete(`${baseURL}/api/entities/${entityId}`, { headers: authed(token) }).catch(() => {})
    await deleteUserByEmail(email)
  })

  test('refresh generates obligations for an S-corp', async ({ request, baseURL }) => {
    const res = await request.post(`${baseURL}/api/calendar/refresh`, {
      headers: authed(token), data: { entity_id: entityId },
    })
    expect(res.status(), await res.text()).toBe(200)

    const list = await request.get(`${baseURL}/api/calendar`, { headers: authed(token) })
    expect(list.status()).toBe(200)
    const body = JSON.stringify(await list.json())
    // An 1120-S filer gets a March 15 return deadline; the generator that
    // stops producing it is the regression worth catching.
    expect(body).toMatch(/1120S|03-15|return/i)
  })

  test('a custom obligation can be created, completed, and deleted', async ({ request, baseURL }) => {
    const created = await request.post(`${baseURL}/api/calendar`, {
      headers: authed(token),
      data: { entity_id: entityId, title: 'E2E custom deadline', due_date: '2026-12-31', kind: 'other' },
    })
    expect(created.status(), await created.text()).toBeLessThan(300)
    const id = (await created.json()).obligation?.id
    expect(id).toBeTruthy()

    const done = await request.patch(`${baseURL}/api/calendar/${id}`, {
      headers: authed(token), data: { status: 'done' },
    })
    expect(done.status()).toBe(200)
    expect((await done.json()).obligation?.status).toBe('done')

    const del = await request.delete(`${baseURL}/api/calendar/${id}`, { headers: authed(token) })
    expect(del.status()).toBe(200)
  })
})

test.describe('schema endpoints', () => {
  const email = testEmail('schema')
  let token = ''
  test.beforeAll(async () => { token = await signUpViaApi(email) })
  test.afterAll(() => deleteUserByEmail(email))

  test('the schema index lists the supported forms', async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}/api/schema`, { headers: authed(token) })
    expect(res.status()).toBe(200)
    const body = JSON.stringify(await res.json())
    for (const form of ['1120S', '1120', '1040']) expect(body).toContain(form)
  })

  test('a per-form schema describes its fields', async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}/api/schema/1120S/2025`, { headers: authed(token) })
    expect(res.status(), await res.text()).toBe(200)
    const body = JSON.stringify(await res.json())
    expect(body).toContain('gross_receipts')
  })
})

test.describe('scratch KV store', () => {
  const email = testEmail('scratch')
  let token = ''
  test.beforeAll(async () => { token = await signUpViaApi(email) })
  test.afterAll(() => deleteUserByEmail(email))

  test('put → get → list → delete round-trip', async ({ request, baseURL }) => {
    const key = `e2e-${Date.now()}`
    const payload = { note: 'scratch round-trip', n: 42 }

    const put = await request.put(`${baseURL}/api/scratch/${key}`, {
      headers: authed(token), data: payload,
    })
    expect(put.status(), await put.text()).toBe(200)

    const get = await request.get(`${baseURL}/api/scratch/${key}`, { headers: authed(token) })
    expect(get.status()).toBe(200)
    expect(await get.json()).toEqual(payload)

    const list = await request.get(`${baseURL}/api/scratch`, { headers: authed(token) })
    expect(JSON.stringify(await list.json())).toContain(key)

    const del = await request.delete(`${baseURL}/api/scratch/${key}`, { headers: authed(token) })
    expect(del.status()).toBe(200)
    // Deliberately NOT a GET-after-delete: the earlier GET primed Supabase
    // Storage's CDN, and delete invalidation there can lag by a minute, so
    // the read path stays 200 long after the blob is gone. The list endpoint
    // queries the database, so it reflects the delete immediately — that is
    // the assertion that proves deletion without flaking.
    const after = await request.get(`${baseURL}/api/scratch`, { headers: authed(token) })
    expect(JSON.stringify(await after.json()), 'deleted key must leave the list').not.toContain(key)
  })
})
