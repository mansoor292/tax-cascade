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
import { nextBusinessDay } from '../../engine/tax_calendar.js'

const PENALTY_CODES: Record<string, string> = {
  '166': 'failure-to-file / late-filing penalty',
  '176': 'estimated tax penalty',
  '246': 'failure-to-file penalty (S corporation / partnership, per shareholder per month)',
  '270': 'failure-to-pay penalty',
  '276': 'failure-to-pay penalty',
  '160': 'failure-to-file penalty',
  '186': 'estimated tax penalty',
}

/** Original due date (calendar-year filers), and the extended one — each
 *  rolled past weekends and holidays (§7503). Without the roll a 1040 filed
 *  Mon 16 Oct 2023 (the 15th was a Sunday) was reported late. */
export function dueDates(formType: string, year: number): { due: Date; extended: Date } {
  const y = year + 1
  const day = (m: number) => new Date(`${nextBusinessDay(`${y}-${String(m).padStart(2, '0')}-15`)}T00:00:00Z`)
  if (formType === '1120S' || formType === '1065') return { due: day(3), extended: day(9) }
  return { due: day(4), extended: day(10) }
}

/** Taxable income as the catalogued return for `year` prints it. */
function returnTaxable(ctx: ReviewContext, year: number): number | undefined {
  const cat = filed(ctx.catalogs, year)
  if (!cat) return undefined
  if (ctx.entity.form_type === '1120S') return amount(cat, 'f1120s', { line: year >= 2023 ? '22' : '21' })
  if (ctx.entity.form_type === '1120') return amount(cat, 'f1120', { line: '30' })
  return amount(cat, 'f1040', { line: '15' })
}

const FAILURE_TO_FILE = new Set(['160', '166', '246'])
const DAY = 86_400_000

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
  version: 2,
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
  version: 2,
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
    const asOf = String(transcriptValue(t, 'Header', /^Response Date$/i)?.value ?? transcriptValue(t, 'Header', /^Request Date$/i)?.value ?? '')
    const asOfDate = parseDate(asOf)
    if (!tc150) {
      // A transcript pulled before or soon after the return went in cannot
      // show it yet; that is a reason to pull a new one, not an unfiled year.
      const fdFact = ctx.facts.get('irs.filing_date', { year: ctx.year })
      const filedOn = fdFact?.status === 'answered' && typeof fdFact.value === 'string' ? parseDate(fdFact.value) : undefined
      const onFile = !!filed(ctx.catalogs, ctx.year)
      if (filedOn && asOfDate && asOfDate.getTime() < filedOn.getTime() + 90 * DAY) {
        out.push({ check: this.id, status: 'gap', severity: 'low', key: '150', title: `${ctx.year}: return filed ${iso(filedOn)} — not yet posted on the transcript dated ${asOf}`, detail: `The transcript predates the return's processing. Pull a new account transcript after ${iso(new Date(filedOn.getTime() + 90 * DAY))} and confirm a TC150 for ${ctx.year}.`, evidence: [{ where: `${ctx.year} IRS transcript dated ${asOf}`, catalog_id: t.id }] })
      } else if (onFile && !filedOn) {
        out.push({ check: this.id, status: 'gap', severity: 'medium', key: '150', title: `${ctx.year}: a return is on file here, but the transcript${asOf ? ` dated ${asOf}` : ''} shows none processed`, detail: 'If the return was filed after the transcript date that is expected — record the filing date. Otherwise confirm where it posted (returns have posted to the wrong period before).', evidence: [{ where: `${ctx.year} IRS transcript${asOf ? ` dated ${asOf}` : ''}`, catalog_id: t.id }], asks: ['irs.filing_date'] })
      } else {
        out.push({ check: this.id, status: 'finding', severity: 'high', key: '150', title: `${ctx.year}: no TC150 — the IRS shows no processed return`, detail: 'Without a TC150 the IRS treats the year as unfiled. Confirm whether a return was sent and where it posted (returns have posted to the wrong period before).', evidence: [{ where: `${ctx.year} IRS transcript${asOf ? ` dated ${asOf}` : ''}`, catalog_id: t.id }] })
      }
    }
    const dups = txs.filter(x => x.code === '976' || x.code === '977')
    // An earlier receipt only helps a failure-to-file penalty, and only if it
    // really is earlier than the receipt the IRS counted.
    const counted = parseDate(transcriptValue(t, 'Return information', /return received date/i)?.date) ?? parseDate(tc150?.date)
    const earlier = dups.map(d => ({ d, at: parseDate(d.date) })).filter(x => x.at && counted && x.at.getTime() < counted.getTime())
      .sort((a, b) => a.at!.getTime() - b.at!.getTime())[0]
    if (dups.length) {
      out.push({
        check: this.id, status: 'finding', severity: 'medium', key: '976',
        title: `${ctx.year}: ${dups.length} additional return(s) received and set aside (${dups.map(d => `TC${d.code} ${d.date}`).join(', ')})`,
        detail: `The IRS received more than one return for this period and processed only one. Confirm the processed one is the right version.${earlier ? ` A copy arrived ${earlier.d.date}, before the receipt the IRS counted (${iso(counted!)}) — that date supports cutting a late-filing penalty.` : ''}`,
        evidence: dups.map(cite),
      })
    }
    const pens = txs.filter(x => PENALTY_CODES[x.code] && x.amount > 0)
    const ftf = pens.some(p => FAILURE_TO_FILE.has(p.code))
    if (pens.length) {
      const total = pens.reduce((s, p) => s + p.amount, 0)
      out.push({
        check: this.id, status: 'finding', severity: 'medium', key: 'penalties',
        title: `${ctx.year}: penalties assessed ${money(total)} (${pens.map(p => `TC${p.code}`).join(', ')})`,
        detail: `${pens.map(p => `${PENALTY_CODES[p.code]} ${money(p.amount)} on ${p.date}`).join('; ')}. First-time abatement needs a clean prior three years; otherwise reasonable cause.${ftf && earlier ? ` A return received earlier (${earlier.d.date}) supports cutting the late-filing penalty to the months before that date.` : ''}`,
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
    // Does the processed return match the catalogued one? If it matches
    // ANOTHER year's return, the IRS posted that return to this period —
    // EZA's 2023 return posted to 2024 and its 2024 return to 2025.
    const ti = transcriptValue(t, 'Return information', /^Taxable Income$/i)
    const ours = returnTaxable(ctx, ctx.year)
    if (ti && typeof ti.value === 'number' && ours !== undefined && Math.abs(ours - ti.value) > 1) {
      const posted = [ctx.year - 1, ctx.year + 1, ctx.year - 2, ctx.year + 2].find(y => {
        const v = returnTaxable(ctx, y)
        return v !== undefined && v !== 0 && Math.abs(v - (ti.value as number)) <= 1
      })
      const where = { where: `${ctx.year} IRS transcript: ${ti.entry.raw}`, catalog_id: t.id }
      out.push(posted !== undefined
        ? { check: this.id, status: 'finding', severity: 'high', key: 'mismatch', title: `${ctx.year}: the IRS posted the ${posted} return to ${ctx.year} (taxable income ${money(ti.value)}); the ${ctx.year} return (${money(ours)}) is not processed`, detail: `The return the IRS processed for ${ctx.year} carries the ${posted} return's taxable income. Ask the IRS to move it to ${posted} and process the ${ctx.year} return. Until it does, a ${ctx.year} return sent in will be set aside as a duplicate (TC976), and ${ctx.year}'s penalties and statute dates are running on the wrong return.`, evidence: [where] }
        : { check: this.id, status: 'finding', severity: 'high', key: 'mismatch', title: `${ctx.year}: the IRS processed taxable income of ${money(ti.value)}; the catalogued return shows ${money(ours)}`, detail: 'The IRS processed a different return from the one on file here (another copy, an amendment, or a return posted to the wrong period). Find out which.', evidence: [where] })
    }
    return out.length ? out : [{ check: this.id, status: 'pass', severity: 'info', title: `${ctx.year} account clean`, detail: '', evidence: [] }]
  },
}

export const irsChecks: Check[] = [statute, transcriptAccount]
