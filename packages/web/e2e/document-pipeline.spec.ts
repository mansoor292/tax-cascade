import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  testEmail, deleteUserByEmail, signUpViaApi, authed, createEntityViaApi, pollDocumentUntilDone,
} from './helpers'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * The full document pipeline as a permanent test — the SOP flow a client
 * actually walked: upload → classify → extract → archived under Returns.
 *
 * Tagged @spend: each run pays for one Textract page (~$0.065) and a couple
 * of Gemini flash-lite calls. `--grep-invert @spend` skips it.
 *
 * The categorize step exists here because of a real drift bug: the re-read
 * path kept its own copy of the classification prompt, which never learned
 * 1065s, so a partnership return re-read kept answering "Other". A unit test
 * pins the shared prompt; THIS pins the deployed behavior.
 */

test.describe('document pipeline @spend', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 })

  const email = testEmail('docpipe')
  let token = ''
  let entityId = ''
  let docId = ''

  test.beforeAll(async () => {
    token = await signUpViaApi(email)
    entityId = (await createEntityViaApi(token, {
      name: 'E2E Sample Partners LLC', form_type: '1065',
    })).id
  })

  test.afterAll(async ({ request, baseURL }) => {
    // Deleting the entity cascades to returns and documents.
    if (entityId) await request.delete(`${baseURL}/api/entities/${entityId}`, { headers: authed(token) }).catch(() => {})
    await deleteUserByEmail(email)
  })

  test('upload → ingest answers 202 and extraction lands in the background', async ({ request, baseURL }) => {
    const pdf = readFileSync(join(__dirname, 'fixtures/sample-1065.pdf'))

    const presign = await request.get(
      `${baseURL}/api/documents/presign?filename=sample-1065.pdf`, { headers: authed(token) })
    expect(presign.status()).toBe(200)
    const { upload_url, s3_key, content_type } = await presign.json()

    const put = await request.put(upload_url, {
      data: pdf, headers: { 'Content-Type': content_type },
    })
    expect(put.status(), 'the presigned PUT must be accepted').toBe(200)

    const t0 = Date.now()
    const ingest = await request.post(`${baseURL}/api/documents/ingest`, {
      headers: authed(token),
      data: { s3_key, filename: 'sample-1065.pdf', entity_id: entityId },
    })
    expect(ingest.status(), await ingest.text()).toBe(202)
    expect(Date.now() - t0, 'ingest must answer immediately, not after extraction').toBeLessThan(5_000)
    docId = (await ingest.json()).document.id
    expect(docId).toBeTruthy()

    const doc = await pollDocumentUntilDone(token, docId)
    expect(doc.doc_type, 'the classifier must recognize a 1065').toBe('prior_return_1065')
    expect(doc.tax_year).toBe(2023)
  })

  test('the ingested return is archived as a filed import, visible under Returns', async ({ request, baseURL }) => {
    expect(docId, 'depends on the ingest test').toBeTruthy()
    const list = await request.get(`${baseURL}/api/returns`, { headers: authed(token) })
    expect(list.status()).toBe(200)
    const rows = JSON.stringify(await list.json())
    expect(rows, 'a filed_import 1065 must exist').toContain('filed_import')
    expect(rows).toContain('1065')
  })

  test('re-categorize agrees with ingest (the prompt-drift regression)', async ({ request, baseURL }) => {
    expect(docId, 'depends on the ingest test').toBeTruthy()
    const res = await request.post(`${baseURL}/api/documents/${docId}/categorize`, {
      headers: authed(token), data: {},
    })
    expect(res.status(), await res.text()).toBe(200)
    const c = (await res.json()).classification
    expect(c.doc_type, 're-reading the same document must not answer "other"').toBe('prior_return_1065')
  })

  test('rearchive from stored extraction succeeds without new AWS spend', async ({ request, baseURL }) => {
    expect(docId, 'depends on the ingest test').toBeTruthy()
    const res = await request.post(`${baseURL}/api/documents/${docId}/rearchive`, {
      headers: authed(token), data: {},
    })
    expect(res.status(), await res.text()).toBe(200)
  })
})
