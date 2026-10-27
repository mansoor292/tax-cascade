/**
 * Read one practice client's IRS records from TaxNow, store them, and
 * recompute its findings.
 *
 * Reading never asks the IRS for anything: it fetches what TaxNow already
 * holds (GETs only). A period TaxNow lists but has never pulled stays
 * `never_synced`, and one our own IRS request came back refused for stays
 * `not_authorized` — a read never downgrades a 451 to "never synced", because
 * the refusal is the only record that the 8821 does not cover the period.
 *
 * Only transcripts TaxNow re-synced since the last read are fetched again
 * (compared on syncedAt), so the daily read of ~45 clients is a few list calls
 * plus whatever changed.
 *
 * Everything stored is the client's entity's, in its practice owner's account,
 * encrypted with that owner's key. Two practices holding the same EIN each
 * read and store their own copy.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { encryptedFields, hydrateAll, ENCRYPTED_TRANSCRIPT_FIELDS, ENCRYPTED_FINDING_FIELDS, ENCRYPTED_PRACTICE_CLIENT_FIELDS, TRANSCRIPT_ENC_COLS } from '../lib/row_crypto.js'
import { taxnowFor, type TaxNowApi, type TranscriptRef } from '../taxnow/client.js'
import { parseTranscriptHtml, returnFormOf, type ParsedTranscript, type PeriodStatus } from '../taxnow/transcript.js'
import { findOpportunities, retentionRefundsByYear, RULES_VERSION, type Period, type Opportunity } from '../taxnow/opportunities.js'
import { findInsights, profileFromRetr, type Insight, type ReturnProfile } from '../taxnow/insights.js'
import { profilesFromReturns } from './practice_profiles.js'

export interface ClientRow {
  id: string
  practice_id: string
  user_id: string
  entity_id: string
  stage: string
  taxnow_account_id: string | null
  tin_last4: string | null
}

export interface StoredTranscript {
  id: string
  type: string
  form: string
  tax_year: number
  period_month: number
  status: PeriodStatus
  synced_at: string | null
  source_sha256: string | null
  parsed: any
}

async function sha256(s: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(s).digest('hex')
}

const key = (t: { type: string; form: string; year?: number; tax_year?: number; month?: number; period_month?: number }) =>
  `${t.type}|${t.form}|${t.year ?? t.tax_year}|${t.month ?? t.period_month}`

export interface ReadResult { transcripts: number; fetched: number; findings: number }

export async function readClient(supabase: SupabaseClient, client: ClientRow, provider: 'taxnow' | 'fixture', api?: TaxNowApi, today = new Date()): Promise<ReadResult> {
  if (!client.taxnow_account_id) throw new Error('This client has no TaxNow account yet.')
  const tn = api ?? await taxnowFor(provider)
  const accountId = client.taxnow_account_id

  const refs = await tn.listTranscripts(accountId)
  // Who else can see this client: other firms named as designees on the
  // account's 8821 record (our own org and the CAF designee left out).
  const account = await tn.getAccount(accountId)
  const ownOrg = tn.orgId
  const otherViewers = account.tia.designees
    .filter(d => d.type !== 'caf' && !(ownOrg && (d.uri ?? '').endsWith(ownOrg)))
    .map(d => d.name).filter(Boolean)
  const { data: existingRows, error } = await supabase.from('taxnow_transcript')
    .select(`id, type, form, tax_year, period_month, status, synced_at, source_sha256, parsed, ${TRANSCRIPT_ENC_COLS}, user_id`)
    .eq('practice_client_id', client.id)
  if (error) throw new Error(error.message)
  const existing = new Map<string, StoredTranscript>()
  for (const r of await hydrateAll(supabase, existingRows as any[], ENCRYPTED_TRANSCRIPT_FIELDS)) existing.set(key(r), r)

  let fetched = 0
  const upserts: Record<string, any>[] = []
  for (const ref of refs) {
    if (ref.type !== 'ACTR' && ref.type !== 'RETR') continue
    const prev = existing.get(key(ref))
    const unchanged = prev && prev.synced_at && ref.syncedAt && new Date(prev.synced_at).getTime() === new Date(ref.syncedAt).getTime() && prev.parsed
    if (unchanged) continue
    let status: PeriodStatus
    let parsed: any = null
    let sha: string | null = null
    let responseDate: string | null = null
    if (!ref.syncedAt) {
      status = prev?.status === 'not_authorized' ? 'not_authorized' : 'never_synced'
      if (prev && prev.status === status) continue
    } else if (ref.type === 'ACTR') {
      const html = await tn.getTranscriptHtml(accountId, ref)
      fetched++
      sha = await sha256(html)
      const p = parseTranscriptHtml(html)
      parsed = p
      status = p.status
      responseDate = p.responseDate
    } else {
      const json = await tn.getTranscriptJson(accountId, ref)
      fetched++
      sha = await sha256(JSON.stringify(json))
      parsed = { retr: json }
      status = 'filed'
    }
    upserts.push({
      user_id: client.user_id, practice_client_id: client.id, entity_id: client.entity_id,
      type: ref.type, form: ref.form, tax_year: ref.year, period_month: ref.month, status, listed: true,
      synced_at: ref.syncedAt, response_date: responseDate, source_sha256: sha, parsed, read_at: new Date().toISOString(),
    })
  }
  for (const u of upserts) {
    const row = { ...u, ...(await encryptedFields(supabase, client.user_id, u, ENCRYPTED_TRANSCRIPT_FIELDS)) }
    const { error: e } = await supabase.from('taxnow_transcript').upsert(row, { onConflict: 'practice_client_id,type,form,tax_year,period_month' })
    if (e) throw new Error(e.message)
    const k = key(u as any)
    existing.set(k, { ...(existing.get(k) ?? {} as StoredTranscript), ...u } as StoredTranscript)
  }

  const all = [...existing.values()]
  const { findings, summary: computed } = await computeFindings(supabase, client, all, today)
  const summary: ClientSummary = { ...computed, other_viewers: otherViewers }
  await replaceFindings(supabase, client, findings)

  const last4 = client.tin_last4 ?? all.map(t => (t.parsed as ParsedTranscript | null)?.tinLast4).find(Boolean) ?? null
  const patch: Record<string, any> = { last_read_at: new Date().toISOString(), summary, status_counts: statusCountsOf(all), updated_at: new Date().toISOString(), ...(last4 && !client.tin_last4 ? { tin_last4: last4 } : {}) }
  const { error: e2 } = await supabase.from('practice_client').update({ ...patch, ...(await encryptedFields(supabase, client.user_id, patch, ENCRYPTED_PRACTICE_CLIENT_FIELDS)) }).eq('id', client.id)
  if (e2) throw new Error(e2.message)
  return { transcripts: all.length, fetched, findings: findings.length }
}

/** Account transcripts by status, stored on the client beside its summary (the list reads it). */
export function statusCountsOf(rows: Array<Pick<StoredTranscript, 'type' | 'status'>>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of rows) if (r.type === 'ACTR') out[r.status] = (out[r.status] ?? 0) + 1
  return out
}

export interface FindingRow {
  section: 'income' | 'payroll' | 'risk'
  type: string
  severity: string
  form: string
  tax_year: number
  period_month: number | null
  amount_cents: number | null
  note: string
  /** Penalties: what abatement would refund, and take off the balance due. */
  refund_cents?: number
  lowers_owed_cents?: number
}

export interface ClientSummary {
  balance_due_cents: number
  credit_held_cents: number
  deposits_awaiting_cents: number
  penalties_standing_cents: number
  filed_through: number | null
  income_form: string | null
  oldest_sync: string | null
  newest_sync: string | null
  /** Other firms the account's 8821 record names: who else can see this client. */
  other_viewers?: string[]
}

/** `returns: false` skips the returns held in Catipult (an imported client has none, and at
 *  8,834 clients the per-client lookup is most of the time). */
export async function computeFindings(supabase: SupabaseClient, client: Pick<ClientRow, 'entity_id' | 'user_id'>, rows: StoredTranscript[], today: Date, opts: { returns?: boolean } = {}): Promise<{ findings: FindingRow[]; summary: ClientSummary }> {
  const periods: Period[] = rows.filter(r => r.type === 'ACTR').map(r => ({
    form: r.form, taxYear: r.tax_year, periodMonth: r.period_month, status: r.status, parsed: r.status === 'never_synced' || r.status === 'not_authorized' ? null : (r.parsed as ParsedTranscript),
  }))
  const opps: Opportunity[] = findOpportunities(periods, today)

  // Return profiles: the IRS return transcripts, and any return held in
  // Catipult for this client's entity where the IRS has none for that year.
  const retr: ReturnProfile[] = rows.filter(r => r.type === 'RETR' && r.parsed?.retr).map(r => profileFromRetr(r.parsed.retr))
  const own = opts.returns === false ? [] : await profilesFromReturns(supabase, client.entity_id, client.user_id)
  const years = new Set(retr.map(p => p.taxYear))
  const profiles = [...retr, ...own.filter(p => !years.has(p.taxYear))].sort((a, b) => a.taxYear - b.taxYear)

  const incomeForms = new Set(['1120', '1065'])
  const est = new Map<number, number>()
  const tax = new Map<number, number>()
  let secondReturn = false
  for (const p of periods) {
    if (!p.parsed || !incomeForms.has(p.form)) continue
    for (const t of p.parsed.txns) {
      if (p.form === '1120' && (t.code === '660' || t.code === '620') && t.date && t.date <= `${p.taxYear}-12-15`) est.set(p.taxYear, (est.get(p.taxYear) ?? 0) - (t.amountCents ?? 0))
      if (t.code === '150') tax.set(p.taxYear, (tax.get(p.taxYear) ?? 0) + (t.amountCents ?? 0))
      if (p.form === '1120' && p.taxYear >= 2022 && t.code === '976') secondReturn = true
    }
  }
  const insights: Insight[] = findInsights(profiles, { retentionRefunds: retentionRefundsByYear(periods), estimatesByDec15: est, assessedTax: tax, secondReturnPosted: secondReturn })

  const findings: FindingRow[] = [
    ...opps.map(o => ({ section: o.section, type: o.type, severity: o.type.startsWith('claim') ? 'review' : 'opportunity', form: o.form, tax_year: o.taxYear, period_month: o.periodMonth, amount_cents: o.amountCents, note: o.note, ...(o.refundCents != null ? { refund_cents: o.refundCents, lowers_owed_cents: o.lowersOwedCents } : {}) })),
    ...insights.map(i => ({ section: i.section, type: i.type, severity: i.severity, form: i.form, tax_year: i.taxYear, period_month: null, amount_cents: i.amountCents, note: i.note })),
  ]

  let balanceDue = 0, creditHeld = 0, deposits = 0, penalties = 0
  let filedThrough: number | null = null
  let incomeForm: string | null = null
  const syncs: string[] = []
  for (const r of rows) if (r.type === 'ACTR' && r.synced_at) syncs.push(r.synced_at)
  for (const p of periods) {
    const bal = p.parsed?.balanceCents ?? null
    if (bal != null && bal > 0) balanceDue += bal
    if (bal != null && bal < 0) { if (p.status === 'filed') creditHeld += -bal; else deposits += -bal }
    if (incomeForms.has(p.form)) {
      if (p.parsed && !incomeForm) incomeForm = returnFormOf(p.form, p.parsed.formTitle)
      if (p.status === 'filed') filedThrough = Math.max(filedThrough ?? 0, p.taxYear)
    }
  }
  for (const o of opps) if (o.type.startsWith('penalty')) penalties += o.amountCents ?? 0
  syncs.sort()
  return {
    findings,
    summary: { balance_due_cents: balanceDue, credit_held_cents: creditHeld, deposits_awaiting_cents: deposits, penalties_standing_cents: penalties, filed_through: filedThrough, income_form: incomeForm, oldest_sync: syncs[0] ?? null, newest_sync: syncs.at(-1) ?? null },
  }
}

async function replaceFindings(supabase: SupabaseClient, client: ClientRow, findings: FindingRow[]) {
  await replaceFindingsMany(supabase, [{ client, findings }])
}

/** Replace the findings of several clients at once (an import batch writes a few hundred). */
export async function replaceFindingsMany(supabase: SupabaseClient, entries: Array<{ client: Pick<ClientRow, 'id' | 'user_id' | 'practice_id'>; findings: FindingRow[] }>) {
  for (let i = 0; i < entries.length; i += 100) {
    const ids = entries.slice(i, i + 100).map(e => e.client.id)
    const { error: d } = await supabase.from('practice_finding').delete().in('practice_client_id', ids)
    if (d) throw new Error(d.message)
  }
  const rows = []
  for (const { client, findings } of entries) {
    for (const f of findings) {
      const detail = { amount_cents: f.amount_cents, note: f.note, ...(f.refund_cents != null ? { refund_cents: f.refund_cents, lowers_owed_cents: f.lowers_owed_cents } : {}) }
      const base = { user_id: client.user_id, practice_id: client.practice_id, practice_client_id: client.id, section: f.section, type: f.type, severity: f.severity, form: f.form, tax_year: f.tax_year, period_month: f.period_month, rules_version: RULES_VERSION, detail }
      rows.push({ ...base, ...(await encryptedFields(supabase, client.user_id, base, ENCRYPTED_FINDING_FIELDS)) })
    }
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('practice_finding').insert(rows.slice(i, i + 500))
    if (error) throw new Error(error.message)
  }
}

/**
 * A finding's identity across recomputes and re-imports, for a reviewer's
 * verdict: type, form, period and — for a penalty — its code, read off the
 * note's "(TC 276)". No amount: the key sits in a plain column. Findings
 * that would still collide (rare) are told apart by their order.
 */
export function findingKey(f: { type: string; form: string; tax_year: number; period_month: number | null; note: string }): string {
  const tc = /\(TC ?(\d{3})\)/.exec(f.note)?.[1] ?? ''
  return [f.type, f.form, f.tax_year, f.period_month ?? '', tc].join('|')
}

/** findingKey for each of a client's findings, with a #2, #3… on collisions. */
export function findingKeys<T extends { type: string; form: string; tax_year: number; period_month: number | null; note: string; amount_cents?: number | null }>(fs: T[]): string[] {
  const seen = new Map<string, number>()
  const order = fs.map((f, i) => i).sort((a, b) => (fs[b].amount_cents ?? 0) - (fs[a].amount_cents ?? 0))
  const out = new Array<string>(fs.length)
  for (const i of order) {
    const k = findingKey(fs[i])
    const n = (seen.get(k) ?? 0) + 1
    seen.set(k, n)
    out[i] = n === 1 ? k : `${k}#${n}`
  }
  return out
}

/** Record an IRS request's outcome on the period (a 451 marks it refused). */
export async function recordIrsOutcome(supabase: SupabaseClient, client: ClientRow, t: Pick<TranscriptRef, 'type' | 'form' | 'year' | 'month'>, refused: boolean) {
  if (!refused) return
  const { error } = await supabase.from('taxnow_transcript').upsert({
    user_id: client.user_id, practice_client_id: client.id, entity_id: client.entity_id, type: t.type, form: t.form,
    tax_year: Number(t.year), period_month: Number(t.month), status: 'not_authorized', listed: true, synced_at: null, read_at: new Date().toISOString(),
  }, { onConflict: 'practice_client_id,type,form,tax_year,period_month' })
  if (error) throw new Error(error.message)
}
