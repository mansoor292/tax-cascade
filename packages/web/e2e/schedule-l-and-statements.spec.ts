import { test, expect } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { testEmail, deleteUserByEmail, signUpViaApi, authed, createEntityViaApi } from './helpers'

/**
 * Read the text that actually lands on the page. Hand-rolled extraction was
 * tried first and quietly found nothing — pdf-lib's output does not keep the
 * drawn strings anywhere a regex over the bytes can reach, so a test built
 * that way passes or fails for reasons unrelated to the PDF. pdftotext is the
 * tool for this; CI installs poppler-utils.
 */
function pdfText(bytes: Buffer): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-pdf-'))
  try {
    const file = path.join(dir, 'return.pdf')
    writeFileSync(file, bytes)
    return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Two defects found on a 1120-S that was about to be filed.
 *
 * Schedule L was only ever checked line 15 against line 28. Both totals
 * routinely arrive straight from the accounting system's roll-up while only
 * some component lines get mapped, so a sheet balances in the two boxes a
 * reviewer checks first and fails to foot everywhere else. A real return had
 * equity overshoot its own line 28 by $3.96M with 15 == 28 to the dollar.
 *
 * And the other-deductions statement — the attachment Form 1120-S line 20
 * literally names — could not itemize from a compute call's detail. The
 * arrays were validated on the way in and then dropped at PDF time, so an
 * itemized return printed a single "Total:" line.
 *
 * Both are asserted against the DEPLOYED build: the unit tests pin the
 * arithmetic, this pins that production actually runs it.
 */

/** A real, correct asset side. It foots exactly and must never be flagged. */
const GOOD_SCHED_L = {
  'schedL.L1_cash_eoy_d': 520_571,
  'schedL.L6_othercurr_eoy_d': 1_577_532,
  'schedL.L10b_dep_eoy_d': 131_745,
  'schedL.L15_total_eoy_d': 2_229_848,
}

test.describe('Schedule L footing and the other-deductions statement', () => {
  const email = testEmail('schedl')
  let token = ''
  let entityId = ''

  test.beforeAll(async () => {
    token = await signUpViaApi(email)
    entityId = (await createEntityViaApi(token, {
      name: 'Schedule L Corp', form_type: '1120S', ein: '12-3456789',
    })).id
  })

  test.afterAll(async ({ request, baseURL }) => {
    if (entityId) await request.delete(`${baseURL}/api/entities/${entityId}`, { headers: authed(token) }).catch(() => {})
    await deleteUserByEmail(email)
  })

  const compute = (request: any, baseURL: string, inputs: Record<string, any>, save = false) =>
    request.post(`${baseURL}/api/returns/compute`, {
      headers: authed(token),
      data: {
        entity_id: entityId, tax_year: 2025, form_type: '1120S', save,
        inputs: {
          gross_receipts: 1_000_000, officer_compensation: 100_000,
          shareholders: [{ name: 'Owner', pct: 100 }],
          ...inputs,
        },
      },
    })

  test('a balance sheet that foots computes cleanly', async ({ request, baseURL }) => {
    const res = await compute(request, baseURL!, GOOD_SCHED_L)
    expect(res.status(), await res.text()).toBe(200)
  })

  test('components that do not add up to their own total are rejected', async ({ request, baseURL }) => {
    // The same sheet with net fixed assets subtracted a second time — the
    // figure a reviewer reported as the app's own, which the app had no way
    // to contradict because it computes no Schedule L total at all.
    const res = await compute(request, baseURL!, {
      ...GOOD_SCHED_L, 'schedL.L15_total_eoy_d': 1_966_358,
    })
    expect(res.status()).toBe(422)
    const body = await res.json()
    expect(body.error).toBe('ARITHMETIC_MISMATCH')
    const fields = body.mismatches.map((m: any) => m.field)
    expect(fields).toContain('Schedule L EOY assets')
    const assets = body.mismatches.find((m: any) => m.field === 'Schedule L EOY assets')
    expect(assets.delta).toBe(263_490)   // exactly twice the net fixed assets
  })

  test('equity that balances on line 28 but does not foot is rejected', async ({ request, baseURL }) => {
    const res = await compute(request, baseURL!, {
      ...GOOD_SCHED_L,
      'schedL.L17_mortshort_eoy_d': 4_006,
      'schedL.L18_othercurrliab_eoy_d': 1_809_278,
      'schedL.L25_retained_eoy_d': 4_376_223,
      'schedL.L28_total_eoy_d': 2_229_848,
    })
    expect(res.status()).toBe(422)
    const body = await res.json()
    expect(body.mismatches.map((m: any) => m.field))
      .toContain('Schedule L EOY liabilities + equity')
  })

  test('a partial balance sheet is left alone', async ({ request, baseURL }) => {
    // Two lines and a total: the total legitimately exceeds what was itemized.
    const res = await compute(request, baseURL!, {
      'schedL.L1_cash_eoy_d': 520_571,
      'schedL.L6_othercurr_eoy_d': 1_577_532,
      'schedL.L15_total_eoy_d': 2_229_848,
    })
    expect(res.status(), await res.text()).toBe(200)
  })

  test('the other-deductions statement itemizes what compute was given', async ({ request, baseURL }) => {
    const detail = [
      { label: 'Professional fees', amount: 92_500 },
      { label: 'Insurance', amount: 41_516 },
      { label: 'Software subscriptions', amount: 30_000 },
    ]
    const res = await compute(request, baseURL!, {
      other_deductions: 164_016,
      other_deductions_detail: detail,
      ...GOOD_SCHED_L,
    }, true)
    expect(res.status(), await res.text()).toBe(200)
    const returnId = (await res.json()).return_id
    expect(returnId).toBeTruthy()

    const pdf = await request.get(`${baseURL}/api/returns/${returnId}/pdf`, { headers: authed(token) })
    expect(pdf.status(), await pdf.text()).toBe(200)
    const { url } = await pdf.json()
    expect(url, 'PDF route must hand back a presigned URL').toBeTruthy()

    const bytes = Buffer.from(await (await request.get(url)).body())
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF')

    const text = pdfText(bytes)
    for (const { label } of detail) expect(text).toContain(label)
    expect(text).toContain('Total Other Deductions')

    // The EIN is printed in box D and on every statement page, and it is
    // stored encrypted. The PDF route selected it bare, so box D came out
    // empty and the statements read "EIN: null" on every package generated
    // after the encryption cutover.
    expect(text).toContain('12-3456789')
    expect(text).not.toContain('EIN: null')
  })
})
