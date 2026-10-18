/**
 * The entity map, derived: what the filed returns, the recorded facts and the
 * entity records say about how the entities in one account are tied together,
 * and how that compares with the links actually recorded (table entity_link,
 * services/entity_map.ts).
 *
 * Why (2026-10-18): the owner's model is a hard-coded map of the group that
 * every check and every session reads, so a change to one return is traced
 * to every return it touches. Before it existed, one kind of link (an S
 * corporation's K-1 on the 1040, matched by EIN) was re-derived on every
 * review run and discarded. Ownership of the C corporations, an intercompany
 * fee and balance, and a disregarded payroll LLC lived in conversation.
 *
 * Everything here is pure and rule-based. A suggestion is evidence that a link
 * exists, read from a filed return (Schedule E rows, K-1 items F/G, Form
 * 1125-E stock percentages, statement rows naming another entity), a fact
 * (entity.disregarded_entities) or an entity record's owner list. A
 * suggestion is never a link: someone records it (record_link), and the
 * review raises a gap while the evidence shows a link the map lacks.
 */
import type { CatalogEntry } from '../catalog/types.js'
import type { CatalogView, EntityInfo, EntityLink, LinkKind, LinkNature, LinkSource } from './types.js'
import { filed, formEntries, cite } from './lookup.js'
import { scheduleERows, issuedK1s } from './k1.js'

export interface EntityBundle { entity: EntityInfo; catalogs: CatalogView[] }

const EIN_LINE: Record<string, { form: string; line: string }> = {
  '1120S': { form: 'f1120s', line: 'D' },
  '1120': { form: 'f1120', line: 'B' },
  '1065': { form: 'f1065', line: 'D' },
}

/** The EIN an entity prints on its own returns (digits only). */
export function einOf(entity: EntityInfo, catalogs: CatalogView[]): string | undefined {
  const where = EIN_LINE[entity.form_type]
  if (!where) return undefined
  for (const c of [...catalogs].sort((a, b) => (b.tax_year ?? 0) - (a.tax_year ?? 0))) {
    const e = formEntries(c, where.form).find(x => x.line === where.line && !x.section)
    const d = String(e?.raw ?? '').replace(/\D/g, '')
    if (d.length === 9) return d
  }
  return undefined
}

// ─── Names ───────────────────────────────────────────────────────────────────

const words = (s: string) => s.toUpperCase().replace(/[^A-Z]+/g, ' ').trim().split(' ').filter(Boolean)

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return d[a.length][b.length]
}

/** Same person: same last word, and the same first word or one typo apart
 *  (the 2023 K-1 prints the shareholder's first name misspelled). */
export function samePerson(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = words(a ?? ''), y = words(b ?? '')
  if (!x.length || !y.length) return false
  if (x[x.length - 1] !== y[y.length - 1]) return false
  const [f, g] = [x[0], y[0]]
  return f === g || (Math.min(f.length, g.length) >= 4 && lev(f, g) <= 1)
}

/** The people who file on a 1040: from the entity record, else the name. */
export function peopleOf(entity: EntityInfo): string[] {
  if (entity.form_type !== '1040') return []
  const m = (entity.meta ?? {}) as Record<string, unknown>
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const out: string[] = []
  if (s(m.first_name) && s(m.last_name)) out.push(`${s(m.first_name)} ${s(m.last_name)}`)
  if (s(m.spouse_first)) out.push(`${s(m.spouse_first)} ${s(m.spouse_last) || s(m.last_name)}`)
  if (out.length) return out
  return entity.name.split(/\s*&\s*|\s+and\s+/i).map(x => x.trim()).filter(Boolean)
}

const GENERIC = new Set(['INC', 'LLC', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'THE', 'LP', 'LLP', 'PC', 'PLLC', 'PA', 'GROUP'])

/** Does printed text name this entity? Every distinctive word of its name
 *  must appear; a printed word may be cut short ("Edgewater Venture"). */
export function namesEntity(text: string, entityName: string): boolean {
  const want = words(entityName).filter(w => !GENERIC.has(w))
  if (!want.length) return false
  const have = words(text)
  return want.every(w => have.some(h => h === w || (h.length >= 5 && w.startsWith(h)) || (w.length >= 5 && h.startsWith(w))))
}

// ─── Suggestions ─────────────────────────────────────────────────────────────

export interface LinkSuggestion {
  kind: LinkKind
  from_entity_id: string
  to_entity_id: string | null
  to_name: string | null
  subject: string | null
  pct: number | null
  nature: LinkNature | null
  years: number[]
  source: LinkSource
  evidence: string[]
}

export interface FactLike { fact_key: string; tax_year: number | null; value: unknown; status?: string; superseded_by?: string | null }

const SOURCE_RANK: Record<LinkSource, number> = { owner: 3, filed_return: 2, fact: 1, entity_record: 0 }

const parsePct = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.]/g, ''))
  return Number.isFinite(n) && n > 0 && n <= 100 ? Math.round(n * 10000) / 10000 : null
}

/** Statement wording → what kind of dealing, and which side pays or owes. */
function intercompanyNature(label: string): { nature: LinkNature; selfPays: boolean } {
  const l = label.toLowerCase()
  if (/due from|receivable|loan to|advance to/.test(l)) return { nature: 'loan', selfPays: false }
  if (/due to|payable|loan from|advance from|owed to/.test(l)) return { nature: 'loan', selfPays: true }
  if (/rent/.test(l)) return { nature: 'rent', selfPays: true }
  if (/fee|management|marketing|services|commission/.test(l)) return { nature: 'services', selfPays: true }
  if (/settlement/.test(l)) return { nature: 'settlement', selfPays: true }
  return { nature: 'other', selfPays: true }
}

/** Every link the evidence on file points to, merged across years. */
export function suggestLinks(bundles: EntityBundle[], factsByEntity: Map<string, FactLike[]> = new Map()): LinkSuggestion[] {
  const merged = new Map<string, LinkSuggestion & { pctByYear: Map<number, number> }>()
  const individuals = bundles.filter(b => b.entity.form_type === '1040')
  const businesses = bundles.filter(b => b.entity.form_type !== '1040')
  const einByEntity = new Map(businesses.map(b => [b.entity.id, einOf(b.entity, b.catalogs)]))

  /** The 1040 in the account a named person files on, and that person's name as the 1040 has it. */
  const personHome = (name: string): { bundle: EntityBundle; person: string } | undefined => {
    for (const b of individuals) {
      const p = peopleOf(b.entity).find(x => samePerson(x, name))
      if (p) return { bundle: b, person: p }
    }
    return undefined
  }

  const add = (s: Omit<LinkSuggestion, 'years' | 'evidence'> & { year?: number; evidence: string }) => {
    const subj = s.subject ? words(s.subject).join(' ') : ''
    const key = [s.kind, s.from_entity_id, s.to_entity_id ?? `name:${words(s.to_name ?? '').join(' ')}`, subj, s.kind === 'intercompany' ? s.nature : ''].join('|')
    const cur = merged.get(key) ?? { ...s, years: [], evidence: [], pctByYear: new Map<number, number>() }
    if (s.year !== undefined && !cur.years.includes(s.year)) cur.years.push(s.year)
    if (!cur.evidence.includes(s.evidence)) cur.evidence.push(s.evidence)
    if (s.pct !== null && s.year !== undefined) cur.pctByYear.set(s.year, s.pct)
    if (cur.pct === null && s.pct !== null) cur.pct = s.pct
    if (SOURCE_RANK[s.source] > SOURCE_RANK[cur.source]) cur.source = s.source
    if (!cur.subject && s.subject) cur.subject = s.subject
    merged.set(key, cur)
  }

  // 1. The 1040 prints the issuer's EIN on Schedule E Part II.
  for (const ind of individuals) {
    for (const cat of ind.catalogs.filter(c => c.kind === 'filed_return' && c.tax_year !== null)) {
      const y = cat.tax_year as number
      for (const row of scheduleERows(cat)) {
        const issuer = businesses.find(b => row.ein && einByEntity.get(b.entity.id) === row.ein)
        if (!issuer) continue
        const k1 = issuedK1s(filed(issuer.catalogs, y)).find(k => peopleOf(ind.entity).some(p => samePerson(p, k.shareholder)))
        const people = peopleOf(ind.entity)
        const person = k1 ? people.find(p => samePerson(p, k1.shareholder)) ?? null : people.length === 1 ? people[0] : null
        add({
          kind: 'owns', from_entity_id: ind.entity.id, to_entity_id: issuer.entity.id, to_name: null, subject: person,
          pct: k1?.pct ?? null, nature: null, source: 'filed_return', year: y,
          evidence: `${y} Form 1040 Schedule E Part II row ${row.row} reports a K-1 from ${row.name} under its EIN`,
        })
      }
    }
  }

  for (const biz of businesses) {
    for (const cat of biz.catalogs.filter(c => c.kind === 'filed_return' && c.tax_year !== null)) {
      const y = cat.tax_year as number
      // 2. The S corporation's own K-1s: items F (shareholder) and G (percentage).
      if (biz.entity.form_type === '1120S') {
        for (const k of issuedK1s(cat)) {
          const home = k.shareholder ? personHome(k.shareholder) : undefined
          if (!home) continue
          add({
            kind: 'owns', from_entity_id: home.bundle.entity.id, to_entity_id: biz.entity.id, to_name: null, subject: home.person,
            pct: k.pct ?? null, nature: null, source: 'filed_return', year: y,
            evidence: `${y} Form 1120-S Schedule K-1 items F/G: ${k.shareholder}${k.pct !== undefined ? `, ${k.pct}%` : ''}`,
          })
        }
      }
      // 3. Form 1125-E: an officer's percentage of the common stock.
      const officers = new Map<string, CatalogEntry[]>()
      for (const e of formEntries(cat, 'f1125e').filter(x => x.line === '1' && x.row)) officers.set(e.row!, [...(officers.get(e.row!) ?? []), e])
      for (const [row, es] of officers) {
        const name = String(es.find(x => x.col === 'a')?.raw ?? '').trim()
        const pct = parsePct(es.find(x => x.col === 'd')?.value ?? es.find(x => x.col === 'd')?.raw)
        const home = name && pct ? personHome(name) : undefined
        if (!home) continue
        add({
          kind: 'owns', from_entity_id: home.bundle.entity.id, to_entity_id: biz.entity.id, to_name: null, subject: home.person,
          pct, nature: null, source: 'filed_return', year: y,
          evidence: `${y} Form 1125-E line 1 row ${row}: officer ${name} owns ${pct}% of the common stock`,
        })
      }
      // 4. Statement rows naming another entity in the account.
      for (const e of cat.entries.filter(x => (x.kind === 'row' || x.kind === 'text') && x.label)) {
        if (namesEntity(e.label, biz.entity.name)) continue
        for (const other of businesses.filter(o => o !== biz && namesEntity(e.label, o.entity.name))) {
          const { nature, selfPays } = intercompanyNature(e.label)
          add({
            kind: 'intercompany', from_entity_id: selfPays ? biz.entity.id : other.entity.id, to_entity_id: selfPays ? other.entity.id : biz.entity.id,
            to_name: null, subject: null, pct: null, nature, source: 'filed_return', year: y,
            evidence: `${cite(cat, e)}: "${e.label.slice(0, 120)}"`,
          })
        }
      }
    }
    // 5. The entity record's owner list.
    const owners = ((biz.entity.meta ?? {}) as Record<string, unknown>).owners
    for (const o of Array.isArray(owners) ? owners : []) {
      const name = typeof o?.name === 'string' ? o.name : ''
      const home = name ? personHome(name) : undefined
      if (!home) continue
      add({
        kind: 'owns', from_entity_id: home.bundle.entity.id, to_entity_id: biz.entity.id, to_name: null, subject: home.person,
        pct: parsePct(o.pct), nature: null, source: 'entity_record',
        evidence: `Entity record owner list: ${name}${o.pct !== undefined ? ` ${o.pct}` : ''}`,
      })
    }
    // 6. Recorded fact: the entity's disregarded entities.
    for (const f of (factsByEntity.get(biz.entity.id) ?? []).filter(x => x.fact_key === 'entity.disregarded_entities' && !x.superseded_by && Array.isArray(x.value))) {
      for (const d of f.value as Array<{ name?: string }>) {
        if (!d?.name) continue
        const inAccount = bundles.find(b => b !== biz && namesEntity(d.name!, b.entity.name) && namesEntity(b.entity.name, d.name!))
        add({
          kind: 'disregarded', from_entity_id: biz.entity.id, to_entity_id: inAccount?.entity.id ?? null, to_name: inAccount ? null : d.name,
          subject: null, pct: null, nature: null, source: 'fact', ...(f.tax_year !== null ? { year: f.tax_year } : {}),
          evidence: `Fact entity.disregarded_entities${f.tax_year !== null ? ` (${f.tax_year})` : ''}: ${d.name}`,
        })
      }
    }
  }

  return [...merged.values()].map(({ pctByYear, ...s }) => {
    const years = s.years.sort((a, b) => a - b)
    // When the percentage changed over the years, the latest one stands and
    // the history stays in the evidence.
    const latest = years.filter(y => pctByYear.has(y)).pop()
    return { ...s, years, pct: latest !== undefined ? pctByYear.get(latest)! : s.pct }
  })
}

// ─── Links vs. evidence ──────────────────────────────────────────────────────

export const coversYear = (l: Pick<EntityLink, 'from_year' | 'to_year'>, y: number) =>
  (l.from_year === null || l.from_year <= y) && (l.to_year === null || y <= l.to_year)

/** Links that hold in a year (all years when year is undefined). */
export function linksFor(links: EntityLink[], year?: number): EntityLink[] {
  return links.filter(l => !l.removed && (year === undefined || coversYear(l, year)))
}

/** The recorded link (current or removed) that answers a suggestion, if any.
 *  A removed link counts: someone looked and said the relationship is wrong. */
export function coveringLink(links: EntityLink[], s: LinkSuggestion, year?: number): EntityLink | undefined {
  return links.find(l => {
    if (l.kind !== s.kind) return false
    if (year !== undefined && !l.removed && !coversYear(l, year)) return false
    if (s.kind === 'intercompany') {
      const a = [l.from_entity_id, l.to_entity_id].sort().join()
      const b = [s.from_entity_id, s.to_entity_id].sort().join()
      return a === b
    }
    if (l.from_entity_id !== s.from_entity_id) return false
    const sameTo = s.to_entity_id ? l.to_entity_id === s.to_entity_id : !!l.to_name && !!s.to_name && namesEntity(l.to_name, s.to_name) && namesEntity(s.to_name, l.to_name)
    if (!sameTo) return false
    return s.kind !== 'owns' || !l.subject || !s.subject || samePerson(l.subject, s.subject)
  })
}

/** Suggestions no recorded link answers. */
export function unrecorded(links: EntityLink[], suggestions: LinkSuggestion[]): LinkSuggestion[] {
  return suggestions.filter(s => !coveringLink(links, s))
}

// ─── Reading the map ─────────────────────────────────────────────────────────

export interface MapEntity { id: string; name: string; form_type: string; years: number[] }

/** Owners and what each holds: the controlled-group picture in one list. */
export function byOwner(links: EntityLink[], entities: MapEntity[]) {
  const name = (id: string | null) => entities.find(e => e.id === id)?.name ?? null
  const groups = new Map<string, { owner: string; files_on: { entity_id: string; name: string | null }; holds: Array<{ entity_id: string | null; name: string | null; form_type: string | null; pct: number | null; from_year: number | null; to_year: number | null; link_key: string }> }>()
  for (const l of linksFor(links).filter(x => x.kind === 'owns')) {
    const owner = l.subject ?? name(l.from_entity_id) ?? l.from_entity_id
    const key = `${l.from_entity_id}|${words(owner).join(' ')}`
    const g = groups.get(key) ?? { owner, files_on: { entity_id: l.from_entity_id, name: name(l.from_entity_id) }, holds: [] }
    g.holds.push({
      entity_id: l.to_entity_id, name: l.to_entity_id ? name(l.to_entity_id) : l.to_name, form_type: entities.find(e => e.id === l.to_entity_id)?.form_type ?? null,
      pct: l.pct, from_year: l.from_year, to_year: l.to_year, link_key: l.link_key,
    })
    groups.set(key, g)
  }
  return [...groups.values()]
}

const PASS_THROUGH = new Set(['1120S', '1065'])

/** What a change to this entity's return reaches, by link. */
export function touches(entityId: string, links: EntityLink[], entities: MapEntity[]) {
  const ent = (id: string | null) => entities.find(e => e.id === id)
  const out: Array<{ entity_id: string | null; name: string | null; via: string; effect: string; link_key: string }> = []
  for (const l of linksFor(links)) {
    if (l.kind === 'owns' && l.to_entity_id === entityId) {
      const pass = PASS_THROUGH.has(ent(entityId)?.form_type ?? '')
      out.push({
        entity_id: l.from_entity_id, name: ent(l.from_entity_id)?.name ?? null, via: `owner (${l.subject ?? 'owner'}${l.pct !== null ? `, ${l.pct}%` : ''})`,
        effect: pass
          ? 'K-1 income and its character (Schedule E, NIIT), stock basis and distributions (Form 7203), and the QBI deduction on the owner\'s return'
          : 'dividends and officer pay on the owner\'s return; the owner\'s other corporations share controlled-group status',
        link_key: l.link_key,
      })
    }
    if (l.kind === 'owns' && l.from_entity_id === entityId && l.to_entity_id) {
      out.push({ entity_id: l.to_entity_id, name: ent(l.to_entity_id)?.name ?? null, via: `owned (${l.pct ?? '?'}%)`, effect: 'ownership changes reach this entity\'s K-1s, Schedule G/1125-E and controlled-group answers', link_key: l.link_key })
    }
    if (l.kind === 'intercompany' && (l.from_entity_id === entityId || l.to_entity_id === entityId)) {
      const other = l.from_entity_id === entityId ? l.to_entity_id : l.from_entity_id
      out.push({
        entity_id: other, name: other ? ent(other)?.name ?? null : l.to_name, via: `intercompany (${l.nature ?? 'other'})`,
        effect: 'the other side\'s matching revenue or expense, and the due-to / due-from balances on both balance sheets', link_key: l.link_key,
      })
    }
    if (l.kind === 'disregarded' && l.from_entity_id === entityId) {
      out.push({ entity_id: l.to_entity_id, name: l.to_entity_id ? ent(l.to_entity_id)?.name ?? null : l.to_name, via: 'disregarded entity', effect: 'its income, payroll and wages are reported on this return', link_key: l.link_key })
    }
  }
  return out
}
