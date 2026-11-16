/**
 * Schedule C (Form 1040) for a single-member LLC held as its own entity, and
 * Schedule SE per person.
 *
 * Owner decision 2026-11-16: a single-member LLC with no election (disregarded,
 * reported on the owner's Schedule C) is held in Cati as its OWN entity —
 * form type `SchC` — linked to the owner's 1040 with a `disregarded` link.
 * It keeps its own documents and books, its Schedule C is computed on its own
 * return row, and the owner's 1040 pulls the line 31 profit in (Schedule 1
 * line 3, Schedule SE, the §199A deduction). Before this an owner's business
 * reached the 1040 as one number, `net_se_income`, with no lines behind it.
 *
 * Schedule SE is figured per person because the social security part stops at
 * the year's wage base LESS that person's own W-2 social security wages
 * (Schedule SE line 8a). The 1040 engine used to apply the full base to the
 * couple's combined self-employment income regardless of wages, overcharging
 * an owner who is also paid a salary.
 */
import { SS_WAGE_BASE } from './tax_tables.js'

export interface ScheduleC_Inputs {
  tax_year?: number
  business_name?: string
  /** Who on the 1040 owns it — drives that person's Schedule SE. */
  owner?: 'taxpayer' | 'spouse'
  gross_receipts?: number          // L1
  returns_allowances?: number      // L2
  cost_of_goods_sold?: number      // L4 (or Part III lines)
  other_income?: number            // L6
  advertising?: number             // L8
  car_truck?: number               // L9
  commissions_fees?: number        // L10
  contract_labor?: number          // L11
  depletion?: number               // L12
  depreciation?: number            // L13
  employee_benefits?: number       // L14
  insurance?: number               // L15
  mortgage_interest?: number       // L16a
  interest?: number                // L16b
  legal_professional?: number      // L17
  office_expense?: number          // L18
  pension_plans?: number           // L19
  rent_vehicles?: number           // L20a
  rents?: number                   // L20b
  repairs_maintenance?: number     // L21
  supplies?: number                // L22
  taxes_licenses?: number          // L23
  travel?: number                  // L24a
  /** Business meals as paid; 50% is deductible on line 24b (§274(n)). */
  meals?: number
  utilities?: number               // L25
  wages?: number                   // L26 — employees only; an owner's draw is not a deduction
  energy_efficient?: number        // L27a
  other_expenses?: number          // L27b (Part V)
  other_expenses_detail?: Array<{ label: string; amount: number }>
  home_office?: number             // L30
  /** §199A for the owner's 1040. */
  is_sstb?: boolean
  ubia?: number
}

const n = (v: unknown): number => {
  const x = typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : Number(v)
  return Number.isFinite(x) ? x : 0
}
const r = (x: number) => Math.round(x)

export function calcScheduleC(inp: ScheduleC_Inputs) {
  const warnings: string[] = []
  const L1 = r(n(inp.gross_receipts)), L2 = r(n(inp.returns_allowances))
  const L3 = L1 - L2
  const L4 = r(n(inp.cost_of_goods_sold))
  const L5 = L3 - L4
  const L6 = r(n(inp.other_income))
  const L7 = L5 + L6
  const meals = r(n(inp.meals))
  const L24b = r(meals * 0.5)
  const detail = Array.isArray(inp.other_expenses_detail) ? inp.other_expenses_detail : []
  const detailSum = r(detail.reduce((t, d) => t + n(d.amount), 0))
  const L27b = inp.other_expenses !== undefined && inp.other_expenses !== null ? r(n(inp.other_expenses)) : detailSum
  if (detail.length && Math.abs(detailSum - L27b) > 1) warnings.push(`Other expenses detail adds to ${detailSum}, line 27b says ${L27b}.`)
  const exp: Record<string, number> = {
    'schedC.L8_advertising': r(n(inp.advertising)),
    'schedC.L9_car_truck': r(n(inp.car_truck)),
    'schedC.L10_commissions_fees': r(n(inp.commissions_fees)),
    'schedC.L11_contract_labor': r(n(inp.contract_labor)),
    'schedC.L12_depletion': r(n(inp.depletion)),
    'schedC.L13_depreciation': r(n(inp.depreciation)),
    'schedC.L14_employee_benefits': r(n(inp.employee_benefits)),
    'schedC.L15_insurance': r(n(inp.insurance)),
    'schedC.L16a_mortgage_interest': r(n(inp.mortgage_interest)),
    'schedC.L16b_other_interest': r(n(inp.interest)),
    'schedC.L17_legal_professional': r(n(inp.legal_professional)),
    'schedC.L18_office_expense': r(n(inp.office_expense)),
    'schedC.L19_pension_plans': r(n(inp.pension_plans)),
    'schedC.L20a_rent_vehicles': r(n(inp.rent_vehicles)),
    'schedC.L20b_rent_other': r(n(inp.rents)),
    'schedC.L21_repairs': r(n(inp.repairs_maintenance)),
    'schedC.L22_supplies': r(n(inp.supplies)),
    'schedC.L23_taxes_licenses': r(n(inp.taxes_licenses)),
    'schedC.L24a_travel': r(n(inp.travel)),
    'schedC.L24b_meals': L24b,
    'schedC.L25_utilities': r(n(inp.utilities)),
    'schedC.L26_wages': r(n(inp.wages)),
    'schedC.L27a_energy_efficient': r(n(inp.energy_efficient)),
    'schedC.L27b_other_expenses': L27b,
  }
  const L28 = Object.values(exp).reduce((a, b) => a + b, 0)
  const L29 = L7 - L28
  const L30 = r(n(inp.home_office))
  const L31 = L29 - L30
  const fv: Record<string, number> = {
    'schedC.L1_gross_receipts': L1, 'schedC.L2_returns': L2, 'schedC.L3_subtract': L3,
    'schedC.L4_cogs': L4, 'schedC.L5_gross_profit': L5, 'schedC.L6_other_income': L6, 'schedC.L7_gross_income': L7,
    ...exp,
    'schedC.L28_total_expenses': L28, 'schedC.L29_tentative_profit': L29,
    'schedC.L30_home_office': L30, 'schedC.L31_net_profit': L31,
  }
  if (detail.length) fv['schedC.L48_total_other_expenses'] = L27b
  if (L31 < 0) warnings.push('Net loss: whether all of it is deductible depends on the owner\'s at-risk amount (line 32) and passive-activity rules, which are not computed here.')
  return {
    computed: { gross_income: L7, total_expenses: L28, net_profit: L31, meals_disallowed: meals - L24b },
    field_values: fv,
    warnings,
    citations: ['Schedule C Instructions: line 28 = lines 8–27b; line 31 = line 29 − line 30', 'IRC §274(n): 50% of business meals'],
  }
}

/** Schedule SE, short of the optional methods, for one person. */
export function scheduleSE(netEarnings: number, ssWages: number, year: number) {
  const L3 = r(netEarnings)
  const L4a = L3 > 0 ? r(L3 * 0.9235) : L3
  const L4c = L4a >= 400 ? L4a : 0
  const L6 = L4c
  const L7 = SS_WAGE_BASE[year] ?? SS_WAGE_BASE[2025]
  const L8d = Math.max(0, r(ssWages))
  const L9 = Math.max(0, L7 - L8d)
  const L10 = r(Math.min(L6, L9) * 0.124)
  const L11 = r(L6 * 0.029)
  const L12 = L10 + L11
  const L13 = r(L12 * 0.5)
  return {
    se_tax: L12, deduction: L13, subject: L6,
    lines: { L2: L3, L3, L4a, L4c, L6, L7, L8a: L8d, L8d, L9, L10, L11, L12, L13 },
  }
}
