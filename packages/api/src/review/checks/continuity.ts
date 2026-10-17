/**
 * Year-to-year continuity: what one return closes with, the next must open
 * with. Schedule L opening balances, the M-2 accumulated adjustments account,
 * capital loss carryovers, the NOL. These are the amounts that were rebuilt by
 * hand, differently, in every conversation — the ledger the owner asked for.
 */
import type { Check, CheckResult } from '../types.js'
import { filed, amount, ev, evs, money, formEntries } from '../lookup.js'

const SCHED_L_LINES_1120S = ['1', '2a', '2b', '3', '4', '5', '6', '7', '8', '9', '10a', '10b', '11a', '11b', '12', '13a', '13b', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24', '25', '26', '27']
const SCHED_L_LINES_1120 = [...SCHED_L_LINES_1120S.filter(l => !['22', '23', '24', '25', '26', '27'].includes(l)), '22a', '22b', '23', '24', '25', '26', '27', '28']

const openingBalances: Check = {
  id: 'balance_sheet.opening_equals_prior_close',
  version: 1,
  area: 'balance_sheet',
  title: 'Schedule L opens where last year closed',
  applies: ['1120S', '1120'],
  kind: 'rule',
  description: 'Every Schedule L beginning-of-year amount (column b; the net column for receivables and fixed assets) must equal the prior year\'s end-of-year amount (column d). A break means one of the two returns is wrong (EZA 2025 opened from the books, not the filed 2024 balance sheet; EZA 2022 opened with equity of +627 although the 2021 return showed a loss).',
  run(ctx) {
    const cur = filed(ctx.catalogs, ctx.year)
    const prev = filed(ctx.catalogs, ctx.year - 1)
    if (!cur || !prev) return [{ check: this.id, status: cur ? 'gap' : 'n/a', severity: cur ? 'low' : 'info', title: cur ? `No catalogued ${ctx.year - 1} return to compare the opening balance sheet with` : 'No return', detail: '', evidence: [] }]
    const form = ctx.entity.form_type === '1120' ? 'f1120' : 'f1120s'
    const lines = form === 'f1120' ? SCHED_L_LINES_1120 : SCHED_L_LINES_1120S
    const out: CheckResult[] = []
    for (const line of lines) {
      const open = amount(cur, form, { section: 'Schedule L', line, col: 'b' })
      const close = amount(prev, form, { section: 'Schedule L', line, col: 'd' })
      if (open === undefined || close === undefined) continue
      if (Math.abs(open - close) > 1) {
        out.push({
          check: this.id, status: 'finding', severity: 'medium', key: line,
          title: `${ctx.year} Schedule L line ${line} opens at ${money(open)}; ${ctx.year - 1} closed at ${money(close)}`,
          detail: 'Beginning-of-year balances must equal last year\'s filed end-of-year balances. If the books moved, the change belongs in this year\'s activity (with an explanation), not in the opening column.',
          evidence: evs(ev(cur, form, { section: 'Schedule L', line, col: 'b' }), ev(prev, form, { section: 'Schedule L', line, col: 'd' })),
        })
      }
    }
    if (ctx.entity.form_type === '1120S') {
      const m2open = amount(cur, form, { section: 'Schedule M-2', line: '1', col: 'a' })
      const m2close = amount(prev, form, { section: 'Schedule M-2', line: '8', col: 'a' })
      if (m2open !== undefined && m2close !== undefined && Math.abs(m2open - m2close) > 1) {
        out.push({
          check: this.id, status: 'finding', severity: 'medium', key: 'M-2',
          title: `${ctx.year} AAA opens at ${money(m2open)}; ${ctx.year - 1} closed at ${money(m2close)}`,
          detail: 'Schedule M-2 line 1 column (a) must equal last year\'s line 8.',
          evidence: evs(ev(cur, form, { section: 'Schedule M-2', line: '1', col: 'a' }), ev(prev, form, { section: 'Schedule M-2', line: '8', col: 'a' })),
        })
      }
    }
    return out.length ? out : [{ check: this.id, status: 'pass', severity: 'info', title: `Opening balances agree with ${ctx.year - 1}`, detail: '', evidence: [] }]
  },
}

const capitalLossChain: Check = {
  id: 'carryovers.capital_loss_chain',
  version: 1,
  area: 'carryovers',
  title: 'Capital loss carryover carried forward correctly',
  applies: ['1040'],
  kind: 'rule',
  description: 'A net capital loss beyond the $3,000 deduction carries forward (Schedule D lines 6 and 14 next year). The carryover the next return claims must match what this one left over; dropping it loses a deduction, inflating it overstates one.',
  run(ctx) {
    const cur = filed(ctx.catalogs, ctx.year)
    const prev = filed(ctx.catalogs, ctx.year - 1)
    if (!cur || !prev || !formEntries(prev, 'f1040sd').length) return [{ check: this.id, status: 'n/a', severity: 'info', title: 'Not enough years to check', detail: '', evidence: [] }]
    const l16 = amount(prev, 'f1040sd', { section: 'Part III', line: '16' }) ?? 0
    const l21 = Math.abs(amount(prev, 'f1040sd', { section: 'Part III', line: '21' }) ?? 0)
    const expected = l16 < 0 ? Math.max(0, -l16 - l21) : 0
    const st = Math.abs(amount(cur, 'f1040sd', { section: 'Part I', line: '6' }) ?? 0)
    const lt = Math.abs(amount(cur, 'f1040sd', { section: 'Part II', line: '14' }) ?? 0)
    const claimed = st + lt
    const evidence = evs(ev(prev, 'f1040sd', { section: 'Part III', line: '16' }), ev(prev, 'f1040sd', { section: 'Part III', line: '21' }), ev(cur, 'f1040sd', { section: 'Part I', line: '6' }), ev(cur, 'f1040sd', { section: 'Part II', line: '14' }))
    if (Math.abs(claimed - expected) > 1) {
      return [{
        check: this.id, status: 'finding', severity: claimed < expected ? 'medium' : 'high',
        title: `${ctx.year}: capital loss carryover claimed ${money(claimed)}; ${ctx.year - 1} left about ${money(expected)}`,
        detail: `${ctx.year - 1} net capital loss ${money(l16)}, of which ${money(l21)} was deducted, so about ${money(expected)} carries to ${ctx.year} (before the taxable-income limit of the carryover worksheet). ${claimed < expected ? 'Part of the carryover was dropped — a lost deduction.' : 'More carryover was claimed than was available.'} Note: any change to ${ctx.year - 1} capital gains (for example gain on distributions above basis) changes this chain.`,
        evidence,
      }]
    }
    return [{ check: this.id, status: 'pass', severity: 'info', title: `Capital loss carryover ${money(claimed)} matches ${ctx.year - 1}`, detail: '', evidence }]
  },
}

const nolChain: Check = {
  id: 'carryovers.nol_chain',
  version: 1,
  area: 'carryovers',
  title: 'NOL deduction is available and within the 80% limit',
  applies: ['1120'],
  kind: 'rule',
  description: 'The NOL deducted on line 29a can\'t exceed the carryover available (Schedule K question 12 of the prior year, less what was used), and post-2017 NOLs are limited to 80% of taxable income before the NOL.',
  run(ctx) {
    const cur = filed(ctx.catalogs, ctx.year)
    const used = amount(cur, 'f1120', { line: '29a' }) ?? 0
    if (!used) return [{ check: this.id, status: 'n/a', severity: 'info', title: 'No NOL deduction', detail: '', evidence: [] }]
    const ti = amount(cur, 'f1120', { line: '28' }) ?? 0
    const avail = amount(cur, 'f1120', { section: 'Schedule K', line: '12' })
    const out: CheckResult[] = []
    if (used > Math.round(ti * 0.8) + 1) {
      out.push({ check: this.id, status: 'gap', severity: 'medium', key: '80', title: `${ctx.year}: NOL deduction ${money(used)} exceeds 80% of taxable income (${money(ti * 0.8)})`, detail: 'Only NOLs from tax years beginning before 2018 escape the 80% limit. Record the NOL vintage schedule to confirm.', evidence: evs(ev(cur, 'f1120', { line: '29a' }), ev(cur, 'f1120', { line: '28' })), asks: ['carryover.nol'] })
    }
    if (avail !== undefined && avail > 0 && used > avail + 1) {
      out.push({ check: this.id, status: 'finding', severity: 'high', key: 'avail', title: `${ctx.year}: NOL deduction ${money(used)} exceeds the ${money(avail)} carryover reported available`, detail: 'The deduction cannot exceed the available carryover.', evidence: evs(ev(cur, 'f1120', { line: '29a' }), ev(cur, 'f1120', { section: 'Schedule K', line: '12' })) })
    }
    return out.length ? out : [{ check: this.id, status: 'pass', severity: 'info', title: 'NOL within limits', detail: '', evidence: [] }]
  },
}

export const continuityChecks: Check[] = [openingBalances, capitalLossChain, nolChain]
