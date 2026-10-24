/**
 * Filed, and accepted, for each year of one entity — what the Returns tab,
 * the Dashboard and the calendar show.
 *
 * FILED: a filed return is on file here — a catalogued filed PDF or a
 * filed_import row. Until 2026-10-22 only the row counted, so the returns
 * catalogued through MCP (the group's three 2025 returns, filed 10/14) read
 * as unfiled on the Returns tab while Compare and the Group map showed the
 * filed PDF.
 *
 * ACCEPTED: the IRS's own record confirms it — the year's account transcript
 * carries a TC150, and the return the IRS processed in that period is this
 * year's. It stays false until a transcript says so (Mansoor, 2026-10-22:
 * "until transcripts confirm, keep it false"), and is false when the IRS
 * posted another year's return in this period, or this return in another
 * period (EZA's 2024 return sat in the 2025 period while the 2024 period
 * held the 2023 return).
 *
 * Computed on read from the catalogued transcripts, never stored: a stored
 * flag would go stale the day a new transcript is uploaded.
 *
 * AMENDMENTS (Mansoor, 2026-10-23): an amendment is filed once the signed
 * amended return is uploaded to it (POST /api/returns/:id/filed, which sets
 * the row's status to 'filed' and catalogues the copy as 'amended_return'),
 * or when it came in as a filed 1040-X. It is accepted once the year's account
 * transcript shows the IRS processed an amended return (TC977): the first
 * TC977 accepts the first amendment filed, the second the second.
 */
import type { CatalogView, EntityInfo } from './types.js'
import { buildContext } from './context.js'
import { filed, transcript, returnTranscript, transactions, transcriptValue, noRecord, iso } from './lookup.js'
import { postedFrom, dueDates } from './checks/irs.js'
import { heldYear } from '../schema/golden.js'
import { actionOf } from '../taxnow/codes.js'

export interface StoredReturnRow { id: string; tax_year: number; source: string; form_type: string; computed_at?: string | null; status?: string | null; filed_at?: string | null }

/** One filed amendment of the year: when it was recorded as filed, its copy, and the IRS's word on it */
export interface AmendmentFiling {
  return_id: string
  filed_at: string | null
  copy: null | { catalog_id: string; document_id?: string | null; filename?: string | null }
  accepted: boolean
  accepted_why: string
}

export interface YearFiling {
  tax_year: number
  /** How the filed return is on file: a catalogued PDF, an imported row, or both */
  filed: null | { via: 'catalog' | 'import'; catalog_id?: string; filename?: string | null; return_id?: string }
  accepted: boolean
  /** Why accepted is what it is, in words a person can check against the transcript */
  accepted_why: string
  transcript_as_of?: string | null
  /** This year's return was posted by the IRS in another year's period */
  posted_in?: number
  /** This year's period holds another year's return */
  holds_return_of?: number
  extended: boolean
  due: string
  extended_due: string
  /** The year's filed amendments, the first filed first */
  amendments?: AmendmentFiling[]
}

/** Filed amendments of one year, each accepted by a TC977 in filing order. */
function amendmentFilings(catalogs: CatalogView[], rows: StoredReturnRow[], year: number, t: CatalogView | undefined, asOf: string | null): AmendmentFiling[] {
  const filedRows = rows.filter(r => r.tax_year === year && r.source === 'amendment' && r.status === 'filed')
    .sort((a, b) => String(a.filed_at ?? a.computed_at ?? '').localeCompare(String(b.filed_at ?? b.computed_at ?? '')))
  // An amended return posts as TC977, or as TC976 worded "Amended return
  // filed" (beside TC976 "Duplicate return filed"; taxnow/codes.ts actionOf).
  const tc977 = transactions(t).filter(x => x.code === '977' || (x.code === '976' && actionOf('976', x.label) === 'amended_return'))
  const dated = asOf ? `, transcript dated ${asOf}` : ''
  return filedRows.map((r, i) => {
    const cat = catalogs.find(c => c.kind === 'amended_return' && c.return_id === r.id)
    const hit = tc977[i]
    const why = !t ? `No ${year} IRS account transcript on file yet — upload one to confirm`
      : hit ? `TC${hit.code} (amended return processed) on the ${year} account transcript${hit.date ? ` (${hit.date})` : ''}${dated}`
      : tc977.length ? `The ${year} transcript${asOf ? ` dated ${asOf}` : ''} shows ${tc977.length} amended return${tc977.length === 1 ? '' : 's'} processed (TC977); this is amendment ${i + 1} filed here`
      : `The ${year} transcript${asOf ? ` dated ${asOf}` : ''} shows no amended return processed yet (no TC977)`
    return {
      return_id: r.id, filed_at: r.filed_at ?? null,
      copy: cat ? { catalog_id: cat.id, document_id: cat.document_id ?? null, filename: cat.source_filename ?? null } : null,
      accepted: !!hit, accepted_why: why,
    }
  })
}

function asOfOf(t: CatalogView | undefined): string | null {
  if (!t) return null
  const v = transcriptValue(t, 'Header', /^Response Date$/i)?.value ?? transcriptValue(t, 'Header', /^Request Date$/i)?.value
  return (typeof v === 'string' && v) ? v : (t.as_of ?? null)
}

/** The year whose return the IRS processed in `year`'s period, when it is not
 *  `year`'s own: read from the return transcript's headline figures, else
 *  from the account transcript's taxable income. */
function heldIn(entity: EntityInfo, catalogs: CatalogView[], year: number, today: Date): number | undefined {
  const rt = returnTranscript(catalogs, year)
  if (rt && !noRecord(rt)) {
    const byYear = new Map<number, CatalogView['entries']>()
    for (let y = year - 2; y <= year + 2; y++) { const f = filed(catalogs, y); if (f) byYear.set(y, f.entries) }
    const held = heldYear(entity.form_type, year, rt.entries, byYear)
    if (held !== undefined) return held
  }
  return postedFrom(buildContext({ self: { entity, catalogs }, others: [], year, facts: [], today }), year)
}

export function yearFilings(entity: EntityInfo, catalogs: CatalogView[], stored: StoredReturnRow[], today = new Date()): YearFiling[] {
  const own = stored.filter(r => r.form_type === entity.form_type || r.source === 'extension')
  const years = new Set<number>([
    ...own.map(r => r.tax_year),
    ...catalogs.filter(c => c.kind === 'filed_return' && c.tax_year).map(c => c.tax_year as number),
    ...catalogs.filter(c => c.kind === 'irs_transcript' && c.tax_year && transactions(c).some(x => x.code === '150')).map(c => c.tax_year as number),
  ])
  const out: YearFiling[] = []
  for (const year of [...years].sort((a, b) => b - a)) {
    const cat = filed(catalogs, year)
    const imp = own.filter(r => r.tax_year === year && r.source === 'filed_import' && r.form_type === entity.form_type)
      .sort((a, b) => String(b.computed_at ?? '').localeCompare(String(a.computed_at ?? '')))[0]
    const filedOn: YearFiling['filed'] = cat
      ? { via: 'catalog', catalog_id: cat.id, filename: cat.source_filename ?? null, ...(imp ? { return_id: imp.id } : {}) }
      : imp ? { via: 'import', return_id: imp.id } : null

    const t = transcript(catalogs, year)
    const asOf = asOfOf(t)
    const tc150 = transactions(t).find(x => x.code === '150')
    const holds = heldIn(entity, catalogs, year, today)
    // This year's return sitting in a neighbouring period.
    const postedIn = [year + 1, year - 1].find(p => heldIn(entity, catalogs, p, today) === year)

    let accepted = false
    let why: string
    if (!filedOn) why = `No filed ${year} return on file here`
    else if (!t) why = `No ${year} IRS account transcript on file yet — upload one to confirm`
    else if (holds !== undefined) why = `The IRS processed the ${holds} return in the ${year} period${postedIn !== undefined ? `, and this return in the ${postedIn} period` : ''} (transcript${asOf ? ` dated ${asOf}` : ''})`
    else if (tc150) {
      // The year's own period confirms it. A copy that also landed in a
      // neighbouring period (EZA's 2023 return, re-sent) does not undo that.
      accepted = true
      why = `TC150 on the ${year} account transcript${tc150.date ? ` (${tc150.date})` : ''}${asOf ? `, transcript dated ${asOf}` : ''}${postedIn !== undefined ? `; a copy was also posted in the ${postedIn} period` : ''}`
    }
    else if (postedIn !== undefined) why = `The IRS posted this return in the ${postedIn} period, not ${year}`
    else why = `The ${year} transcript${asOf ? ` dated ${asOf}` : ''} shows no return processed yet`

    const extended = transactions(t).some(x => x.code === '460') || own.some(r => r.tax_year === year && r.source === 'extension')
    const { due, extended: extDue } = dueDates(entity.form_type, year)
    const amendments = amendmentFilings(catalogs, own, year, t, asOf)
    out.push({
      tax_year: year, filed: filedOn, accepted, accepted_why: why, transcript_as_of: asOf,
      ...(postedIn !== undefined ? { posted_in: postedIn } : {}),
      ...(holds !== undefined ? { holds_return_of: holds } : {}),
      extended, due: iso(due), extended_due: iso(extDue),
      ...(amendments.length ? { amendments } : {}),
    })
  }
  return out
}
