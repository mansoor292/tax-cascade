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
import type { Check, CheckResult, ReviewContext, CatalogView } from '../types.js'
import { transcript, returnTranscript, returnLine, noRecord, transactions, transcriptValue, parseDate, iso, money, filed, amount } from '../lookup.js'
import { goldenRows, heldYear, type GoldenRow } from '../../schema/golden.js'
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

/** Each penalty is reduced or removed by the next transaction code (TC177
 *  removes a TC176, TC277 a TC276, TC247 a TC246…). Without netting them,
 *  EV's 2024 transcript — every penalty reversed the day it was assessed —
 *  read as 6,223 of penalties owed (2026-10-18). */
const REVERSES: Record<string, string> = Object.fromEntries(Object.keys(PENALTY_CODES).map(c => [String(Number(c) + 1), c]))

type Tx = ReturnType<typeof transactions>[number]

/** Penalties still standing: each assessment less the reversals of its code,
 *  applied oldest assessment first. */
export function standingPenalties(txs: Tx[]): { standing: Array<Tx & { gross: number }>; reversals: Tx[] } {
  const reversals = txs.filter(x => REVERSES[x.code])
  const left: Record<string, number> = {}
  for (const r of reversals) left[REVERSES[r.code]] = (left[REVERSES[r.code]] ?? 0) + Math.abs(r.amount)
  const standing = txs.filter(x => PENALTY_CODES[x.code] && x.amount > 0).map(p => {
    const off = Math.min(p.amount, left[p.code] ?? 0)
    left[p.code] = (left[p.code] ?? 0) - off
    return { ...p, gross: p.amount, amount: Math.round((p.amount - off) * 100) / 100 }
  }).filter(p => p.amount >= 0.5)
  return { standing, reversals }
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

/** The year whose return the IRS processed in `year`'s slot, when the
 *  processed taxable income matches a neighbouring year's return instead. */
export function postedFrom(ctx: ReviewContext, year: number): number | undefined {
  const ti = transcriptValue(transcript(ctx.catalogs, year), 'Return information', /^Taxable Income$/i)
  const ours = returnTaxable(ctx, year)
  if (!ti || typeof ti.value !== 'number' || ours === undefined || Math.abs(ours - ti.value) <= 1) return undefined
  return [year - 1, year + 1, year - 2, year + 2].find(y => {
    const v = returnTaxable(ctx, y)
    return v !== undefined && v !== 0 && Math.abs(v - (ti.value as number)) <= 1
  })
}

const FAILURE_TO_FILE = new Set(['160', '166', '246'])

/** Was the year extended? The transcript's TC460 says so; a recorded answer
 *  stands in when there is no transcript. EZA's 2021 and 2022 have no TC460,
 *  so those returns were due 15 March, not 15 September. */
function extensionOnFile(ctx: ReviewContext, year: number): { extended: boolean; how: string } {
  const t = transcript(ctx.catalogs, year)
  if (t) return transactions(t).some(x => x.code === '460') ? { extended: true, how: 'TC460 on the transcript' } : { extended: false, how: 'no extension (TC460) on the transcript' }
  const f = ctx.facts.get('irs.extension_filed', { year })
  return f?.value === false ? { extended: false, how: 'no extension filed (recorded)' } : { extended: true, how: f?.value === true ? 'extension filed (recorded)' : 'extension assumed' }
}

/** Months late, each month or part of one counting (§6699, §6651). */
function monthsLate(due: Date, at: Date): number {
  let m = 0
  while (m < 600 && Date.UTC(due.getUTCFullYear(), due.getUTCMonth() + m, due.getUTCDate()) < at.getTime()) m++
  return m
}

/** What a late-filing penalty would be had the IRS counted an earlier
 *  receipt: the per-month rate is read off the assessment itself, so no rate
 *  table is needed. §6699 (TC246) caps at 12 months, §6651 (TC166) at 5. */
function reliefFromEarlierReceipt(p: { code: string; amount: number }, dueUsed: Date, counted: Date, earlier: Date): number {
  const cap = p.code === '246' ? 12 : 5
  const charged = Math.min(cap, monthsLate(dueUsed, counted))
  if (!charged) return 0
  const kept = Math.min(cap, monthsLate(dueUsed, earlier))
  return Math.round(p.amount - (p.amount / charged) * kept)
}
const DAY = 86_400_000

function addYears(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear() + n, d.getUTCMonth(), d.getUTCDate()))
}

/** When the return counts as filed, and how we know. */
export function filingDate(ctx: ReviewContext, year: number): { date?: Date; source: string; assumed: boolean } {
  const t = transcript(ctx.catalogs, year)
  // When the IRS posted ANOTHER year's return here, the transcript's dates
  // belong to that return, not to this year's (EZA 2025: the 2024 return's
  // receipt would have started the 2025 statute).
  const misposted = postedFrom(ctx, year)
  if (misposted === undefined) {
    const rec = transcriptValue(t, 'Return information', /return received date/i)
    if (rec?.date) return { date: parseDate(rec.date), source: `${year} IRS transcript: return received ${rec.date}`, assumed: false }
    const tc150 = transactions(t).find(x => x.code === '150')
    if (tc150?.date) return { date: parseDate(tc150.date), source: `${year} IRS transcript: TC150 ${tc150.date}`, assumed: false }
  }
  const f = ctx.facts.get('irs.filing_date', { year })
  if (f?.status === 'answered' && typeof f.value === 'string') {
    const d = parseDate(f.value)
    if (d) return { date: d, source: `Recorded filing date ${f.value}${misposted !== undefined ? ` (the ${year} transcript carries the ${misposted} return)` : ''}`, assumed: false }
  }
  const { due, extended } = dueDates(ctx.entity.form_type, year)
  const ext = ctx.facts.get('irs.extension_filed', { year })
  // An early-filed return is treated as filed on the due date (§6501(b)(1), §6513(a)).
  return { date: ext?.value === false ? due : extended, source: `not known — assumed the ${ext?.value === false ? 'original' : 'extended'} due date`, assumed: true }
}

const statute: Check = {
  id: 'statute.windows',
  version: 3,
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
  version: 6,
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
    // Transcripts arrive for every year asked for, including years before
    // the entity existed (EZA 2018–2020) and the current one (2026): no
    // return is missing there.
    const incorporated = Number(String(ctx.entity.date_incorporated ?? '').slice(0, 4)) || undefined
    const notDue = dueDates(ctx.entity.form_type, ctx.year).due.getTime() > ctx.today.getTime()
    const noReturnExpected = !tc150 && (notDue || (incorporated !== undefined && ctx.year < incorporated))
    if (noReturnExpected) {
      out.push({ check: this.id, status: 'pass', severity: 'info', key: '150', title: `${ctx.year}: no return ${notDue ? 'is due yet' : `expected — before the entity was incorporated (${ctx.entity.date_incorporated})`}`, detail: '', evidence: [{ where: `${ctx.year} IRS transcript${asOf ? ` dated ${asOf}` : ''}`, catalog_id: t.id }] })
    } else if (!tc150) {
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
    const { standing: pens, reversals } = standingPenalties(txs)
    const { due, extended } = dueDates(ctx.entity.form_type, ctx.year)
    const ext = extensionOnFile(ctx, ctx.year)
    const dueUsed = ext.extended ? extended : due
    const ftfPens = pens.filter(p => FAILURE_TO_FILE.has(p.code))
    const relief = earlier && counted ? ftfPens.reduce((s, p) => s + reliefFromEarlierReceipt(p, dueUsed, counted, earlier.at!), 0) : 0
    const reversedNote = reversals.length ? ` Already reduced by the IRS: ${reversals.map(r => `TC${r.code} ${money(Math.abs(r.amount))} on ${r.date}`).join('; ')}.` : ''
    if (pens.length) {
      const total = pens.reduce((s, p) => s + p.amount, 0)
      out.push({
        check: this.id, status: 'finding', severity: 'medium', key: 'penalties',
        title: `${ctx.year}: penalties assessed ${money(total)} (${pens.map(p => `TC${p.code}`).join(', ')})${reversals.length ? ' after reversals' : ''}${relief > 0 ? ` — ${money(relief)} of it is abatable on the earlier receipt` : ''}`,
        detail: `${pens.map(p => `${PENALTY_CODES[p.code]} ${money(p.amount)}${p.gross !== p.amount ? ` (of ${money(p.gross)})` : ''} on ${p.date}`).join('; ')}.${reversedNote} First-time abatement needs a clean prior three years; otherwise reasonable cause.${ftfPens.length && earlier ? ` A return received earlier (${earlier.d.date}) supports cutting the late-filing penalty to the months before that date: due ${iso(dueUsed)} (${ext.how}), ${monthsLate(dueUsed, earlier.at!)} month(s) late at ${earlier.d.date} against ${monthsLate(dueUsed, counted!)} at ${iso(counted!)}${relief > 0 ? ` — ${money(relief)} less` : ''}.` : ''}`,
        evidence: [...pens.map(p => cite({ ...p, amount: p.gross })), ...reversals.map(cite)], asks: ['irs.penalties'],
        ...(relief > 0 ? { dollar_effect: -relief } : {}),
      })
    } else if (reversals.length) {
      out.push({ check: this.id, status: 'pass', severity: 'info', key: 'penalties', title: `${ctx.year}: every penalty assessed was reversed by the IRS`, detail: reversedNote.trim(), evidence: reversals.map(cite) })
    }
    const bal = transcriptValue(t, 'Account', /^Account balance plus accruals|^Account balance$/i)
    if (bal && typeof bal.value === 'number' && bal.value > 0) {
      out.push({ check: this.id, status: 'finding', severity: 'medium', key: 'balance', title: `${ctx.year}: ${money(bal.value)} owed to the IRS per the transcript`, detail: 'Pay it or request abatement; interest accrues daily.', evidence: [{ where: `${ctx.year} IRS transcript: ${bal.entry.raw}`, catalog_id: t.id, value: bal.value }], dollar_effect: bal.value })
    }
    // A credit balance is the IRS holding the taxpayer's money — the 2023
    // 1040 refund (181,409) was issued twice and came back both times
    // (TC841 cancelled, TC740 undelivered), and nothing flagged it.
    // Before the return posts, a credit is the year's payments waiting for
    // it (the 2025 1040: 493,626 paid, return filed 10/14/2026, not posted
    // by 10/20) — not money the IRS is holding back.
    if (bal && typeof bal.value === 'number' && bal.value < -1 && !tc150) {
      out.push({ check: this.id, status: 'pass', severity: 'info', key: 'credit', title: `${ctx.year}: ${money(-bal.value)} paid, waiting for the return to post${asOf ? ` (as of ${asOf})` : ''}`, detail: 'Payments and credits for the year sit as a credit until the return is processed; the return then applies them.', evidence: [{ where: `${ctx.year} IRS transcript: ${bal.entry.raw}`, catalog_id: t.id, value: bal.value }] })
    } else if (bal && typeof bal.value === 'number' && bal.value < -1) {
      const refunds = txs.filter(x => x.code === '846')
      const back = txs.filter(x => x.code === '740' || x.code === '841')
      const history = [...refunds.map(r => `refund issued ${r.date} ${money(r.amount)}`), ...back.map(b => `${b.code === '740' ? 'undelivered refund returned to the IRS' : 'refund cancelled'} ${b.date}`)].join('; ')
      out.push({
        check: this.id, status: 'finding', severity: 'high', key: 'credit',
        title: `${ctx.year}: the IRS is holding ${money(-bal.value)} of yours (credit balance${asOf ? ` as of ${asOf}` : ''})${back.length ? ' — the refund came back' : ''}`,
        detail: `${history ? `${history}. ` : ''}${back.length ? 'The refund did not reach you. Ask the IRS to reissue it (confirm the address on file — Form 8822 if it changed — or give direct-deposit details), or have the credit applied to a balance due for another year. ' : 'Ask for it to be refunded or applied to another year. '}Pull a fresh transcript first: this one is dated ${asOf || 'unknown'}, and a reissue may already have gone out.`,
        evidence: [{ where: `${ctx.year} IRS transcript: ${bal.entry.raw}`, catalog_id: t.id, value: bal.value }, ...[...refunds, ...back].map(cite)],
        dollar_effect: bal.value,
      })
    }
    const rec = transcriptValue(t, 'Return information', /return received date/i)
    const received = parseDate(rec?.date)
    if (received && received.getTime() > dueUsed.getTime()) {
      out.push({ check: this.id, status: 'finding', severity: 'medium', key: 'late', title: `${ctx.year}: return received ${rec!.date}, after the ${ext.extended ? 'extended ' : ''}due date ${iso(dueUsed)}${ext.extended ? '' : ' (no extension on file)'}`, detail: `${ext.extended ? `Original due date ${iso(due)}; ${ext.how}.` : `${ext.how[0].toUpperCase()}${ext.how.slice(1)}, so the return was due ${iso(due)}, not ${iso(extended)}.`} A return processed late draws late-filing penalties and starts the statute later.`, evidence: [{ where: `${ctx.year} IRS transcript: ${rec!.entry.raw}`, catalog_id: t.id }] })
    }
    // Does the processed return match the catalogued one? If it matches
    // ANOTHER year's return, the IRS posted that return to this period —
    // EZA's 2023 return posted to 2024 and its 2024 return to 2025.
    // A return transcript settles it line by line (irs.return_transcript);
    // repeating it here from the one taxable-income figure would list the
    // same misposting twice.
    const ti = transcriptValue(t, 'Return information', /^Taxable Income$/i)
    const ours = returnTaxable(ctx, ctx.year)
    const rt = returnTranscript(ctx.catalogs, ctx.year)
    if (ti && typeof ti.value === 'number' && ours !== undefined && Math.abs(ours - ti.value) > 1 && !(rt && !noRecord(rt))) {
      const posted = postedFrom(ctx, ctx.year)
      const where = { where: `${ctx.year} IRS transcript: ${ti.entry.raw}`, catalog_id: t.id }
      out.push(posted !== undefined
        ? { check: this.id, status: 'finding', severity: 'high', key: 'mismatch', title: `${ctx.year}: the IRS posted the ${posted} return to ${ctx.year} (taxable income ${money(ti.value)}); the ${ctx.year} return (${money(ours)}) is not processed`, detail: `The return the IRS processed for ${ctx.year} carries the ${posted} return's taxable income. Ask the IRS to move it to ${posted} and process the ${ctx.year} return. Until it does, a ${ctx.year} return sent in will be set aside as a duplicate (TC976), and ${ctx.year}'s penalties and statute dates are running on the wrong return.`, evidence: [where] }
        : { check: this.id, status: 'finding', severity: 'high', key: 'mismatch', title: `${ctx.year}: the IRS processed taxable income of ${money(ti.value)}; the catalogued return shows ${money(ours)}`, detail: 'The IRS processed a different return from the one on file here (another copy, an amendment, or a return posted to the wrong period). Find out which.', evidence: [where] })
    }
    return out.length ? out : [{ check: this.id, status: 'pass', severity: 'info', title: `${ctx.year} account clean`, detail: '', evidence: [] }]
  },
}

const returnTranscriptCheck: Check = {
  id: 'irs.return_transcript',
  version: 2,
  area: 'irs_account',
  title: 'The return the IRS processed, line by line, against the filed return',
  applies: ['1040', '1120', '1120S'],
  kind: 'rule',
  description: 'Reads the IRS return transcript (its own copy of the return as processed) and compares every line it carries with the filed return through the golden schema (src/schema/golden.ts): income, deductions, tax and payments first, then the balance sheet and schedules. When the headline figures match ANOTHER year\'s return, the IRS posted that return to this period — EZA\'s 2024 period holds its 2023 return and its 2025 period its 2024 return.',
  run(ctx) {
    const rt = returnTranscript(ctx.catalogs, ctx.year)
    if (!rt) return [{ check: this.id, status: 'n/a', severity: 'info', title: `No ${ctx.year} IRS return transcript catalogued`, detail: '', evidence: [] }]
    const asOf = rt.as_of ? ` dated ${rt.as_of}` : ''
    const own = filed(ctx.catalogs, ctx.year)
    if (noRecord(rt)) {
      return [own
        ? { check: this.id, status: 'gap', severity: 'low', key: 'no_record', title: `${ctx.year}: the IRS return transcript${asOf} shows no return processed; a filed return is on file here`, detail: 'Expected for a return filed in the last few months. Otherwise the IRS has not processed it, or posted it to another period — pull a fresh transcript and compare.', evidence: [{ where: `${ctx.year} IRS return transcript${asOf}: No record of return filed`, catalog_id: rt.id }], asks: ['irs.filing_date'] }
        : { check: this.id, status: 'pass', severity: 'info', key: 'no_record', title: `${ctx.year}: the IRS has no return on record${asOf}`, detail: '', evidence: [{ where: `${ctx.year} IRS return transcript${asOf}: No record of return filed`, catalog_id: rt.id }] }]
    }
    const dln = returnLine(rt, /^Return$/, /^Document Locator Number$/i)?.value
    const received = returnLine(rt, /^Return$/, /^Received Date$/i)?.value
    const about = `${dln ? `DLN ${dln}` : ''}${dln && received ? ', ' : ''}${received ? `received ${received}` : ''}`
    const byYear = new Map<number, CatalogView['entries']>()
    for (let y = ctx.year - 2; y <= ctx.year + 2; y++) { const f = filed(ctx.catalogs, y); if (f) byYear.set(y, f.entries) }
    const held = heldYear(ctx.entity.form_type, ctx.year, rt.entries, byYear)
    const rows = goldenRows({ formType: ctx.entity.form_type, year: ctx.year, filed: own ? { id: own.id, entries: own.entries } : undefined, transcript: { id: rt.id, entries: rt.entries, as_of: rt.as_of, ...(held !== undefined ? { holdsYear: held } : {}) } })
    const compared = rows.filter(r => r.filed && r.irs)
    if (!own || !compared.length) {
      return [{ check: this.id, status: 'gap', severity: 'medium', key: 'no_filed', title: `${ctx.year}: the IRS processed a return${about ? ` (${about})` : ''}, but no filed ${ctx.year} return is catalogued to compare it with`, detail: 'Upload the filed return so the IRS\'s figures can be checked against it.', evidence: [{ where: `${ctx.year} IRS return transcript${asOf}`, catalog_id: rt.id }] }]
    }
    const cite = (r: GoldenRow) => [
      ...(r.irs ? [{ where: r.irs.where, catalog_id: rt.id, value: r.irs.value as number }] : []),
      ...(r.filed ? [{ where: r.filed.where, catalog_id: own.id, value: r.filed.value as number }] : []),
    ]
    const line = (r: GoldenRow) => `${r.label.split('.')[0].slice(0, 60)} (${r.section ? r.section + ' ' : ''}line ${r.line}${r.col ? ' ' + r.col : ''}): IRS ${typeof r.irs?.value === 'number' ? money(r.irs.value) : '—'}, filed ${typeof r.filed?.value === 'number' ? money(r.filed.value) : '—'}`
    const head = compared.filter(r => r.headline)
    if (held !== undefined) {
      const otherRows = goldenRows({ formType: ctx.entity.form_type, year: held, filed: { id: filed(ctx.catalogs, held)!.id, entries: byYear.get(held)! }, transcript: { id: rt.id, entries: rt.entries } }).filter(r => r.headline && r.filed && r.irs)
      return [{
        check: this.id, status: 'finding', severity: 'high', key: 'misposted',
        title: `${ctx.year}: the IRS holds the ${held} return in the ${ctx.year} period${about ? ` (${about})` : ''} — the ${ctx.year} return is not processed`,
        detail: `The figures the IRS processed for ${ctx.year} match the filed ${held} return, not the ${ctx.year} one (${head.map(line).join('; ')}). Ask the IRS to move that return to ${held} and process the ${ctx.year} return. Until then a ${ctx.year} return sent in is set aside as a duplicate (TC976), and ${ctx.year}'s penalties and statute dates run on the wrong return.`,
        evidence: [...head.flatMap(cite), ...otherRows.flatMap(r => r.filed ? [{ where: r.filed.where, value: r.filed.value as number }] : [])],
      }]
    }
    const out: CheckResult[] = []
    const diffs = rows.filter(r => r.status === 'differs')
    const headDiffs = diffs.filter(r => r.headline)
    const minor = [...diffs.filter(r => !r.headline), ...rows.filter(r => r.status === 'irs_only')]
    const recomputed = rows.filter(r => r.status === 'irs_recomputed')
    if (headDiffs.length) {
      out.push({ check: this.id, status: 'finding', severity: 'high', key: 'differs', title: `${ctx.year}: the IRS processed figures that differ from the filed return on ${headDiffs.length} headline line(s)`, detail: `${headDiffs.map(line).join('; ')}. The IRS processed another version (an amendment, a duplicate copy, or a math-error adjustment), or keyed the return wrongly. Find out which before relying on the ${ctx.year} figures.${about ? ` The processed return: ${about}.` : ''}`, evidence: headDiffs.flatMap(cite) })
    } else {
      out.push({ check: this.id, status: 'pass', severity: 'info', key: 'agrees', title: `${ctx.year}: the IRS processed the return as filed (${compared.filter(r => r.status === 'agrees').length} figures agree${about ? `; ${about}` : ''})`, detail: '', evidence: head.flatMap(cite) })
    }
    if (minor.length) {
      out.push({ check: this.id, status: 'finding', severity: 'low', key: 'differs_other', title: `${ctx.year}: the IRS recorded ${minor.length} other figure(s) differently from the filed return`, detail: `${minor.map(line).join('; ')}. These are balance-sheet and schedule figures as the IRS keyed them; they do not change the tax, but they are what the IRS holds on record.`, evidence: minor.flatMap(cite) })
    }
    if (recomputed.length) {
      out.push({ check: this.id, status: 'pass', severity: 'info', key: 'recomputed', title: `${ctx.year}: the IRS recomputed ${recomputed.length} line(s)`, detail: recomputed.map(r => `${r.label.split('.')[0].slice(0, 60)}: filed ${typeof r.filed?.value === 'number' ? money(r.filed.value) : '—'}, IRS computed ${typeof r.irs_computed?.value === 'number' ? money(r.irs_computed.value) : '—'}`).join('; '), evidence: recomputed.flatMap(r => [...(r.irs_computed ? [{ where: r.irs_computed.where, catalog_id: rt.id }] : []), ...(r.filed ? [{ where: r.filed.where, catalog_id: own.id }] : [])]) })
    }
    return out
  },
}

export const irsChecks: Check[] = [statute, transcriptAccount, returnTranscriptCheck]
