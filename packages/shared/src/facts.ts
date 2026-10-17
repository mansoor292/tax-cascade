/**
 * Fact registry — the ONE list of facts each return type needs (R2 in
 * docs/RETURN_CATALOG_AND_REVIEW.md).
 *
 * Why this exists (2026-10-17): for six months the facts that decide how a
 * return is prepared lived in the owner's head, in free-text entity notes, or
 * nowhere, and surfaced one at a time — each only when a nearby question
 * happened to be asked:
 *   - an S-corp's first-year loss was funded by a loan from a RELATED COMPANY,
 *     not from the shareholder, so it created no debt basis;
 *   - a single-member LLC the S-corp owns is disregarded for income tax but
 *     issues W-2s and files 941s under its own EIN;
 *   - material participation was never recorded, so the 1040 treated
 *     nonpassive S-corp income as passive and paid NIIT on it;
 *   - the S election was accepted (CP261) years after its effective date;
 *   - a large "loan to shareholder" on Schedule L had no note behind it;
 *   - the business code and the SSTB answer contradicted each other;
 *   - share counts, intercompany fees, state-tax payment dates and IRS
 *     transcript events (misposted and duplicate returns, penalties) were
 *     never recorded anywhere a check could read them.
 *
 * The owner's rule: any information that comes in for one return must be the
 * same for every return of that type. So facts are defined HERE, once per
 * return type, and every return of that type, every year, is held to the same
 * list. Something learned on one return becomes a question in this file —
 * never a note on that one return.
 *
 * Everything in a FactDef is plain data (no functions, no classes) so the
 * registry can be serialised, stored alongside a review run, and diffed
 * between versions. `required_when` is declarative for the same reason.
 *
 * Answers live in table `tax_fact` (encrypted; superseded, never overwritten).
 * packages/api/src/services/facts.ts turns answers + this registry into the
 * gap list (answered / unknown / not_applicable / missing / contradicted).
 *
 * Catalog selectors name the IRS PDF slug the catalog uses (f1120s, f1120ssk
 * for the 1120-S K-1, f1065sk1, f1040se, f8960 …). Line numbers drift between
 * revisions; a selector whose numbering is not stable is marked
 * `relation: 'related'` so it is shown for review but never raises a
 * contradiction on its own.
 */

// ─── Vocabularies ───────────────────────────────────────────────────────────

export const FACT_FORM_TYPES = ['1120S', '1120', '1040', '1065'] as const
export type FactFormType = typeof FACT_FORM_TYPES[number]

/**
 * Where an answer is stored, i.e. how many answers one fact has.
 *
 *   entity             once per entity, for all years
 *   entity_year        once per entity per tax year
 *   owner              once per owner × entity pair, for all years
 *   owner_year         once per owner × entity pair per tax year
 *   relationship_year  once per non-ownership counterparty (a related company)
 *                      per tax year
 *   return             once per filed return (entity × tax year); `subject`
 *                      is empty for the original and names an amended or
 *                      superseding return ('amended:1')
 *
 * For owner scopes `subject` names the OTHER side of the ownership: on an
 * issuer (1120-S, 1065, 1120) it is the owner; on a 1040 it is the entity that
 * issued the K-1. The two views of one relationship are linked by
 * `counterpart`, which is how the review checks both sides agree.
 */
export const FACT_SCOPES = [
  'entity', 'entity_year', 'owner', 'owner_year', 'relationship_year', 'return',
] as const
export type FactScope = typeof FACT_SCOPES[number]

export const FACT_TYPES = [
  'date', 'bool', 'enum', 'number', 'money', 'percent', 'text', 'list',
] as const
export type FactType = typeof FACT_TYPES[number]

/** Review areas — the check groups in the design doc that read the fact. */
export const FACT_AREAS = [
  'basis', 'niit', 'qbi', 'loans', 'corporate', 'carryovers', 'intercompany',
  'state', 'irs_account', 'payroll', 'statute', 'k1', 'balance_sheet',
] as const
export type FactArea = typeof FACT_AREAS[number]

export const EVIDENCE_KINDS = [
  'owner_statement', 'irs_notice', 'irs_transcript', 'return_line', 'books',
  'agreement', 'bank_record', 'third_party_form',
] as const
export type EvidenceKind = typeof EVIDENCE_KINDS[number]

/** Stored statuses. 'missing' and 'contradicted' are computed, never stored. */
export const FACT_STATUSES = ['answered', 'unknown', 'not_applicable'] as const
export type FactStatus = typeof FACT_STATUSES[number]

export const FACT_SOURCES = ['owner', 'document', 'catalog', 'derived', 'migrated'] as const
export type FactSource = typeof FACT_SOURCES[number]

// ─── Shapes ─────────────────────────────────────────────────────────────────

export type FactScalar = string | number | boolean
export type FactListItem = Record<string, FactScalar | null>
export type FactValue = FactScalar | FactListItem[]

/** One column of a list fact's rows. */
export interface FactItemField {
  key: string
  type: Exclude<FactType, 'list'>
  label: string
  options?: readonly string[]
  /** Rows may leave this blank. Everything else is required on every row. */
  optional?: boolean
}

/** A return line that answers the fact, or must agree with it. */
export interface CatalogSelector {
  /** IRS PDF slug as the catalog names it: f1120s, f1120ssk, f1040se … */
  form: string
  /** 'Schedule B', 'Schedule L', 'Part II' … omitted for page-1 lines/items */
  section?: string
  /** Line or item: '7', '16', 'A', 'I', '14a' */
  line: string
  row?: string
  col?: string
  note?: string
  /**
   * 'equals' (default): the line answers the fact, so a different value is a
   * contradiction. 'related': the line is affected by the fact and is shown
   * for review, but never by itself contradicts it.
   */
  relation?: 'equals' | 'related'
  /** List facts: reduce the rows to one value (sum a money column, or count rows) before comparing. */
  aggregate?: { op: 'sum' | 'count'; field?: string }
  /** The return prints this amount as a loss in parentheses; compare magnitudes. */
  shown_negative?: boolean
}

/**
 * Declarative condition over other facts' answers. `fact` must name a
 * non-list fact; values must be valid for that fact's type.
 */
export type FactCondition =
  | { fact: string; equals: FactScalar }
  | { fact: string; not_equals: FactScalar }
  | { fact: string; in: readonly FactScalar[] }
  | { all: readonly FactCondition[] }
  | { any: readonly FactCondition[] }

export interface FactDef {
  /** Dot path, stable forever once answers exist: 'scorp.election_effective_date' */
  key: string
  scope: FactScope
  applies_to: readonly FactFormType[]
  type: FactType
  options?: readonly string[]
  item_fields?: readonly FactItemField[]
  /** As you would ask the owner, in plain English. */
  question: string
  /** One sentence: what goes wrong without it. */
  why: string
  affects: readonly FactArea[]
  /** Kinds of evidence accepted as support for an answer. */
  evidence: readonly EvidenceKind[]
  catalog?: readonly CatalogSelector[]
  /** Absent = always required. */
  required_when?: FactCondition
  /** An 'equals' catalog line can answer it, with the line as provenance. */
  derive_from_catalog?: boolean
  /** Owner / relationship scopes: the list fact whose rows name the subjects. */
  subjects_from?: { fact: string; field: string }
  /**
   * The same fact seen from the other side of a K-1: an issuer fact (1120-S,
   * 1065) names the 1040 recipient's fact and vice versa. Both must agree.
   */
  counterpart?: string
  /** Tax years the fact exists in law (inclusive). Absent = every year. */
  years?: { from?: number; to?: number }
}

export interface FactAnswer {
  status: FactStatus
  value?: FactValue | null
}

/** Answers by fact key, or a resolver (which applies scope, subject and year). */
export type FactAnswers =
  | Readonly<Record<string, FactAnswer | undefined>>
  | ((key: string) => FactAnswer | undefined)

// ─── Shared fragments ───────────────────────────────────────────────────────

const ALL: readonly FactFormType[] = ['1120S', '1120', '1040', '1065']
const BUSINESS: readonly FactFormType[] = ['1120S', '1120', '1065']
const CORPS: readonly FactFormType[] = ['1120S', '1120']
const ISSUERS: readonly FactFormType[] = ['1120S', '1065']
const S_CORP: readonly FactFormType[] = ['1120S']
const C_CORP: readonly FactFormType[] = ['1120']
const PARTNERSHIP: readonly FactFormType[] = ['1065']
const INDIVIDUAL: readonly FactFormType[] = ['1040']
const ESTIMATE_PAYERS: readonly FactFormType[] = ['1040', '1120', '1120S']

const OWNER_SUBJECTS = { fact: 'owners.roster', field: 'name' } as const
const K1_SUBJECTS = { fact: 'k1.received', field: 'issuer' } as const
const COUNTERPARTY_SUBJECTS = { fact: 'intercompany.counterparties', field: 'name' } as const

const MATERIAL_PARTICIPATION_TESTS = [
  'test_1_over_500_hours',
  'test_2_substantially_all_participation',
  'test_3_over_100_hours_and_not_less_than_anyone',
  'test_4_significant_participation_activities',
  'test_5_five_of_last_ten_years',
  'test_6_personal_service_three_prior_years',
  'test_7_facts_and_circumstances',
  'does_not_materially_participate',
] as const

const SSTB_OPTIONS = ['sstb', 'not_sstb', 'not_sstb_de_minimis', 'separate_sstb_and_non_sstb_trades'] as const

const LIABILITY_SHARE_FIELDS: readonly FactItemField[] = [
  { key: 'kind', type: 'enum', label: 'Liability type', options: ['recourse', 'nonrecourse', 'qualified_nonrecourse'] },
  { key: 'amount', type: 'money', label: 'Share at year end' },
]

const MONEY_ROW_EVIDENCE: readonly EvidenceKind[] = ['books', 'bank_record', 'return_line']

// ─── The registry ───────────────────────────────────────────────────────────

export const FACT_DEFS: readonly FactDef[] = [
  // ── Entity identity and formation ─────────────────────────────────────────
  {
    key: 'entity.legal_form',
    scope: 'entity', applies_to: BUSINESS, type: 'enum',
    options: ['corporation', 'llc', 'general_partnership', 'limited_partnership', 'llp', 'other'],
    question: 'What kind of legal entity is this under state law — a corporation, an LLC, or a partnership?',
    why: 'Tax treatment is a separate election from legal form; an LLC taxed as an S-corp needs both its state filings and its election history to line up.',
    affects: ['corporate'],
    evidence: ['agreement', 'third_party_form'],
  },
  {
    key: 'entity.formation_date',
    scope: 'entity', applies_to: BUSINESS, type: 'date',
    question: 'On what date was the entity legally formed (the filing date on the articles of incorporation or organization)?',
    why: 'The date-incorporated box, the earliest possible S-election date and the first year a return was due all hang on it.',
    affects: ['corporate', 'irs_account'],
    evidence: ['third_party_form', 'agreement', 'return_line'],
    catalog: [
      { form: 'f1120s', line: 'E', note: 'Date incorporated' },
      { form: 'f1120', line: 'C', note: 'Date incorporated' },
      { form: 'f1065', line: 'E', note: 'Date business started' },
    ],
    derive_from_catalog: true,
  },
  {
    key: 'entity.formation_state',
    scope: 'entity', applies_to: BUSINESS, type: 'text',
    question: 'In which state was the entity formed, and is it registered to do business in any other state?',
    why: 'The formation state sets annual-report and franchise-tax duties, and registrations elsewhere usually mean more state returns.',
    affects: ['state', 'corporate'],
    evidence: ['third_party_form'],
  },
  {
    key: 'entity.ein_assigned_date',
    scope: 'entity', applies_to: BUSINESS, type: 'date',
    question: 'On what date did the IRS assign the EIN (the date on the CP575 or 147C letter), and for what form type was it registered?',
    why: 'The IRS opens filing requirements when the EIN is issued, so any year between that date and the first return filed shows as a delinquency.',
    affects: ['irs_account', 'corporate'],
    evidence: ['irs_notice', 'irs_transcript'],
  },
  {
    key: 'entity.tax_year_end',
    scope: 'entity', applies_to: BUSINESS, type: 'text',
    question: 'Is the tax year the calendar year (ending December 31)? If not, what month does it end, and under what authority (§444 election or business purpose)?',
    why: 'Due dates, extensions and estimated payments are computed from it, and an S-corp needs IRS approval for anything other than December.',
    affects: ['corporate', 'statute'],
    evidence: ['irs_notice', 'return_line'],
  },
  {
    key: 'entity.classification_history',
    scope: 'entity', applies_to: BUSINESS, type: 'list',
    item_fields: [
      { key: 'effective_date', type: 'date', label: 'Effective from' },
      { key: 'classification', type: 'enum', label: 'Taxed as', options: ['c_corporation', 's_corporation', 'partnership', 'disregarded', 'sole_proprietorship'] },
      { key: 'election', type: 'enum', label: 'How', options: ['default', 'form_8832', 'form_2553', 'late_election_relief'] },
    ],
    question: 'List every federal tax classification this entity has had since it was formed — C-corp, S-corp, partnership or disregarded — with the date each began and the election that caused it (default, Form 8832 or Form 2553).',
    why: 'Years taxed as a C-corp leave earnings & profits and built-in-gains exposure behind; an unknown history makes those invisible.',
    affects: ['corporate'],
    evidence: ['irs_notice', 'irs_transcript', 'return_line'],
  },
  {
    key: 'entity.governing_agreement',
    scope: 'entity', applies_to: BUSINESS, type: 'bool',
    question: 'Is a signed operating agreement, partnership agreement, or set of bylaws and shareholder agreement on file? What is the date of the current version?',
    why: 'Ownership percentages, allocations, distribution rights and who may sign all come from it; without it the K-1s rest on assumption.',
    affects: ['corporate', 'k1'],
    evidence: ['agreement'],
  },
  {
    key: 'entity.owns_disregarded_entities',
    scope: 'entity_year', applies_to: ALL, type: 'bool',
    question: 'Did this taxpayer own any single-member LLC or qualified subchapter S subsidiary (QSub) this year that does not file its own income tax return?',
    why: 'A disregarded entity is invisible on the income tax return but can still be an employer with its own EIN, W-2s and 941s that must tie back to this return.',
    affects: ['payroll', 'corporate'],
    evidence: ['owner_statement', 'agreement', 'irs_notice'],
  },
  {
    key: 'entity.disregarded_entities',
    scope: 'entity_year', applies_to: ALL, type: 'list',
    item_fields: [
      { key: 'name', type: 'text', label: 'Name' },
      { key: 'kind', type: 'enum', label: 'Kind', options: ['single_member_llc', 'qsub'] },
      { key: 'has_own_ein', type: 'bool', label: 'Has its own EIN' },
      { key: 'employer_of_record', type: 'bool', label: 'Issues W-2s and files 941s under its own EIN' },
      { key: 'activity', type: 'text', label: 'What it does', optional: true },
    ],
    question: 'For each disregarded entity: its name, whether it is an LLC or a QSub, whether it has its own EIN, whether it issues W-2s and files Forms 941 under that EIN, and what it does.',
    why: 'Wages paid under a disregarded entity\'s EIN are deducted on this return; if nobody knows which EIN issued them, the wage lines cannot be reconciled to the W-3s the IRS holds.',
    affects: ['payroll', 'corporate'],
    evidence: ['irs_notice', 'third_party_form', 'agreement'],
    required_when: { fact: 'entity.owns_disregarded_entities', equals: true },
  },
  {
    key: 'entity.business_description',
    scope: 'entity_year', applies_to: BUSINESS, type: 'text',
    question: 'In plain words, what did the business do this year, who were its customers, and what did it sell?',
    why: 'It drives the business code, the SSTB determination and the Schedule B answers; descriptions that change between years or between returns draw questions.',
    affects: ['qbi', 'corporate'],
    evidence: ['owner_statement', 'books', 'return_line'],
    catalog: [
      { form: 'f1120s', section: 'Schedule B', line: '2a', note: 'Business activity', relation: 'related' },
      { form: 'f1120s', section: 'Schedule B', line: '2b', note: 'Product or service', relation: 'related' },
      { form: 'f1120', section: 'Schedule K', line: '2b', note: 'Business activity', relation: 'related' },
      { form: 'f1120', section: 'Schedule K', line: '2c', note: 'Product or service', relation: 'related' },
      { form: 'f1065', line: 'A', note: 'Principal business activity', relation: 'related' },
      { form: 'f1065', line: 'B', note: 'Principal product or service', relation: 'related' },
    ],
  },
  {
    key: 'entity.naics_code',
    scope: 'entity_year', applies_to: BUSINESS, type: 'text',
    question: 'Which six-digit business activity (NAICS) code describes the business this year?',
    why: 'The code is how the IRS benchmarks the return and how SSTB status is screened; a code that names a specified service (accounting, consulting) next to a "not SSTB" answer is a contradiction on the face of the return.',
    affects: ['qbi', 'corporate'],
    evidence: ['return_line', 'owner_statement'],
    catalog: [
      { form: 'f1120s', line: 'B', note: 'Business activity code number' },
      { form: 'f1120', section: 'Schedule K', line: '2a', note: 'Business activity code no.' },
      { form: 'f1065', line: 'C', note: 'Business code number' },
    ],
    derive_from_catalog: true,
  },
  {
    key: 'entity.accounting_method',
    scope: 'entity_year', applies_to: BUSINESS, type: 'enum',
    options: ['cash', 'accrual', 'other'],
    question: 'Which overall accounting method did the entity use this year — cash or accrual? If it changed from the prior year, was Form 3115 filed?',
    why: 'It decides the year in which state taxes, intercompany fees and year-end bills are deductible; an unfiled method change is itself an error.',
    affects: ['corporate', 'intercompany', 'state'],
    evidence: ['return_line', 'books'],
    catalog: [
      { form: 'f1120s', section: 'Schedule B', line: '1', note: 'Check accounting method' },
      { form: 'f1120', section: 'Schedule K', line: '1', note: 'Check accounting method' },
      { form: 'f1065', line: 'H', note: 'Check accounting method' },
    ],
    derive_from_catalog: true,
  },
  {
    key: 'entity.sstb_determination',
    scope: 'entity_year', applies_to: ISSUERS, type: 'enum',
    options: SSTB_OPTIONS,
    question: 'Is the business a Specified Service Trade or Business under §199A(d)(2) this year — health, law, accounting, actuarial science, performing arts, consulting, athletics, financial services, brokerage, or one whose principal asset is the owners\' reputation or skill?',
    why: 'SSTB status sets the owners\' QBI deduction above the income threshold; it must match the K-1 §199A statement and the owners\' Form 8995-A.',
    affects: ['qbi', 'k1'],
    evidence: ['owner_statement', 'books', 'return_line'],
    catalog: [
      { form: 'f1120ssk', line: '17', row: 'V', note: '§199A statement SSTB indicator', relation: 'related' },
      { form: 'f1065sk1', line: '20', row: 'Z', note: '§199A statement SSTB indicator', relation: 'related' },
    ],
    counterpart: 'k1.sstb',
  },
  {
    key: 'entity.sstb_rationale',
    scope: 'entity_year', applies_to: ISSUERS, type: 'text',
    question: 'Why is the business (or is it not) an SSTB this year? Name the facts relied on: the services actually performed, how revenue splits between activities, and whether the de minimis test was applied.',
    why: 'The answer is a judgement; without the reasoning written down it gets re-decided differently each year, which is how a return ends up saying SSTB one year and not the next for the same business.',
    affects: ['qbi'],
    evidence: ['owner_statement', 'books'],
  },
  {
    key: 'entity.final_or_dissolved',
    scope: 'entity_year', applies_to: BUSINESS, type: 'bool',
    question: 'Did the entity stop operating, dissolve, merge or convert during this year, so that this is its final return?',
    why: 'A final return closes basis, triggers liquidation reporting and ends the state annual-report obligation; marking it wrongly leaves the IRS expecting returns that will never come.',
    affects: ['corporate', 'irs_account'],
    evidence: ['third_party_form', 'return_line'],
    catalog: [
      { form: 'f1120s', line: 'H', row: '1', note: 'Final return' },
      { form: 'f1120', line: 'E', row: '2', note: 'Final return' },
      { form: 'f1065', line: 'G', row: '2', note: 'Final return' },
    ],
    derive_from_catalog: true,
  },
  {
    key: 'entity.state_annual_report_filed',
    scope: 'entity_year', applies_to: BUSINESS, type: 'bool',
    question: 'Was the state annual report filed for this year (Florida: by May 1 on Sunbiz), and is the entity in active status?',
    why: 'An administratively dissolved entity can lose liability protection and its standing to sign contracts, and reinstatement fees accumulate.',
    affects: ['state', 'corporate'],
    evidence: ['third_party_form'],
  },
  {
    key: 'entity.qof',
    scope: 'entity_year', applies_to: ALL, type: 'enum',
    options: ['none', 'is_qof', 'holds_qof_investment', 'both'],
    question: 'Did the taxpayer certify as a Qualified Opportunity Fund this year (Form 8996), or hold an investment in one (Form 8997)?',
    why: 'Either status carries an annual form and deferred-gain inclusion dates that are lost if nobody knows the investment exists.',
    affects: ['corporate', 'carryovers'],
    evidence: ['owner_statement', 'return_line', 'third_party_form'],
    catalog: [
      { form: 'f1120s', section: 'Schedule B', line: '15', note: 'Attaching Form 8996 (QOF)', relation: 'related' },
    ],
  },
  {
    key: 'entity.digital_assets',
    scope: 'entity_year', applies_to: ALL, type: 'bool',
    question: 'At any time this year did the taxpayer receive digital assets (crypto, stablecoins, NFTs) as payment or reward, or sell, exchange or otherwise dispose of any?',
    why: 'The return asks this under penalties of perjury, and a "No" contradicted by an exchange\'s 1099-DA is an easy matching notice.',
    affects: ['irs_account'],
    evidence: ['owner_statement', 'third_party_form'],
  },
  {
    key: 'entity.foreign_accounts',
    scope: 'entity_year', applies_to: ALL, type: 'bool',
    question: 'At any time this year did the taxpayer have a financial interest in, or signature authority over, a bank, brokerage or other financial account outside the United States?',
    why: 'Foreign accounts above $10,000 in aggregate require an FBAR (FinCEN 114) with severe non-filing penalties, and the return\'s own question must be answered truthfully.',
    affects: ['irs_account'],
    evidence: ['owner_statement', 'bank_record'],
    catalog: [
      { form: 'f1040sb', section: 'Part III', line: '7a', note: 'Foreign account question' },
    ],
    derive_from_catalog: true,
  },

  // ── Owners (issuer side: 1120-S, 1120, 1065) ──────────────────────────────
  {
    key: 'owners.roster',
    scope: 'entity_year', applies_to: BUSINESS, type: 'list',
    item_fields: [
      { key: 'name', type: 'text', label: 'Owner name' },
      { key: 'kind', type: 'enum', label: 'Owner type', options: ['individual', 'corporation', 'partnership', 'trust', 'estate', 'disregarded_entity', 'other'] },
      { key: 'pct_end', type: 'percent', label: 'Ownership % at year end' },
      { key: 'us_person', type: 'bool', label: 'U.S. citizen or resident' },
      { key: 'officer', type: 'bool', label: 'Officer or manager' },
      { key: 'partner_type', type: 'enum', label: 'Partner type (1065 only)', options: ['general', 'limited', 'llc_member_manager', 'llc_member'], optional: true },
    ],
    question: 'List every owner at any time during the year: name, whether an individual or an entity, ownership percentage at year end, whether a U.S. person, and whether an officer or manager.',
    why: 'K-1 allocations, Schedule G, Form 1125-E and the controlled-group test all read from the owner list; ownership that lives only on the K-1s cannot be checked against them.',
    affects: ['k1', 'corporate', 'basis'],
    evidence: ['agreement', 'return_line', 'books'],
    catalog: [
      { form: 'f1120s', line: 'I', note: 'Number of shareholders during any part of the year', aggregate: { op: 'count' } },
      { form: 'f1120s', section: 'Schedule B', line: '3', note: 'Shareholder that is a disregarded entity, trust, estate or nominee', relation: 'related' },
      { form: 'f1120ssk', line: 'G', note: 'Current year allocation percentage', relation: 'related' },
      { form: 'f1120', section: 'Schedule K', line: '10', note: 'Number of shareholders at year end', relation: 'related' },
      { form: 'f1065', line: 'I', note: 'Number of Schedules K-1 attached', aggregate: { op: 'count' }, relation: 'related' },
    ],
  },
  {
    key: 'corp.shares_outstanding_begin',
    scope: 'entity_year', applies_to: CORPS, type: 'number',
    question: 'How many shares were issued and outstanding at the START of the year?',
    why: 'K-1 item D reports it, and S-corp allocations are per share per day; a share count nobody recorded makes every K-1 percentage unprovable.',
    affects: ['k1', 'corporate'],
    evidence: ['agreement', 'books', 'return_line'],
    catalog: [{ form: 'f1120ssk', line: 'D', col: 'beginning', note: 'Corporation\'s total number of shares' }],
    derive_from_catalog: true,
  },
  {
    key: 'corp.shares_outstanding_end',
    scope: 'entity_year', applies_to: CORPS, type: 'number',
    question: 'How many shares were issued and outstanding at the END of the year?',
    why: 'K-1 item D reports it; a change from the start of the year means shares were issued or redeemed, which changes allocations and may be a sale someone must report.',
    affects: ['k1', 'corporate'],
    evidence: ['agreement', 'books', 'return_line'],
    catalog: [{ form: 'f1120ssk', line: 'D', col: 'end', note: 'Corporation\'s total number of shares' }],
    derive_from_catalog: true,
  },
  {
    key: 'owners.shares_begin',
    scope: 'owner_year', applies_to: CORPS, type: 'number', subjects_from: OWNER_SUBJECTS,
    question: 'How many shares did this shareholder hold at the START of the year?',
    why: 'K-1 item H reports it, and the shares must add up to the corporation\'s total; percentages without share counts cannot be verified.',
    affects: ['k1', 'corporate'],
    evidence: ['agreement', 'books', 'return_line'],
    catalog: [{ form: 'f1120ssk', line: 'H', col: 'beginning', note: 'Shareholder\'s number of shares' }],
    derive_from_catalog: true,
  },
  {
    key: 'owners.shares_end',
    scope: 'owner_year', applies_to: CORPS, type: 'number', subjects_from: OWNER_SUBJECTS,
    question: 'How many shares did this shareholder hold at the END of the year?',
    why: 'K-1 item H reports it; a change during the year means a purchase, sale or redemption that changes the allocation and the shareholder\'s basis.',
    affects: ['k1', 'corporate'],
    evidence: ['agreement', 'books', 'return_line'],
    catalog: [{ form: 'f1120ssk', line: 'H', col: 'end', note: 'Shareholder\'s number of shares' }],
    derive_from_catalog: true,
  },
  {
    key: 'owners.basis_at_inception',
    scope: 'owner', applies_to: ISSUERS, type: 'money', subjects_from: OWNER_SUBJECTS,
    question: 'What was this owner\'s basis in their stock or partnership interest when they first acquired it — the cash paid in, plus the adjusted basis of any property contributed, or the purchase price if bought from someone else?',
    why: 'Basis is rolled forward from inception every year; without the starting figure every later loss limitation and every distribution test is unprovable.',
    affects: ['basis'],
    evidence: ['bank_record', 'agreement', 'books'],
    counterpart: 'k1.basis_at_inception',
  },
  {
    key: 'owners.capital_contributions',
    scope: 'owner_year', applies_to: BUSINESS, type: 'money', subjects_from: OWNER_SUBJECTS,
    question: 'How much did this owner contribute to the entity\'s capital this year — cash or property put in as equity, not as a loan?',
    why: 'Contributions increase basis (Form 7203 line 2, K-1 item L); money recorded as a contribution when it was meant as a loan, or the reverse, changes what is taxable when it comes back out.',
    affects: ['basis', 'balance_sheet'],
    evidence: ['bank_record', 'books'],
    catalog: [
      { form: 'f1065sk1', line: 'L', row: 'Capital contributed during the year' },
    ],
    counterpart: 'k1.capital_contributions',
  },
  {
    key: 'owners.distributions',
    scope: 'owner_year', applies_to: ISSUERS, type: 'money', subjects_from: OWNER_SUBJECTS,
    question: 'How much did the entity distribute to this owner this year, per the books — cash plus the fair value of any property, including personal expenses paid on the owner\'s behalf?',
    why: 'Distributions above basis are taxable gain on the owner\'s return, and S-corp distributions that are not pro rata to shares put the S election at risk.',
    affects: ['basis', 'k1'],
    evidence: ['books', 'bank_record', 'return_line'],
    catalog: [
      { form: 'f1120ssk', line: '16', row: 'D', note: 'Distributions' },
      { form: 'f1065sk1', line: '19', row: 'A', note: 'Cash distributions (property is code B/C)', relation: 'related' },
      { form: 'f1120s', section: 'Schedule M-2', line: '7', col: 'a', note: 'Distributions, all shareholders', relation: 'related' },
    ],
    derive_from_catalog: true,
    counterpart: 'k1.distributions',
  },
  {
    key: 'owners.material_participation',
    scope: 'owner_year', applies_to: ISSUERS, type: 'enum', subjects_from: OWNER_SUBJECTS,
    options: MATERIAL_PARTICIPATION_TESTS,
    question: 'Did this owner materially participate in the business this year, and under which of the seven §469 tests — for example, more than 500 hours of work?',
    why: 'It decides whether the owner\'s share is passive or nonpassive on Schedule E and therefore whether NIIT applies; leaving it unrecorded once caused nonpassive S-corp income to be taxed as passive with NIIT.',
    affects: ['niit', 'k1'],
    evidence: ['owner_statement', 'books'],
    counterpart: 'k1.material_participation',
  },
  {
    key: 'owners.participation_hours',
    scope: 'owner_year', applies_to: ISSUERS, type: 'number', subjects_from: OWNER_SUBJECTS,
    question: 'Roughly how many hours did this owner work in the business this year, and what records (calendar, timesheets, emails) support that?',
    why: 'Hours are the evidence behind the 500-hour, 100-hour and significant-participation tests; a material participation claim with no hours estimate cannot be defended.',
    affects: ['niit'],
    evidence: ['owner_statement', 'books'],
    counterpart: 'k1.participation_hours',
  },
  {
    key: 'owners.suspended_losses_carried_in',
    scope: 'owner_year', applies_to: ISSUERS, type: 'money', subjects_from: OWNER_SUBJECTS,
    question: 'Did this owner carry into this year any losses that were disallowed in earlier years for lack of basis (§1366(d) for S-corps, §704(d) for partnerships)? How much?',
    why: 'Suspended losses become deductible as soon as basis is restored; if nobody carries them forward they are simply lost.',
    affects: ['basis', 'carryovers'],
    evidence: ['return_line', 'books'],
    counterpart: 'k1.suspended_losses_carried_in',
  },
  {
    key: 'owners.direct_loan_balance_end',
    scope: 'owner_year', applies_to: S_CORP, type: 'money', subjects_from: OWNER_SUBJECTS,
    question: 'At year end, how much did the company owe this shareholder for money the shareholder lent DIRECTLY from personal funds (not through another company they own)?',
    why: 'Only a direct shareholder loan creates debt basis; K-1 item I must show exactly this figure and Schedule L line 19 must agree with the total.',
    affects: ['basis', 'loans', 'k1'],
    evidence: ['bank_record', 'agreement', 'books', 'return_line'],
    catalog: [
      { form: 'f1120ssk', line: 'I', col: 'end', note: 'Loans from shareholder' },
    ],
    derive_from_catalog: true,
    counterpart: 'k1.direct_loan_balance_end',
  },
  {
    key: 'owners.officer_compensation',
    scope: 'owner_year', applies_to: CORPS, type: 'money', subjects_from: OWNER_SUBJECTS,
    question: 'How much W-2 compensation (box 1 and box 5) did this owner receive from the company this year as an officer or employee? Answer 0 if none.',
    why: 'It must equal Form 1125-E and the W-2; S-corp officer pay that is low against distributions is the most common reasonable-compensation adjustment, and wages reduce QBI.',
    affects: ['payroll', 'qbi'],
    evidence: ['third_party_form', 'books', 'return_line'],
    catalog: [
      { form: 'f1125e', line: '1', col: 'f', note: 'Amount of compensation (this officer\'s row)', relation: 'related' },
      { form: 'f1120s', line: '7', note: 'Compensation of officers, all officers', relation: 'related' },
      { form: 'f1120', line: '12', note: 'Compensation of officers, all officers', relation: 'related' },
    ],
    counterpart: 'k1.wages_from_issuer',
  },
  {
    key: 'owners.health_insurance_paid',
    scope: 'owner_year', applies_to: S_CORP, type: 'money', subjects_from: OWNER_SUBJECTS,
    question: 'How much did the company pay this year toward this shareholder\'s (and family\'s) health insurance premiums? (For a 2%+ shareholder it must be included in W-2 box 1.)',
    why: 'Premiums left off the W-2 are a payroll error, and they are what lets the shareholder take the self-employed health insurance deduction.',
    affects: ['payroll'],
    evidence: ['third_party_form', 'books'],
  },
  {
    key: 'owners.guaranteed_payments',
    scope: 'owner_year', applies_to: PARTNERSHIP, type: 'money', subjects_from: OWNER_SUBJECTS,
    question: 'How much did the partnership pay this partner this year as guaranteed payments (for services or for the use of capital), regardless of profit?',
    why: 'Guaranteed payments are ordinary income subject to self-employment tax, are not QBI, and must appear as such on the K-1 and the partner\'s Schedule E.',
    affects: ['qbi', 'k1', 'payroll'],
    evidence: ['books', 'agreement', 'return_line'],
    catalog: [
      { form: 'f1065sk1', line: '4c', note: 'Total guaranteed payments' },
      { form: 'f1065', line: '10', note: 'Guaranteed payments, all partners', relation: 'related' },
    ],
    derive_from_catalog: true,
    counterpart: 'k1.guaranteed_payments',
  },
  {
    key: 'owners.share_of_liabilities',
    scope: 'owner_year', applies_to: PARTNERSHIP, type: 'list', subjects_from: OWNER_SUBJECTS,
    item_fields: LIABILITY_SHARE_FIELDS,
    question: 'At year end, what was this partner\'s share of the partnership\'s liabilities, split into recourse, nonrecourse and qualified nonrecourse financing?',
    why: 'A partner\'s share of liabilities is part of outside basis and at-risk amount, so it decides whether losses are deductible.',
    affects: ['basis', 'k1'],
    evidence: ['books', 'agreement', 'return_line'],
    catalog: [
      { form: 'f1065sk1', line: 'K', note: 'Partner\'s share of liabilities', relation: 'related' },
    ],
    counterpart: 'k1.share_of_liabilities',
  },

  // ── Corporate governance and compensation ─────────────────────────────────
  {
    key: 'corp.non_owner_officers',
    scope: 'entity_year', applies_to: CORPS, type: 'list',
    item_fields: [
      { key: 'name', type: 'text', label: 'Name' },
      { key: 'title', type: 'text', label: 'Title' },
      { key: 'compensation', type: 'money', label: 'Compensation' },
      { key: 'pct_time', type: 'percent', label: '% of time devoted to the business' },
    ],
    question: 'Apart from owners, did anyone else serve as an officer this year? For each: name, title, compensation and percent of time devoted to the business. (Answer with an empty list if none.)',
    why: 'Form 1125-E must list every officer, and officer pay is a separate deduction line from other wages.',
    affects: ['payroll', 'corporate'],
    evidence: ['third_party_form', 'books'],
    catalog: [{ form: 'f1125e', line: '1', note: 'Officer rows', relation: 'related' }],
  },
  {
    key: 'corp.reasonable_compensation_basis',
    scope: 'entity_year', applies_to: CORPS, type: 'text',
    question: 'How was the owner-officers\' salary set this year — comparable pay data, hours and duties, a written compensation study, or not considered?',
    why: 'The IRS recharacterizes S-corp distributions as wages when officer pay is unreasonably low (and C-corp pay as dividends when it is high); a written basis is the defence.',
    affects: ['payroll', 'corporate'],
    evidence: ['owner_statement', 'agreement', 'third_party_form'],
  },
  {
    key: 'entity.owner_personal_expenses_paid',
    scope: 'entity_year', applies_to: BUSINESS, type: 'bool',
    question: 'Did the business pay any owner\'s personal expenses this year, or let an owner use company property (car, home office, travel) personally without reimbursing it?',
    why: 'Such payments are distributions, dividends or wages — not business deductions — and booked as expenses they overstate deductions and understate basis reductions.',
    affects: ['corporate', 'basis', 'payroll'],
    evidence: ['books', 'bank_record', 'owner_statement'],
  },
  {
    key: 'corp.controlled_group_member',
    scope: 'entity_year', applies_to: CORPS, type: 'bool',
    question: 'Was this corporation part of a controlled group this year — another corporation owns 80% of it, or the same five or fewer people own more than 50% of it and of another corporation?',
    why: 'Controlled-group members must file Schedule O and share certain limits (including Florida\'s $50,000 exemption); members\' returns must tell the same story.',
    affects: ['corporate', 'state', 'intercompany'],
    evidence: ['agreement', 'return_line'],
  },
  {
    key: 'corp.controlled_group_members',
    scope: 'entity_year', applies_to: CORPS, type: 'list',
    item_fields: [
      { key: 'name', type: 'text', label: 'Member' },
      { key: 'group_type', type: 'enum', label: 'Group type', options: ['parent_subsidiary', 'brother_sister', 'combined'] },
      { key: 'common_owners', type: 'text', label: 'Common owners' },
      { key: 'return_form', type: 'enum', label: 'Return it files', options: ['1120', '1120S', '1065', 'other'] },
    ],
    question: 'List the other members of the controlled group: name, type of group (parent-subsidiary or brother-sister), the common owners, and which return each files.',
    why: 'Schedule O must name every member and apportion shared items consistently on each member\'s return.',
    affects: ['corporate', 'state', 'intercompany'],
    evidence: ['agreement', 'return_line'],
    catalog: [{ form: 'f1120so', section: 'Part I', line: '1', note: 'Type of controlled group', relation: 'related' }],
    required_when: { fact: 'corp.controlled_group_member', equals: true },
  },

  // ── S corporation ─────────────────────────────────────────────────────────
  {
    key: 'scorp.election_effective_date',
    scope: 'entity', applies_to: S_CORP, type: 'date',
    question: 'What is the effective date of the S election, as stated on the IRS acceptance letter (CP261)?',
    why: 'It is item A on every 1120-S; any period before it is a C-corp period with its own return, earnings & profits and built-in-gains consequences.',
    affects: ['corporate', 'irs_account'],
    evidence: ['irs_notice', 'return_line'],
    catalog: [{ form: 'f1120s', line: 'A', note: 'S election effective date' }],
    derive_from_catalog: true,
  },
  {
    key: 'scorp.form_2553_filed_date',
    scope: 'entity', applies_to: S_CORP, type: 'date',
    question: 'On what date was Form 2553 filed (mailed or faxed), and was it filed again after any rejection?',
    why: 'An election filed more than 2 months and 15 days into the year it is meant to take effect is late and is valid only with relief.',
    affects: ['corporate', 'irs_account'],
    evidence: ['irs_notice', 'third_party_form'],
  },
  {
    key: 'scorp.election_acceptance_date',
    scope: 'entity', applies_to: S_CORP, type: 'date',
    question: 'On what date did the IRS issue the S election acceptance letter (CP261)? If none has arrived, say so.',
    why: 'Returns filed as 1120-S before the election was accepted may have been processed as missing 1120s; an acceptance years after the effective date usually means penalty notices for the gap.',
    affects: ['corporate', 'irs_account'],
    evidence: ['irs_notice', 'irs_transcript'],
  },
  {
    key: 'scorp.late_election_relief',
    scope: 'entity', applies_to: S_CORP, type: 'bool',
    question: 'Was the S election filed late with a request for relief (Rev. Proc. 2013-30 or a private letter ruling)?',
    why: 'A late election without granted relief is invalid, which would make every 1120-S filed under it the wrong return.',
    affects: ['corporate'],
    evidence: ['irs_notice'],
  },
  {
    key: 'scorp.shareholder_consents',
    scope: 'entity', applies_to: S_CORP, type: 'bool',
    question: 'Did every person who was a shareholder on the election date (and each spouse with a community-property interest) sign the consent on Form 2553?',
    why: 'A missing consent invalidates the election.',
    affects: ['corporate'],
    evidence: ['third_party_form', 'irs_notice'],
  },
  {
    key: 'scorp.prior_c_corp_history',
    scope: 'entity', applies_to: S_CORP, type: 'bool',
    question: 'Was this entity ever taxed as a C corporation before its S election (filed, or should have filed, Form 1120), or did it acquire assets from a C corporation in a tax-free transaction?',
    why: 'C-corp history leaves accumulated earnings & profits (taxable dividends ahead of basis, passive-income tax, termination risk) and five years of built-in-gains tax exposure.',
    affects: ['corporate', 'basis'],
    evidence: ['irs_transcript', 'return_line', 'owner_statement'],
    catalog: [
      { form: 'f1120s', section: 'Schedule B', line: '8', note: 'Net unrealized built-in gain', relation: 'related' },
      { form: 'f1120s', section: 'Schedule M-2', line: '1', col: 'c', note: 'Accumulated earnings and profits', relation: 'related' },
    ],
  },
  {
    key: 'scorp.accumulated_ep_at_election',
    scope: 'entity', applies_to: S_CORP, type: 'money',
    question: 'What were the corporation\'s accumulated earnings and profits on the day the S election took effect?',
    why: 'Distributions above the AAA come out of these E&P as taxable dividends, and E&P plus too much passive income can terminate the election.',
    affects: ['corporate', 'basis'],
    evidence: ['return_line', 'books'],
    catalog: [{ form: 'f1120s', section: 'Schedule M-2', line: '1', col: 'c', note: 'Accumulated E&P (first S year)', relation: 'related' }],
    required_when: { fact: 'scorp.prior_c_corp_history', equals: true },
  },
  {
    key: 'scorp.nubig_at_election',
    scope: 'entity', applies_to: S_CORP, type: 'money',
    question: 'What was the net unrealized built-in gain on the S election date — fair value of all assets (including receivables and goodwill) over their tax basis?',
    why: 'Built-in gains recognized within five years of conversion are taxed at the corporate level (§1374) on Schedule D.',
    affects: ['corporate'],
    evidence: ['books', 'third_party_form', 'return_line'],
    catalog: [{ form: 'f1120s', section: 'Schedule B', line: '8', note: 'Net unrealized built-in gain', relation: 'related' }],
    required_when: { fact: 'scorp.prior_c_corp_history', equals: true },
  },
  {
    key: 'scorp.ownership_changed',
    scope: 'entity_year', applies_to: S_CORP, type: 'bool',
    question: 'Did any shareholder\'s percentage change during the year — shares issued, redeemed, sold or transferred, or a shareholder died?',
    why: 'K-1 allocations must then be made per share per day (or on a closing of the books), and the change usually has a basis and gain consequence for someone.',
    affects: ['k1', 'basis', 'corporate'],
    evidence: ['agreement', 'books'],
    catalog: [{ form: 'f1120ssk', line: 'H', note: 'Shareholder\'s number of shares, beginning vs end', relation: 'related' }],
  },
  {
    key: 'scorp.closing_of_books_election',
    scope: 'entity_year', applies_to: S_CORP, type: 'bool',
    question: 'When ownership changed, was a §1377(a)(2) election made (with every affected shareholder\'s consent) to close the books on the date of the change?',
    why: 'Without the election income is allocated per day across the whole year, which can shift income to the wrong shareholder.',
    affects: ['k1'],
    evidence: ['agreement', 'return_line'],
    required_when: { fact: 'scorp.ownership_changed', equals: true },
  },
  {
    key: 'scorp.single_class_of_stock',
    scope: 'entity_year', applies_to: S_CORP, type: 'bool',
    question: 'Throughout the year, did every share carry identical rights to distributions and liquidation proceeds, and were all distributions made in proportion to shares held?',
    why: 'Disproportionate distributions or differing rights can be a second class of stock, which terminates the S election.',
    affects: ['corporate', 'k1'],
    evidence: ['agreement', 'books', 'bank_record'],
  },

  // ── C corporation ─────────────────────────────────────────────────────────
  {
    key: 'ccorp.personal_service_corporation',
    scope: 'entity_year', applies_to: C_CORP, type: 'bool',
    question: 'Is this a personal service corporation — substantially all of its work is in health, law, engineering, architecture, accounting, actuarial science, performing arts or consulting, performed by employee-owners?',
    why: 'PSC status is checked on page 1 (item A3) and brings the passive-activity rules and a calendar-year requirement with it.',
    affects: ['corporate'],
    evidence: ['owner_statement', 'return_line'],
    catalog: [{ form: 'f1120', line: 'A', row: '3', note: 'Personal service corporation' }],
    derive_from_catalog: true,
  },
  {
    key: 'ccorp.dividends_paid',
    scope: 'entity_year', applies_to: C_CORP, type: 'money',
    question: 'How much did the corporation pay its shareholders this year as dividends, in cash or property?',
    why: 'Dividends require Forms 1099-DIV, reduce earnings & profits on Schedule M-2, and anything paid to shareholders that is not salary or a documented loan repayment is a dividend whether or not it was called one.',
    affects: ['corporate', 'balance_sheet'],
    evidence: ['books', 'bank_record', 'third_party_form'],
    catalog: [{ form: 'f1120', section: 'Schedule M-2', line: '5a', note: 'Distributions: cash', relation: 'related' }],
  },

  // ── Partnership ───────────────────────────────────────────────────────────
  {
    key: 'partnership.section_754_election',
    scope: 'entity', applies_to: PARTNERSHIP, type: 'bool',
    question: 'Has the partnership ever made a §754 election (and not revoked it)? In which year?',
    why: 'With the election in place, every transfer of an interest and certain distributions require basis adjustments to partnership property.',
    affects: ['basis', 'k1'],
    evidence: ['return_line'],
    catalog: [{ form: 'f1065', section: 'Schedule B', line: '10a', note: 'Section 754 election' }],
    derive_from_catalog: true,
  },
  {
    key: 'partnership.capital_account_method',
    scope: 'entity_year', applies_to: PARTNERSHIP, type: 'enum',
    options: ['tax_basis', 'gaap', 'section_704b', 'other'],
    question: 'On what basis are the partners\' capital accounts kept in the books — tax basis, GAAP, or §704(b)?',
    why: 'K-1 item L must be reported on the tax basis; when the books use another method the difference has to be reconciled every year.',
    affects: ['k1', 'balance_sheet', 'basis'],
    evidence: ['books', 'agreement'],
    catalog: [{ form: 'f1065sk1', line: 'L', note: 'Partner\'s capital account analysis', relation: 'related' }],
  },
  {
    key: 'partnership.special_allocations',
    scope: 'entity_year', applies_to: PARTNERSHIP, type: 'bool',
    question: 'Does the partnership agreement allocate any item other than in proportion to capital — special allocations, preferred returns, or different profit and loss percentages?',
    why: 'Special allocations must follow the agreement and have substantial economic effect; K-1s prepared pro rata would then be wrong.',
    affects: ['k1'],
    evidence: ['agreement'],
  },
  {
    key: 'partnership.bba_election_out',
    scope: 'entity_year', applies_to: PARTNERSHIP, type: 'bool',
    question: 'Is the partnership electing out of the centralized partnership audit regime (§6221(b)) this year? (Only possible with 100 or fewer eligible partners.)',
    why: 'Without the election an IRS audit assesses tax at the partnership level, which changes who pays for a prior-year error.',
    affects: ['irs_account', 'statute'],
    evidence: ['return_line'],
    catalog: [{ form: 'f1065', section: 'Schedule B', line: '25', note: 'Election out of centralized audit regime', relation: 'related' }],
  },
  {
    key: 'partnership.representative',
    scope: 'entity_year', applies_to: PARTNERSHIP, type: 'text',
    question: 'Who is the designated partnership representative for this year (and the designated individual, if the representative is an entity)?',
    why: 'The representative alone binds every partner in an IRS proceeding; an undesignated one is appointed by the IRS.',
    affects: ['irs_account'],
    evidence: ['return_line', 'agreement'],
  },

  // ── Loans ─────────────────────────────────────────────────────────────────
  {
    key: 'loans.from_owners_exist',
    scope: 'entity_year', applies_to: BUSINESS, type: 'bool',
    question: 'At any time this year, did an owner lend money to the entity, or was an earlier owner loan still outstanding?',
    why: 'Owner loans affect debt basis, Schedule L and the K-1; asking first keeps a "no" from being confused with "nobody asked".',
    affects: ['loans', 'basis', 'balance_sheet'],
    evidence: ['books', 'bank_record'],
  },
  {
    key: 'loans.from_owners',
    scope: 'entity_year', applies_to: BUSINESS, type: 'list',
    item_fields: [
      { key: 'lender', type: 'text', label: 'Lender (owner)' },
      { key: 'direct_from_owner', type: 'bool', label: 'Paid directly from the owner\'s personal funds' },
      { key: 'balance_begin', type: 'money', label: 'Balance at start of year' },
      { key: 'advances', type: 'money', label: 'New advances' },
      { key: 'repayments', type: 'money', label: 'Principal repaid' },
      { key: 'balance_end', type: 'money', label: 'Balance at end of year' },
      { key: 'written_note', type: 'bool', label: 'Signed promissory note' },
      { key: 'interest_rate', type: 'percent', label: 'Stated interest rate', optional: true },
      { key: 'note_date', type: 'date', label: 'Date of the note', optional: true },
    ],
    question: 'List each loan from an owner outstanding during the year: lender, whether the money came directly from the owner personally (not through another company), opening balance, new advances, repayments, closing balance, whether there is a signed note, and the interest rate.',
    why: 'Only a direct loan from the shareholder creates debt basis, repayment of a basis-reduced loan is taxable, and Schedule L line 19 and K-1 item I must equal these balances.',
    affects: ['loans', 'basis', 'balance_sheet', 'k1'],
    evidence: ['agreement', 'bank_record', 'books'],
    catalog: [
      { form: 'f1120s', section: 'Schedule L', line: '19', col: 'd', note: 'Loans from shareholders, end of year', aggregate: { op: 'sum', field: 'balance_end' } },
      { form: 'f1120', section: 'Schedule L', line: '19', col: 'd', note: 'Loans from shareholders, end of year', aggregate: { op: 'sum', field: 'balance_end' } },
      { form: 'f1065', section: 'Schedule L', line: '19a', col: 'd', note: 'Loans from partners (or persons related to partners)', relation: 'related' },
      { form: 'f1120ssk', line: 'I', col: 'end', note: 'Loans from shareholder', relation: 'related' },
    ],
    required_when: { fact: 'loans.from_owners_exist', equals: true },
  },
  {
    key: 'loans.from_related_entities_exist',
    scope: 'entity_year', applies_to: BUSINESS, type: 'bool',
    question: 'At any time this year, did the entity owe money to another company with common ownership (a sister company, a parent, or a company an owner controls)?',
    why: 'A loan from a related company looks like an owner loan on the books but creates no debt basis; it is the most common basis error in closely held groups.',
    affects: ['loans', 'basis', 'intercompany'],
    evidence: ['books', 'bank_record'],
  },
  {
    key: 'loans.from_related_entities',
    scope: 'entity_year', applies_to: BUSINESS, type: 'list',
    item_fields: [
      { key: 'lender_entity', type: 'text', label: 'Lending company' },
      { key: 'common_owner', type: 'text', label: 'Common owner' },
      { key: 'balance_begin', type: 'money', label: 'Balance at start of year' },
      { key: 'advances', type: 'money', label: 'New advances' },
      { key: 'repayments', type: 'money', label: 'Principal repaid' },
      { key: 'balance_end', type: 'money', label: 'Balance at end of year' },
      { key: 'written_note', type: 'bool', label: 'Signed promissory note' },
      { key: 'interest_rate', type: 'percent', label: 'Stated interest rate', optional: true },
      { key: 'schedule_l_line', type: 'enum', label: 'Where it is on Schedule L', options: ['19_loans_from_shareholders', '17_short_term_notes', '20_long_term_notes', '18_other_current_liabilities', '21_other_liabilities', 'not_on_schedule_l'] },
    ],
    question: 'List each loan from a related company: the lender, the common owner, opening balance, advances, repayments, closing balance, whether there is a note and rate, and which Schedule L line it is reported on.',
    why: 'A loss funded by a related company\'s loan gives the shareholder no debt basis; reporting it as a shareholder loan (line 19, K-1 item I) overstates basis, and the lender\'s books must show the same balance.',
    affects: ['loans', 'basis', 'intercompany', 'balance_sheet'],
    evidence: ['agreement', 'bank_record', 'books'],
    catalog: [
      { form: 'f1120s', section: 'Schedule L', line: '19', col: 'd', note: 'Must NOT include related-company loans', relation: 'related' },
      { form: 'f1120s', section: 'Schedule L', line: '20', col: 'd', relation: 'related' },
      { form: 'f1120s', section: 'Schedule L', line: '21', col: 'd', relation: 'related' },
      { form: 'f1120', section: 'Schedule L', line: '20', col: 'd', relation: 'related' },
      { form: 'f1120', section: 'Schedule L', line: '21', col: 'd', relation: 'related' },
    ],
    required_when: { fact: 'loans.from_related_entities_exist', equals: true },
  },
  {
    key: 'loans.to_owners_exist',
    scope: 'entity_year', applies_to: BUSINESS, type: 'bool',
    question: 'At any time this year, was any owner (or a person or company related to an owner) in debt to the entity — an advance, a loan, or money taken out to be repaid later?',
    why: 'Loans to owners are a primary audit flag, and advances that are never repaid are reclassified as distributions or dividends.',
    affects: ['loans', 'balance_sheet', 'corporate'],
    evidence: ['books', 'bank_record'],
  },
  {
    key: 'loans.to_owners',
    scope: 'entity_year', applies_to: BUSINESS, type: 'list',
    item_fields: [
      { key: 'borrower', type: 'text', label: 'Borrower' },
      { key: 'balance_begin', type: 'money', label: 'Balance at start of year' },
      { key: 'advances', type: 'money', label: 'New advances' },
      { key: 'repayments', type: 'money', label: 'Principal repaid' },
      { key: 'balance_end', type: 'money', label: 'Balance at end of year' },
      { key: 'written_note', type: 'bool', label: 'Signed promissory note' },
      { key: 'fixed_repayment_schedule', type: 'bool', label: 'Fixed repayment schedule' },
      { key: 'interest_rate', type: 'percent', label: 'Stated interest rate', optional: true },
      { key: 'interest_paid', type: 'money', label: 'Interest actually paid this year' },
    ],
    question: 'List each loan the entity made to an owner or related person that was outstanding during the year: borrower, balances, advances, repayments, whether there is a signed note with a repayment schedule, the interest rate, and the interest actually paid.',
    why: 'A balance with no note, no interest and no repayments is treated as a distribution (S-corp: possibly a disproportionate one) or a constructive dividend, and below-market loans impute interest; Schedule L line 7 has to stand up on this.',
    affects: ['loans', 'balance_sheet', 'corporate', 'basis'],
    evidence: ['agreement', 'bank_record', 'books'],
    catalog: [
      { form: 'f1120s', section: 'Schedule L', line: '7', col: 'd', note: 'Loans to shareholders, end of year', aggregate: { op: 'sum', field: 'balance_end' } },
      { form: 'f1120', section: 'Schedule L', line: '7', col: 'd', note: 'Loans to shareholders, end of year', aggregate: { op: 'sum', field: 'balance_end' } },
      { form: 'f1065', section: 'Schedule L', line: '7a', col: 'd', note: 'Loans to partners (or persons related to partners)', relation: 'related' },
    ],
    required_when: { fact: 'loans.to_owners_exist', equals: true },
  },

  // ── Intercompany ──────────────────────────────────────────────────────────
  {
    key: 'intercompany.has_related_entities',
    scope: 'entity', applies_to: BUSINESS, type: 'bool',
    question: 'Does this entity do business with any other company that shares an owner — fees, shared staff, shared costs, rent or loans?',
    why: 'Every related-party flow has two sides that must agree year by year; a counterparty nobody listed is never reconciled.',
    affects: ['intercompany'],
    evidence: ['owner_statement', 'books'],
  },
  {
    key: 'intercompany.counterparties',
    scope: 'entity', applies_to: BUSINESS, type: 'list',
    item_fields: [
      { key: 'name', type: 'text', label: 'Related company' },
      { key: 'relationship', type: 'text', label: 'How it is related' },
      { key: 'return_form', type: 'enum', label: 'Return it files', options: ['1120', '1120S', '1065', '1040', 'other'] },
      { key: 'in_this_account', type: 'bool', label: 'Its returns are kept in this system' },
    ],
    question: 'List every related company this entity deals with: its name, how it is related (who owns what), and which return it files.',
    why: 'This list drives the cross-entity checks — fees, balances and loans are reconciled against each counterparty named here.',
    affects: ['intercompany'],
    evidence: ['owner_statement', 'agreement'],
    required_when: { fact: 'intercompany.has_related_entities', equals: true },
  },
  {
    key: 'intercompany.agreement_in_place',
    scope: 'relationship_year', applies_to: BUSINESS, type: 'bool', subjects_from: COUNTERPARTY_SUBJECTS,
    question: 'Is there a written agreement with this related company covering this year\'s services and fees? What are its date and term?',
    why: 'Without an agreement, related-party fees look like disguised distributions or income shifting and the deduction is the first thing disallowed.',
    affects: ['intercompany'],
    evidence: ['agreement'],
    required_when: { fact: 'intercompany.has_related_entities', equals: true },
  },
  {
    key: 'intercompany.services',
    scope: 'relationship_year', applies_to: BUSINESS, type: 'text', subjects_from: COUNTERPARTY_SUBJECTS,
    question: 'What did this entity provide to, or receive from, this related company this year?',
    why: 'The fee is only deductible for real services at an arm\'s-length price, and the description has to match on both returns.',
    affects: ['intercompany'],
    evidence: ['agreement', 'owner_statement'],
    required_when: { fact: 'intercompany.has_related_entities', equals: true },
  },
  {
    key: 'intercompany.fee_revenue',
    scope: 'relationship_year', applies_to: BUSINESS, type: 'money', subjects_from: COUNTERPARTY_SUBJECTS,
    question: 'How much did this entity charge this related company for the year (revenue to this entity)? Answer 0 if nothing.',
    why: 'This entity\'s revenue must equal the related company\'s deduction for the same year; mismatches (double-billed journal entries, a fee booked in the wrong year) break both returns.',
    affects: ['intercompany'],
    evidence: ['books', 'agreement', 'bank_record'],
    required_when: { fact: 'intercompany.has_related_entities', equals: true },
  },
  {
    key: 'intercompany.fee_expense',
    scope: 'relationship_year', applies_to: BUSINESS, type: 'money', subjects_from: COUNTERPARTY_SUBJECTS,
    question: 'How much did this related company charge THIS entity for the year (an expense here)? Answer 0 if nothing.',
    why: 'The deduction here must equal the related company\'s revenue for the same year, and an accrued but unpaid related-party fee is not deductible until the payee includes it (§267(a)(2)).',
    affects: ['intercompany'],
    evidence: ['books', 'agreement', 'bank_record'],
    required_when: { fact: 'intercompany.has_related_entities', equals: true },
  },
  {
    key: 'intercompany.settlement',
    scope: 'relationship_year', applies_to: BUSINESS, type: 'enum', subjects_from: COUNTERPARTY_SUBJECTS,
    options: ['invoiced_and_paid_in_year', 'invoiced_paid_after_year_end', 'journal_entry_only', 'not_invoiced'],
    question: 'How were this year\'s charges with this related company invoiced and settled — invoices paid within the year, invoiced but paid after year end, a journal entry only, or not invoiced?',
    why: 'A cash-basis payee and an accrual-basis payor recognise the same fee in different years unless it is paid in the year; journal-entry-only fees are the ones that double up.',
    affects: ['intercompany'],
    evidence: ['books', 'bank_record'],
    required_when: { fact: 'intercompany.has_related_entities', equals: true },
  },
  {
    key: 'intercompany.balance_end',
    scope: 'relationship_year', applies_to: BUSINESS, type: 'money', subjects_from: COUNTERPARTY_SUBJECTS,
    question: 'At year end, what was the net balance between this entity and this related company? (Positive = the related company owes this entity; negative = this entity owes it.)',
    why: 'One side\'s receivable must equal the other side\'s payable on both balance sheets; a difference means an entry is missing on one side.',
    affects: ['intercompany', 'balance_sheet', 'loans'],
    evidence: ['books'],
    required_when: { fact: 'intercompany.has_related_entities', equals: true },
  },

  // ── State ─────────────────────────────────────────────────────────────────
  {
    key: 'state.filing_states',
    scope: 'entity_year', applies_to: ALL, type: 'list',
    item_fields: [
      { key: 'state', type: 'text', label: 'State' },
      { key: 'reason', type: 'enum', label: 'Why it files', options: ['formation', 'physical_presence', 'payroll', 'sales', 'property', 'residency', 'nonresident_income', 'pass_through_entity_tax'] },
      { key: 'return_form', type: 'text', label: 'State return', optional: true },
    ],
    question: 'In which states did the taxpayer have to file an income or franchise tax return this year, and why each one?',
    why: 'A state obligation nobody listed is never filed; each listed state is checked for a return and payments.',
    affects: ['state'],
    evidence: ['owner_statement', 'third_party_form', 'return_line'],
  },
  {
    key: 'state.income_tax_payments',
    scope: 'entity_year', applies_to: CORPS, type: 'list',
    item_fields: [
      { key: 'state', type: 'text', label: 'State' },
      { key: 'payment_date', type: 'date', label: 'Date paid' },
      { key: 'amount', type: 'money', label: 'Amount' },
      { key: 'for_tax_year', type: 'number', label: 'Tax year it was for' },
      { key: 'kind', type: 'enum', label: 'Kind', options: ['estimate', 'extension', 'balance_due', 'amended_return', 'penalty_or_interest'] },
    ],
    question: 'List every state income or franchise tax payment made during this year: the state, date paid, amount, which tax year it was for, and whether it was an estimate, extension payment, balance due, amended-return payment, or penalty and interest.',
    why: 'State income tax is deducted on the federal return in the year paid (or properly accrued), never in the year it relates to by default — a Florida corporate tax that was never deducted is exactly this fact going unrecorded; penalties and interest are not deductible as tax.',
    affects: ['state', 'carryovers'],
    evidence: ['bank_record', 'third_party_form', 'books'],
    catalog: [
      { form: 'f1120', line: '17', note: 'Taxes and licenses', relation: 'related' },
      { form: 'f1120s', line: '12', note: 'Taxes and licenses', relation: 'related' },
    ],
  },
  {
    key: 'state.florida_corporate_filer',
    scope: 'entity_year', applies_to: C_CORP, type: 'bool',
    question: 'Is the corporation required to file a Florida corporate income tax return (F-1120) for this year?',
    why: 'Florida taxes C-corps doing business there, and the federal deduction, the exemption and the F-1120 due dates all follow from it.',
    affects: ['state'],
    evidence: ['return_line', 'owner_statement'],
  },
  {
    key: 'state.florida_exemption_share',
    scope: 'entity_year', applies_to: C_CORP, type: 'money',
    question: 'How much of Florida\'s $50,000 exemption is this corporation claiming, given that members of a controlled group share a single exemption?',
    why: 'Each member claiming the full exemption understates Florida tax across the group.',
    affects: ['state', 'corporate'],
    evidence: ['return_line', 'agreement'],
    required_when: { all: [
      { fact: 'state.florida_corporate_filer', equals: true },
      { fact: 'corp.controlled_group_member', equals: true },
    ] },
  },
  {
    key: 'state.pass_through_entity_tax',
    scope: 'entity_year', applies_to: ISSUERS, type: 'bool',
    question: 'Did the entity elect into any state\'s pass-through entity tax (PTET) for this year?',
    why: 'An elective entity-level state tax is deductible federally by the entity, and each owner then claims a state credit instead of a deduction — both sides need to know.',
    affects: ['state', 'k1'],
    evidence: ['third_party_form', 'return_line'],
  },
  {
    key: 'indiv.state_residency',
    scope: 'entity_year', applies_to: INDIVIDUAL, type: 'list',
    item_fields: [
      { key: 'state', type: 'text', label: 'State' },
      { key: 'status', type: 'enum', label: 'Status', options: ['resident', 'part_year_resident', 'nonresident'] },
      { key: 'from', type: 'date', label: 'From', optional: true },
      { key: 'to', type: 'date', label: 'To', optional: true },
    ],
    question: 'For each state you lived in or earned income from this year: were you a resident, part-year resident or nonresident, and over which dates?',
    why: 'Residency decides which state taxes all income and which tax only income sourced there; a missed nonresident state (New York, for work days there) is a missed return.',
    affects: ['state'],
    evidence: ['owner_statement', 'third_party_form'],
  },
  {
    key: 'indiv.nonresident_state_income',
    scope: 'entity_year', applies_to: INDIVIDUAL, type: 'list',
    item_fields: [
      { key: 'state', type: 'text', label: 'State' },
      { key: 'income_type', type: 'text', label: 'Income (wages, K-1, rent …)' },
      { key: 'amount', type: 'money', label: 'Amount sourced to the state' },
      { key: 'allocation_method', type: 'text', label: 'How it was allocated (days worked, entity apportionment …)' },
    ],
    question: 'For each state where you were a nonresident with income: what income was sourced there, how much, and how it was allocated (for example wages by days worked there, K-1 income by the entity\'s apportionment)?',
    why: 'Nonresident returns (New York IT-203 and the like) tax only state-source income; without the allocation basis neither the state return nor the resident-state credit can be checked.',
    affects: ['state', 'k1'],
    evidence: ['third_party_form', 'owner_statement', 'books'],
  },

  // ── Federal estimated payments ────────────────────────────────────────────
  {
    key: 'payments.estimated_federal',
    scope: 'entity_year', applies_to: ESTIMATE_PAYERS, type: 'list',
    item_fields: [
      { key: 'payment_date', type: 'date', label: 'Date paid' },
      { key: 'amount', type: 'money', label: 'Amount' },
      { key: 'applied_from_prior_year', type: 'bool', label: 'Prior-year overpayment applied (not a new payment)' },
    ],
    question: 'List every federal estimated tax payment for this tax year with its date and amount, including any overpayment from the prior year that was applied to it. (Empty list if none.)',
    why: 'Underpayment penalties (Forms 2210/2220) are computed by payment date, and the return\'s payments line must equal the credits on the IRS account transcript — misapplied payments are common.',
    affects: ['irs_account'],
    evidence: ['bank_record', 'irs_transcript', 'return_line'],
    catalog: [
      { form: 'f1040', line: '26', note: 'Estimated payments and amount applied from prior year', aggregate: { op: 'sum', field: 'amount' } },
      { form: 'f1120s', line: '24a', note: 'Estimated payments and prior-year overpayment credited', aggregate: { op: 'sum', field: 'amount' } },
    ],
  },

  // ── Information returns received and issued ───────────────────────────────
  {
    key: 'income.information_returns_received',
    scope: 'entity_year', applies_to: ALL, type: 'list',
    item_fields: [
      { key: 'payer', type: 'text', label: 'Payer' },
      { key: 'form', type: 'enum', label: 'Form', options: ['W-2', '1099-NEC', '1099-MISC', '1099-K', '1099-INT', '1099-DIV', '1099-B', '1099-R', '1099-G', '1099-DA', 'K-1', '1098', 'other'] },
      { key: 'amount', type: 'money', label: 'Main amount', optional: true },
    ],
    question: 'List every information return received for this year — W-2s, 1099s, K-1s, 1098s — with the payer and the main amount.',
    why: 'The IRS matches every information return to the return (CP2000); income on a 1099 that never reached the return is an automatic notice.',
    affects: ['irs_account', 'k1'],
    evidence: ['third_party_form', 'irs_transcript'],
  },
  {
    key: 'info_returns.form_1099_required',
    scope: 'entity_year', applies_to: BUSINESS, type: 'bool',
    question: 'Did the entity make payments this year that required Forms 1099 — for example $600 or more to an unincorporated contractor, for rent, or for legal fees?',
    why: 'The return asks this directly, and unfiled 1099s carry per-form penalties and can cost the deduction on examination.',
    affects: ['payroll', 'irs_account'],
    evidence: ['books', 'third_party_form', 'return_line'],
    catalog: [
      { form: 'f1120s', section: 'Schedule B', line: '14a', note: 'Payments requiring Forms 1099' },
      { form: 'f1120', section: 'Schedule K', line: '15a', note: 'Payments requiring Forms 1099', relation: 'related' },
      { form: 'f1065', section: 'Schedule B', line: '16a', note: 'Payments requiring Forms 1099', relation: 'related' },
    ],
    derive_from_catalog: true,
  },
  {
    key: 'info_returns.form_1099_filed',
    scope: 'entity_year', applies_to: BUSINESS, type: 'bool',
    question: 'Were all the required Forms 1099 actually filed (by January 31), and under which EIN?',
    why: 'Answering "Yes" on the return when they were not filed is a false statement on a signed return.',
    affects: ['payroll', 'irs_account'],
    evidence: ['third_party_form', 'irs_transcript', 'return_line'],
    catalog: [
      { form: 'f1120s', section: 'Schedule B', line: '14b', note: 'Did or will file required Forms 1099' },
      { form: 'f1120', section: 'Schedule K', line: '15b', relation: 'related' },
      { form: 'f1065', section: 'Schedule B', line: '16b', relation: 'related' },
    ],
    derive_from_catalog: true,
    required_when: { fact: 'info_returns.form_1099_required', equals: true },
  },
  {
    key: 'info_returns.foreign_contractors_paid',
    scope: 'entity_year', applies_to: BUSINESS, type: 'bool',
    question: 'Did the entity pay any foreign (non-U.S.) individual or company for services this year?',
    why: 'Payments to foreign persons need a W-8 on file instead of a 1099, or they are subject to withholding and Form 1042-S reporting.',
    affects: ['payroll', 'irs_account'],
    evidence: ['books', 'bank_record'],
  },
  {
    key: 'info_returns.foreign_contractors',
    scope: 'entity_year', applies_to: BUSINESS, type: 'list',
    item_fields: [
      { key: 'name', type: 'text', label: 'Contractor' },
      { key: 'country', type: 'text', label: 'Country' },
      { key: 'service', type: 'text', label: 'Service' },
      { key: 'amount_paid', type: 'money', label: 'Amount paid' },
      { key: 'w8_on_file', type: 'bool', label: 'Signed W-8BEN / W-8BEN-E on file' },
      { key: 'work_in_us', type: 'bool', label: 'Any of the work was performed in the U.S.' },
    ],
    question: 'For each foreign contractor: name, country, the service, amount paid this year, whether a signed W-8BEN (or W-8BEN-E) is on file, and whether any of the work was done inside the U.S.',
    why: 'Without a W-8 the payer must treat the contractor as a U.S. person (backup withholding), and U.S.-source pay to a foreign person is subject to 30% withholding.',
    affects: ['payroll', 'irs_account'],
    evidence: ['third_party_form', 'books', 'bank_record'],
    required_when: { fact: 'info_returns.foreign_contractors_paid', equals: true },
  },
  {
    key: 'info_returns.k2_k3_domestic_exception',
    scope: 'entity_year', applies_to: ISSUERS, type: 'bool',
    question: 'Does the entity meet the domestic filing exception for Schedules K-2 and K-3 this year — no foreign activity, all owners U.S. persons, owners notified by the one-month deadline, and no owner asked for a K-3?',
    why: 'Without the exception Schedules K-2/K-3 are required, and missing ones are penalised per K-1.',
    affects: ['k1', 'irs_account'],
    evidence: ['owner_statement', 'return_line'],
    years: { from: 2021 },
  },

  // ── Payroll ───────────────────────────────────────────────────────────────
  {
    key: 'payroll.has_employees',
    scope: 'entity_year', applies_to: BUSINESS, type: 'bool',
    question: 'Did the entity (or a disregarded entity it owns) pay anyone wages on a W-2 this year, including the owners?',
    why: 'Wages bring payroll returns, the officer-pay test and the QBI wage limit with them.',
    affects: ['payroll', 'qbi'],
    evidence: ['third_party_form', 'books'],
  },
  {
    key: 'payroll.provider',
    scope: 'entity_year', applies_to: BUSINESS, type: 'text',
    question: 'Who ran payroll this year (the provider\'s name, or "in-house")?',
    why: 'The provider holds the 941s, 940 and W-3 that every wage line on the return is checked against; knowing who has them is how they get pulled.',
    affects: ['payroll'],
    evidence: ['third_party_form', 'owner_statement'],
    required_when: { fact: 'payroll.has_employees', equals: true },
  },
  {
    key: 'payroll.w2_issuer',
    scope: 'entity_year', applies_to: BUSINESS, type: 'enum',
    options: ['this_entity', 'disregarded_entity', 'peo_or_agent'],
    question: 'Whose EIN issued this year\'s W-2s and filed the Forms 941 — this entity, a disregarded entity it owns, or a PEO or payroll agent?',
    why: 'The IRS matches W-3 totals by EIN; when a disregarded LLC is the employer the wages filed under its EIN must still tie to this return\'s wage and officer-pay lines.',
    affects: ['payroll'],
    evidence: ['third_party_form', 'irs_transcript'],
    required_when: { fact: 'payroll.has_employees', equals: true },
  },
  {
    key: 'payroll.total_w2_wages',
    scope: 'entity_year', applies_to: BUSINESS, type: 'money',
    question: 'What were total W-2 wages for the year (W-3 box 1), across every EIN that paid this entity\'s workers?',
    why: 'Officer pay, salaries and any wages in cost of goods sold must add up to this; a gap is either an unreported deduction or a payroll filing problem.',
    affects: ['payroll', 'qbi'],
    evidence: ['third_party_form'],
    catalog: [
      { form: 'f1120s', line: '8', note: 'Salaries and wages (excludes officers; add line 7 and COGS labor)', relation: 'related' },
      { form: 'f1120', line: '13', note: 'Salaries and wages (excludes officers)', relation: 'related' },
    ],
    required_when: { fact: 'payroll.has_employees', equals: true },
  },
  {
    key: 'payroll.quarterly_returns_filed',
    scope: 'entity_year', applies_to: BUSINESS, type: 'bool',
    question: 'Were all four quarterly Forms 941 and the annual Form 940 filed and paid on time for this year?',
    why: 'Unfiled or unpaid payroll returns carry the heaviest IRS penalties and personal liability for the trust-fund portion.',
    affects: ['payroll', 'irs_account'],
    evidence: ['irs_transcript', 'third_party_form'],
    required_when: { fact: 'payroll.has_employees', equals: true },
  },
  {
    key: 'payroll.erc_claimed',
    scope: 'entity_year', applies_to: BUSINESS, type: 'bool',
    question: 'Did the entity claim the Employee Retention Credit for any quarter of this year?',
    why: 'ERC reduces the wage deduction for the year the wages were paid (an amended income tax return if missed), and the IRS is examining and disallowing many claims.',
    affects: ['payroll', 'irs_account'],
    evidence: ['third_party_form', 'irs_transcript'],
    years: { from: 2020, to: 2021 },
    required_when: { fact: 'payroll.has_employees', equals: true },
  },

  // ── Carryovers ────────────────────────────────────────────────────────────
  {
    key: 'carryover.nol',
    scope: 'entity_year', applies_to: ['1120', '1040'], type: 'list',
    item_fields: [
      { key: 'origin_year', type: 'number', label: 'Year the loss arose' },
      { key: 'amount_generated', type: 'money', label: 'Loss generated' },
      { key: 'used_before_this_year', type: 'money', label: 'Used in earlier years' },
      { key: 'available_this_year', type: 'money', label: 'Available this year' },
    ],
    question: 'List each net operating loss still being carried, by the year it arose: the loss generated, how much was used in earlier years, and how much is available this year. (Empty list if none.)',
    why: 'Post-2017 NOLs are limited to 80% of taxable income and older ones expire; a stale or missing carryover loses real deductions.',
    affects: ['carryovers'],
    evidence: ['return_line', 'books'],
    catalog: [
      { form: 'f1120', section: 'Schedule K', line: '12', note: 'Available NOL carryover from prior years', aggregate: { op: 'sum', field: 'available_this_year' } },
      { form: 'f1120', line: '29a', note: 'NOL deduction used', relation: 'related' },
      { form: 'f1040s1', line: '8a', note: 'Net operating loss', relation: 'related' },
    ],
  },
  {
    key: 'carryover.capital_loss_short_term_in',
    scope: 'entity_year', applies_to: ['1040', '1120'], type: 'money',
    question: 'What short-term capital loss carryover came into this year from the prior year? (For a corporation, its capital loss carryover.) Answer 0 if none.',
    why: 'The carryover chain must be continuous from the year the loss arose; a break silently forfeits it.',
    affects: ['carryovers'],
    evidence: ['return_line'],
    catalog: [{ form: 'f1040sd', line: '6', note: 'Short-term capital loss carryover', shown_negative: true }],
    derive_from_catalog: true,
  },
  {
    key: 'carryover.capital_loss_long_term_in',
    scope: 'entity_year', applies_to: INDIVIDUAL, type: 'money',
    question: 'What long-term capital loss carryover came into this year from the prior year? Answer 0 if none.',
    why: 'Only $3,000 of net capital loss is deductible against other income each year; the rest has to be carried, year after year, or it is lost.',
    affects: ['carryovers'],
    evidence: ['return_line'],
    catalog: [{ form: 'f1040sd', line: '14', note: 'Long-term capital loss carryover', shown_negative: true }],
    derive_from_catalog: true,
  },
  {
    key: 'carryover.charitable_in',
    scope: 'entity_year', applies_to: ['1040', '1120'], type: 'list',
    item_fields: [
      { key: 'origin_year', type: 'number', label: 'Year of the gift' },
      { key: 'amount', type: 'money', label: 'Carryover available' },
    ],
    question: 'List any charitable contribution carryovers coming into this year, by the year of the original gift. (Empty list if none.)',
    why: 'Excess charitable gifts carry forward only five years.',
    affects: ['carryovers'],
    evidence: ['return_line'],
    catalog: [{ form: 'f1040sa', line: '13', note: 'Carryover from prior year', aggregate: { op: 'sum', field: 'amount' } }],
  },
  {
    key: 'carryover.section_179_in',
    scope: 'entity_year', applies_to: ['1040', '1120'], type: 'money',
    question: 'Was any §179 expense disallowed in a prior year (business-income limit) and carried into this year? How much? Answer 0 if none.',
    why: 'Disallowed §179 carries forward indefinitely but only if it is carried on Form 4562 each year.',
    affects: ['carryovers'],
    evidence: ['return_line'],
    catalog: [{ form: 'f4562', section: 'Part I', line: '10', note: 'Carryover of disallowed deduction from prior year' }],
    derive_from_catalog: true,
  },
  {
    key: 'carryover.passive_losses_in',
    scope: 'entity_year', applies_to: INDIVIDUAL, type: 'list',
    item_fields: [
      { key: 'activity', type: 'text', label: 'Activity' },
      { key: 'amount', type: 'money', label: 'Suspended loss carried in' },
    ],
    question: 'List any passive activity losses suspended in prior years (Form 8582) by activity, with the amount carried into this year. (Empty list if none.)',
    why: 'Suspended passive losses are released by passive income or by disposing of the activity; untracked, they are never claimed.',
    affects: ['carryovers', 'niit'],
    evidence: ['return_line'],
    catalog: [
      { form: 'f8582', section: 'Part I', line: '1c', note: 'Prior years\' unallowed losses (rental real estate)', relation: 'related' },
      { form: 'f8582', section: 'Part I', line: '2c', note: 'Prior years\' unallowed losses (other passive)', relation: 'related' },
      { form: 'f1040se', section: 'Part II', line: '27', note: 'Prior-year unallowed loss question', relation: 'related' },
    ],
  },

  // ── IRS account, per return ───────────────────────────────────────────────
  {
    key: 'irs.filing_date',
    scope: 'return', applies_to: ALL, type: 'date',
    question: 'On what date was this return filed — the postmark date for paper, or the e-file acceptance date?',
    why: 'It starts the three-year assessment and refund statutes and decides whether late-filing penalties apply.',
    affects: ['irs_account', 'statute'],
    evidence: ['irs_transcript', 'irs_notice', 'third_party_form'],
  },
  {
    key: 'irs.filing_method',
    scope: 'return', applies_to: ALL, type: 'enum',
    options: ['e_file', 'paper', 'not_filed'],
    question: 'Was this return e-filed, mailed on paper, or not filed yet?',
    why: 'Paper returns post months later and are where misposted and duplicate returns start.',
    affects: ['irs_account'],
    evidence: ['irs_transcript', 'third_party_form'],
  },
  {
    key: 'irs.extension_filed',
    scope: 'return', applies_to: ALL, type: 'bool',
    question: 'Was an extension (Form 4868 or 7004) filed for this return?',
    why: 'Whether the return was on time depends on it; the transcript should show it as TC460.',
    affects: ['irs_account', 'statute'],
    evidence: ['irs_transcript', 'third_party_form'],
  },
  {
    key: 'irs.extension_date',
    scope: 'return', applies_to: ALL, type: 'date',
    question: 'On what date was the extension filed, and was it accepted?',
    why: 'A late or rejected extension makes an otherwise on-time return late, with penalties that run from the original due date.',
    affects: ['irs_account', 'statute'],
    evidence: ['irs_transcript', 'third_party_form'],
    required_when: { fact: 'irs.extension_filed', equals: true },
  },
  {
    key: 'irs.transcript_date',
    scope: 'return', applies_to: ALL, type: 'date',
    question: 'What is the date of the most recent IRS account transcript you have for this return year?',
    why: 'Every IRS-account answer below is only as current as the transcript it came from; a stale transcript misses new assessments and notices.',
    affects: ['irs_account'],
    evidence: ['irs_transcript'],
  },
  {
    key: 'irs.tc150_period',
    scope: 'return', applies_to: ALL, type: 'text',
    question: 'Per the account transcript, to which tax period did this return post (the TC150 entry — for example 202312), and is that the right period and the right EIN or SSN?',
    why: 'A return posted to the wrong period or entity leaves the real period showing as unfiled, and penalty notices follow.',
    affects: ['irs_account'],
    evidence: ['irs_transcript'],
  },
  {
    key: 'irs.tc150_amount',
    scope: 'return', applies_to: ALL, type: 'money',
    question: 'What tax liability did the TC150 entry on the transcript post for this return?',
    why: 'It must equal the total tax on the return as filed; a difference means the IRS processed something other than what was sent.',
    affects: ['irs_account'],
    evidence: ['irs_transcript'],
  },
  {
    key: 'irs.duplicate_or_misposted',
    scope: 'return', applies_to: ALL, type: 'bool',
    question: 'Does the transcript show a duplicate return (TC976/977), a second return for the same period, or a return posted to the wrong period or entity?',
    why: 'Duplicates freeze the account and can generate assessments for returns that were never meant to be separate filings.',
    affects: ['irs_account'],
    evidence: ['irs_transcript', 'irs_notice'],
  },
  {
    key: 'irs.duplicate_or_misposted_detail',
    scope: 'return', applies_to: ALL, type: 'text',
    question: 'Describe the duplicate or misposting: what posted where, on what dates, and what has been done to correct it.',
    why: 'Corrections take months and several contacts; without a record each contact starts over.',
    affects: ['irs_account'],
    evidence: ['irs_transcript', 'irs_notice'],
    required_when: { fact: 'irs.duplicate_or_misposted', equals: true },
  },
  {
    key: 'irs.notices',
    scope: 'return', applies_to: ALL, type: 'list',
    item_fields: [
      { key: 'notice', type: 'text', label: 'Notice number (CP or LTR)' },
      { key: 'notice_date', type: 'date', label: 'Date of notice' },
      { key: 'subject', type: 'text', label: 'What it said' },
      { key: 'status', type: 'enum', label: 'Status', options: ['no_response_needed', 'answered', 'open'] },
    ],
    question: 'List every IRS notice received about this return year: the CP or letter number, its date, what it said, and whether it has been answered. (Empty list if none.)',
    why: 'Notices carry response deadlines measured in days; an unanswered one becomes an assessment.',
    affects: ['irs_account', 'statute'],
    evidence: ['irs_notice'],
  },
  {
    key: 'irs.penalties',
    scope: 'return', applies_to: ALL, type: 'list',
    item_fields: [
      { key: 'penalty', type: 'enum', label: 'Penalty', options: ['failure_to_file', 'failure_to_pay', 'estimated_tax', 'late_pass_through_return', 'information_return', 'accuracy_related', 'other'] },
      { key: 'amount', type: 'money', label: 'Amount' },
      { key: 'assessed_date', type: 'date', label: 'Date assessed', optional: true },
      { key: 'status', type: 'enum', label: 'Status', options: ['assessed', 'paid', 'abated', 'abatement_requested'] },
    ],
    question: 'List every penalty assessed for this return year: the type, amount, date, and whether it was paid, abated, or an abatement request is pending. (Empty list if none.)',
    why: 'First-time abatement can be used once per clean three-year window, and the late S-corp/partnership penalty is per owner per month — each is worth contesting only if it is on record.',
    affects: ['irs_account'],
    evidence: ['irs_transcript', 'irs_notice'],
  },
  {
    key: 'irs.balance_due',
    scope: 'return', applies_to: ALL, type: 'money',
    question: 'What balance (tax, penalties and interest) does the IRS show for this return year as of the latest transcript? Answer 0 if none.',
    why: 'Open balances accrue interest and lead to liens and levies, and an overpayment elsewhere may be offset against them.',
    affects: ['irs_account'],
    evidence: ['irs_transcript', 'irs_notice'],
  },
  {
    key: 'irs.representative_on_file',
    scope: 'return', applies_to: ALL, type: 'enum',
    options: ['none', 'form_2848', 'form_8821', 'both'],
    question: 'Is a power of attorney (Form 2848) or tax information authorization (Form 8821) on file with the IRS for this return year, and for whom?',
    why: 'Without one nobody but the taxpayer can pull transcripts or speak to the IRS about the year.',
    affects: ['irs_account'],
    evidence: ['irs_notice', 'third_party_form'],
  },
  {
    key: 'irs.amended_return_filed',
    scope: 'return', applies_to: ALL, type: 'bool',
    question: 'Has an amended or superseding return been filed for this year (1040-X, 1120-X, an amended 1120-S or 1065, or an AAR)? When?',
    why: 'The amended figures replace the original for every carryover and basis computation that follows, and amending extends nothing about the original statute.',
    affects: ['irs_account', 'statute', 'carryovers'],
    evidence: ['irs_transcript', 'return_line'],
    catalog: [
      { form: 'f1120s', line: 'H', row: '4', note: 'Amended return', relation: 'related' },
      { form: 'f1065', line: 'G', row: '5', note: 'Amended return', relation: 'related' },
    ],
  },
  {
    key: 'irs.preparer',
    scope: 'return', applies_to: ALL, type: 'enum',
    options: ['self_prepared', 'paid_preparer'],
    question: 'Was this return self-prepared or prepared by a paid preparer? If paid, who (name and firm)?',
    why: 'A paid preparer must sign and give a PTIN; a self-prepared return must leave that block empty — and the preparer is who to ask about positions taken.',
    affects: ['irs_account'],
    evidence: ['return_line', 'owner_statement'],
  },

  // ── Individual (1040) ─────────────────────────────────────────────────────
  {
    key: 'indiv.filing_status',
    scope: 'entity_year', applies_to: INDIVIDUAL, type: 'enum',
    options: ['single', 'married_filing_jointly', 'married_filing_separately', 'head_of_household', 'qualifying_surviving_spouse'],
    question: 'What is your filing status for this year?',
    why: 'Every bracket, threshold and phase-out (NIIT, QBI, capital loss) depends on it.',
    affects: ['niit', 'qbi'],
    evidence: ['owner_statement', 'return_line'],
  },
  {
    key: 'indiv.dependents',
    scope: 'entity_year', applies_to: INDIVIDUAL, type: 'list',
    item_fields: [
      { key: 'name', type: 'text', label: 'Name' },
      { key: 'relationship', type: 'text', label: 'Relationship' },
      { key: 'birth_year', type: 'number', label: 'Year of birth' },
      { key: 'months_lived_with_you', type: 'number', label: 'Months lived with you' },
      { key: 'child_tax_credit', type: 'bool', label: 'Qualifies for the child tax credit' },
    ],
    question: 'List each dependent: name, relationship, year of birth, months they lived with you this year, and whether they qualify for the child tax credit. (Empty list if none.)',
    why: 'Dependents drive filing status, credits and the household-income tests.',
    // No review area reads dependents yet; credits are not a check group.
    affects: [],
    evidence: ['owner_statement', 'return_line'],
  },
  {
    key: 'indiv.activity_grouping',
    scope: 'entity', applies_to: INDIVIDUAL, type: 'bool',
    question: 'Have you ever filed a §469 grouping statement (Rev. Proc. 2010-13) treating two or more of your businesses as one activity? Which ones?',
    why: 'Grouping changes which activities you must materially participate in, and therefore what is passive income for NIIT.',
    affects: ['niit'],
    evidence: ['return_line', 'owner_statement'],
  },
  {
    key: 'indiv.passthrough_interest_sales',
    scope: 'entity_year', applies_to: INDIVIDUAL, type: 'list',
    item_fields: [
      { key: 'issuer', type: 'text', label: 'Entity' },
      { key: 'date_sold', type: 'date', label: 'Date sold or redeemed' },
      { key: 'amount_realized', type: 'money', label: 'Amount realized' },
      { key: 'adjusted_basis', type: 'money', label: 'Adjusted basis', optional: true },
    ],
    question: 'Did you sell, redeem or otherwise dispose of any interest in an S corporation or partnership this year? For each: the entity, date, amount received and your basis. (Empty list if none.)',
    why: 'Gain on a nonpassive interest is partly excluded from NIIT (§1411(c)(4), Form 8960 line 5c) and the final basis has to be proved.',
    affects: ['niit', 'basis'],
    evidence: ['agreement', 'bank_record', 'third_party_form'],
    catalog: [{ form: 'f8960', line: '5c', note: 'Adjustment for disposition of partnership interest or S stock', relation: 'related' }],
  },

  // ── K-1s received (1040 recipient side) ───────────────────────────────────
  {
    key: 'k1.received',
    scope: 'entity_year', applies_to: INDIVIDUAL, type: 'list',
    item_fields: [
      { key: 'issuer', type: 'text', label: 'Issuing entity' },
      { key: 'issuer_form', type: 'enum', label: 'Issuer\'s return', options: ['1120S', '1065', '1041'] },
      { key: 'pct_end', type: 'percent', label: 'Your ownership % at year end' },
      { key: 'date_received', type: 'date', label: 'Date received', optional: true },
    ],
    question: 'List every Schedule K-1 you received for this year: the issuing entity, whether it is an S-corp, partnership or trust, your ownership percentage at year end, and when you received it. (Empty list if none.)',
    why: 'Every K-1 must reach Schedule E line 28 and drives basis, NIIT and QBI; this list is also what the per-K-1 questions below are asked about.',
    affects: ['k1', 'basis', 'niit', 'qbi'],
    evidence: ['third_party_form', 'return_line'],
    catalog: [{ form: 'f1040se', section: 'Part II', line: '28', note: 'One row per K-1', aggregate: { op: 'count' }, relation: 'related' }],
  },
  {
    key: 'k1.basis_at_inception',
    scope: 'owner', applies_to: INDIVIDUAL, type: 'money', subjects_from: K1_SUBJECTS,
    question: 'What was your basis in this company\'s stock or partnership interest when you first acquired it — cash paid in, the basis of property you contributed, or what you paid for it?',
    why: 'Form 7203 (and the partnership basis worksheet) start from it every year; without it no distribution or loss can be shown to be within basis.',
    affects: ['basis'],
    evidence: ['bank_record', 'agreement', 'books'],
    catalog: [{ form: 'f7203', section: 'Part I', line: '1', note: 'Stock basis at beginning of year (first year of ownership)', relation: 'related' }],
    counterpart: 'owners.basis_at_inception',
  },
  {
    key: 'k1.capital_contributions',
    scope: 'owner_year', applies_to: INDIVIDUAL, type: 'money', subjects_from: K1_SUBJECTS,
    question: 'How much did you put into this company as capital this year (not as a loan)? Answer 0 if nothing.',
    why: 'Contributions increase your basis (Form 7203 line 2); the company\'s books must show the same amount as equity.',
    affects: ['basis'],
    evidence: ['bank_record', 'books'],
    catalog: [{ form: 'f7203', section: 'Part I', line: '2', note: 'Capital contributions and stock acquired' }],
    derive_from_catalog: true,
    counterpart: 'owners.capital_contributions',
  },
  {
    key: 'k1.distributions',
    scope: 'owner_year', applies_to: INDIVIDUAL, type: 'money', subjects_from: K1_SUBJECTS,
    question: 'How much did this company distribute to you this year (cash plus the value of any property or personal expenses it paid for you)?',
    why: 'Distributions above your basis are taxable capital gain that the K-1 itself does not report — which is how excess distributions went unreported.',
    affects: ['basis', 'k1'],
    evidence: ['third_party_form', 'bank_record', 'return_line'],
    catalog: [{ form: 'f7203', section: 'Part I', line: '5', note: 'Distributions (excluding dividends)' }],
    derive_from_catalog: true,
    counterpart: 'owners.distributions',
  },
  {
    key: 'k1.material_participation',
    scope: 'owner_year', applies_to: INDIVIDUAL, type: 'enum', subjects_from: K1_SUBJECTS,
    options: MATERIAL_PARTICIPATION_TESTS,
    question: 'Did you materially participate in this company\'s business this year, and under which §469 test — for example, more than 500 hours of work?',
    why: 'It decides whether this K-1 is passive (Schedule E column (h)) or nonpassive (column (k)) and whether its income is excluded from NIIT on Form 8960 line 4b; unrecorded, nonpassive income was once taxed as passive with NIIT.',
    affects: ['niit', 'k1'],
    evidence: ['owner_statement', 'books'],
    catalog: [
      { form: 'f1040se', section: 'Part II', line: '28', col: 'h', note: 'Passive income — must be empty for a materially participated activity', relation: 'related' },
      { form: 'f1040se', section: 'Part II', line: '28', col: 'k', note: 'Nonpassive income', relation: 'related' },
      { form: 'f8960', line: '4b', note: 'Adjustment for nonpassive trade or business income', relation: 'related' },
    ],
    counterpart: 'owners.material_participation',
  },
  {
    key: 'k1.participation_hours',
    scope: 'owner_year', applies_to: INDIVIDUAL, type: 'number', subjects_from: K1_SUBJECTS,
    question: 'Roughly how many hours did you work in this company\'s business this year, and what records support it?',
    why: 'Hours are the evidence for material participation; the claim fails on examination without them.',
    affects: ['niit'],
    evidence: ['owner_statement', 'books'],
    counterpart: 'owners.participation_hours',
  },
  {
    key: 'k1.suspended_losses_carried_in',
    scope: 'owner_year', applies_to: INDIVIDUAL, type: 'money', subjects_from: K1_SUBJECTS,
    question: 'Did you carry into this year losses from this company that were disallowed earlier for lack of basis? How much? Answer 0 if none.',
    why: 'They become deductible the year basis is restored, and must be carried on Form 7203 Part III until then.',
    affects: ['basis', 'carryovers'],
    evidence: ['return_line'],
    catalog: [{ form: 'f1040se', section: 'Part II', line: '27', note: 'Prior-year unallowed losses question', relation: 'related' }],
    counterpart: 'owners.suspended_losses_carried_in',
  },
  {
    key: 'k1.direct_loan_balance_end',
    scope: 'owner_year', applies_to: INDIVIDUAL, type: 'money', subjects_from: K1_SUBJECTS,
    question: 'At year end, how much did this S corporation owe you for money you lent it DIRECTLY from your own funds (not through another company you own)? Answer 0 if none.',
    why: 'Only direct loans give debt basis for losses, and repayments of a loan whose basis was used up are taxable.',
    affects: ['basis', 'loans'],
    evidence: ['bank_record', 'agreement', 'third_party_form'],
    counterpart: 'owners.direct_loan_balance_end',
  },
  {
    key: 'k1.wages_from_issuer',
    scope: 'owner_year', applies_to: INDIVIDUAL, type: 'money', subjects_from: K1_SUBJECTS,
    question: 'How much W-2 pay did this company (or a disregarded LLC it owns) pay you this year? Answer 0 if none.',
    why: 'Your W-2 from the company must equal what it reported as your officer pay, and wages paid to you are not QBI.',
    affects: ['payroll', 'qbi'],
    evidence: ['third_party_form'],
    counterpart: 'owners.officer_compensation',
  },
  {
    key: 'k1.guaranteed_payments',
    scope: 'owner_year', applies_to: INDIVIDUAL, type: 'money', subjects_from: K1_SUBJECTS,
    question: 'How much did this partnership pay you as guaranteed payments this year? Answer 0 if none or if it is not a partnership.',
    why: 'Guaranteed payments are nonpassive and subject to self-employment tax, and are not QBI.',
    affects: ['qbi', 'k1'],
    evidence: ['third_party_form'],
    catalog: [{ form: 'f1040se', section: 'Part II', line: '28', col: 'k', note: 'Nonpassive income', relation: 'related' }],
    counterpart: 'owners.guaranteed_payments',
  },
  {
    key: 'k1.share_of_liabilities',
    scope: 'owner_year', applies_to: INDIVIDUAL, type: 'list', subjects_from: K1_SUBJECTS,
    item_fields: LIABILITY_SHARE_FIELDS,
    question: 'If this is a partnership: what was your share of its liabilities at year end, split into recourse, nonrecourse and qualified nonrecourse (K-1 item K)? (Empty list for an S corporation.)',
    why: 'Your share of partnership liabilities is part of your basis and at-risk amount, so it decides whether losses are deductible.',
    affects: ['basis', 'k1'],
    evidence: ['third_party_form'],
    counterpart: 'owners.share_of_liabilities',
  },
  {
    key: 'k1.sstb',
    scope: 'owner_year', applies_to: INDIVIDUAL, type: 'enum', subjects_from: K1_SUBJECTS,
    options: SSTB_OPTIONS,
    question: 'Per this K-1\'s §199A statement, is the business a Specified Service Trade or Business this year?',
    why: 'Above the income threshold an SSTB\'s QBI deduction phases out to zero; Form 8995-A must carry the same flag as the K-1.',
    affects: ['qbi', 'k1'],
    evidence: ['third_party_form', 'return_line'],
    catalog: [{ form: 'f8995a', section: 'Part I', line: '1', col: 'b', note: 'Check if specified service', relation: 'related' }],
    counterpart: 'entity.sstb_determination',
  },
]

// ─── Lookup and evaluation ──────────────────────────────────────────────────

export const FACT_DEF_BY_KEY: Readonly<Record<string, FactDef>> =
  Object.fromEntries(FACT_DEFS.map(d => [d.key, d]))

export function getFactDef(key: string): FactDef | undefined {
  return FACT_DEF_BY_KEY[key]
}

/** True when the fact exists in law for this tax year (see `years`). */
export function factAppliesInYear(def: FactDef, year: number): boolean {
  if (def.years?.from !== undefined && year < def.years.from) return false
  if (def.years?.to !== undefined && year > def.years.to) return false
  return true
}

/**
 * The facts a return of this type needs, in registry order. With a year,
 * facts that did not exist in law that year are left out; the gap list still
 * shows them (as not applicable) so the list itself never changes shape.
 */
export function factsFor(formType: FactFormType | string, year?: number): FactDef[] {
  return FACT_DEFS.filter(d =>
    (d.applies_to as readonly string[]).includes(formType) &&
    (year === undefined || factAppliesInYear(d, year)))
}

/** Scopes whose answers are per tax year. */
export function scopeIsYearly(scope: FactScope): boolean {
  return scope === 'entity_year' || scope === 'owner_year' || scope === 'relationship_year' || scope === 'return'
}

/** Scopes whose answers are per subject (owner, issuer or counterparty). */
export function scopeHasSubject(scope: FactScope): boolean {
  return scope === 'owner' || scope === 'owner_year' || scope === 'relationship_year'
}

export type RequiredState = 'required' | 'not_required' | 'undetermined'

export interface RequiredResult {
  state: RequiredState
  /** Undetermined only: the facts whose answers would settle it. */
  waiting_on: string[]
}

type Tri = { v: true } | { v: false } | { v: 'unknown'; keys: string[] }

function sameScalar(a: unknown, b: FactScalar): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.trim().toLowerCase() === b.trim().toLowerCase()
  return a === b
}

function evalCondition(cond: FactCondition, get: (key: string) => FactAnswer | undefined): Tri {
  if ('all' in cond) {
    const parts = cond.all.map(c => evalCondition(c, get))
    if (parts.some(p => p.v === false)) return { v: false }
    const keys = parts.flatMap(p => (p.v === 'unknown' ? p.keys : []))
    return keys.length ? { v: 'unknown', keys } : { v: true }
  }
  if ('any' in cond) {
    const parts = cond.any.map(c => evalCondition(c, get))
    if (parts.some(p => p.v === true)) return { v: true }
    const keys = parts.flatMap(p => (p.v === 'unknown' ? p.keys : []))
    return keys.length ? { v: 'unknown', keys } : { v: false }
  }
  const ans = get(cond.fact)
  if (!ans || ans.status === 'unknown') return { v: 'unknown', keys: [cond.fact] }
  // Not applicable reads as "no value": it equals nothing and differs from everything.
  const value = ans.status === 'answered' ? ans.value : undefined
  if ('equals' in cond) return { v: value !== undefined && value !== null && sameScalar(value, cond.equals) }
  if ('not_equals' in cond) return { v: !(value !== undefined && value !== null && sameScalar(value, cond.not_equals)) }
  return { v: value !== undefined && value !== null && cond.in.some(x => sameScalar(value, x)) }
}

/**
 * Whether `def` is required given the other answers. A condition that reads
 * a fact nobody has answered (or answered "unknown") is `undetermined`, not
 * `not_required`: the gap list still asks it, flagged as conditional, because
 * a question that silently drops out is exactly how facts went missing.
 */
export function evaluateRequired(def: FactDef, answers: FactAnswers): RequiredResult {
  if (!def.required_when) return { state: 'required', waiting_on: [] }
  const get = typeof answers === 'function' ? answers : (k: string) => answers[k]
  const r = evalCondition(def.required_when, get)
  if (r.v === true) return { state: 'required', waiting_on: [] }
  if (r.v === false) return { state: 'not_required', waiting_on: [] }
  return { state: 'undetermined', waiting_on: [...new Set(r.keys)] }
}

/** Every fact key a condition reads. */
export function conditionFacts(cond: FactCondition): string[] {
  if ('all' in cond) return cond.all.flatMap(conditionFacts)
  if ('any' in cond) return cond.any.flatMap(conditionFacts)
  return [cond.fact]
}

// ─── Value validation ───────────────────────────────────────────────────────

/** YYYY-MM-DD and a real calendar date (rejects 2026-02-30). */
export function isFactDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

const MAX_TEXT = 4000
const MAX_ROWS = 500

export type FactValueCheck =
  | { ok: true; value: FactValue }
  | { ok: false; error: string }

function checkScalar(
  type: Exclude<FactType, 'list'>, options: readonly string[] | undefined, v: unknown, label: string,
): FactValueCheck {
  switch (type) {
    case 'date':
      return isFactDate(v) ? { ok: true, value: v } : { ok: false, error: `${label} must be a real date as YYYY-MM-DD` }
    case 'bool':
      return typeof v === 'boolean' ? { ok: true, value: v } : { ok: false, error: `${label} must be true or false` }
    case 'enum':
      return typeof v === 'string' && (options || []).includes(v)
        ? { ok: true, value: v }
        : { ok: false, error: `${label} must be one of: ${(options || []).join(', ')}` }
    case 'number':
    case 'money':
      return typeof v === 'number' && Number.isFinite(v)
        ? { ok: true, value: v }
        : { ok: false, error: `${label} must be a number` }
    case 'percent':
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100
        ? { ok: true, value: v }
        : { ok: false, error: `${label} must be a percentage from 0 to 100` }
    case 'text': {
      if (typeof v !== 'string' || !v.trim()) return { ok: false, error: `${label} must be non-empty text` }
      if (v.length > MAX_TEXT) return { ok: false, error: `${label} is longer than ${MAX_TEXT} characters` }
      return { ok: true, value: v.trim() }
    }
  }
}

/**
 * Check an answer's value against its definition. Strict on purpose: money
 * must arrive as a number, not "$1,234" — parsing happens at the edge that
 * received the text, never here.
 */
export function validateFactValue(def: FactDef, value: unknown): FactValueCheck {
  if (def.type !== 'list') return checkScalar(def.type, def.options, value, def.key)
  if (!Array.isArray(value)) return { ok: false, error: `${def.key} must be a list of rows` }
  if (value.length > MAX_ROWS) return { ok: false, error: `${def.key} has more than ${MAX_ROWS} rows` }
  const fields = def.item_fields || []
  const known = new Set(fields.map(f => f.key))
  const rows: FactListItem[] = []
  for (let i = 0; i < value.length; i++) {
    const row = value[i]
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return { ok: false, error: `${def.key}[${i}] must be an object` }
    }
    const extra = Object.keys(row).filter(k => !known.has(k))
    if (extra.length) {
      return { ok: false, error: `${def.key}[${i}] has unknown field(s): ${extra.join(', ')}; expected ${[...known].join(', ')}` }
    }
    const out: FactListItem = {}
    for (const f of fields) {
      const v = (row as Record<string, unknown>)[f.key]
      if (v === undefined || v === null || v === '') {
        if (f.optional) { out[f.key] = null; continue }
        return { ok: false, error: `${def.key}[${i}].${f.key} (${f.label}) is required` }
      }
      const c = checkScalar(f.type, f.options, v, `${def.key}[${i}].${f.key}`)
      if (!c.ok) return c
      out[f.key] = c.value as FactScalar
    }
    rows.push(out)
  }
  return { ok: true, value: rows }
}

/**
 * Where an answer is stored must match the fact's scope: a yearly fact needs a
 * tax year and an all-years fact must not have one; owner and relationship
 * facts need a subject. Returns an error message, or null when consistent.
 */
export function validateFactCoordinates(
  def: FactDef, at: { tax_year?: number | null; subject?: string | null },
): string | null {
  const year = at.tax_year ?? null
  const subject = typeof at.subject === 'string' && at.subject.trim() ? at.subject.trim() : null
  if (scopeIsYearly(def.scope)) {
    if (year === null) return `${def.key} is recorded per tax year — tax_year is required`
    if (!Number.isInteger(year) || year < 1900 || year > 2100) return 'tax_year must be a four-digit year'
  } else if (year !== null) {
    return `${def.key} applies to every year (scope ${def.scope}) — omit tax_year`
  }
  if (scopeHasSubject(def.scope)) {
    if (!subject) {
      const who = def.subjects_from ? `a name from ${def.subjects_from.fact} (${def.subjects_from.field})` : 'a subject'
      return `${def.key} is recorded per ${def.scope === 'relationship_year' ? 'counterparty' : 'owner'} — subject is required (${who})`
    }
  } else if (subject && def.scope !== 'return') {
    return `${def.key} (scope ${def.scope}) does not take a subject`
  }
  return null
}
