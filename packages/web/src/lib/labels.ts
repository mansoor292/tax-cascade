/**
 * Shared domain constants and labels. These were copied per page and had
 * already drifted — the Dashboard's copy was missing 1120-S and 1065, so
 * those entities rendered raw form codes. One definition, imported.
 */

export const FORM_TYPE_LABEL: Record<string, string> = {
  '1040': 'Individual',
  '1120': 'C-Corp',
  '1120S': 'S-Corp',
  '1120-S': 'S-Corp',
  '1065': 'Partnership',
}

/**
 * What an entity can BE (its tax treatment). Includes 1065: a partnership
 * recorded as an individual silently got the wrong filing deadline (a 1065
 * is due 15 March, a 1040 on 15 April).
 */
export const FORM_TYPE_OPTIONS = [
  { value: '1040', label: 'Individual (1040)' },
  { value: '1120', label: 'C-Corporation (1120)' },
  { value: '1120S', label: 'S-Corporation (1120-S)' },
  { value: '1065', label: 'Partnership (1065)' },
]

/**
 * What the engine can COMPUTE — deliberately narrower than
 * FORM_TYPE_OPTIONS: there is no calc1065, partnership returns only enter
 * as filed imports. Don't add 1065 here without engine support.
 */
export const COMPUTABLE_FORM_OPTIONS = [
  { value: '1040', label: '1040 (Individual)' },
  { value: '1120', label: '1120 (C-Corp)' },
  { value: '1120S', label: '1120-S (S-Corp)' },
]

export const FORM_TYPE_COLOR: Record<string, string> = {
  '1040': 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  '1120': 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  '1120S': 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  '1120-S': 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  '1065': 'bg-amber-500/10 text-amber-400 border-amber-500/20',
}

// What the entity legally IS, as distinct from how it is taxed. An LLC may
// file a 1065 or, having elected on Form 2553, an 1120-S.
export const LEGAL_FORMS = [
  { value: '',                 label: 'Not specified' },
  { value: 'llc',              label: 'LLC' },
  { value: 'corporation',      label: 'Corporation' },
  { value: 'partnership',      label: 'Partnership' },
  { value: 'sole_proprietor',  label: 'Sole proprietor' },
  { value: 'trust',            label: 'Trust' },
  { value: 'estate',           label: 'Estate' },
  { value: 'individual',       label: 'Individual' },
]

export const LEGAL_FORM_LABEL: Record<string, string> = {
  llc: 'LLC', corporation: 'Corporation', partnership: 'Partnership',
  sole_proprietor: 'Sole proprietor', trust: 'Trust', estate: 'Estate',
  individual: 'Individual',
}

export type ReturnSource = 'filed_import' | 'amendment' | 'proforma' | 'extension'

export const SOURCE_LABEL: Record<ReturnSource, string> = {
  filed_import: 'Filed',
  amendment:    'Amendment',
  proforma:     'Proforma',
  extension:    'Extension',
}

export const SOURCE_VARIANT: Record<ReturnSource, string> = {
  filed_import: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  amendment:    'bg-amber-500/10 text-amber-400 border-amber-500/20',
  proforma:     'bg-blue-500/10 text-blue-400 border-blue-500/20',
  extension:    'bg-purple-500/10 text-purple-400 border-purple-500/20',
}
