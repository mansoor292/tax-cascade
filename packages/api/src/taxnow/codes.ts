/**
 * IRS transaction codes as a practice reads them: what family each belongs
 * to, which code it reverses, and what the wording says it is.
 *
 * Ported from the 2026-10-24 TaxNow prototype (~/taxnow-data/tools/build_db.py),
 * where these tables were checked against 24,142 transactions across 45
 * business accounts (the parse matched TaxNow's own transaction list row for
 * row). Two things it learned that the code alone does not tell you:
 *  - Several codes say what they are only in their wording. Amended returns
 *    post as TC 976 "Amended return filed", right beside TC 976 "Duplicate
 *    return filed"; a claim is TC 971 "Amended tax return or claim forwarded
 *    for processing"; "Disallowed claim" is a TC 290. Read `actionOf`, never
 *    the code alone.
 *  - Most reversals are the code plus one (TC 167 reverses 166); the
 *    exceptions are listed by hand below.
 * review/checks/irs.ts reads TC 976 through `actionOf` too, so the owner's
 * review and the practice agree on what an amended return is.
 */

export type Family =
  | 'return' | 'return_other' | 'extension' | 'assessment' | 'penalty' | 'interest' | 'payment'
  | 'credit_in' | 'credit_out' | 'refundable_credit' | 'irs_interest' | 'refund' | 'write_off'
  | 'collection' | 'exam' | 'hold' | 'statute' | 'representative' | 'action' | 'other'

const FAMILY: Record<Exclude<Family, 'other'>, string[]> = {
  return: ['150'],
  return_other: ['140', '976', '977', '474', '590', '591', '592', '593', '594', '595', '596', '597', '598', '599'],
  extension: ['460'],
  assessment: ['290', '291', '294', '295', '298', '299', '300', '301'],
  penalty: ['160', '161', '166', '167', '170', '171', '176', '177', '180', '181', '186', '187', '234', '235', '240', '241', '246', '247', '270', '271', '276', '277', '286', '287', '360', '361', '173', '280', '281', '163', '238', '239', '283'],
  interest: ['196', '197', '336', '337', '190', '191', '340', '341'],
  payment: ['430', '800', '806', '807', '673', '613', '642', '643', '663', '610', '611', '612', '620', '621', '622', '640', '641', '650', '651', '652', '660', '661', '662', '670', '671', '672', '680', '690', '694'],
  credit_in: ['666', '667', '700', '701', '702', '706', '710', '712', '713', '716', '730', '736'],
  credit_out: ['820', '821', '822', '826', '830', '832', '836', '850', '856'],
  refundable_credit: ['764', '765', '766', '767', '768'],
  irs_interest: ['770', '771', '772', '776', '777'],
  refund: ['720', '740', '841', '843', '844', '845', '846', '840', '896', '898', '899'],
  write_off: ['386', '388', '389', '604', '605', '606', '607', '608', '609'],
  collection: ['520', '521', '522', '530', '531', '532', '537', '582', '583', '480', '481', '482', '780', '788', '500', '502', '503', '538', '539'],
  exam: ['420', '421', '424', '425', '922', '494', '495'],
  hold: ['470', '471', '472', '570', '571', '572', '576', '577', '810', '811'],
  statute: ['560'],
  representative: ['960', '961', '962'],
  action: ['971', '972', '973'],
}

const FAMILY_OF = new Map<string, Family>()
for (const [f, codes] of Object.entries(FAMILY)) for (const c of codes) FAMILY_OF.set(c, f as Family)

export function familyOf(code: string): Family {
  return FAMILY_OF.get(code) ?? 'other'
}

// The code each one removes or reverses: odd codes in the penalty, interest
// and credit families reverse the even code below them, plus named pairs.
const REVERSES = new Map<string, string>()
for (const f of ['penalty', 'interest', 'irs_interest', 'refundable_credit'] as const) {
  for (const c of FAMILY[f]) if (Number(c) % 2 === 1) REVERSES.set(c, String(Number(c) - 1))
}
for (const [c, r] of Object.entries({
  '291': '290', '295': '290', '299': '298', '301': '300', '521': '520', '522': '520', '531': '530', '532': '530', '537': '530',
  '571': '570', '572': '570', '583': '582', '607': '606', '389': '388', '651': '650', '652': '650', '661': '660', '662': '660',
  '671': '670', '672': '670', '611': '610', '612': '610', '621': '620', '622': '620', '811': '810', '841': '846', '843': '841',
  '845': '844', '961': '960', '972': '971', '471': '470', '472': '470', '361': '360', '577': '576',
})) REVERSES.set(c, r)
// Added 2026-10-26 from the prototype's first TaxNow export (codes the two
// API-built orgs never showed): 173, 163 and 283 are odd but assessments
// (estimated-tax, late-filing, dishonored-payment penalties), not reversals.
for (const c of ['173', '163', '283']) REVERSES.delete(c)

export function reversesOf(code: string): string | null {
  return REVERSES.get(code) ?? null
}

export type Action =
  | 'claim_forwarded' | 'claim_returned' | 'misposted_return' | 'tentative_refund_claim' | 'first_time_abatement'
  | 'first_time_abatement_reversed' | 'installment_agreement' | 'installment_pending' | 'installment_removed' | 'levy'
  | 'lien' | 'cdp' | 'private_collection' | 'notice' | 'replacement_refund' | 'levy_block' | 'claim_disallowed'
  | 'quick_assessment' | 'amended_return' | 'duplicate_return'

// First match wins: order matters ("Reversal of No penalty" before "No penalty").
const ACTION_RULES: Array<[RegExp, Action]> = [
  [/Amended tax return or claim forwarded/, 'claim_forwarded'], [/Amended return sent back/, 'claim_returned'],
  [/Amended\/duplicate tax return processed to wrong/, 'misposted_return'], [/Application for tentative refund/, 'tentative_refund_claim'],
  [/Reversal of No penalty/, 'first_time_abatement_reversed'], [/No penalty due to previous/, 'first_time_abatement'],
  [/Installment agreement established/, 'installment_agreement'], [/Pending installment/, 'installment_pending'], [/Removed installment/, 'installment_removed'],
  [/Notice of Intent to Levy|levy|Levy/, 'levy'], [/lien/, 'lien'], [/Collection due process/, 'cdp'], [/private debt collection/, 'private_collection'],
  [/Notice issued/, 'notice'], [/replacement refund/, 'replacement_refund'], [/blocked from automated levy/, 'levy_block'],
  [/Disallowed claim/, 'claim_disallowed'], [/quick assessment/, 'quick_assessment'], [/Amended return filed/, 'amended_return'],
  [/Duplicate return filed/, 'duplicate_return'],
]
const WORDED = new Set(['971', '972', '973', '290', '976'])

/** What a transaction is, read from its wording, for the codes that say it
 *  only there (971/972/973, 290, 976). Null for any other code. */
export function actionOf(code: string, explanation: string): Action | null {
  if (!WORDED.has(code)) return null
  for (const [re, a] of ACTION_RULES) if (re.test(explanation)) return a
  return null
}

/** Penalties first-time abatement can remove: late filing, late payment,
 *  deposit, and the 1120-S/1065 per-shareholder late-filing penalty. */
export const FTA_CODES = new Set(['166', '160', '276', '270', '186', '180', '246', '234', '240'])
/** Never abatable here: estimated-tax penalties (no reasonable-cause relief
 *  for corporations) and collection fees. */
export const NOT_ABATABLE = new Set(['170', '173', '176', '360'])

export const PENALTY_NAME: Record<string, string> = {
  '166': 'late filing', '160': 'late filing', '276': 'late payment', '270': 'late payment', '186': 'deposit',
  '180': 'deposit', '246': 'late filing (per shareholder/partner)', '176': 'estimated tax', '170': 'estimated tax', '173': 'estimated tax',
  '286': 'dishonored payment', '280': 'dishonored payment', '234': 'daily delinquency', '240': 'miscellaneous', '196': 'interest',
}

/** Income-tax forms vs payroll: the practice leads with income tax. */
export const PAYROLL_FORMS = new Set(['940', '941', '943', '944', '945'])
export function sectionOfForm(form: string): 'income' | 'payroll' {
  return PAYROLL_FORMS.has(form) ? 'payroll' : 'income'
}
