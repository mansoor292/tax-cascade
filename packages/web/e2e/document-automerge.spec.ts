import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import path, { dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
import {
  testEmail, deleteUserByEmail, signUpViaApi, createEntityViaApi, authed,
} from './helpers'

/**
 * Document → compute auto-merge, end to end through the REAL pipeline
 * (S3, Gemini classification, Textract, encrypted persistence, compute).
 *
 * Pins the hydrate bug an SOP-04 tester hit: post-encryption-cutover the
 * document meta/textract_data plaintext columns are null, and the compute
 * auto-merge read them bare — every uploaded document contributed zero
 * key_values and "the documents uploaded do not populate". The extraction
 * had worked all along; the values sat unread in meta_enc.
 *
 * Spends ~$0.07/run on Textract+Gemini and takes ~1-2 min — the price of
 * testing the path users actually take.
 */

const BASE = process.env.BASE_URL || 'https://fin.catipult.ai'

async function pollDoc(token: string, docId: string, timeoutMs = 240_000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await fetch(`${BASE}/api/documents/${docId}`, { headers: authed(token) })
    const doc: any = ((await res.json().catch(() => null)) as any)?.document ?? null
    if (doc?.processing_status === 'done') return doc
    if (doc?.processing_status === 'failed') throw new Error(`extraction failed: ${doc.processing_error}`)
    if (Date.now() > deadline) throw new Error('document still processing')
    await new Promise(r => setTimeout(r, 5_000))
  }
}

test.describe('uploaded documents populate compute (auto-merge, encrypted rows)', () => {
  test.describe.configure({ timeout: 360_000 })
  const email = testEmail('automerge')
  let token = ''
  let entityId = ''

  test.beforeAll(async () => {
    token = await signUpViaApi(email)
    entityId = (await createEntityViaApi(token, { name: 'Automerge Person', form_type: '1040' })).id
  })
  test.afterAll(() => deleteUserByEmail(email))

  test('a real W-2 upload fills wages and withholding at compute time', async () => {
    const pdf = readFileSync(path.join(__dirname, 'fixtures', 'sample-w2.pdf'))
    const ingest = await fetch(`${BASE}/api/documents/ingest`, {
      method: 'POST',
      headers: { ...authed(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'sample-w2.pdf', base64: pdf.toString('base64'), entity_id: entityId }),
    })
    expect(ingest.status, await ingest.clone().text()).toBe(202)
    const docId = ((await ingest.json()) as any).document.id

    const doc = await pollDoc(token, docId)
    expect(doc.doc_type).toBe('w2')
    expect(doc.tax_year).toBe(2024)

    const compute = await fetch(`${BASE}/api/returns/compute`, {
      method: 'POST',
      headers: { ...authed(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity_id: entityId, tax_year: 2024, form_type: '1040',
        inputs: { filing_status: 'single' }, save: false, new_row: true,
      }),
    })
    expect(compute.ok, await compute.clone().text()).toBe(true)
    const body: any = await compute.json()
    const merged: any[] = body?.supporting_documents?.auto_merged || []
    const wages = merged.find(m => m.field === 'wages')
    const withholding = merged.find(m => m.field === 'withholding')
    expect(wages, `auto_merged was: ${JSON.stringify(merged)}`).toBeTruthy()
    expect(wages.value).toBe(12346)
    expect(withholding?.value).toBe(2345)
  })
})
