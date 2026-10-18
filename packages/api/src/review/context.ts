/**
 * Build a ReviewContext from catalogs, facts and documents.
 *
 * Linking is evidence-only: a 1040 is linked to an S corporation because the
 * entity map records the ownership (entity_link, with its evidence) or because
 * its Schedule E row prints the same EIN the S corporation prints on its own
 * return — never because two entities share an account (the MCP evidence
 * rule: co-location is not a relationship).
 */
import type { EntityLink, FactValue, FactView, LinkedEntity, ReviewContext, DocumentFact } from './types.js'
import { filed } from './lookup.js'
import { scheduleERows } from './k1.js'
import { einOf, linksFor, suggestLinks, type EntityBundle, type FactLike } from './map.js'

export { einOf, type EntityBundle } from './map.js'

const PASS_THROUGH = ['1120S', '1065']

/** K-1 links the entity map records for this year. */
function mapLinks(self: EntityBundle, others: EntityBundle[], year: number, links: EntityLink[]): LinkedEntity[] {
  const out: LinkedEntity[] = []
  const owns = linksFor(links, year).filter(l => l.kind === 'owns')
  const says = (l: EntityLink) => `entity map: ${l.subject ?? 'the owner'} owns ${l.pct !== null ? `${l.pct}%` : 'an interest'} (${l.source.replace('_', ' ')})`
  if (self.entity.form_type === '1040') {
    for (const l of owns.filter(x => x.from_entity_id === self.entity.id)) {
      const o = others.find(b => b.entity.id === l.to_entity_id && PASS_THROUGH.includes(b.entity.form_type))
      if (!o) continue
      const ein = einOf(o.entity, o.catalogs)
      out.push({ entity: { ...o.entity, meta: { ...(o.entity.meta ?? {}), ...(ein ? { ein_digits: ein } : {}) } }, relation: 'k1_issuer', evidence: says(l), catalogs: o.catalogs })
    }
  } else if (PASS_THROUGH.includes(self.entity.form_type)) {
    for (const l of owns.filter(x => x.to_entity_id === self.entity.id)) {
      const o = others.find(b => b.entity.id === l.from_entity_id && b.entity.form_type === '1040')
      if (o) out.push({ entity: o.entity, relation: 'k1_recipient', evidence: says(l), catalogs: o.catalogs })
    }
  }
  return out
}

function einLinks(self: EntityBundle, others: EntityBundle[], year: number): LinkedEntity[] {
  const out: LinkedEntity[] = []
  if (self.entity.form_type === '1040') {
    const rows = scheduleERows(filed(self.catalogs, year))
    for (const o of others) {
      const ein = einOf(o.entity, o.catalogs)
      const row = ein && rows.find(r => r.ein === ein)
      if (row) {
        out.push({
          entity: { ...o.entity, meta: { ...(o.entity.meta ?? {}), ein_digits: ein } }, relation: 'k1_issuer',
          evidence: `${year} Form 1040 Schedule E line 28 row ${row.row} prints this entity's EIN`, catalogs: o.catalogs,
        })
      }
    }
  } else {
    const ein = einOf(self.entity, self.catalogs)
    if (!ein) return out
    for (const o of others.filter(x => x.entity.form_type === '1040')) {
      const years = [...new Set(o.catalogs.map(c => c.tax_year).filter((y): y is number => y !== null))]
      const y = years.find(yy => scheduleERows(filed(o.catalogs, yy)).some(r => r.ein === ein))
      if (y !== undefined) {
        out.push({ entity: o.entity, relation: 'k1_recipient', evidence: `${y} Form 1040 Schedule E prints this entity's EIN`, catalogs: o.catalogs })
      }
    }
  }
  return out
}

/** K-1 links for a year: the entity map's first, then the ones the returns
 *  themselves document (Schedule E prints the issuer's EIN). A link found
 *  both ways carries both pieces of evidence. */
export function linkEntities(self: EntityBundle, others: EntityBundle[], year: number, links: EntityLink[] = []): LinkedEntity[] {
  const out = mapLinks(self, others, year, links)
  for (const l of einLinks(self, others, year)) {
    const same = out.find(x => x.entity.id === l.entity.id && x.relation === l.relation)
    if (same) same.evidence = `${same.evidence}; ${l.evidence}`
    else out.push(l)
  }
  return out
}

export interface StoredFactLike {
  fact_key: string
  tax_year: number | null
  subject: string | null
  value: unknown
  status: 'answered' | 'unknown' | 'not_applicable'
  source?: string
  recorded_at?: string
  superseded_by?: string | null
}

export function factView(rows: StoredFactLike[]): FactView {
  const current = rows.filter(r => !r.superseded_by)
  const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return {
    get(key, opts = {}): FactValue | undefined {
      const cands = current.filter(r => r.fact_key === key &&
        (opts.year === undefined ? true : r.tax_year === opts.year || r.tax_year === null) &&
        (opts.subject === undefined ? true : !r.subject || norm(r.subject) === norm(opts.subject) || norm(opts.subject).startsWith(norm(r.subject)) || norm(r.subject).startsWith(norm(opts.subject))))
      // Prefer the year-specific answer over the all-years one.
      const best = cands.sort((a, b) => (b.tax_year ?? 0) - (a.tax_year ?? 0))[0]
      return best ? { value: best.value, status: best.status, source: best.source, recorded_at: best.recorded_at } : undefined
    },
  }
}

export function buildContext(args: {
  self: EntityBundle
  others: EntityBundle[]
  year: number
  facts: StoredFactLike[]
  /** The account's recorded links (entity_link, current versions) */
  links?: EntityLink[]
  /** Facts of every entity, for map suggestions (disregarded entities) */
  factsByEntity?: Map<string, FactLike[]>
  documents?: DocumentFact[]
  factGaps?: ReviewContext['factGaps']
  today?: Date
}): ReviewContext {
  return {
    entity: args.self.entity,
    year: args.year,
    catalogs: args.self.catalogs,
    linked: linkEntities(args.self, args.others, args.year, args.links ?? []),
    facts: factView(args.facts),
    documents: args.documents ?? [],
    factGaps: args.factGaps,
    ...(args.links ? {
      map: {
        links: args.links,
        suggestions: suggestLinks([args.self, ...args.others], args.factsByEntity),
        bundles: [args.self, ...args.others],
      },
    } : {}),
    today: args.today ?? new Date(),
  }
}
