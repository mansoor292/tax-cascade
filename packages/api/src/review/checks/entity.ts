/**
 * Entity, income-completeness, preparation and fact-registry checks.
 */
import type { Check, CheckResult } from '../types.js'
import { filed, find, amount, ev, evs, money, formEntries, transcript, transcriptValue } from '../lookup.js'
import { issuedK1s } from '../k1.js'
import { beforeRecords } from './irs.js'

const electionDate: Check = {
  id: 'corporate.s_election_date',
  version: 1,
  area: 'corporate',
  title: 'S election date agrees with the IRS acceptance',
  applies: ['1120S'],
  kind: 'rule',
  description: 'The S election effective date on the return (item A) must match the IRS\'s acceptance (CP261) and the incorporation date; a mismatch can mean C-corporation years (built-in gains, E&P) that nobody has accounted for.',
  run(ctx) {
    const cat = filed(ctx.catalogs, ctx.year)
    const printed = String(find(cat, 'f1120s', { line: 'A' })?.raw ?? '').trim()
    const f = ctx.facts.get('scorp.election_effective_date')
    const ev1 = ev(cat, 'f1120s', { line: 'A' })
    if (!printed) return [{ check: this.id, status: cat ? 'finding' : 'n/a', severity: 'low', title: 'Item A (S election effective date) is blank', detail: 'Item A should carry the effective date of the S election.', evidence: evs(ev1) }]
    if (!f || f.status !== 'answered') return [{ check: this.id, status: 'gap', severity: 'low', title: `Return says the S election is effective ${printed}; the IRS acceptance isn't recorded`, detail: 'Record the CP261 acceptance letter\'s effective date.', evidence: evs(ev1), asks: ['scorp.election_effective_date', 'scorp.election_acceptance_date'] }]
    const norm = (s: string) => s.replace(/\D/g, '')
    const a = norm(printed), b = norm(String(f.value))
    const same = a === b || (a.length === 8 && b.length === 8 && a.slice(4) + a.slice(0, 4) === b) || (b.length === 8 && a.length === 8 && (a.slice(4) + a.slice(0, 2) + a.slice(2, 4)) === b)
    return [{ check: this.id, status: same ? 'pass' : 'finding', severity: same ? 'info' : 'high', title: same ? `S election date ${printed} matches the IRS acceptance` : `Return says S election effective ${printed}; IRS acceptance says ${f.value}`, detail: same ? '' : 'Years before the effective date are C-corporation years.', evidence: evs(ev1, { where: `Recorded fact scorp.election_effective_date: ${f.value}`, fact: 'scorp.election_effective_date' }) }]
  },
}

const k1Blanks: Check = {
  id: 'k1.items_complete',
  version: 1,
  area: 'k1',
  title: 'K-1 identification items are filled in',
  applies: ['1120S'],
  kind: 'rule',
  description: 'Items C (IRS center), D (corporation\'s shares) and H (shareholder\'s shares) are required; blank share counts were carried on every EZA K-1.',
  run(ctx) {
    const cat = filed(ctx.catalogs, ctx.year)
    const k1s = issuedK1s(cat)
    if (!k1s.length) return [{ check: this.id, status: 'n/a', severity: 'info', title: 'No K-1s', detail: '', evidence: [] }]
    const out: CheckResult[] = k1s.filter(k => k.itemsBlank.length).map(k => ({
      check: this.id, status: 'finding' as const, severity: 'low' as const, key: k.instance || 'k1',
      title: `${ctx.year} K-1${k.instance ? ' ' + k.instance : ''}: item(s) ${k.itemsBlank.join(', ')} blank`,
      detail: 'Fill in the share counts and the IRS center; record the share count once so every year carries it.',
      evidence: [], asks: ['corp.shares_outstanding_end', 'owners.shares_end'],
    }))
    return out.length ? out : [{ check: this.id, status: 'pass', severity: 'info', title: 'K-1 items complete', detail: '', evidence: [] }]
  },
}

const preparerBlock: Check = {
  id: 'preparation.self_prepared_preparer_block',
  version: 1,
  area: 'preparation',
  title: 'A self-prepared return leaves the paid-preparer block empty',
  applies: ['1040', '1120', '1120S', '1065'],
  kind: 'rule',
  description: 'The paid-preparer block is for a preparer paid by the taxpayer. An officer preparing the company\'s own return, or a taxpayer preparing their own, is not a paid preparer.',
  run(ctx) {
    const cat = filed(ctx.catalogs, ctx.year)
    const form = { '1040': 'f1040', '1120': 'f1120', '1120S': 'f1120s', '1065': 'f1065' }[ctx.entity.form_type]
    const prep = formEntries(cat, form).find(e => /Print\/Type preparer|Preparer.s name/i.test(e.label) && e.raw)
    if (!prep) return [{ check: this.id, status: cat ? 'pass' : 'n/a', severity: 'info', title: 'No paid preparer named', detail: '', evidence: [] }]
    const owners = (ctx.entity.meta?.owners as Array<{ name?: string }> | undefined) ?? []
    const names = [ctx.entity.name, ...owners.map(o => o.name ?? ''), String(ctx.entity.meta?.spouse_first ?? '') + ' ' + String(ctx.entity.meta?.spouse_last ?? '')].map(s => s.toLowerCase())
    const p = String(prep.raw).toLowerCase()
    const self = names.some(n => n.trim() && n.split(/\s+/).filter(w => w.length > 2).every(w => p.includes(w)))
    return [{ check: this.id, status: self ? 'finding' : 'pass', severity: self ? 'low' : 'info', title: self ? `${ctx.year}: the taxpayer/owner is named as the paid preparer` : `Paid preparer named`, detail: self ? 'Leave the paid-preparer block blank on a self-prepared return.' : '', evidence: [{ where: `${ctx.year} preparer block (page ${prep.page})`, entry_id: prep.id, catalog_id: cat?.id }] }]
  },
}

const infoReturns: Check = {
  id: 'income.information_returns_reported',
  version: 1,
  area: 'income',
  title: 'Every 1099 on file is reported',
  applies: ['1120S', '1120', '1040'],
  kind: 'rule',
  description: 'Interest and dividends on Forms 1099 recorded for the year must appear on the return (EZA 2022 left $2,098 of interest and $803 of dividends off Schedule K entirely). The IRS matches these automatically.',
  run(ctx) {
    const cat = filed(ctx.catalogs, ctx.year)
    if (!cat) return [{ check: this.id, status: 'n/a', severity: 'info', title: 'No return', detail: '', evidence: [] }]
    const docs = ctx.documents.filter(d => d.tax_year === ctx.year)
    const sum = (types: string[], keys: string[]) => docs.filter(d => types.includes(d.doc_type)).reduce((s, d) => s + keys.reduce((a, k) => a + (Number(d.key_values[k]) || 0), 0), 0)
    const interest = sum(['1099_int'], ['box1_interest'])
    const divs = sum(['1099_div'], ['box1a_ordinary_dividends'])
    if (!interest && !divs) return [{ check: this.id, status: 'n/a', severity: 'info', title: 'No 1099 interest or dividends on file', detail: '', evidence: [] }]
    const sel = ctx.entity.form_type === '1120S'
      ? { int: ['f1120s', { section: 'Schedule K', line: '4' }] as const, div: ['f1120s', { section: 'Schedule K', line: '5a' }] as const }
      : ctx.entity.form_type === '1120'
        ? { int: ['f1120', { line: '5' }] as const, div: ['f1120', { line: '4' }] as const }
        : { int: ['f1040', { line: '2b' }] as const, div: ['f1040', { line: '3b' }] as const }
    const onInt = amount(cat, sel.int[0], sel.int[1]) ?? 0
    const onDiv = amount(cat, sel.div[0], sel.div[1]) ?? 0
    const out: CheckResult[] = []
    if (interest - onInt > 1) out.push({ check: this.id, status: 'finding', severity: 'medium', key: 'int', title: `${ctx.year}: 1099 interest ${money(interest)}, return reports ${money(onInt)}`, detail: 'Interest on Forms 1099 is missing from the return; the IRS matching program will propose the difference.', evidence: evs(ev(cat, sel.int[0], sel.int[1])) })
    if (divs - onDiv > 1) out.push({ check: this.id, status: 'finding', severity: 'medium', key: 'div', title: `${ctx.year}: 1099 dividends ${money(divs)}, return reports ${money(onDiv)}`, detail: 'Dividends on Forms 1099 are missing from the return.', evidence: evs(ev(cat, sel.div[0], sel.div[1])) })
    return out.length ? out : [{ check: this.id, status: 'pass', severity: 'info', title: '1099 interest and dividends reported', detail: '', evidence: [] }]
  },
}

const lossYearSuspended: Check = {
  id: 'basis.loss_year_without_basis',
  version: 1,
  area: 'basis',
  title: 'A loss year is tracked against the owner\'s basis',
  applies: ['1120S'],
  kind: 'rule',
  description: 'An S-corporation loss passes through only to the extent of the shareholder\'s stock and debt basis; the rest is suspended and deductible later. EZA\'s 2021 loss (−41,424 as processed) was funded by a related company\'s loan — no debt basis — and never deducted; it carries forward.',
  run(ctx) {
    const cat = filed(ctx.catalogs, ctx.year)
    const line = ctx.year >= 2023 ? '22' : '21'
    let loss = amount(cat, 'f1120s', { line }) ?? 0
    let where = `${ctx.year} Form 1120-S line ${line}`
    if (!cat) {
      const t = transcriptValue(transcript(ctx.catalogs, ctx.year), 'Return information', /^Taxable Income$/i)
      if (t && typeof t.value === 'number') { loss = t.value; where = `${ctx.year} IRS transcript: ${t.entry.raw}` }
    }
    if (loss >= 0) return [{ check: this.id, status: 'n/a', severity: 'info', title: 'Not a loss year', detail: '', evidence: [] }]
    const f = ctx.facts.get('owners.suspended_losses_carried_in', { year: ctx.year + 1 })
    return [{
      check: this.id, status: f?.status === 'answered' ? 'pass' : 'gap', severity: 'medium',
      title: `${ctx.year}: ordinary loss ${money(loss)} — how much did the shareholder have basis to deduct?`,
      detail: 'Record the shareholder\'s stock basis at the start of the year, capital contributed, and any loans the SHAREHOLDER personally made (a related company\'s loan gives no basis). Loss above basis is suspended and carries forward under §1366(d)(2).',
      evidence: [{ where, value: loss }], asks: ['owners.basis_at_inception', 'owners.capital_contributions', 'owners.direct_loan_balance_end', 'owners.suspended_losses_carried_in'],
    }]
  },
}

const factGaps: Check = {
  id: 'facts.required_answered',
  version: 2,
  area: 'facts',
  title: 'Every fact this return type requires is answered',
  applies: ['1040', '1120', '1120S', '1065'],
  kind: 'fact',
  description: 'The fact registry lists what every return of this type must know (ownership, elections, loans and lenders, material participation, IRS events…). Unanswered facts are asked all at once, and contradicted ones — where the return says something different — are findings.',
  run(ctx) {
    const gaps = ctx.factGaps ?? []
    if (!gaps.length) return [{ check: this.id, status: 'n/a', severity: 'info', title: 'Fact registry not evaluated', detail: '', evidence: [] }]
    // A year before anything on file asks 47 questions nobody needs answered
    // (the same reasoning as catalog.return_present; UI audit 2026-10-22).
    const first = beforeRecords(ctx)
    if (first !== undefined) return [{ check: this.id, status: 'n/a', severity: 'info', title: `${ctx.year} is before the first year on file here (${first})`, detail: '', evidence: [] }]
    const missing = gaps.filter(g => g.status === 'missing' || g.status === 'unknown')
    const contradicted = gaps.filter(g => g.status === 'contradicted')
    const out: CheckResult[] = contradicted.map(g => ({ check: this.id, status: 'finding' as const, severity: 'high' as const, key: g.key, title: `Recorded answer to "${g.question}" contradicts the return`, detail: 'Either the recorded fact or the return is wrong.', evidence: [{ where: `fact ${g.key}`, fact: g.key }] }))
    if (missing.length) out.push({ check: this.id, status: 'gap', severity: 'medium', key: 'missing', title: `${missing.length} required fact(s) unanswered for ${ctx.year}`, detail: missing.slice(0, 40).map(g => `• ${g.question}`).join('\n'), evidence: [], asks: missing.map(g => g.key) })
    return out.length ? out : [{ check: this.id, status: 'pass', severity: 'info', title: 'All required facts answered', detail: '', evidence: [] }]
  },
}

export const entityChecks: Check[] = [electionDate, k1Blanks, preparerBlock, infoReturns, lossYearSuspended, factGaps]
