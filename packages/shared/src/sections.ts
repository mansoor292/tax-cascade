/**
 * The canonical section vocabulary for `field_values` keys — display order
 * and labels. The authoritative prefix SET lives server-side in
 * packages/api/src/maps/canonical_schema.ts (which validates on persist);
 * this list is the presentation-side mirror the Compare UI renders with.
 * Add a new section in both places.
 */
export const SECTION_ORDER = [
  'income', 'cogs', 'deductions', 'tax', 'credits', 'payments',
  'result', 'refund', 'owed', 'overpayment',
  'schedJ', 'schedL', 'schedM1', 'schedM2', 'schedK', 'schedB', 'schedE',
  'meta', 'preparer',
]

export const SECTION_LABELS: Record<string, string> = {
  income:      'Income (Page 1)',
  cogs:        '1125-A COGS',
  deductions:  'Deductions (Page 1)',
  tax:         'Tax Computation',
  credits:     'Credits',
  payments:    'Payments',
  result:      'Refund / Owed',
  refund:      'Refund',
  owed:        'Balance Due',
  overpayment: 'Overpayment',
  schedJ:      'Schedule J',
  schedL:      'Schedule L (Balance Sheet)',
  schedM1:     'Schedule M-1',
  schedM2:     'Schedule M-2',
  schedK:      'Schedule K',
  schedB:      'Schedule B',
  schedE:      'Schedule E',
  meta:        'Entity Metadata',
  preparer:    'Preparer',
  other:       'Other',
}
