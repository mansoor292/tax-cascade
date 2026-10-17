/**
 * The IRS's own record, and the clock.
 *
 * Statute dates run from when the IRS actually received a return — which for
 * EZA's 2021 return was the third copy, 12 Feb 2024, not the first (15 Sep
 * 2022). Refund claims die three years after filing (§6511); the IRS's
 * assessment window closes three years after filing (§6501). Penalties
 * (TC166/176/246/270/276) and their first-time-abatement history decide what
 * to request; TC976 duplicates mean the IRS may have processed the wrong copy.
 */
import type { Check, CheckResult, ReviewContext } from '../types.js'
import { transcript, transactions, transcriptValue, parseDate, iso, money, filed, amount } from '../lookup.js'

const PENALTY_CODES: Record<string, string> = {
  '166': 'failure-to-file / late-filing penalty',
  '176': 'estimated tax penalty',
  '246': 'failure-to-file penalty (S corporation / partnership, per shareholder per month)',
  '270': 'failure-to-pay penalty',
  '276': 'failure-to-pay penalty',
  '160': 'failure-to-file penalty',
  '186': 'estimated tax penalty',
}

/** Original due date (calendar-year filers), and the extended one. */
function dueDates(formType: string, year: number): { due: Date; extended: Date } {
  const y = year + 1
  if (formType === '1120S' || formType === '1065') return { due: new Date(Date.UTC(y, 2, 15)), extended: new Date(Date.UTC(y, 8, 15)) }
  if (formType === '1120') return { due: new Date(Date.UTC(y, 3, 15)), extended: new Date(Date.UTC(y, 9, 15)) }
  return { due: new Date(Date.UTC(y, 3, 15)), extended: new Date(Date.UTC(y, 9, 15)) }
}

function addYears(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear() + n, d.getUTCMonth(), d.getUTCDate()))
}

/** When the return counts as filed, and how we know. */
export function filingDate(ctx: ReviewContext, year: number): { date?: Date; source: string; assumed: boolean } {
  const t = transcript(ctx.catalogs, year)
  const rec = transcriptValue(t, 'Return information', /return received date/i)
  if (rec?.date) return { date: parseDate(rec.date), source: `${year} IRS transcript: return received ${rec.date}`, assumed: false }
  const tc150 = transactions(t).find(x => x.code === '150')
  if (tc150?.date) return { date: parseDate(tc150.date), source: `${year} IRS transcript: TC150 ${tc150.date}`, assumed: false }
  const f = ctx.facts.get('irs.filing_date', { year })
  if (f?.status === 'answered' && typeof f.value === 'string') {
    const d = parseDate(f.value)
    if (d) return { date: d, source: `Recorded filing date ${f.value}`, assumed: false }
  }
  const { due, extended } = dueDates(ctx.entity.form_type, year)
  const ext = ctx.facts.get('irs.extension_filed', { year })
  // An early-filed return is treated as filed on the due date (§6501(b)(1), §6513(a)).
  return { date: ext?.value === false ? due : extended, source: `not known — assumed the ${ext?.value === false ? 'original' : 'extended'} due date`, assumed: true }
}

const statute: Check = {
  id: 'statute.windows',
  version: 1,
  area: 'statute',
  title: 'Refund and assessment windows for the year',
  applies: ['1040', '1120', '1120S', '1065'],
  kind: 'rule',
  description: 'A refund claim must be filed within three years of the filing date (§6511); the IRS can assess for three years (§6501). Every amendment decision for a year depends on these dates, and they run from the date the IRS actually received the return.',
  run(ctx) {
    const fd = filingDate(ctx, ctx.year)
    if (!fd.date) return [{ check: this.id, status: 'gap', severity: 'medium', title: `${ctx.year} filing date unknown`, detail: '', evidence: [], asks: ['irs.filing_date'] }]
    const refund = addYears(fd.date, 3)
    const days = Math.round((refund.getTime() - ctx.today.getTime()) / 86_400_000)
    const open = days >= 0
    // A window that "closed" in the last 120 days on an ASSUMED filing date
    // may still be open (the real date can be later) — that is urgent, not
    // history.
    const severity = !open ? (fd.assumed && days > -120 ? 'high' : 'info') : days <= 120 ? 'high' : days <= 365 ? 'medium' : 'info'
    return [{
      check: this.id, status: fd.assumed ? 'gap' : (open && days <= 365 ? 'finding' : 'pass'), severity,
      title: open
        ? `${ctx.year}: refund window closes ${iso(refund)} (${days} days)${fd.assumed ? ' — filing date assumed' : ''}`
        : `${ctx.year}: refund window closed ${iso(refund)}${fd.assumed ? ' (filing date assumed)' : ''}`,
      detail: `Filed: ${fd.source}. Refund claims (Form 1040-X / 1120-X / amended 1120-S) must be filed by ${iso(refund)}; the IRS's assessment window for ${ctx.year} also closes ${iso(addYears(fd.date, 3))} (six years if income was understated by more than 25%). ${fd.assumed ? 'The real filing date may differ — the account transcript shows it.' : ''}`,
      evidence: [{ where: fd.source }], deadline: iso(refund),
      ...(fd.assumed ? { asks: ['irs.filing_date', 'irs.transcript_date'] } : {}),
    }]
  },
}

const transcriptAccount: Check = {
  id: 'irs.account_status',
  version: 1,
  area: 'irs_account',
  title: 'What the IRS processed, duplicates, penalties and balance due',
  applies: ['1040', '1120', '1120S', '1065'],
  kind: 'rule',
  description: 'Reads the account transcript: the processed return (TC150) and whether its figures match the catalogued return, duplicates set aside (TC976/977), penalties assessed and whether they qualify for abatement, the balance due, and lateness against the due date.',
  run(ctx) {
    const t = transcript(ctx.catalogs, ctx.year)
    if (!t) return [{ check: this.id, status: 'n/a', severity: 'info', title: 'No transcript (see catalog.transcript_present)', detail: '', evidence: [] }]
    const txs = transactions(t)
    const out: CheckResult[] = []
    const cite = (x: { code: string; label: string; amount: number; date?: string }) => ({ where: `${ctx.year} IRS transcript: TC${x.code} ${x.label} ${x.date ?? ''} ${money(x.amount)}`, catalog_id: t.id, value: x.amount })
    const tc150 = txs.find(x => x.code === '150')
    if (!tc150) out.push({ check: this.id, status: 'finding', severity: 'high', key: '150', title: `${ctx.year}: no TC150 — the IRS shows no processed return`, detail: 'Without a TC150 the IRS treats the year as unfiled. Confirm whether a return was sent and where it posted (returns have posted to the wrong period before).', evidence: [] })
    const dups = txs.filter(x => x.code === '976' || x.code === '977')
    if (dups.length) {
      out.push({
        check: this.id, status: 'finding', severity: 'medium', key: '976',
        title: `${ctx.year}: ${dups.length} additional return(s) received and set aside (${dups.map(d => `TC${d.code} ${d.date}`).join(', ')})`,
        detail: 'The IRS received more than one return for this period and processed only one. Confirm the processed one is the right version; the earliest receipt date supports penalty relief.',
        evidence: dups.map(cite),
      })
    }
    const pens = txs.filter(x => PENALTY_CODES[x.code] && x.amount > 0)
    if (pens.length) {
      const total = pens.reduce((s, p) => s + p.amount, 0)
      out.push({
        check: this.id, status: 'finding', severity: 'medium', key: 'penalties',
        title: `${ctx.year}: penalties assessed ${money(total)} (${pens.map(p => `TC${p.code}`).join(', ')})`,
        detail: `${pens.map(p => `${PENALTY_CODES[p.code]} ${money(p.amount)} on ${p.date}`).join('; ')}. First-time abatement needs a clean prior three years; otherwise reasonable cause. ${dups.length ? `A return received earlier (${dups[0].date}) supports cutting a late-filing penalty to the months before that date.` : ''}`,
        evidence: pens.map(cite), asks: ['irs.penalties'],
      })
    }
    const bal = transcriptValue(t, 'Account', /^Account balance plus accruals|^Account balance$/i)
    if (bal && typeof bal.value === 'number' && bal.value > 0) {
      out.push({ check: this.id, status: 'finding', severity: 'medium', key: 'balance', title: `${ctx.year}: ${money(bal.value)} owed to the IRS per the transcript`, detail: 'Pay it or request abatement; interest accrues daily.', evidence: [{ where: `${ctx.year} IRS transcript: ${bal.entry.raw}`, catalog_id: t.id, value: bal.value }], dollar_effect: bal.value })
    }
    const rec = transcriptValue(t, 'Return information', /return received date/i)
    const { due, extended } = dueDates(ctx.entity.form_type, ctx.year)
    const received = parseDate(rec?.date)
    if (received && received.getTime() > extended.getTime()) {
      out.push({ check: this.id, status: 'finding', severity: 'medium', key: 'late', title: `${ctx.year}: return received ${rec!.date}, after the extended due date ${iso(extended)}`, detail: `Original due date ${iso(due)}. A return processed late draws late-filing penalties and starts the statute later.`, evidence: [{ where: `${ctx.year} IRS transcript: ${rec!.entry.raw}`, catalog_id: t.id }] })
    }
    // Does the processed return match the catalogued one?
    const cat = filed(ctx.catalogs, ctx.year)
    const ti = transcriptValue(t, 'Return information', /^Taxable Income$/i)
    if (cat && ti && typeof ti.value === 'number') {
      const ours = ctx.entity.form_type === '1120S'
        ? amount(cat, 'f1120s', { line: ctx.year >= 2023 ? '22' : '21' })
        : ctx.entity.form_type === '1120' ? amount(cat, 'f1120', { line: '30' }) : amount(cat, 'f1040', { line: '15' })
      if (ours !== undefined && Math.abs(ours - ti.value) > 1) {
        out.push({ check: this.id, status: 'finding', severity: 'high', key: 'mismatch', title: `${ctx.year}: the IRS processed taxable income of ${money(ti.value)}; the catalogued return shows ${money(ours)}`, detail: 'The IRS processed a different return from the one on file here (another copy, an amendment, or a return posted to the wrong period). Find out which.', evidence: [{ where: `${ctx.year} IRS transcript: ${ti.entry.raw}`, catalog_id: t.id }] })
      }
    }
    return out.length ? out : [{ check: this.id, status: 'pass', severity: 'info', title: `${ctx.year} account clean`, detail: '', evidence: [] }]
  },
}

export const irsChecks: Check[] = [statute, transcriptAccount]
