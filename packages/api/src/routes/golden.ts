/**
 * The golden view of a return year (src/schema/golden.ts):
 *
 *   GET /api/golden/:entity_id?year=2024[&text=1][&books=0]
 *
 * Every golden key with its value from each source side by side — the filed
 * return, the IRS's record of it (as filed and as the IRS recomputed it), and
 * the returns stored here (filed import, proforma, amendment), the books
 * (QuickBooks classified to return lines, before any tax computation — for
 * corporations with a QuickBooks connection; books=0 skips it) and the
 * scenarios computed for the year — with the golden value and whether the
 * sources agree. Amounts only unless text=1:
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
import { booksToGolden } from '../schema/books.js'
import { booksPacket } from '../services/books.js'
import { documentsToGolden, k1ToGolden, type DocLine } from '../schema/documents.js'
import { SUPPORTED_DOC_TYPES } from '../services/document_merge.js'
import { ENCRYPTED_DOC_FIELDS } from '../lib/row_crypto.js'
import { listLinks } from '../services/entity_map.js'

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
    // the books: only corporations have them here; a QuickBooks failure is
    // reported in sources, never fails the view
    let books: { label: string; lines: ReturnType<typeof booksToGolden>['lines'] } | undefined
    let booksSource: Record<string, unknown> | null = null
    if ((ent.form_type === '1120' || ent.form_type === '1120S') && req.query.books !== '0') {
      try {
        const b = await booksPacket(userId, ent.id, year, ent.form_type)
        if (b) {
          const v = booksToGolden(ent.form_type, b.packet)
          books = { label: `${year} books (QuickBooks, P&L as of ${b.sources.pnl_as_of ?? '?'})`, lines: v.lines }
          booksSource = { ...b.sources, lines: v.lines.length, unplaced: v.unplaced, dropped: b.packet.dropped.length, warnings: b.packet.warnings.map(w => w.code) }
        } else booksSource = { available: false, why: 'no QuickBooks P&L for the year (not connected, or no data)' }
      } catch (e: any) {
        booksSource = { available: false, why: String(e?.message ?? e).slice(0, 200) }
      }
    }
    // the source documents on file for the year, and for a 1040 the K-1s the
    // group's own S corporations issued (entity map ownership, filed catalogs)
    const { data: docRows, error: e4 } = await supabase.from('document')
      .select('*').eq('entity_id', ent.id).eq('user_id', userId).eq('tax_year', year).in('doc_type', SUPPORTED_DOC_TYPES)
    if (e4) return sendDbError(res, e4)
    for (const d of docRows ?? []) await hydrate(supabase, d, { ...ENCRYPTED_DOC_FIELDS, userId })
    const docView = documentsToGolden(ent.form_type, docRows ?? [])
    const docLines: DocLine[] = [...docView.lines]
    const k1From: string[] = []
    if (ent.form_type === '1040') {
      const hasK1Docs = (docRows ?? []).some(d => d.doc_type === 'k1')
      const links = (await listLinks(supabase, userId)).filter(l => l.kind === 'owns' && l.from_entity_id === ent.id && l.to_entity_id &&
        (!l.from_year || l.from_year <= year) && (!l.to_year || l.to_year >= year))
      for (const l of links) {
        const { data: issuer } = await supabase.from('tax_entity').select('id, name, form_type').eq('id', l.to_entity_id!).eq('user_id', userId).maybeSingle()
        if (!issuer || issuer.form_type !== '1120S') continue
        if (hasK1Docs) { docView.notes.push(`K-1 documents are on file, so ${issuer.name}'s K-1 is not added again from its return`); continue }
        if (l.pct !== null && l.pct !== undefined && l.pct < 100) { docView.notes.push(`${issuer.name}: ${l.pct}% owned — its return's K-1s are not matched to a shareholder yet`); continue }
        const src = pick(await loadSources(supabase, userId, issuer.id, [year], ['filed_return']), year).filed
        if (!src) continue
        const add = k1ToGolden(src.entries, issuer.name)
        for (const a of add) {
          const cur = docLines.find(x => x.form === a.form && x.key === a.key)
          if (cur) { cur.value += a.value; cur.sources.push(...a.sources) } else docLines.push(a)
        }
        if (add.length) k1From.push(issuer.name)
      }
    }
    const { data: scs, error: e3 } = await supabase.from('scenario')
      .select('id, name, computed_result').eq('entity_id', ent.id).eq('user_id', userId).eq('tax_year', year)
    if (e3) return sendDbError(res, e3)
    const scenarios = (scs ?? []).filter(x => x.computed_result?.field_values).map(x => ({ id: x.id as string, label: x.name as string, field_values: x.computed_result.field_values as Record<string, unknown> }))
    const rows = goldenRows({
      formType: ent.form_type, year, includeText: req.query.text === '1',
      ...(filed ? { filed: { id: filed.catalog_id, entries: filed.entries } } : {}),
      ...(transcript ? { transcript: { id: transcript.catalog_id, entries: transcript.entries, as_of: transcript.as_of, ...(held !== undefined ? { holdsYear: held } : {}) } } : {}),
      returns,
      ...(books ? { books } : {}),
      ...(docLines.length ? { documents: { label: `${year} documents on file`, lines: docLines } } : {}),
      scenarios,
    })
    const order = { differs: 0, irs_only: 1, irs_recomputed: 2, agrees: 3, filed_only: 4, returns_only: 5 } as const
    rows.sort((a, b) => Number(!!b.headline) - Number(!!a.headline) || order[a.status] - order[b.status] || a.form.localeCompare(b.form) || a.key.localeCompare(b.key))
    res.json({
      entity: { id: ent.id, name: ent.name, form_type: ent.form_type }, year,
      sources: {
        filed_return: filed ? { catalog_id: filed.catalog_id, filename: filed.source_filename } : null,
        irs_return_transcript: transcript ? { catalog_id: transcript.catalog_id, type: transcript.transcript_type, as_of: transcript.as_of, ...(held !== undefined ? { holds_return_of: held, note: `The IRS has the ${held} return in the ${year} period; its figures are shown but are not golden.` } : {}) } : null,
        returns: returns.map(r => ({ id: r.id, label: r.label })),
        books: booksSource,
        documents: { count: (docRows ?? []).length, types: [...new Set((docRows ?? []).map(d => d.doc_type))], lines: docLines.length, k1s_from_group_returns: k1From, unplaced: docView.unplaced, notes: docView.notes },
        scenarios: scenarios.map(x => ({ id: x.id, label: x.label })),
      },
      summary: summarize(rows),
      rows,
    })
  } catch (e: any) {
    sendError(res, e)
  }
})

export default router
