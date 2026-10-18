/**
 * Cross-entity checks: what one return says about another, read through the
 * entity map (review/map.ts). Each item is raised once, on the return that
 * starts the link (the side that pays or owes), or on the corporation whose
 * own answer is being tested.
 *
 * Why (2026-10-18): the Edgewater intercompany fee had been reconciled by
 * hand dozens of times. EZA's deduction and EV's revenue were compared from
 * scratch in each conversation, and a 50,000 gap in one year and a balance
 * the two balance sheets disagree on were each found, lost and found again.
 * The controlled-group answers on EV's returns changed from year to year
 * with nothing checking them against who owns what. These checks run on
 * every review, from the map and the recorded facts, so the comparison is
 * made once and stays made.
 */
import type { Check, CheckResult, Evidence, EntityInfo, ReviewContext } from '../types.js'
import type { CatalogEntry } from '../../catalog/types.js'
import { factView } from '../context.js'
import { cite, filed, formEntries, money } from '../lookup.js'
import { linksFor, namesEntity, samePerson, type FactLike } from '../map.js'

const BUSINESS = ['1120', '1120S', '1065'] as const

function bundle(ctx: ReviewContext, id: string | null) {
  return ctx.map?.bundles.find(b => b.entity.id === id)
}

function theirFacts(ctx: ReviewContext, id: string) {
  return factView((ctx.map?.facts.get(id) ?? []) as Array<FactLike & { subject: string | null; status: 'answered' | 'unknown' | 'not_applicable' }>)
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(/[$,\s]/g, '')) : NaN
  return Number.isFinite(n) ? n : undefined
}

// ─── Intercompany fees ───────────────────────────────────────────────────────

const feesMatch: Check = {
  id: 'intercompany.fees_match',
  version: 1,
  area: 'intercompany',
  title: 'The fee one entity deducts is the revenue the other reports',
  applies: [...BUSINESS],
  kind: 'rule',
  description:
    'For each services or rent link in the entity map, the paying entity\'s deduction for the related company (fact ' +
    'intercompany.fee_expense) must equal the related company\'s revenue from it (intercompany.fee_revenue) for the same year. ' +
    'A difference means one return is wrong: a fee booked twice, in the wrong year, or on one side only; and an accrued, unpaid ' +
    'related-party fee is not deductible before the payee includes it (§267(a)(2)). Raised on the paying entity.',
  run(ctx) {
    if (!ctx.map) return [{ check: this.id, status: 'n/a', severity: 'info', title: 'Entity map not loaded for this run', detail: '', evidence: [] }]
    const links = linksFor(ctx.map.links, ctx.year).filter(l => l.kind === 'intercompany' && (l.nature === 'services' || l.nature === 'rent') && l.from_entity_id === ctx.entity.id)
    if (!links.length) return [{ check: this.id, status: 'n/a', severity: 'info', title: `${ctx.year}: no fees paid to a related company in the entity map`, detail: '', evidence: [] }]
    const out: CheckResult[] = []
    for (const l of links) {
      const payee = bundle(ctx, l.to_entity_id)
      if (!payee) continue
      const payer = ctx.entity
      const exp = ctx.facts.get('intercompany.fee_expense', { year: ctx.year, subject: payee.entity.name })
      const rev = theirFacts(ctx, payee.entity.id).get('intercompany.fee_revenue', { year: ctx.year, subject: payer.name })
      const e = exp?.status === 'answered' ? num(exp.value) : undefined
      const r = rev?.status === 'answered' ? num(rev.value) : undefined
      const ev: Evidence[] = [
        { where: `Entity map: ${payer.name} pays ${payee.entity.name} (${l.nature})${l.evidence ? `; ${l.evidence}` : ''}` },
        ...(e !== undefined ? [{ where: `${payer.name} fact intercompany.fee_expense (${ctx.year}, ${payee.entity.name}): ${money(e)}`, fact: 'intercompany.fee_expense', value: e }] : []),
        ...(r !== undefined ? [{ where: `${payee.entity.name} fact intercompany.fee_revenue (${ctx.year}, ${payer.name}): ${money(r)}`, fact: 'intercompany.fee_revenue', value: r }] : []),
      ]
      const key = `fees:${l.link_key}`
      if (e === undefined || r === undefined) {
        const missing = [e === undefined ? `${payer.name}'s deduction` : '', r === undefined ? `${payee.entity.name}'s revenue` : ''].filter(Boolean)
        out.push({
          check: this.id, status: 'gap', severity: 'medium', key,
          title: `${ctx.year}: the ${payee.entity.name} fee cannot be matched — ${missing.join(' and ')} not recorded`,
          detail: `Record ${payer.name}'s intercompany.fee_expense and ${payee.entity.name}'s intercompany.fee_revenue for ${ctx.year} (subject: the other company), from the books, so the two sides can be compared.`,
          evidence: ev,
          asks: [...(e === undefined ? ['intercompany.fee_expense'] : []), ...(r === undefined ? ['intercompany.fee_revenue'] : [])],
        })
        continue
      }
      const diff = Math.round((e - r) * 100) / 100
      if (Math.abs(diff) < 1) {
        out.push({ check: this.id, status: 'pass', severity: 'info', key, title: `${ctx.year}: ${payer.name} deducted and ${payee.entity.name} reported the same ${money(e)}`, detail: '', evidence: ev })
        continue
      }
      // Tax effect falls on the payee when its revenue is what moves; a C
      // corporation pays 21%. Positive = the payee under-reported.
      const effect = payee.entity.form_type === '1120' ? Math.round(diff * 0.21) : undefined
      out.push({
        check: this.id, status: 'finding', severity: Math.abs(diff) >= 10_000 ? 'high' : 'medium', key,
        title: `${ctx.year}: ${payer.name} deducted ${money(e)} for ${payee.entity.name}'s fees; ${payee.entity.name} reported ${money(r)} — ${money(Math.abs(diff))} apart`,
        detail: `${diff > 0 ? `${payee.entity.name} reported less than ${payer.name} deducted` : `${payee.entity.name} reported more than ${payer.name} deducted`}. One side is wrong for ${ctx.year}: find the month or entry that differs and correct that return (an amended return if it is filed). ` +
          (effect !== undefined ? `At 21%, ${payee.entity.name}'s tax is ${effect > 0 ? 'understated' : 'overstated'} by about ${money(Math.abs(effect))} if its side is the one that is wrong.` : ''),
        evidence: ev,
        ...(effect !== undefined ? { dollar_effect: effect } : {}),
      })
    }
    return out.length ? out : [{ check: this.id, status: 'n/a', severity: 'info', title: `${ctx.year}: fees go to a company outside this account`, detail: '', evidence: [] }]
  },
}

// ─── Intercompany balances ───────────────────────────────────────────────────

/** End-of-year amount on a statement row naming the other company. */
function namedBalance(ctx: ReviewContext, entity: EntityInfo, catalogs: Parameters<typeof filed>[0], otherName: string): { amount: number; where: string; entry: CatalogEntry } | undefined {
  const cat = filed(catalogs, ctx.year)
  if (!cat) return undefined
  const e = cat.entries.find(x => x.kind === 'row' && x.amounts?.length && namesEntity(x.label, otherName) && !namesEntity(x.label, entity.name))
  if (!e) return undefined
  return { amount: Math.abs(e.amounts![e.amounts!.length - 1]), where: `${cite(cat, e)}: "${e.label.slice(0, 80)}"`, entry: e }
}

const balancesMatch: Check = {
  id: 'intercompany.balances_match',
  version: 1,
  area: 'intercompany',
  title: 'What one entity owes a related company, the other says it is owed',
  applies: [...BUSINESS],
  kind: 'rule',
  description:
    'For each loan, settlement or other balance link in the entity map, the year-end amount the owing entity shows as due to the ' +
    'related company must equal what the related company shows as due from it. Read from the recorded facts ' +
    '(intercompany.balance_end) or, failing those, from a balance-sheet statement row on each filed return that names the other ' +
    'company. A difference means an entry is on one side only. Raised on the owing entity.',
  run(ctx) {
    if (!ctx.map) return [{ check: this.id, status: 'n/a', severity: 'info', title: 'Entity map not loaded for this run', detail: '', evidence: [] }]
    const links = linksFor(ctx.map.links, ctx.year).filter(l => l.kind === 'intercompany' && l.nature !== 'services' && l.nature !== 'rent' && l.from_entity_id === ctx.entity.id)
    if (!links.length) return [{ check: this.id, status: 'n/a', severity: 'info', title: `${ctx.year}: no balance owed to a related company in the entity map`, detail: '', evidence: [] }]
    const out: CheckResult[] = []
    for (const l of links) {
      const cred = bundle(ctx, l.to_entity_id)
      if (!cred) continue
      const debtor = ctx.entity
      const df = ctx.facts.get('intercompany.balance_end', { year: ctx.year, subject: cred.entity.name })
      const cf = theirFacts(ctx, cred.entity.id).get('intercompany.balance_end', { year: ctx.year, subject: debtor.name })
      const dFact = df?.status === 'answered' ? num(df.value) : undefined
      const cFact = cf?.status === 'answered' ? num(cf.value) : undefined
      const dRow = dFact === undefined ? namedBalance(ctx, debtor, ctx.catalogs, cred.entity.name) : undefined
      const cRow = cFact === undefined ? namedBalance(ctx, cred.entity, cred.catalogs, debtor.name) : undefined
      // Facts are signed from each side (negative = this entity owes);
      // statement rows are amounts. Compare what is owed with what is due.
      const owes = dFact !== undefined ? -dFact : dRow?.amount
      const owed = cFact !== undefined ? cFact : cRow?.amount
      const ev: Evidence[] = [
        { where: `Entity map: ${debtor.name} owes ${cred.entity.name} (${l.nature})` },
        ...(dFact !== undefined ? [{ where: `${debtor.name} fact intercompany.balance_end (${ctx.year}, ${cred.entity.name}): ${money(dFact)}`, fact: 'intercompany.balance_end', value: dFact }] : []),
        ...(dRow ? [{ where: dRow.where, entry_id: dRow.entry.id, value: dRow.amount }] : []),
        ...(cFact !== undefined ? [{ where: `${cred.entity.name} fact intercompany.balance_end (${ctx.year}, ${debtor.name}): ${money(cFact)}`, fact: 'intercompany.balance_end', value: cFact }] : []),
        ...(cRow ? [{ where: cRow.where, entry_id: cRow.entry.id, value: cRow.amount }] : []),
      ]
      const key = `balance:${l.link_key}`
      if (owes === undefined || owed === undefined) {
        const missing = [owes === undefined ? debtor.name : '', owed === undefined ? cred.entity.name : ''].filter(Boolean)
        out.push({
          check: this.id, status: 'gap', severity: 'low', key,
          title: `${ctx.year}: the ${debtor.name} – ${cred.entity.name} balance cannot be compared — ${missing.join(' and ')} not identifiable`,
          detail: `Neither a recorded intercompany.balance_end nor a balance-sheet statement row naming the other company gives ${missing.join(' and ')}'s year-end balance. Record intercompany.balance_end for ${ctx.year} on each side (negative = this entity owes).`,
          evidence: ev, asks: ['intercompany.balance_end'],
        })
        continue
      }
      const diff = Math.round((owes - owed) * 100) / 100
      if (Math.abs(diff) < 1) {
        out.push({ check: this.id, status: 'pass', severity: 'info', key, title: `${ctx.year}: both sides show ${money(owes)} owed`, detail: '', evidence: ev })
        continue
      }
      out.push({
        check: this.id, status: 'finding', severity: 'medium', key,
        title: `${ctx.year}: ${debtor.name} shows ${money(owes)} due to ${cred.entity.name}; ${cred.entity.name} shows ${money(owed)} due from it — ${money(Math.abs(diff))} apart`,
        detail: 'The two balance sheets disagree about the same balance, so an entry (a payment, a fee, a charge against the balance) is recorded on one side only. Find it and correct the side that is missing it.',
        evidence: ev,
      })
    }
    return out.length ? out : [{ check: this.id, status: 'n/a', severity: 'info', title: `${ctx.year}: the balance is with a company outside this account`, detail: '', evidence: [] }]
  },
}

// ─── Controlled group ────────────────────────────────────────────────────────

/** The ticked answer to a Schedule K yes/no question, found by its wording
 *  (line numbers move between revisions). */
function scheduleKAnswer(cat: Parameters<typeof formEntries>[0], wording: RegExp): { answer: 'Yes' | 'No'; entry: CatalogEntry } | undefined {
  const e = formEntries(cat, 'f1120').find(x => x.section === 'Schedule K' && x.kind === 'check' && x.value === true && wording.test(x.label))
  const m = e ? /\b(Yes|No)\W*$/i.exec(e.label) : null
  return e && m ? { answer: (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) as 'Yes' | 'No', entry: e } : undefined
}

function formation(ctx: ReviewContext, b: { entity: EntityInfo }): string | undefined {
  const f = theirFacts(ctx, b.entity.id).get('entity.formation_date')
  const v = f?.status === 'answered' && typeof f.value === 'string' ? f.value : b.entity.date_incorporated ?? undefined
  return v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined
}

const controlledGroup: Check = {
  id: 'corporate.controlled_group_consistent',
  version: 1,
  area: 'corporate',
  title: 'Controlled-group answers agree with who owns what',
  applies: ['1120'],
  kind: 'rule',
  description:
    'From the entity map\'s ownership on December 31: another C corporation in the account is in a brother–sister controlled ' +
    'group with this one when the same five or fewer individuals own more than 50% of each, counting each person only to the ' +
    'extent their ownership is identical in both (the Schedule O 50% test; S corporations are excluded members). Then the return ' +
    'must answer Schedule K "member of a controlled group?" Yes, attach Schedule O and list the other members; and it may answer ' +
    '"subsidiary in a parent–subsidiary group?" Yes only if a corporation could own 80% of it. A corporation formed after December ' +
    '31 is not a member that year.',
  run(ctx) {
    if (!ctx.map) return [{ check: this.id, status: 'n/a', severity: 'info', title: 'Entity map not loaded for this run', detail: '', evidence: [] }]
    const cat = filed(ctx.catalogs, ctx.year)
    if (!cat) return [{ check: this.id, status: 'n/a', severity: 'info', title: `${ctx.year}: no filed return to compare`, detail: '', evidence: [] }]
    const owns = linksFor(ctx.map.links, ctx.year).filter(l => l.kind === 'owns')
    const ownersOf = (id: string) => owns.filter(l => l.to_entity_id === id).map(l => ({ link: l, from: l.from_entity_id, person: l.subject, pct: l.pct ?? 0 }))
    const mine = ownersOf(ctx.entity.id)
    if (!mine.length) return [{ check: this.id, status: 'n/a', severity: 'info', title: `${ctx.year}: the entity map records no owner of this corporation`, detail: '', evidence: [] }]
    const individuals = mine.filter(o => bundle(ctx, o.from)?.entity.form_type === '1040')
    const yearEnd = `${ctx.year}-12-31`
    const members: Array<{ name: string; identical: number; owners: string }> = []
    const excluded: string[] = []
    const unknownFormation: string[] = []
    for (const b of ctx.map.bundles.filter(x => x.entity.id !== ctx.entity.id && (x.entity.form_type === '1120' || x.entity.form_type === '1120S'))) {
      const theirs = ownersOf(b.entity.id)
      const common = individuals.map(a => ({ a, b: theirs.find(t => t.from === a.from && (!a.person || !t.person || samePerson(a.person, t.person))) })).filter(x => x.b)
      if (!common.length || common.length > 5) continue
      const identical = common.reduce((s, x) => s + Math.min(x.a.pct, x.b!.pct), 0)
      if (identical <= 50) continue
      const who = common.map(x => `${x.a.person ?? 'owner'} ${x.a.pct}% / ${x.b!.pct}%`).join(', ')
      // An S corporation is an excluded member: it changes nothing on this
      // return, so its formation date does not matter here.
      if (b.entity.form_type === '1120S') { excluded.push(b.entity.name); continue }
      const f = formation(ctx, b)
      if (!f) { unknownFormation.push(b.entity.name); continue }
      if (f > yearEnd) continue
      members.push({ name: b.entity.name, identical, owners: who })
    }
    const out: CheckResult[] = []
    const mapEv: Evidence = { where: `Entity map ownership on ${yearEnd}: ${mine.map(o => `${o.person ?? bundle(ctx, o.from)?.entity.name} ${o.pct}%`).join(', ')} of ${ctx.entity.name}${members.length ? `; ${members.map(m => `${m.name}: ${m.owners}`).join('; ')}` : ''}` }
    const k28 = scheduleKAnswer(cat, /member of a controlled group/i)
    const k3 = scheduleKAnswer(cat, /subsidiary in an affiliated group|parent.subsidiary controlled group/i)
    const schO = formEntries(cat, 'f1120so')
    const kEv = (a: { entry: CatalogEntry } | undefined): Evidence[] => (a ? [{ where: cite(cat, a.entry), entry_id: a.entry.id, catalog_id: cat.id, value: a.entry.label.slice(-3) }] : [])

    if (unknownFormation.length) {
      out.push({
        check: this.id, status: 'gap', severity: 'medium', key: 'formation',
        title: `${ctx.year}: when was ${unknownFormation.join(', ')} formed? Its controlled-group status depends on it`,
        detail: `${unknownFormation.join(', ')} shares more than 50% identical ownership with ${ctx.entity.name}. It is a member of the group only for years it existed on December 31; record its formation date.`,
        evidence: [mapEv], asks: ['entity.formation_date'],
      })
    }
    const excludedNote = excluded.length ? ` ${excluded.join(', ')} ${excluded.length === 1 ? 'is' : 'are'} also under common control but, as S corporations, excluded members (not listed as component members on Schedule O).` : ''
    if (members.length) {
      const names = members.map(m => m.name).join(', ')
      if (k28?.answer === 'No') {
        out.push({
          check: this.id, status: 'finding', severity: 'medium', key: 'k28',
          title: `${ctx.year}: Schedule K answers "No" to controlled-group membership, but ${ctx.entity.name} and ${names} were under common control on ${yearEnd}`,
          detail: `The same owner(s) held more than 50% of each on December 31 (identical ownership ${members.map(m => `${m.identical}%`).join(', ')}): a brother–sister controlled group. The return should answer Yes and attach Schedule O, which apportions the accumulated earnings credit and the $1 million large-corporation estimated-tax threshold; Florida's $50,000 exemption is shared by the group too.${excludedNote} If the ownership recorded in the entity map did not hold on ${yearEnd}, correct the map's years instead.`,
          evidence: [mapEv, ...kEv(k28)],
        })
      } else if (!schO.length) {
        out.push({
          check: this.id, status: 'finding', severity: 'medium', key: 'schedule_o',
          title: `${ctx.year}: no Schedule O, but ${ctx.entity.name} and ${names} were a controlled group on ${yearEnd}`,
          detail: `A component member of a controlled group files Schedule O every year.${excludedNote}`,
          evidence: [mapEv, ...kEv(k28)],
        })
      } else {
        const listed = schO.filter(e => e.kind === 'text').map(e => String(e.raw ?? e.value ?? ''))
        const missing = members.filter(m => !listed.some(t => namesEntity(t, m.name)))
        if (missing.length) {
          out.push({
            check: this.id, status: 'finding', severity: 'low', key: 'schedule_o_members',
            title: `${ctx.year}: Schedule O does not list ${missing.map(m => m.name).join(', ')}`,
            detail: `Schedule O lists every component member of the group.${excludedNote}`,
            evidence: [mapEv, { where: `${ctx.year} Schedule O (Form 1120)`, catalog_id: cat.id }],
          })
        }
      }
    } else if (!unknownFormation.length && k28?.answer === 'Yes') {
      out.push({
        check: this.id, status: 'finding', severity: 'low', key: 'k28',
        title: `${ctx.year}: Schedule K answers "Yes" to controlled-group membership, but no corporation in this account shared its owners on ${yearEnd}`,
        detail: 'Either a member is outside this account (record it in the entity map) or the answer is wrong.',
        evidence: [mapEv, ...kEv(k28)],
      })
    }
    const individualPct = individuals.reduce((s, o) => s + o.pct, 0)
    if (k3?.answer === 'Yes' && individualPct > 20) {
      out.push({
        check: this.id, status: 'finding', severity: 'medium', key: 'k3',
        title: `${ctx.year}: Schedule K says this is a subsidiary in an affiliated or parent–subsidiary group, but individuals own ${individualPct}% of it`,
        detail: 'A parent–subsidiary group needs a corporation owning at least 80% of this one; with more than 20% held by individuals that is impossible. The answer should be No.',
        evidence: [mapEv, ...kEv(k3)],
      })
    }
    if (!out.length) {
      out.push({
        check: this.id, status: 'pass', severity: 'info',
        title: members.length ? `${ctx.year}: controlled group with ${members.map(m => m.name).join(', ')} reported` : `${ctx.year}: no other corporation under common control; the return agrees`,
        detail: excludedNote.trim(), evidence: [mapEv, ...kEv(k28), ...kEv(k3)],
      })
    }
    return out
  },
}

export const crossEntityChecks: Check[] = [feesMatch, balancesMatch, controlledGroup]
