import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  testEmail, deleteUserByEmail, signUpViaApi, signInThroughUi, authed, createEntityViaApi, pollDocumentUntilDone,
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

  test('the document list strips Textract blobs and ciphertext (MCP-size contract)', async ({ request, baseURL }) => {
    // list_documents through the Claude connector 502'd when this strip
    // silently regressed (a lint sweep rewrote `{ textract_data: _td }` into
    // `{ _textract_data }`, which strips a nonexistent key): 1.1 MB for 7
    // documents instead of ~30 KB, and the connector gateway refused the
    // oversized tool result. The contract: summaries in, blobs and
    // ciphertext out, unless ?full=1 is asked for.
    expect(docId, 'depends on the ingest test').toBeTruthy()
    const res = await request.get(`${baseURL}/api/documents`, { headers: authed(token) })
    expect(res.status()).toBe(200)
    const body = await res.text()
    const docs = JSON.parse(body).documents
    const mine = docs.find((d: any) => d.id === docId)
    expect(mine.textract_summary, 'the summary must replace the blob').toBeTruthy()
    expect(mine.textract_summary.kv_count).toBeGreaterThan(0)
    expect(body, 'no raw Textract payloads in the list').not.toContain('"textract_data"')
    expect(body, 'no ciphertext columns in the list').not.toContain('_enc"')
    expect(body.length, 'a stripped list stays connector-sized').toBeLessThan(200_000)
  })

  test('rearchive from stored extraction succeeds without new AWS spend', async ({ request, baseURL }) => {
    expect(docId, 'depends on the ingest test').toBeTruthy()
    const res = await request.post(`${baseURL}/api/documents/${docId}/rearchive`, {
      headers: authed(token), data: {},
    })
    expect(res.status(), await res.text()).toBe(200)
  })
})

/**
 * The amendment flow @spend — pins the 1040-X bug: an amended return used to
 * classify as a plain 1040 and archive as a DUPLICATE filed_import for the
 * same year (two "filed" returns, no supersedes link, Amendment column stuck
 * on "Create"). Reported on SOP 02 with a real 1040-X.
 */
test.describe('amendment pipeline @spend', () => {
  test.describe.configure({ mode: 'serial', timeout: 420_000 })

  const email = testEmail('amend')
  let token = ''
  let entityId = ''

  test.beforeAll(async () => {
    token = await signUpViaApi(email)
    entityId = (await createEntityViaApi(token, {
      name: 'E2E Amendment Sample', form_type: '1040',
    })).id
  })
  test.afterAll(async ({ request, baseURL }) => {
    if (entityId) await request.delete(`${baseURL}/api/entities/${entityId}`, { headers: authed(token) }).catch(() => {})
    await deleteUserByEmail(email)
  })

  async function upload(request: any, baseURL: string, file: string): Promise<string> {
    const pdf = readFileSync(join(__dirname, 'fixtures', file))
    const presign = await request.get(`${baseURL}/api/documents/presign?filename=${file}`, { headers: authed(token) })
    const { upload_url, s3_key, content_type } = await presign.json()
    const put = await request.put(upload_url, { data: pdf, headers: { 'Content-Type': content_type } })
    expect(put.status()).toBe(200)
    const ingest = await request.post(`${baseURL}/api/documents/ingest`, {
      headers: authed(token), data: { s3_key, filename: file, entity_id: entityId },
    })
    expect(ingest.status(), await ingest.text()).toBe(202)
    return (await ingest.json()).document.id
  }

  test('the original 1040 archives as a filed import', async ({ request, baseURL }) => {
    const docId = await upload(request, baseURL as string, 'sample-1040-2023.pdf')
    const doc = await pollDocumentUntilDone(token, docId)
    expect(doc.doc_type).toBe('prior_return_1040')
    expect(doc.tax_year).toBe(2023)
  })

  test('the 1040-X classifies as an amendment and links to the original', async ({ request, baseURL }) => {
    const docId = await upload(request, baseURL as string, 'sample-1040x-2023.pdf')
    const doc = await pollDocumentUntilDone(token, docId)
    expect(doc.doc_type, 'a 1040-X must not classify as a plain 1040').toBe('prior_return_1040x')
    expect(doc.tax_year).toBe(2023)

    const list = await request.get(`${baseURL}/api/returns`, { headers: authed(token) })
    const rows: any[] = (await list.json()).returns || []
    const y2023 = rows.filter(r => r.tax_year === 2023 && r.form_type === '1040')
    const filed = y2023.filter(r => r.source === 'filed_import')
    const amendments = y2023.filter(r => r.source === 'amendment')

    expect(filed, 'exactly ONE originally-filed 2023 return — no duplicate').toHaveLength(1)
    expect(amendments, 'the 1040-X must archive as an amendment').toHaveLength(1)
    expect(amendments[0].is_amended).toBe(true)
    expect(amendments[0].supersedes_id, 'the amendment must supersede the original').toBe(filed[0].id)
  })

  test('Compare vs Filed shows unrestated lines as "not restated", not changes to zero', async ({ page }) => {
    // The 1040-X fixture restates AGI/taxable/total tax but NOT wages. The
    // filed return's wages must not appear as a -$50,000 "change" — that is
    // the false-amendment bug reported on a real 1040-X ($259k of W-2 wages
    // shown as removed).
    await signInThroughUi(page, email)
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })
    await page.goto(`/app/compare/${entityId}?year=2023`)

    await expect(page.getByText(/not restated/i).first(), 'unrestated lines must be labeled').toBeVisible({ timeout: 30_000 })
    const body = await page.locator('table').first().innerText()
    expect(body, 'no fabricated -$50,000 wages change').not.toMatch(/-\$50,000/)
  })
})
