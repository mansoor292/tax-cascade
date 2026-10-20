/**
 * The golden view of a return year (src/schema/golden.ts):
 *
 *   GET /api/golden/:entity_id?year=2024[&text=1]
 *
 * Every golden key with its value from each source side by side — the filed
 * return, the IRS's record of it (as filed and as the IRS recomputed it), and
 * the returns stored here (filed import, proforma, amendment) — with the
 * golden value and whether the sources agree. Amounts only unless text=1:
 * names, addresses and identification numbers stay out of the default answer.
 */
import { Router } from 'express'
import { sendError, sendDbError } from '../lib/http_error.js'
import { lazyServiceClient, requestUserId as getUser } from '../lib/supabase.js'
import { hydrate } from '../lib/row_crypto.js'
import { ENCRYPTED_RETURN_FIELDS } from '../lib/row_crypto.js'
import { loadSources } from '../catalog/store.js'
import type { CatalogSource } from '../catalog/query.js'
import { goldenRows, heldYear, summarize } from '../schema/golden.js'
import { transcriptParts } from '../catalog/transcript.js'

const supabase = lazyServiceClient()
const router = Router()

/** The year's filed return (complete preferred) and golden return transcript. */
function pick(sources: CatalogSource[], year: number) {
  const filedRet = sources.filter(s => s.kind === 'filed_return' && s.tax_year === year)
  const filed = filedRet.find(s => s.status === 'complete') ?? filedRet[0]
  const transcript = sources
    .filter(s => s.kind === 'irs_transcript' && s.tax_year === year && transcriptParts(s.transcript_type as never).includes('return'))
    .sort((a, b) => (b.as_of ?? '').localeCompare(a.as_of ?? '') || Number(a.transcript_type !== 'return') - Number(b.transcript_type !== 'return'))[0]
  return { filed, transcript }
}

router.get('/:entity_id', async (req, res) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  const year = Number(req.query.year)
  if (!Number.isInteger(year) || year < 1990 || year > 2100) return res.status(400).json({ error: 'year must be a four-digit tax year', field: 'year' })
  try {
    const { data: ent, error } = await supabase.from('tax_entity').select('id, name, form_type').eq('id', req.params.entity_id).eq('user_id', userId).maybeSingle()
    if (error) return sendDbError(res, error)
    if (!ent) return res.status(404).json({ error: 'Entity not found' })
    const sources = await loadSources(supabase, userId, ent.id, [year - 2, year - 1, year, year + 1, year + 2], ['filed_return', 'irs_transcript'])
    const { filed, transcript } = pick(sources, year)
    const byYear = new Map<number, CatalogSource['entries']>()
    for (let y = year - 2; y <= year + 2; y++) { const f = pick(sources, y).filed; if (f) byYear.set(y, f.entries) }
    const held = transcript ? heldYear(ent.form_type, year, transcript.entries, byYear) : undefined
    const { data: rets, error: e2 } = await supabase.from('tax_return')
      .select('*').eq('entity_id', ent.id).eq('tax_year', year).order('computed_at', { ascending: false })
    if (e2) return sendDbError(res, e2)
    for (const r of rets ?? []) await hydrate(supabase, r, { ...ENCRYPTED_RETURN_FIELDS, userId })
    const returns = (rets ?? []).map(r => ({ id: r.id as string, label: `${r.source ?? 'return'}${r.computed_at ? ' ' + String(r.computed_at).slice(0, 10) : ''} (${String(r.id).slice(0, 8)})`, field_values: r.field_values as Record<string, unknown> }))
    const rows = goldenRows({
      formType: ent.form_type, year, includeText: req.query.text === '1',
      ...(filed ? { filed: { id: filed.catalog_id, entries: filed.entries } } : {}),
      ...(transcript ? { transcript: { id: transcript.catalog_id, entries: transcript.entries, as_of: transcript.as_of, ...(held !== undefined ? { holdsYear: held } : {}) } } : {}),
      returns,
    })
    const order = { differs: 0, irs_only: 1, irs_recomputed: 2, agrees: 3, filed_only: 4, returns_only: 5 } as const
    rows.sort((a, b) => Number(!!b.headline) - Number(!!a.headline) || order[a.status] - order[b.status] || a.form.localeCompare(b.form) || a.key.localeCompare(b.key))
    res.json({
      entity: { id: ent.id, name: ent.name, form_type: ent.form_type }, year,
      sources: {
        filed_return: filed ? { catalog_id: filed.catalog_id, filename: filed.source_filename } : null,
        irs_return_transcript: transcript ? { catalog_id: transcript.catalog_id, type: transcript.transcript_type, as_of: transcript.as_of, ...(held !== undefined ? { holds_return_of: held, note: `The IRS has the ${held} return in the ${year} period; its figures are shown but are not golden.` } : {}) } : null,
        returns: returns.map(r => ({ id: r.id, label: r.label })),
      },
      summary: summarize(rows),
      rows,
    })
  } catch (e: any) {
    sendError(res, e)
  }
})

export default router
