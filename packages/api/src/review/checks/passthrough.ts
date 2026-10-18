/**
 * Pass-through checks: NIIT on nonpassive income, stock basis and
 * distributions above it, Form 7203 against the K-1, the SSTB position on both
 * ends of the K-1, and shareholder loans.
 *
 * Each of these was a real miss on the Edgewater returns, found months apart:
 * 2023–2024 1040s reported EZA income as PASSIVE and paid 3.8% NIIT on it
 * (≈115,688 and 6,156); 2023 and 2024 distributions exceeded stock basis and no
 * gain was reported; the 2023 Form 7203 left line 3a blank; the K-1s marked the
 * business SSTB while the 1040s took the QBI deduction as non-SSTB; K-1 item I
 * reported a related company's loan as a shareholder loan.
 */
import type { Check, CheckResult, ReviewContext, CatalogView, Evidence } from '../types.js'
import { filed, amount, find, cite, ev, evs, money, transcript, transcriptValue, formEntries } from '../lookup.js'
import { scheduleERows, issuedK1s, scheduleKAsK1, basisItems, type IssuedK1 } from '../k1.js'

const NIIT_RATE = 0.038

/** Material participation answer for an issuer: true / false / undefined. */
function materiallyParticipated(ctx: ReviewContext, issuer: string, year: number): { value: boolean | undefined; ev?: Evidence } {
  for (const key of ['k1.material_participation', 'owners.material_participation']) {
    for (const subject of [issuer, undefined]) {
      const f = ctx.facts.get(key, { year, subject })
      if (f && f.status === 'answered') {
        const v = String(f.value ?? '').toLowerCase()
        const yes = !!v && !/^(no|none|false|passive|not_material|did_not)/.test(v)
        return { value: yes, ev: { where: `Recorded fact ${key}${subject ? ' (' + subject + ')' : ''}: ${f.value}`, fact: key, value: f.value } }
      }
    }
  }
  return { value: undefined }
}

function issuerFor(ctx: ReviewContext, ein: string, name: string) {
  return ctx.linked.find(l => l.relation === 'k1_issuer' && (
    (ein && String(l.entity.meta?.ein_digits ?? '') === ein) ||
    l.evidence.includes(`row`) && l.entity.name.toLowerCase().replace(/[^a-z]/g, '').startsWith(name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 10))
  ))
}

// ─── NIIT ────────────────────────────────────────────────────────────────────

const niitPassive: Check = {
  id: 'niit.nonpassive_income_taxed',
  version: 1,
  tie: true,
  area: 'niit',
  title: 'Business income from an activity you work in is not charged NIIT',
  applies: ['1040'],
  kind: 'rule',
  description: 'S-corporation or partnership income from a business you materially participate in is nonpassive (Schedule E column (k)) and excluded from net investment income (Form 8960 line 4b). Reported as passive (column (h)) with no 4b adjustment, it is charged 3.8% NIIT it does not owe.',
  run(ctx) {
    const cat = filed(ctx.catalogs, ctx.year)
    const rows = scheduleERows(cat)
    if (!cat || !rows.length) return [{ check: this.id, status: 'n/a', severity: 'info', title: 'No K-1 income on Schedule E', detail: '', evidence: [] }]
    const out: CheckResult[] = []
    const l4a = amount(cat, 'f8960', { line: '4a' }) ?? 0
    const l4b = amount(cat, 'f8960', { line: '4b' }) ?? 0
    for (const r of rows) {
      const rowEv = r.entries.find(e => e.col === 'h')
      if (r.passive_income > 0) {
        const mp = materiallyParticipated(ctx, r.name, ctx.year)
        const inNII = l4a >= r.passive_income - 1 && l4b === 0
        const tax = inNII ? Math.round(r.passive_income * NIIT_RATE) : 0
        const evidence = evs(
          rowEv ? { where: cite(cat, rowEv), entry_id: rowEv.id, catalog_id: cat.id, value: r.passive_income } : null,
          ev(cat, 'f8960', { line: '4a' }), ev(cat, 'f8960', { line: '4b' }), mp.ev,
        )
        if (mp.value === true) {
          out.push({
            check: this.id, status: 'finding', severity: 'high', key: r.row,
            title: `${ctx.year}: ${r.name} income reported as passive although you materially participate${tax ? ` — about ${money(tax)} of NIIT overpaid` : ''}`,
            detail: `Schedule E line 28 row ${r.row} puts ${money(r.passive_income)} in column (h), passive income.${inNII ? ` Form 8960 includes it in line 4a with no line 4b adjustment, so 3.8% NIIT (${money(tax)}) was charged on it.` : ''} With material participation recorded, it belongs in column (k) and is excluded from NIIT. A Form 1040-X recovers it within the refund window.`,
            evidence, dollar_effect: -tax,
          })
        } else if (mp.value === undefined) {
          out.push({
            check: this.id, status: 'gap', severity: 'high', key: r.row,
            title: `${ctx.year}: ${r.name} income is reported as passive — is that right?${tax ? ` (${money(tax)} of NIIT rides on it)` : ''}`,
            detail: `Schedule E row ${r.row} reports ${money(r.passive_income)} as passive income${inNII ? ' and Form 8960 charges NIIT on it' : ''}. If you worked in this business more than 500 hours (or met another §469 test), it is nonpassive and the NIIT is refundable.`,
            evidence, asks: ['k1.material_participation', 'k1.participation_hours'],
          })
        } else {
          out.push({ check: this.id, status: 'pass', severity: 'info', key: r.row, title: `${r.name}: passive treatment matches the recorded facts`, detail: '', evidence })
        }
      }
      if (r.nonpassive_income > 0 && l4a > 0 && l4b === 0 && l4a >= r.nonpassive_income - 1) {
        const tax = Math.round(r.nonpassive_income * NIIT_RATE)
        out.push({
          check: this.id, status: 'finding', severity: 'high', key: `${r.row}:4b`,
          title: `${ctx.year}: nonpassive ${r.name} income left in Form 8960 line 4a — about ${money(tax)} of NIIT`,
          detail: `Schedule E column (k) shows ${money(r.nonpassive_income)} of nonpassive income, but Form 8960 line 4b (the adjustment that removes it) is blank.`,
          evidence: evs(ev(cat, 'f8960', { line: '4a' }), ev(cat, 'f8960', { line: '4b' })), dollar_effect: -tax,
        })
      }
    }
    return out.length ? out : [{ check: this.id, status: 'pass', severity: 'info', title: 'No NIIT on nonpassive income', detail: '', evidence: [] }]
  },
}

// ─── Basis ───────────────────────────────────────────────────────────────────

export interface BasisYear {
  year: number
  source: string
  boy: number
  increases: number
  distributions: number
  excess: number
  nondeductible: number
  losses: number
  allowedLoss: number
  suspendedOut: number
  eoy: number
}

/**
 * Stock basis rolled forward from the first year, in the order of Reg.
 * 1.1367-1(f): income items, then distributions (any excess over basis is
 * gain, §1368(b)(2)), then nondeductible expenses, then losses (limited to
 * basis; the rest is suspended under §1366(d) and treated as incurred next
 * year). A year without a filed return falls back to the IRS transcript's
 * figure for ordinary income, and says so.
 */
export function basisRollforward(issuerCatalogs: CatalogView[], upTo: number, startBasis: number, firstYear: number, contributions: (y: number) => number): BasisYear[] {
  const out: BasisYear[] = []
  let basis = startBasis
  let suspended = 0
  for (let y = firstYear; y <= upTo; y++) {
    const cat = filed(issuerCatalogs, y)
    let k: IssuedK1 | undefined = issuedK1s(cat)[0] ?? scheduleKAsK1(cat)
    let source = cat ? `${y} Form 1120-S${issuedK1s(cat).length ? ' Schedule K-1' : ' Schedule K'}` : ''
    if (!k) {
      const t = transcriptValue(transcript(issuerCatalogs, y), 'Return information', /^Taxable Income$/i)
      if (t && typeof t.value === 'number') {
        k = { instance: 'transcript', shareholder: '', pct: 100, box: { '1': t.value }, codes: {}, itemI: {}, itemsBlank: [], entries: [] }
        source = `${y} IRS transcript (ordinary income as processed; no return copy)`
      }
    }
    if (!k) continue
    const b = basisItems(k)
    const boy = basis
    const inc = b.increases + contributions(y)
    let afterInc = boy + inc
    const excess = Math.max(0, b.distributions - afterInc)
    afterInc = Math.max(0, afterInc - b.distributions)
    const afterNd = Math.max(0, afterInc - b.nondeductible)
    const lossesNow = b.losses + suspended
    const allowed = Math.min(afterNd, lossesNow)
    suspended = lossesNow - allowed
    basis = afterNd - allowed
    out.push({ year: y, source, boy, increases: inc, distributions: b.distributions, excess, nondeductible: b.nondeductible, losses: lossesNow, allowedLoss: allowed, suspendedOut: suspended, eoy: basis })
  }
  return out
}

function firstYearOf(ctx: ReviewContext, cats: CatalogView[], entity?: { date_incorporated?: string | null }): number {
  const inc = entity?.date_incorporated ? Number(String(entity.date_incorporated).slice(0, 4)) : NaN
  const years = cats.map(c => c.tax_year ?? 9999)
  return Number.isFinite(inc) ? inc : Math.min(...years, ctx.year)
}

function basisCheckFor(ctx: ReviewContext, checkId: string, issuerName: string, issuerCats: CatalogView[], issuerEntity: { date_incorporated?: string | null }): CheckResult[] {
  const start = ctx.facts.get('owners.basis_at_inception', { subject: undefined }) ?? ctx.facts.get('k1.basis_at_inception', { subject: issuerName })
  const startBasis = start?.status === 'answered' && typeof start.value === 'number' ? start.value : 0
  const contrib = (y: number) => {
    const f = ctx.facts.get('owners.capital_contributions', { year: y }) ?? ctx.facts.get('k1.capital_contributions', { year: y, subject: issuerName })
    return f?.status === 'answered' && typeof f.value === 'number' ? f.value : 0
  }
  const first = firstYearOf(ctx, issuerCats, issuerEntity)
  const roll = basisRollforward(issuerCats, ctx.year, startBasis, first, contrib)
  const yr = roll.find(r => r.year === ctx.year)
  if (!yr) return [{ check: checkId, status: 'n/a', severity: 'info', title: `No ${issuerName} K-1 data for ${ctx.year}`, detail: '', evidence: [] }]
  const path = roll.map(r => `${r.year}: ${money(r.boy)} + ${money(r.increases)} − distributions ${money(r.distributions)}${r.excess ? ` (EXCESS ${money(r.excess)})` : ''} − nondeductible ${money(r.nondeductible)} − losses ${money(r.allowedLoss)}${r.suspendedOut ? ` (suspended ${money(r.suspendedOut)})` : ''} = ${money(r.eoy)} [${r.source}]`).join('\n')
  const assumptions = start?.status === 'answered' ? [] : ['k1.basis_at_inception']
  const out: CheckResult[] = []
  if (yr.excess > 0) {
    out.push({
      check: checkId, status: 'finding', severity: 'high', key: `${issuerName}:${ctx.year}:excess`,
      title: `${ctx.year}: ${issuerName} distributions exceeded stock basis by ${money(yr.excess)} — taxable gain`,
      detail: `Distributions above stock basis are long-term capital gain (§1368(b)(2)) that the K-1 does not report; it belongs on the shareholder's Form 8949/Schedule D. Estimated tax at 20%: ${money(yr.excess * 0.2)} (plus NIIT unless excluded under §1411(c)(4)).${assumptions.length ? ' Starting basis is assumed 0 — record it.' : ''}\nRollforward:\n${path}`,
      evidence: [{ where: yr.source, value: yr.excess }], dollar_effect: Math.round(yr.excess * 0.2), asks: [...assumptions, 'k1.capital_contributions'],
    })
  }
  if (yr.suspendedOut > 0) {
    out.push({
      check: checkId, status: 'finding', severity: 'medium', key: `${issuerName}:${ctx.year}:suspended`,
      title: `${ctx.year}: ${money(yr.suspendedOut)} of ${issuerName} losses suspended for lack of basis carry forward`,
      detail: `Losses above basis are not lost: §1366(d)(2) carries them to the next year with basis. Track them on Form 7203 Part III and deduct them when basis allows.\nRollforward:\n${path}`,
      evidence: [{ where: yr.source, value: yr.suspendedOut }],
    })
  }
  // Losses suspended in earlier years become deductible in the first year
  // with basis (§1366(d)(2)). On the recipient's 1040 they appear as a
  // prior-year unallowed loss (Schedule E line 27 "Yes", Form 7203 Part III);
  // if not, the deduction was missed.
  const prevYr = roll.find(r => r.year === ctx.year - 1)
  const carriedIn = prevYr?.suspendedOut ?? 0
  const released = Math.min(carriedIn, yr.allowedLoss)
  if (released > 0) {
    const recipients = ctx.entity.form_type === '1040' ? [{ name: ctx.entity.name, catalogs: ctx.catalogs }] : ctx.linked.filter(l => l.relation === 'k1_recipient').map(l => ({ name: l.entity.name, catalogs: l.catalogs }))
    for (const r of recipients) {
      const rc = filed(r.catalogs, ctx.year)
      const yes27 = formEntries(rc, 'f1040se').some(e => e.section === 'Part II' && e.line === '27' && e.kind === 'check' && e.value === true && /yes/i.test(e.label))
      const p3 = formEntries(rc, 'f7203').filter(e => e.section === 'Part III' && e.col === 'c' && typeof e.value === 'number' && e.value > 0).reduce((a, e) => a + (e.value as number), 0)
      if (!yes27 && p3 < released - 1) {
        const tax = Math.round(released * 0.37)
        out.push({
          check: checkId, status: 'finding', severity: 'high', key: `${issuerName}:${ctx.year}:released`,
          title: `${ctx.year}: ${money(released)} of ${issuerName} losses suspended in earlier years became deductible — ${r.name}'s ${ctx.year} return didn't deduct them (about ${money(tax)})`,
          detail: `In ${ctx.year} stock basis was enough to absorb ${money(released)} of losses carried in from earlier years. They are deducted as a prior-year unallowed loss on Schedule E (line 27 "Yes", with Form 7203 Part III). The ${ctx.year} 1040 shows neither. The amount depends on the earlier losses as the IRS processed them — confirm the figures before amending.\nRollforward:\n${path}`,
          evidence: [{ where: yr.source }], dollar_effect: -tax, asks: ['k1.suspended_losses_carried_in'],
        })
      }
    }
  }
  if (!out.length) out.push({ check: checkId, status: 'pass', severity: 'info', key: issuerName, title: `${ctx.year}: ${issuerName} distributions within basis (end of year ${money(yr.eoy)})`, detail: path, evidence: [{ where: yr.source }], ...(assumptions.length ? { asks: assumptions } : {}) })
  return out
}

const basisDistributions: Check = {
  id: 'basis.distributions_within_basis',
  version: 1,
  area: 'basis',
  title: 'Distributions stay within stock basis; suspended losses are tracked',
  applies: ['1120S', '1040'],
  kind: 'rule',
  description: 'Rolls stock basis forward from the company\'s first year using every K-1 (Reg. 1.1367-1(f) ordering) and flags distributions above basis (taxable gain the K-1 never shows) and losses suspended for lack of basis (deductible later).',
  run(ctx) {
    if (ctx.entity.form_type === '1120S') {
      return basisCheckFor(ctx, this.id, ctx.entity.name, ctx.catalogs, ctx.entity)
    }
    const issuers = ctx.linked.filter(l => l.relation === 'k1_issuer' && l.entity.form_type === '1120S')
    if (!issuers.length) {
      const rows = scheduleERows(filed(ctx.catalogs, ctx.year)).filter(r => r.type === 'S')
      if (!rows.length) return [{ check: this.id, status: 'n/a', severity: 'info', title: 'No S-corporation K-1s', detail: '', evidence: [] }]
      return rows.map(r => ({
        check: this.id, status: 'gap' as const, severity: 'medium' as const, key: r.row,
        title: `${ctx.year}: ${r.name} is not in the system, so its basis can't be rolled forward`,
        detail: 'Add the S corporation and catalogue its returns (or record its K-1s) so basis and distributions can be checked.',
        evidence: [], asks: ['k1.received', 'k1.basis_at_inception', 'k1.distributions'],
      }))
    }
    return issuers.flatMap(l => basisCheckFor(ctx, this.id, l.entity.name, l.catalogs, l.entity))
  },
}

const form7203: Check = {
  id: 'basis.form7203_matches_k1',
  version: 1,
  tie: true,
  area: 'basis',
  title: 'Form 7203 carries the K-1 figures',
  applies: ['1040'],
  kind: 'rule',
  description: 'Form 7203 must start from last year\'s ending basis and include every K-1 income item (the 2023 Form 7203 left the 3,044,422 of ordinary income off line 3a, then reported distributions far above the basis it showed). A 7203 is required whenever an S corporation made distributions.',
  run(ctx) {
    const cat = filed(ctx.catalogs, ctx.year)
    const out: CheckResult[] = []
    const has7203 = formEntries(cat, 'f7203').length > 0
    for (const l of ctx.linked.filter(x => x.relation === 'k1_issuer' && x.entity.form_type === '1120S')) {
      const k = issuedK1s(filed(l.catalogs, ctx.year))[0] ?? scheduleKAsK1(filed(l.catalogs, ctx.year))
      if (!k) continue
      const dist = basisItems(k).distributions
      if (!has7203) {
        if (dist > 0) out.push({ check: this.id, status: 'finding', severity: 'medium', key: l.entity.name, title: `${ctx.year}: no Form 7203 although ${l.entity.name} distributed ${money(dist)}`, detail: 'Form 7203 is required when an S corporation makes a distribution to you.', evidence: [] })
        continue
      }
      const l3a = amount(cat, 'f7203', { section: 'Part I', line: '3a' }) ?? 0
      const box1 = k.box['1'] ?? 0
      if (box1 > 0 && Math.abs(l3a - box1) > 1) {
        out.push({
          check: this.id, status: 'finding', severity: 'high', key: `${l.entity.name}:3a`,
          title: `${ctx.year}: Form 7203 line 3a shows ${money(l3a)}, the K-1 box 1 is ${money(box1)}`,
          detail: 'Ordinary business income increases stock basis; leaving it off line 3a understates basis — or, as here, shows distributions far above it without reporting the gain.',
          evidence: evs(ev(cat, 'f7203', { section: 'Part I', line: '3a' }), { where: `${ctx.year} ${l.entity.name} K-1 box 1`, value: box1 }),
        })
      }
      const l6 = amount(cat, 'f7203', { section: 'Part I', line: '6' }) ?? 0
      if (dist && Math.abs(l6 - dist) > 1) {
        out.push({
          check: this.id, status: 'finding', severity: 'medium', key: `${l.entity.name}:6`,
          title: `${ctx.year}: Form 7203 line 6 distributions ${money(l6)} vs K-1 box 16 code D ${money(dist)}`,
          detail: 'The distributions on Form 7203 must equal the K-1.',
          evidence: evs(ev(cat, 'f7203', { section: 'Part I', line: '6' }), { where: `${ctx.year} ${l.entity.name} K-1 box 16D`, value: dist }),
        })
      }
      const prior = filed(ctx.catalogs, ctx.year - 1)
      const priorEnd = amount(prior, 'f7203', { section: 'Part I', line: '15' })
      const l1 = amount(cat, 'f7203', { section: 'Part I', line: '1' })
      if (priorEnd !== undefined && l1 !== undefined && Math.abs(priorEnd - l1) > 1) {
        out.push({
          check: this.id, status: 'finding', severity: 'medium', key: `${l.entity.name}:1`,
          title: `${ctx.year}: Form 7203 opening basis ${money(l1)} ≠ ${ctx.year - 1} ending basis ${money(priorEnd)}`,
          detail: 'Line 1 must equal last year\'s line 15.',
          evidence: evs(ev(cat, 'f7203', { section: 'Part I', line: '1' }), ev(prior, 'f7203', { section: 'Part I', line: '15' })),
        })
      }
    }
    return out.length ? out : [{ check: this.id, status: has7203 ? 'pass' : 'n/a', severity: 'info', title: 'Form 7203 consistent with the K-1s', detail: '', evidence: [] }]
  },
}

// ─── SSTB / QBI ──────────────────────────────────────────────────────────────

/** NAICS codes in fields §199A(d)(2) lists (health, law, accounting,
 *  actuarial, performing arts, consulting, athletics, financial and brokerage
 *  services) — a code here makes a non-SSTB position need support. */
export const SSTB_NAICS = [/^5411/, /^5412/, /^5416/, /^6211/, /^6212/, /^6213/, /^6214/, /^6215/, /^6219/, /^5239/, /^5242/, /^5231/, /^7111/, /^7112/, /^7113/, /^7114/, /^7115/, /^524292/, /^541990/]

function statementMarksSSTB(cat: CatalogView | undefined): { marked: boolean; ev?: Evidence } {
  if (!cat) return { marked: false }
  // Statement rows render worksheet boxes as ☒/☐ (see markAnswers in the
  // cataloguer); only an explicit ☒Yes on an SSTB question counts.
  const hit = cat.entries.find(e => e.form === 'statement' && /SSTB|specified service/i.test(e.raw) && /☒\s*Yes/i.test(e.raw))
  return hit ? { marked: true, ev: { where: `${cat.tax_year} statement: "${hit.raw.slice(0, 80)}" (page ${hit.page})`, entry_id: hit.id, catalog_id: cat.id } } : { marked: false }
}

function marginalRate(taxable: number): number {
  return taxable > 700_000 ? 0.37 : taxable > 450_000 ? 0.35 : taxable > 380_000 ? 0.32 : 0.24
}

const sstbConsistency: Check = {
  id: 'qbi.sstb_position_consistent',
  version: 1,
  tie: true,
  area: 'qbi',
  title: 'The SSTB position agrees on the K-1, the 1040 and the business code',
  applies: ['1040', '1120S'],
  kind: 'rule',
  description: 'A QBI deduction taken as non-SSTB needs a business that is not in a §199A(d)(2) field. If the K-1 marks the business SSTB, or its activity code is accounting, law, consulting or another listed field, the 1040\'s non-SSTB deduction is exposed (EZA 2023: 501,393 deduction on an "accounting / tax preparation" code).',
  run(ctx) {
    const out: CheckResult[] = []
    const check1040 = (issuerName: string, issuerCats: CatalogView[]) => {
      const cat = filed(ctx.catalogs, ctx.year)
      const ded = amount(cat, 'f8995a', { section: 'Part IV', line: '39' }) ?? amount(cat, 'f8995', { line: '15' }) ?? 0
      if (!ded) return
      const sstbBox = formEntries(cat, 'f8995a').some(e => e.section === 'Part I' && e.col === 'b' && e.kind === 'check' && e.value === true)
      const icat = filed(issuerCats, ctx.year)
      const code = String(find(icat, 'f1120s', { line: 'B' })?.raw ?? '').replace(/\D/g, '')
      const codeSSTB = SSTB_NAICS.some(re => re.test(code))
      const st = statementMarksSSTB(icat)
      const taxable = amount(cat, 'f1040', { line: '15' }) ?? 0
      const cost = Math.round(ded * marginalRate(taxable))
      if (!sstbBox && (codeSSTB || st.marked)) {
        out.push({
          check: this.id, status: 'finding', severity: 'high', key: issuerName,
          title: `${ctx.year}: QBI deduction ${money(ded)} taken as non-SSTB, but ${st.marked ? "the K-1 marks the business SSTB" : `the business code ${code} is in a specified-service field`} — about ${money(cost)} at risk`,
          detail: `Above the phase-in threshold an SSTB gets no QBI deduction. Either document why the business is not a specified service (what it actually does, who performs the services) or correct the K-1/1040. Exposure: ${money(ded)} × ${(marginalRate(taxable) * 100).toFixed(0)}%, plus interest and possibly a 20% accuracy penalty.`,
          evidence: evs(ev(cat, 'f8995a', { section: 'Part IV', line: '39' }), icat ? ev(icat, 'f1120s', { line: 'B' }) : null, st.ev),
          dollar_effect: cost, asks: ['entity.sstb_determination', 'entity.sstb_rationale', 'entity.business_description'],
        })
      }
    }
    if (ctx.entity.form_type === '1040') {
      for (const l of ctx.linked.filter(x => x.relation === 'k1_issuer')) check1040(l.entity.name, l.catalogs)
    } else {
      const cat = filed(ctx.catalogs, ctx.year)
      const code = String(find(cat, 'f1120s', { line: 'B' })?.raw ?? '').replace(/\D/g, '')
      const st = statementMarksSSTB(cat)
      const fact = ctx.facts.get('entity.sstb_determination', { year: ctx.year })
      if (SSTB_NAICS.some(re => re.test(code)) && fact?.status === 'answered' && /not|no/i.test(String(fact.value)) && !st.marked) {
        out.push({ check: this.id, status: 'finding', severity: 'medium', key: 'code', title: `${ctx.year}: business code ${code} is an SSTB field but the recorded position is non-SSTB`, detail: 'The code the return reports should describe what the business does; a listed-field code undercuts the non-SSTB position.', evidence: evs(ev(cat, 'f1120s', { line: 'B' }), { where: `Recorded fact entity.sstb_determination: ${fact.value}`, fact: 'entity.sstb_determination' }) })
      }
      for (const l of ctx.linked.filter(x => x.relation === 'k1_recipient')) {
        const rcat = filed(l.catalogs, ctx.year)
        const ded = amount(rcat, 'f8995a', { section: 'Part IV', line: '39' }) ?? 0
        const sstbBox = formEntries(rcat, 'f8995a').some(e => e.section === 'Part I' && e.col === 'b' && e.kind === 'check' && e.value === true)
        if (ded && st.marked && !sstbBox) {
          out.push({ check: this.id, status: 'finding', severity: 'high', key: l.entity.name, title: `${ctx.year}: this K-1 marks the business SSTB, but ${l.entity.name}'s 1040 took ${money(ded)} of QBI as non-SSTB`, detail: 'The two returns contradict each other; whichever the IRS reads first decides the question. Correct one of them.', evidence: evs(st.ev, ev(rcat, 'f8995a', { section: 'Part IV', line: '39' })) })
        }
      }
    }
    return out.length ? out : [{ check: this.id, status: 'pass', severity: 'info', title: 'SSTB position consistent', detail: '', evidence: [] }]
  },
}

// ─── Shareholder loans (K-1 item I vs Schedule L) ───────────────────────────

const itemILoans: Check = {
  id: 'loans.k1_item_i_matches_schedule_l',
  version: 1,
  tie: true,
  area: 'loans',
  title: 'K-1 item I shows only real loans from the shareholder',
  applies: ['1120S'],
  kind: 'rule',
  description: 'Item I reports what the CORPORATION owes the SHAREHOLDER; it gives debt basis. It must agree with Schedule L line 19, and a loan from a related company (EV\'s advances to EZA) is not a shareholder loan — reporting it there overstates debt basis.',
  run(ctx) {
    const cat = filed(ctx.catalogs, ctx.year)
    const k1s = issuedK1s(cat)
    if (!cat || !k1s.length) return [{ check: this.id, status: 'n/a', severity: 'info', title: 'No K-1s', detail: '', evidence: [] }]
    const l19b = amount(cat, 'f1120s', { section: 'Schedule L', line: '19', col: 'b' }) ?? 0
    const l19d = amount(cat, 'f1120s', { section: 'Schedule L', line: '19', col: 'd' }) ?? 0
    const sumB = k1s.reduce((s, k) => s + (k.itemI.beginning ?? 0), 0)
    const sumE = k1s.reduce((s, k) => s + (k.itemI.end ?? 0), 0)
    const out: CheckResult[] = []
    if (Math.abs(sumB - l19b) > 1 || Math.abs(sumE - l19d) > 1) {
      out.push({
        check: this.id, status: 'finding', severity: 'medium', key: 'match',
        title: `${ctx.year}: K-1 item I (${money(sumB)} → ${money(sumE)}) disagrees with Schedule L line 19 (${money(l19b)} → ${money(l19d)})`,
        detail: 'Item I must equal the loans from shareholders on Schedule L. Find which is wrong; a related company\'s loan belongs on line 18/20/21, not 19 and not item I.',
        evidence: evs(ev(cat, 'f1120s', { section: 'Schedule L', line: '19', col: 'b' }), ev(cat, 'f1120s', { section: 'Schedule L', line: '19', col: 'd' }),
          ...k1s.map(k => ({ where: `${ctx.year} K-1${k.instance ? ' ' + k.instance : ''} item I`, value: `${k.itemI.beginning ?? 0} → ${k.itemI.end ?? 0}` }))),
      })
    }
    if (sumE > 0 || l19d > 0) {
      const f = ctx.facts.get('loans.from_owners', { year: ctx.year })
      if (!f || f.status !== 'answered') {
        out.push({
          check: this.id, status: 'gap', severity: 'medium', key: 'lender',
          title: `${ctx.year}: who actually lent the ${money(Math.max(sumE, l19d))} shown as loans from shareholders?`,
          detail: 'Only money the shareholder personally lent gives debt basis. Record each loan: the lender, the note, interest and repayments.',
          evidence: evs(ev(cat, 'f1120s', { section: 'Schedule L', line: '19', col: 'd' })),
          asks: ['loans.from_owners_exist', 'loans.from_owners', 'loans.from_related_entities_exist'],
        })
      }
    }
    return out.length ? out : [{ check: this.id, status: 'pass', severity: 'info', title: 'Item I agrees with Schedule L', detail: '', evidence: [] }]
  },
}

const loansToShareholders: Check = {
  id: 'loans.to_shareholders_documented',
  version: 1,
  area: 'loans',
  title: 'Loans to shareholders are real loans',
  applies: ['1120S', '1120'],
  kind: 'rule',
  description: 'A balance on Schedule L line 7 (loans to shareholders) that is not a documented loan — note, interest at the AFR, repayments — is a distribution (S corp: reduces basis, gain above it) or a dividend (C corp).',
  run(ctx) {
    const cat = filed(ctx.catalogs, ctx.year)
    const form = ctx.entity.form_type === '1120' ? 'f1120' : 'f1120s'
    const d = amount(cat, form, { section: 'Schedule L', line: '7', col: 'd' }) ?? 0
    if (!d) return [{ check: this.id, status: 'n/a', severity: 'info', title: 'No loans to shareholders', detail: '', evidence: [] }]
    const f = ctx.facts.get('loans.to_owners', { year: ctx.year })
    return [{
      check: this.id, status: f?.status === 'answered' ? 'pass' : 'gap', severity: f?.status === 'answered' ? 'info' : 'high',
      title: `${ctx.year}: ${money(d)} of loans to shareholders on Schedule L line 7`,
      detail: f?.status === 'answered' ? 'Loan terms recorded.' : 'Record the note, the interest rate and the repayment history. Without them the IRS can recharacterise the balance as a distribution or dividend.',
      evidence: evs(ev(cat, form, { section: 'Schedule L', line: '7', col: 'd' })),
      ...(f?.status === 'answered' ? {} : { asks: ['loans.to_owners_exist', 'loans.to_owners'] }),
    }]
  },
}

export const passthroughChecks: Check[] = [niitPassive, basisDistributions, form7203, sstbConsistency, itemILoans, loansToShareholders]
export { issuerFor }
