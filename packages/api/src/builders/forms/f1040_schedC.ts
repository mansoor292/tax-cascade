/**
 * Schedule C and Schedule SE (Form 1040), 2025 — single-member LLCs held as
 * their own entities and linked to the owner's 1040 (owner decision
 * 2026-11-16; engine/schedule_c.ts).
 *
 * One Schedule C per linked business, printed from that business's own saved
 * Schedule C lines, which compute_return carries on the 1040's inputs
 * (`schedule_c[].field_values`, with the business's name, EIN and address).
 * The proprietor is whichever spouse the link names. Schedule SE prints from
 * the 1040's own f1040sse.* lines, for the person whose income they are.
 */
import { PDFDocument } from 'pdf-lib'
import { readFileSync } from 'fs'
import { F1040SC_2025, F1040SSE_2025 } from '../../maps/pdf_field_map_2025.js'
import { blankPath, setText, check, headerName, headerSsn, specBuilder, any, type Value } from './f1040_common.js'
import type { Attachment, AttachmentContext } from './types.js'

interface PulledC {
  name?: string
  owner?: 'taxpayer' | 'spouse'
  field_values?: Record<string, number>
  business?: { name?: string; ein?: string | null; address?: string | null; city_state_zip?: string | null; activity?: string | null; code?: string | null; accounting_method?: string | null }
}

export async function buildSchedulesC(c: AttachmentContext): Promise<Attachment[] | null> {
  if (c.formType !== '1040') return null
  const list = (Array.isArray(c.inputData?.schedule_c) ? c.inputData.schedule_c : []) as PulledC[]
  const out: Attachment[] = []
  for (const b of list) {
    if (!b?.field_values) continue
    const path = blankPath('f1040sc', c.taxYear)
    if (!path) return null
    const pdf = await PDFDocument.load(readFileSync(path))
    const form = pdf.getForm()
    const who = b.owner === 'spouse' ? 'spouse' : 'primary'
    const values: Record<string, Value> = {
      'meta.proprietor_name': headerName(c, 'f1040sc', who),
      'meta.ssn': headerSsn(c, who),
      'meta.business_activity': b.business?.activity ?? null,
      'meta.business_code': b.business?.code ?? null,
      'meta.entity_name': b.business?.name ?? b.name ?? null,
      'meta.ein': b.business?.ein ? String(b.business.ein).replace(/\D/g, '') : null,
      'meta.address': b.business?.address ?? null,
      'meta.city_state_zip': b.business?.city_state_zip ?? null,
      ...b.field_values,
    }
    let filled = 0
    for (const [key, id] of Object.entries(F1040SC_2025)) if (setText(form, id, values[key])) filled++
    const method = String(b.business?.accounting_method ?? '').toLowerCase()
    if (method === 'cash' && check(form, 'c1_1[0]')) filled++
    if (method === 'accrual' && check(form, 'c1_1[1]')) filled++
    out.push({ seq: 9, label: `Schedule C — ${b.business?.name ?? b.name ?? 'business'}`, pdf, filled })
  }
  return out.length ? out : null
}

const seFields: Record<string, string> = Object.fromEntries(
  Object.entries(F1040SSE_2025).filter(([k]) => k.startsWith('f1040sse.')).map(([k, id]) => [id, k]))

const seSpec = (who: 'primary' | 'spouse') => specBuilder({
  form: 'f1040sse', label: 'Schedule SE', seq: 17,
  when: c => any(c, 'f1040sse.L12_se_tax'),
  header: { name: F1040SSE_2025['meta.name'], ssn: F1040SSE_2025['meta.ssn'], who },
  fields: seFields,
})
const seTaxpayer = seSpec('primary'), seSpouse = seSpec('spouse')
/** The engine prints the taxpayer's Schedule SE when the taxpayer has SE income, else the spouse's. */
export async function buildScheduleSE(c: AttachmentContext): Promise<Attachment | null> {
  const owners = (Array.isArray(c.inputData?.schedule_c) ? c.inputData.schedule_c : []) as PulledC[]
  const taxpayerHasSe = Number(c.inputData?.net_se_income || 0) !== 0 || owners.some(b => (b.owner ?? 'taxpayer') === 'taxpayer')
  return (taxpayerHasSe || !owners.length ? seTaxpayer : seSpouse)(c) as Promise<Attachment | null>
}
