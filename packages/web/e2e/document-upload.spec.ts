import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { signUpThroughUi, signUpViaApi, testEmail, deleteUserByEmail } from './helpers'

/**
 * Document upload (SOP 02, step 1).
 *
 * Reported: selecting a 2022 1040 PDF returned "Failed to fetch" twice, with
 * nothing uploaded and no processing started.
 *
 * Uploads do not go through our API. The browser asks for a presigned URL and
 * then PUTs the file STRAIGHT TO S3, so the S3 bucket's own CORS policy has to
 * allow the site's origin. It listed the old netlify.app domain and localhost
 * but never fin.catipult.ai, so every upload from the real site was rejected
 * by the browser before a byte left the machine — surfacing only as "Failed to
 * fetch", with our API never involved and nothing to see in our logs.
 *
 * The PUT is issued from inside the page so that real CORS applies; a request
 * made from the test runner would bypass the very thing being tested and pass
 * against a broken bucket.
 *
 * Deliberately stops at the S3 PUT and does not call /register: registration
 * kicks off Textract and Gemini extraction, and a test should not spend money
 * on every run. What broke here is the transport, and that is what is covered.
 */
test.describe('document upload', () => {
  const email = testEmail('upload')

  test.afterAll(async () => {
    const r = await deleteUserByEmail(email)
    if (r === 'skipped') console.log(`NOTE: no service role key — left ${email} behind`)
  })

  test('the browser can PUT a file to S3 from the deployed origin', async ({ page }) => {
    await signUpThroughUi(page, email)
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })

    const result = await page.evaluate(async () => {
      // Same two steps the app performs, run in the page so CORS is enforced.
      const token = JSON.parse(
        localStorage.getItem(
          Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token')) || '',
        ) || '{}',
      )?.access_token

      const presignRes = await fetch('/api/documents/presign?filename=sop02-probe.pdf', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!presignRes.ok) return { stage: 'presign', status: presignRes.status }
      const presign = await presignRes.json()

      // A minimal but structurally valid PDF.
      const pdf = new Blob(
        ['%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF'],
        { type: presign.content_type },
      )

      try {
        const put = await fetch(presign.upload_url, {
          method: 'PUT',
          headers: { 'Content-Type': presign.content_type },
          body: pdf,
        })
        return { stage: 'put', status: put.status, ok: put.ok }
      } catch (e) {
        // A CORS rejection reaches JavaScript only as an opaque TypeError —
        // exactly the "Failed to fetch" a user sees, with no detail.
        return { stage: 'put', error: String(e) }
      }
    })

    expect(result.stage, `failed before the upload: ${JSON.stringify(result)}`).toBe('put')
    expect(
      result.error,
      `the browser could not PUT to S3 — the bucket's CORS policy is missing this origin: ${result.error}`,
    ).toBeUndefined()
    expect(result.ok, `S3 rejected the upload: HTTP ${result.status}`).toBe(true)
  })

  test('an uploaded document is attached to the entity and visible afterwards', async ({ page }) => {
    /*
     * The second half of the reported problem: after the transport was fixed,
     * the app said "Uploaded 2022 1040 Tax Return.pdf" and the Documents tab
     * still read "No documents uploaded yet".
     *
     * The upload hook knows which entity it is working in — it uses that id to
     * FILTER the list — but never sent it when registering the document. So
     * every upload was stored with entity_id null and then filtered out of the
     * very view that created it. The file was safe the whole time; it was
     * simply attached to nothing.
     *
     * Telling a user their tax return uploaded successfully and then not
     * showing it is the worst failure of the three, because they have no way
     * to tell whether we hold their document.
     *
     * This one DOES register, which runs extraction, so it is the only test in
     * the suite that costs anything. One small page, and it is the only way to
     * cover the attachment.
     */
    const email2 = testEmail('upload-attach')
    await signUpThroughUi(page, email2)
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 })

    // A document has nowhere to attach without an entity.
    await page.goto('/app/entities')
    await page.getByRole('button', { name: /Create Entity|New Entity|Create/ }).first().click()
    await page.getByPlaceholder('e.g. John Smith or Acme Corp').fill('Upload Test Individual')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.getByText('Upload Test Individual').first().click()

    await page.getByRole('tab', { name: /Documents/i }).click()
    await expect(page.getByText('No documents uploaded yet.')).toBeVisible()

    await page.setInputFiles('input[type="file"]', 'e2e/fixtures/sample-1040.pdf')

    // Extraction runs on register, so allow generous time.
    // exact: the success toast also contains the filename; we want the LIST row.
    await expect(page.getByText('sample-1040.pdf', { exact: true })).toBeVisible({ timeout: 90_000 })
    await expect(page.getByText('No documents uploaded yet.')).toHaveCount(0)

    // And it must SURVIVE a reload — proving it was attached, not just held
    // in local state by the component that uploaded it.
    await page.reload()
    await page.getByRole('tab', { name: /Documents/i }).click()
    await expect(page.getByText('sample-1040.pdf', { exact: true })).toBeVisible({ timeout: 30_000 })

    await deleteUserByEmail(email2)
  })
})

/**
 * Registration must answer before extraction, not after.
 *
 * Reported on SOP 02: uploading a 2023 return failed with "Unexpected 504
 * response from /api/documents/register", and the document did not appear —
 * except it had actually been stored and fully extracted. Classification and
 * a Textract job ran on the HTTP request, taking roughly 8s plus 0.85s per
 * page, and the proxy in front of the site gives up around 26s.
 *
 * Measured directly: a 20-page return took 24.8s and just survived; a 34-page
 * return returned 504 to the browser at 28.0s while the identical request
 * straight to the API returned 200 and created the document. The upload
 * succeeded and the person was told it had failed.
 *
 * The size that triggers it is a moving target, so this pins the property
 * that removes the whole class: the response comes back immediately and the
 * extraction lands afterwards. A one-page file keeps the Textract bill at one
 * page while still failing against the old behaviour, which only ever replied
 * once extraction was complete.
 */
test.describe('upload registration responds before extraction', () => {
  const email = testEmail('async-register')

  test.afterAll(async () => {
    const r = await deleteUserByEmail(email)
    if (r === 'skipped') console.log(`NOTE: no service role key — left ${email} behind`)
  })

  test('the file is stored and acknowledged without waiting for extraction', async ({ request, baseURL }) => {
    test.setTimeout(180_000)
    const token = await signUpViaApi(email)
    const auth = { Authorization: `Bearer ${token}` }

    const ent = await request.post(`${baseURL}/api/entities`, {
      headers: auth, data: { name: 'Async Register Co', form_type: '1040' },
    })
    const entityId = (await ent.json())?.entity?.id
    expect(entityId).toBeTruthy()

    const pre = await request.get(`${baseURL}/api/documents/presign?filename=async.pdf`, { headers: auth })
    const presign = await pre.json()

    const pdf = readFileSync('e2e/fixtures/sample-1040.pdf')
    const put = await request.put(presign.upload_url, {
      headers: { 'Content-Type': presign.content_type }, data: pdf,
    })
    expect(put.ok(), 'file must reach storage').toBe(true)

    const started = Date.now()
    const reg = await request.post(`${baseURL}/api/documents/register`, {
      headers: auth,
      data: { s3_key: presign.s3_key, filename: 'async.pdf', entity_id: entityId },
    })
    const elapsed = Date.now() - started
    const body = await reg.json()

    // The old behaviour answered only once Gemini and Textract had finished,
    // which is what put it over the proxy limit on a real return.
    expect(reg.status(), `register should acknowledge immediately: ${JSON.stringify(body).slice(0, 200)}`).toBe(202)
    expect(body.processing, 'response must say extraction is still running').toBe(true)
    expect(elapsed, `register took ${elapsed}ms — it must not wait for extraction`).toBeLessThan(8_000)
    expect(body.document?.id, 'the document row must exist immediately').toBeTruthy()
    expect(body.document?.processing_status).toBe('processing')

    // And it must actually finish, not sit in "processing" forever.
    const docId = body.document.id
    let status = 'processing'
    for (let i = 0; i < 40 && status === 'processing'; i++) {
      await new Promise(r => setTimeout(r, 3_000))
      const r = await request.get(`${baseURL}/api/documents/${docId}`, { headers: auth })
      status = (await r.json())?.document?.processing_status
    }
    expect(status, 'extraction must reach a terminal state').not.toBe('processing')

    await request.delete(`${baseURL}/api/entities/${entityId}`, { headers: auth })
  })
})

