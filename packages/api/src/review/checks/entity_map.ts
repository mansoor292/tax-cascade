/**
 * Entity-map checks: the recorded links between the entities in an account
 * against what the filed returns say (review/map.ts).
 *
 * Why (2026-10-18): the map is only worth reading if it stays true. These two
 * checks keep it honest from both directions. Evidence of a link the map
 * lacks is a gap; a recorded link the returns contradict (a different
 * percentage, a K-1 the owner's 1040 never reports) is a finding. Each item
 * is raised on one return only, so the account-wide list carries it once:
 * ownership on the owned entity, anything else on the entity the link starts
 * from. A K-1 missing from the 1040 is raised on the 1040.
 */
import type { Check, CheckResult, EntityLink, ReviewContext } from '../types.js'
import { filed, formEntries } from '../lookup.js'
import { issuedK1s, scheduleERows } from '../k1.js'
import { coveringLink, einOf, linksFor, namesEntity, samePerson, type LinkSuggestion } from '../map.js'

const ALL = ['1040', '1120', '1120S', '1065'] as const

function nameOf(ctx: ReviewContext, id: string | null, fallback: string | null = null): string {
  return ctx.map?.bundles.find(b => b.entity.id === id)?.entity.name ?? fallback ?? 'an entity outside this account'
}

function describe(ctx: ReviewContext, s: Pick<LinkSuggestion, 'kind' | 'from_entity_id' | 'to_entity_id' | 'to_name' | 'subject' | 'pct' | 'nature'>): string {
  const from = nameOf(ctx, s.from_entity_id), to = nameOf(ctx, s.to_entity_id, s.to_name)
  if (s.kind === 'owns') return `${s.subject ?? from} owns ${s.pct !== null ? `${s.pct}%` : 'an interest'} of ${to}`
  if (s.kind === 'disregarded') return `${to} is a disregarded entity of ${from}`
  return `${from} and ${to} deal with each other (${s.nature ?? 'other'})`
}

/** The return an item about this link is raised on. */
const homeOf = (s: Pick<LinkSuggestion, 'kind' | 'from_entity_id' | 'to_entity_id'>) =>
  s.kind === 'owns' && s.to_entity_id ? s.to_entity_id : s.from_entity_id

const keyOf = (s: Pick<LinkSuggestion, 'kind' | 'from_entity_id' | 'to_entity_id' | 'to_name' | 'subject'>) =>
  [s.kind, s.kind === 'owns' ? s.from_entity_id : s.to_entity_id === null ? s.from_entity_id : [s.from_entity_id, s.to_entity_id].sort().join('+'), s.to_entity_id ?? s.to_name ?? '', (s.subject ?? '').toLowerCase().replace(/[^a-z]/g, '')]
    .join(':').slice(0, 160)

const linksRecorded: Check = {
  id: 'entity_map.links_recorded',
  version: 1,
  area: 'entity_map',
  title: 'Every link the returns show is in the entity map',
  applies: [...ALL],
  kind: 'rule',
  description:
    'Reads the filed returns, the recorded facts and the entity records for evidence that this entity is tied to another: a K-1 on a ' +
    'Schedule E row, K-1 items F/G, an officer\'s stock percentage on Form 1125-E, a statement row naming another entity in the ' +
    'account, a disregarded entity. Each piece of evidence the entity map does not answer is a gap, because the checks that follow ' +
    'links (K-1 flow, intercompany, controlled group) cannot see a relationship nobody recorded. An item is answered by recording ' +
    'the link (record_link), or by a removed link or a resolution when the evidence is misleading.',
  run(ctx) {
    if (!ctx.map) return [{ check: this.id, status: 'n/a', severity: 'info', title: 'Entity map not loaded for this run', detail: '', evidence: [] }]
    const self = ctx.entity.id
    const filedYears = ctx.catalogs.filter(c => c.kind === 'filed_return' && c.tax_year !== null).map(c => c.tax_year as number)
    const latest = filedYears.length ? Math.max(...filedYears) : ctx.year
    // Evidence with no year (an entity record's owner list) is raised once,
    // on the latest year this entity has a return for.
    const relevant = ctx.map.suggestions.filter(s => homeOf(s) === self && (s.years.length ? s.years.includes(ctx.year) : ctx.year === latest))
    if (!relevant.length) return [{ check: this.id, status: 'n/a', severity: 'info', title: `${ctx.year}: no evidence ties this return to another entity`, detail: '', evidence: [] }]
    const out: CheckResult[] = []
    let answered = 0
    for (const s of relevant) {
      if (coveringLink(ctx.map.links, s, ctx.year)) { answered++; continue }
      out.push({
        check: this.id, status: 'gap', severity: s.source === 'entity_record' ? 'low' : 'medium', key: keyOf(s),
        title: `${ctx.year}: ${describe(ctx, s)} — not in the entity map`,
        detail: 'The evidence below shows this relationship, but the entity map has no link for it, so the checks that follow links ' +
          '(K-1 flow, intercompany, controlled group) cannot use it. Record it with record_link (kind, both entities, percentage or ' +
          'nature, the years it holds, the evidence). If the evidence is misleading, resolve this item and say why.',
        evidence: s.evidence.map(where => ({ where })),
      })
    }
    if (!out.length) out.push({ check: this.id, status: 'pass', severity: 'info', title: `${ctx.year}: the entity map answers all ${answered} piece(s) of link evidence`, detail: '', evidence: [] })
    return out
  },
}

const ownershipMatches: Check = {
  id: 'entity_map.ownership_matches_returns',
  version: 1,
  tie: true,
  area: 'entity_map',
  title: 'Recorded ownership agrees with the returns',
  applies: [...ALL],
  kind: 'rule',
  description:
    'For each ownership link that holds this year: on the owned entity, the percentage must match the shareholder\'s K-1 item G ' +
    '(Form 1120-S) and the officer\'s common-stock percentage on Form 1125-E, and an S corporation that issued K-1s must have issued ' +
    'one to the recorded owner. On the owner\'s 1040, a pass-through entity the owner holds must appear on Schedule E Part II — a ' +
    'K-1 missing from the 1040 is income left off the return.',
  run(ctx) {
    if (!ctx.map) return [{ check: this.id, status: 'n/a', severity: 'info', title: 'Entity map not loaded for this run', detail: '', evidence: [] }]
    const self = ctx.entity.id
    const owns = linksFor(ctx.map.links, ctx.year).filter(l => l.kind === 'owns')
    const out: CheckResult[] = []
    let checked = 0
    const cat = filed(ctx.catalogs, ctx.year)
    const mapEv = (l: EntityLink) => ({ where: `Entity map: ${describe(ctx, l)} (${l.source.replace('_', ' ')}${l.evidence ? `; ${l.evidence}` : ''})` })

    // Owned entity: the percentage on its own return.
    for (const l of owns.filter(x => x.to_entity_id === self && x.subject)) {
      if (!cat) continue
      if (ctx.entity.form_type === '1120S') {
        const k1s = issuedK1s(cat).filter(k => k.shareholder)
        if (k1s.length) {
          checked++
          const k = k1s.find(x => samePerson(x.shareholder, l.subject))
          if (!k) {
            out.push({
              check: this.id, status: 'finding', severity: 'medium', key: `k1:${l.link_key}`,
              title: `${ctx.year}: no K-1 issued to ${l.subject}, who the entity map says owns ${l.pct ?? '?'}%`,
              detail: `The ${ctx.year} return's K-1s name ${k1s.map(x => x.shareholder).join(', ')}. Either the K-1 is missing or the map is wrong.`,
              evidence: [mapEv(l)],
            })
          } else if (k.pct !== undefined && l.pct !== null && Math.abs(k.pct - l.pct) > 0.01) {
            out.push({
              check: this.id, status: 'finding', severity: 'medium', key: `pct:${l.link_key}`,
              title: `${ctx.year}: K-1 item G shows ${k.pct}% for ${k.shareholder}; the entity map says ${l.pct}%`,
              detail: 'The allocation percentage on the K-1 drives every shareholder\'s share of income. Correct the map (with the years each percentage held) or the return.',
              evidence: [mapEv(l), { where: `${ctx.year} Form 1120-S Schedule K-1 item G: ${k.pct}%`, catalog_id: cat.id }],
            })
          }
        }
      }
      const officers = new Map<string, Array<{ col?: string; raw: string; value: unknown }>>()
      for (const e of formEntries(cat, 'f1125e').filter(x => x.line === '1' && x.row)) officers.set(e.row!, [...(officers.get(e.row!) ?? []), e])
      for (const [row, es] of officers) {
        const name = String(es.find(x => x.col === 'a')?.raw ?? '').trim()
        if (!samePerson(name, l.subject)) continue
        const d = es.find(x => x.col === 'd')
        const pct = Number(String(d?.value ?? d?.raw ?? '').replace(/[^\d.]/g, ''))
        if (!d || !Number.isFinite(pct) || l.pct === null) continue
        checked++
        if (Math.abs(pct - l.pct) > 0.01) {
          out.push({
            check: this.id, status: 'finding', severity: 'low', key: `1125e:${l.link_key}`,
            title: `${ctx.year}: Form 1125-E shows ${name} owning ${pct}% of the common stock; the entity map says ${l.pct}%`,
            detail: 'Form 1125-E reports each officer\'s stock percentage. Correct the map (with the years each percentage held) or the return.',
            evidence: [mapEv(l), { where: `${ctx.year} Form 1125-E line 1 row ${row}, column (d): ${pct}%`, catalog_id: cat.id }],
          })
        }
      }
    }

    // Owner's 1040: every pass-through it holds is on Schedule E.
    if (ctx.entity.form_type === '1040' && cat) {
      const rows = scheduleERows(cat)
      for (const l of owns.filter(x => x.from_entity_id === self && x.to_entity_id)) {
        const issuer = ctx.map.bundles.find(b => b.entity.id === l.to_entity_id)
        if (!issuer || !['1120S', '1065'].includes(issuer.entity.form_type)) continue
        checked++
        const ein = einOf(issuer.entity, issuer.catalogs)
        const row = rows.find(r => (ein && r.ein === ein) || namesEntity(r.name, issuer.entity.name))
        if (!row) {
          out.push({
            check: this.id, status: 'finding', severity: 'high', key: `sche:${l.link_key}`,
            title: `${ctx.year}: ${issuer.entity.name}'s K-1 is not on this 1040 — the entity map says ${describe(ctx, l).replace(/ of .*/, '')} of it`,
            detail: `Schedule E Part II lists ${rows.length ? rows.map(r => r.name).join(', ') : 'no K-1s'}. A K-1 from an entity the owner holds that never reaches the 1040 is income left off the return — unless the link does not hold for ${ctx.year}, in which case set its years.`,
            evidence: [mapEv(l), { where: `${ctx.year} Form 1040 Schedule E Part II line 28`, catalog_id: cat.id }],
          })
        }
      }
    }

    if (!out.length) {
      return [{ check: this.id, status: checked ? 'pass' : 'n/a', severity: 'info', title: checked ? `${ctx.year}: recorded ownership agrees with the return (${checked} comparison(s))` : `${ctx.year}: no recorded ownership to compare`, detail: '', evidence: [] }]
    }
    return out
  },
}

export const entityMapChecks: Check[] = [linksRecorded, ownershipMatches]
