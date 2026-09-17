/**
 * Schedules M-1 and M-2 must follow the income statement, not be restated
 * alongside it.
 *
 * Both schedules were pure pass-through: whatever the caller sent was stored,
 * and nothing re-derived them when the numbers above changed. A return was
 * recomputed with a different taxes-and-licenses figure and a new other-income
 * line, which moved ordinary business income by $37,483 — and M-1 line 8 and
 * M-2 line 2 both kept the previous figure, because the caller had supplied
 * them explicitly on an earlier pass and nothing invalidated that. The ending
 * AAA, and therefore the number a shareholder's basis is computed from, was
 * built on income the return no longer reported.
 *
 * Several of those lines are not judgements at all, they are arithmetic the
 * form prints instructions for: "Add lines 1 through 3", "Combine lines 1
 * through 5", "Subtract line 7 from line 6", and M-2 line 2 is page 1 line 22
 * by definition. Those are derived here and cannot go stale. The rest —
 * opening AAA, distributions, the reconciling items, book income — are facts
 * only the caller knows, and are left exactly as given.
 */

export interface ReconciliationIssue {
  field: string
  expected: number
  found: number
  delta: number
  note: string
}

const n = (fv: Record<string, any>, k: string): number => {
  const v = fv[k]
  return typeof v === 'number' && isFinite(v) ? v : 0
}

/**
 * Fill the derived lines of Schedules M-1 and M-2 from the figures already on
 * the return. Mutates `fv`. Returns anything that still does not tie.
 *
 * Only runs for a schedule the caller actually populated — a return with no
 * M-2 does not acquire an empty one.
 */
export function deriveReconciliation1120S(
  fv: Record<string, any>,
  ordinaryIncome: number,
): ReconciliationIssue[] {
  const issues: ReconciliationIssue[] = []
  const has = (prefix: string) => Object.keys(fv).some(k => k.startsWith(prefix))

  if (has('schedM1.')) {
    // Line 4 = lines 1 + 2 + 3; line 7 = lines 5 + 6; line 8 = line 4 - line 7.
    const l4 = n(fv, 'schedM1.L1_net_income_books') + n(fv, 'schedM1.L2_income_on_K') + n(fv, 'schedM1.L3_expenses_not_K')
    const l7 = n(fv, 'schedM1.L5_income_not_K') + n(fv, 'schedM1.L6_ded_on_K')
    fv['schedM1.L4_add'] = Math.round(l4)
    fv['schedM1.L7_add_5_6'] = Math.round(l7)
    fv['schedM1.L8_income_K18'] = Math.round(l4 - l7)

    // Line 8 is labelled "Income (loss) (Schedule K, line 18)". If the
    // reconciling items do not land there, the items are wrong — say so rather
    // than forcing the number, which would hide the discrepancy.
    const k18 = n(fv, 'schedK.L18_income_loss')
    const delta = Math.round(l4 - l7) - k18
    if (k18 !== 0 && Math.abs(delta) > 1) {
      issues.push({
        field: 'schedM1.L8_income_K18',
        expected: k18,
        found: Math.round(l4 - l7),
        delta,
        note: 'Schedule M-1 line 8 must equal Schedule K line 18. The reconciling '
            + 'items on M-1 lines 2, 3, 5 and 6 do not bridge book income to the '
            + 'total on Schedule K.',
      })
    }
  }

  if (has('schedM2.')) {
    // Ordinary income goes on line 2, a loss on line 4 — never both.
    const income = ordinaryIncome > 0 ? Math.round(ordinaryIncome) : 0
    const loss = ordinaryIncome < 0 ? Math.round(-ordinaryIncome) : 0
    fv['schedM2.L2_ordinary_income'] = income
    fv['schedM2.L4_loss'] = loss

    const l6 = n(fv, 'schedM2.L1_beg_balance') + income + n(fv, 'schedM2.L3_other_additions')
             - loss - n(fv, 'schedM2.L5_other_reductions')
    fv['schedM2.L6_combine'] = Math.round(l6)
    fv['schedM2.L8_end_balance'] = Math.round(l6 - n(fv, 'schedM2.L7_distributions'))
  }

  return issues
}
