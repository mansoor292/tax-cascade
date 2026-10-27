/**
 * The practice workspace: one preparer's clients, read and onboarded through
 * the platform's TaxNow org. See supabase/migrations/20261025120000_practice.sql
 * for the decisions (2026-10-24) this encodes; the two that shape every query:
 *  - A TaxNow account is a practice's client only through a practice_client
 *    row. Nothing here lists the platform org to decide who is whose (only the
 *    admin claim does, explicitly).
 *  - Each practice's clients are its own entities (tax_entity.practice_id),
 *    hidden from the owner pages; the same EIN may sit in two practices.
 *
 *  - A practice reads an account only on its OWN authority (2026-10-25): an
 *    8821 signed and ID-verified in Catipult, or an admin claim. Every 8821
 *    names the platform's one CAF, so TaxNow finding a TIN proves only that
 *    SOMEONE's 8821 is on file. When the account was already in the org at
 *    submission, or another practice holds it, the client waits for proof
 *    that its own 8821 went in (submission_confirmed_at) — and the practice
 *    is never told why, which would reveal another firm's client.
 *
 * Signing, the kept signed copy, and how it goes in (staff send it to
 * TaxNow's staff and record their confirmation) are practice_filing.ts.
 *
 * The full TIN exists only while onboarding is pending: encrypted, sent to
 * TaxNow's TIN search by the daily check, wiped once the client is readable.
 * It is never returned by any endpoint and never logged.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  encryptedFields, encryptionEnabled, hydrate, hydrateAll,
  ENCRYPTED_PRACTICE_CLIENT_FIELDS, ENCRYPTED_FINDING_FIELDS, ENCRYPTED_TRANSCRIPT_FIELDS,
  PRACTICE_CLIENT_ENC_COLS, FINDING_ENC_COLS, TRANSCRIPT_ENC_COLS,
} from '../lib/row_crypto.js'
import { TaxNowError, accountForTin, taxnowFor, type AccountRecord } from '../taxnow/client.js'
import type { ClientSummary } from './practice_read.js'
import { fill8821 } from './f8821.js'
import { idvView } from './signer_idv.js'
import { proofView } from './signer_proof.js'
import { verifiedName } from './practice_filing.js'

export type Provider = 'taxnow' | 'fixture'
export interface Practice {
  id: string
  user_id: string
  name: string
  designee_mode: 'platform' | 'own'
  designee: Record<string, string>
  provider: Provider
  /** The TaxNow org it reads through ('platform', or an org whose key we hold for it: taxnow/client.ts). */
  taxnow_org: string
}

export const PRACTICE_COLS = 'id, user_id, name, designee_mode, designee, provider, taxnow_org'

/** The TaxNow this practice reads through. */
export function taxnowOf(p: Pick<Practice, 'provider' | 'taxnow_org'>) {
  return taxnowFor(p.provider, p.taxnow_org)
}

export class PracticeError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

const FORM_TO_TYPE: Record<string, string> = { '1120': 'c_corp', '1120S': 's_corp', '1065': 'partnership', '1040': 'individual' }

/** The designee the platform uses for practitioners with no CAF of their own. */
export function platformDesignee(): Record<string, string> {
  return {
    name: process.env.PLATFORM_DESIGNEE_NAME || '',
    caf: process.env.PLATFORM_DESIGNEE_CAF || '',
    address: process.env.PLATFORM_DESIGNEE_ADDRESS || '',
    phone: process.env.PLATFORM_DESIGNEE_PHONE || '',
  }
}

export function isPlatformAdmin(userId: string | null): boolean {
  if (!userId) return false
  return (process.env.PLATFORM_ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean).includes(userId)
}

export async function getPractice(sb: SupabaseClient, userId: string): Promise<Practice | null> {
  const { data, error } = await sb.from('practice').select(PRACTICE_COLS).eq('user_id', userId).maybeSingle()
  if (error) throw new PracticeError(500, error.message)
  return data as Practice | null
}

export async function requirePractice(sb: SupabaseClient, userId: string): Promise<Practice> {
  const p = await getPractice(sb, userId)
  if (!p) throw new PracticeError(404, 'No practice yet. Create one first.')
  return p
}

export async function createPractice(sb: SupabaseClient, userId: string, name: string): Promise<Practice> {
  const existing = await getPractice(sb, userId)
  if (existing) return existing
  if (!name?.trim()) throw new PracticeError(400, 'A practice needs a name.')
  const { data, error } = await sb.from('practice').insert({ user_id: userId, name: name.trim() }).select(PRACTICE_COLS).single()
  if (error) throw new PracticeError(500, error.message)
  await sb.from('practice_member').insert({ practice_id: data.id, user_id: userId, role: 'owner' })
  return data as Practice
}

const DESIGNEE_KEYS = ['name', 'caf', 'ptin', 'address', 'city', 'state', 'zip', 'phone', 'fax']

export async function updatePractice(sb: SupabaseClient, p: Practice, body: { name?: string; designee_mode?: string; designee?: Record<string, unknown> }): Promise<Practice> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.name !== undefined) {
    if (!String(body.name).trim()) throw new PracticeError(400, 'A practice needs a name.')
    patch.name = String(body.name).trim()
  }
  if (body.designee_mode !== undefined) {
    if (body.designee_mode !== 'platform' && body.designee_mode !== 'own') throw new PracticeError(400, 'designee_mode is platform or own.')
    patch.designee_mode = body.designee_mode
  }
  if (body.designee !== undefined) {
    const d: Record<string, string> = {}
    for (const k of DESIGNEE_KEYS) if (body.designee?.[k] != null) d[k] = String(body.designee[k]).trim().slice(0, 200)
    if (d.caf && !/^[0-9A-Z-]{4,20}$/i.test(d.caf)) throw new PracticeError(400, 'A CAF number is letters and digits.')
    patch.designee = d
  }
  const { data, error } = await sb.from('practice').update(patch).eq('id', p.id).select(PRACTICE_COLS).single()
  if (error) throw new PracticeError(500, error.message)
  return data as Practice
}

/** The designee an 8821 from this practice names. */
export function designeeOf(p: Practice): Record<string, string> & { source: 'platform' | 'own' } {
  return p.designee_mode === 'own' ? { ...p.designee, source: 'own' } : { ...platformDesignee(), source: 'platform' }
}

// ─── Clients ────────────────────────────────────────────────────────────────

const CLIENT_COLS = `id, practice_id, user_id, entity_id, stage, tin_last4, taxnow_account_id, taxnow_client_uri, authorization_scope, signed_at, submitted_at, submission, submission_confirmed_at, last_check_at, check_count, readable_at, last_read_at, created_at, summary, signature, ${PRACTICE_CLIENT_ENC_COLS}`

export interface ClientListRow {
  id: string
  entity_id: string
  name: string
  form_type: string
  stage: string
  tin_last4: string | null
  summary: ClientSummary | null
  status_counts: Record<string, number>
  findings: { count: number; amount_cents: number; by_section: Record<string, number> }
  last_read_at: string | null
  oldest_sync: string | null
  submitted_at: string | null
  last_check_at: string | null
  check_count: number
  signed: boolean
}

export async function listClients(sb: SupabaseClient, p: Practice): Promise<ClientListRow[]> {
  const { data: rows, error } = await sb.from('practice_client').select(CLIENT_COLS).eq('practice_id', p.id).order('created_at')
  if (error) throw new PracticeError(500, error.message)
  const clients = await hydrateAll(sb, rows as any[], ENCRYPTED_PRACTICE_CLIENT_FIELDS)
  const entityIds = clients.map(c => c.entity_id)
  const { data: ents } = entityIds.length ? await sb.from('tax_entity').select('id, name, form_type').in('id', entityIds) : { data: [] as any[] }
  const entById = new Map((ents ?? []).map((e: any) => [e.id, e]))
  const counts = await statusCounts(sb, clients.map(c => c.id))
  const findings = await findingRows(sb, p)
  const byClient = new Map<string, { count: number; amount_cents: number; by_section: Record<string, number> }>()
  for (const f of findings) {
    const b = byClient.get(f.practice_client_id) ?? { count: 0, amount_cents: 0, by_section: {} }
    b.count++
    if (f.severity === 'opportunity' && f.amount_cents && f.amount_cents > 0) b.amount_cents += f.amount_cents
    b.by_section[f.section] = (b.by_section[f.section] ?? 0) + 1
    byClient.set(f.practice_client_id, b)
  }
  return clients.map(c => ({
    id: c.id, entity_id: c.entity_id, name: entById.get(c.entity_id)?.name ?? '', form_type: entById.get(c.entity_id)?.form_type ?? '',
    stage: c.stage, tin_last4: c.tin_last4, summary: c.summary ?? null, status_counts: counts.get(c.id) ?? {},
    findings: byClient.get(c.id) ?? { count: 0, amount_cents: 0, by_section: {} }, last_read_at: c.last_read_at,
    oldest_sync: c.summary?.oldest_sync ?? null, submitted_at: c.submitted_at, last_check_at: c.last_check_at, check_count: c.check_count,
    signed: !!c.signed_at,
  }))
}

async function statusCounts(sb: SupabaseClient, clientIds: string[]): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>()
  if (!clientIds.length) return out
  // Plain columns only: counting needs no decrypt. Paged past PostgREST's 1,000-row cap.
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('taxnow_transcript').select('practice_client_id, status').eq('type', 'ACTR').in('practice_client_id', clientIds).range(from, from + 999)
    if (error) throw new PracticeError(500, error.message)
    for (const r of data ?? []) {
      const m = out.get(r.practice_client_id) ?? {}
      m[r.status] = (m[r.status] ?? 0) + 1
      out.set(r.practice_client_id, m)
    }
    if ((data ?? []).length < 1000) break
  }
  return out
}

export interface FindingOut {
  id: string
  practice_client_id: string
  section: string
  type: string
  severity: string
  form: string
  tax_year: number
  period_month: number | null
  amount_cents: number | null
  note: string
}

async function findingRows(sb: SupabaseClient, p: Practice, clientId?: string): Promise<FindingOut[]> {
  const out: any[] = []
  for (let from = 0; ; from += 1000) {
    let q = sb.from('practice_finding').select(`id, user_id, practice_client_id, section, type, severity, form, tax_year, period_month, detail, ${FINDING_ENC_COLS}`).eq('practice_id', p.id)
    if (clientId) q = q.eq('practice_client_id', clientId)
    const { data, error } = await q.range(from, from + 999)
    if (error) throw new PracticeError(500, error.message)
    out.push(...(data ?? []))
    if ((data ?? []).length < 1000) break
  }
  await hydrateAll(sb, out, ENCRYPTED_FINDING_FIELDS)
  return out.map(f => ({ id: f.id, practice_client_id: f.practice_client_id, section: f.section, type: f.type, severity: f.severity, form: f.form, tax_year: f.tax_year, period_month: f.period_month, amount_cents: f.detail?.amount_cents ?? null, note: f.detail?.note ?? '' }))
}

export async function opportunities(sb: SupabaseClient, p: Practice) {
  const [findings, clients] = await Promise.all([findingRows(sb, p), listClientNames(sb, p)])
  return findings.map(f => ({ ...f, client_name: clients.get(f.practice_client_id) ?? '' }))
}

async function listClientNames(sb: SupabaseClient, p: Practice): Promise<Map<string, string>> {
  const { data } = await sb.from('practice_client').select('id, entity_id').eq('practice_id', p.id)
  const ids = (data ?? []).map(r => r.entity_id)
  const { data: ents } = ids.length ? await sb.from('tax_entity').select('id, name').in('id', ids) : { data: [] as any[] }
  const name = new Map((ents ?? []).map((e: any) => [e.id, e.name]))
  return new Map((data ?? []).map(r => [r.id, name.get(r.entity_id) ?? '']))
}

export async function clientDetail(sb: SupabaseClient, p: Practice, clientId: string) {
  const { data: row, error } = await sb.from('practice_client').select(CLIENT_COLS).eq('practice_id', p.id).eq('id', clientId).maybeSingle()
  if (error) throw new PracticeError(500, error.message)
  if (!row) throw new PracticeError(404, 'No such client in this practice.')
  await hydrate(sb, row, ENCRYPTED_PRACTICE_CLIENT_FIELDS)
  const { data: ent } = await sb.from('tax_entity').select('id, name, form_type, fiscal_year_end').eq('id', row.entity_id).single()
  const { data: tx } = await sb.from('taxnow_transcript').select(`id, user_id, type, form, tax_year, period_month, status, synced_at, response_date, parsed, ${TRANSCRIPT_ENC_COLS}`).eq('practice_client_id', clientId)
  const transcripts = await hydrateAll(sb, (tx ?? []) as any[], ENCRYPTED_TRANSCRIPT_FIELDS)
  const findings = await findingRows(sb, p, clientId)
  return {
    client: {
      id: row.id, entity_id: row.entity_id, name: ent?.name ?? '', form_type: ent?.form_type ?? '', stage: row.stage, tin_last4: row.tin_last4,
      authorization_scope: row.authorization_scope, signed_at: row.signed_at, submitted_at: row.submitted_at, last_check_at: row.last_check_at,
      check_count: row.check_count, readable_at: row.readable_at, last_read_at: row.last_read_at, summary: row.summary ?? null,
      signer: row.signature ? {
        name: row.signature.signer_name, title: row.signature.signer_title, id_verified_at: row.signature.id_verified_at ?? null, id_method: row.signature.id_method ?? null,
        method: row.signature.method ?? null, idv: idvView(row.signature.idv), proof: proofView(row.signature.proof),
        // Line 6 prints the verified name; the kept copy's hash is what was sent.
        print_name: row.signature.print_name ?? (row.signature.id_verified_at ? verifiedName(row.signature) : null), signed_copy_sha256: row.signature.signed_copy?.sha256 ?? null,
      } : null,
      // Where its filing stands, in the preparer's terms: not who sent it or to whom.
      filing: { sent_at: row.submission?.sent_at ?? null, confirmed_at: row.submission_confirmed_at ?? null },
    },
    transcripts: transcripts.map(t => ({
      type: t.type, form: t.form, tax_year: t.tax_year, period_month: t.period_month, status: t.status, synced_at: t.synced_at, response_date: t.response_date,
      // The account transcript as parsed; return transcripts as their lines. The TIN is never here (last four only).
      parsed: t.type === 'ACTR' ? t.parsed : null,
      retr: t.type === 'RETR' ? (t.parsed?.retr?.sections ?? null) : null,
    })),
    findings,
  }
}

export async function coverage(sb: SupabaseClient, p: Practice) {
  const clients = await listClients(sb, p)
  const { data: gapsRows } = await sb.from('taxnow_transcript').select('practice_client_id, form, tax_year, period_month').in('practice_client_id', clients.map(c => c.id).concat(['00000000-0000-0000-0000-000000000000'])).eq('status', 'not_authorized')
  const gaps = new Map<string, { client_id: string; form: string; periods: string[] }>()
  for (const g of gapsRows ?? []) {
    const k = `${g.practice_client_id}|${g.form}`
    const e = gaps.get(k) ?? { client_id: g.practice_client_id, form: g.form, periods: [] as string[] }
    e.periods.push(`${g.tax_year}-${String(g.period_month).padStart(2, '0')}`)
    gaps.set(k, e)
  }
  const { data: syncRows } = await sb.from('taxnow_transcript').select('synced_at, status').in('practice_client_id', clients.map(c => c.id).concat(['00000000-0000-0000-0000-000000000000'])).eq('type', 'ACTR')
  const now = Date.now()
  const ages = { under_30: 0, d30_90: 0, d90_365: 0, over_365: 0, never: 0, refused: 0 }
  for (const r of syncRows ?? []) {
    if (r.status === 'not_authorized') { ages.refused++; continue }
    if (!r.synced_at) { ages.never++; continue }
    const days = (now - new Date(r.synced_at).getTime()) / 86_400_000
    if (days < 30) ages.under_30++; else if (days < 90) ages.d30_90++; else if (days < 365) ages.d90_365++; else ages.over_365++
  }
  return {
    designee: designeeOf(p),
    provider: p.provider,
    clients: clients.map(c => ({ id: c.id, name: c.name, stage: c.stage, status_counts: c.status_counts, oldest_sync: c.oldest_sync, last_read_at: c.last_read_at, submitted_at: c.submitted_at, last_check_at: c.last_check_at, check_count: c.check_count, signed: c.signed })),
    gaps: [...gaps.values()].map(g => ({ ...g, client_name: clients.find(c => c.id === g.client_id)?.name ?? '', periods: g.periods.sort() })),
    ages,
  }
}

// ─── Onboarding ─────────────────────────────────────────────────────────────

export interface NewClient {
  name: string
  form_type: '1120' | '1120S' | '1065' | '1040'
  tin?: string
  year_end_month?: number
  scope?: { income?: boolean; payroll?: string[]; from_year?: number; to_year?: number }
}

export async function createClient(sb: SupabaseClient, p: Practice, body: NewClient) {
  const name = String(body.name ?? '').trim()
  if (!name) throw new PracticeError(400, 'The client needs a legal name.')
  const form = body.form_type
  if (!FORM_TO_TYPE[form]) throw new PracticeError(400, 'form_type is 1120, 1120S, 1065 or 1040.')
  const tin = body.tin ? String(body.tin).replace(/\D/g, '') : ''
  if (tin && tin.length !== 9) throw new PracticeError(400, 'An EIN or SSN has nine digits.')
  // The full TIN must never sit in a readable column; refuse rather than store it plain.
  if (tin && !encryptionEnabled()) throw new PracticeError(503, 'Encryption is not configured on this server, so the TIN cannot be stored.')
  const yem = Number(body.year_end_month ?? 12)
  if (!(yem >= 1 && yem <= 12)) throw new PracticeError(400, 'year_end_month is 1–12.')
  const thisYear = new Date().getUTCFullYear()
  const scope = {
    income: body.scope?.income !== false ? [form] : [],
    payroll: (body.scope?.payroll ?? ['941', '940']).filter(f => ['940', '941', '943', '944'].includes(f)),
    from_year: Number(body.scope?.from_year ?? thisYear - 8),
    to_year: Number(body.scope?.to_year ?? thisYear + 1),
    year_end_month: yem,
  }
  const { data: ent, error: e1 } = await sb.from('tax_entity').insert({
    user_id: p.user_id, practice_id: p.id, name, entity_type: FORM_TO_TYPE[form], form_type: form,
    fiscal_year_end: `${String(yem).padStart(2, '0')}/${new Date(Date.UTC(2001, yem, 0)).getUTCDate()}`,
  }).select('id').single()
  if (e1) throw new PracticeError(500, e1.message)
  const base: Record<string, any> = {
    practice_id: p.id, user_id: p.user_id, entity_id: ent.id, stage: 'awaiting_signature', authorization_scope: scope,
    tin_last4: tin ? tin.slice(-4) : null, ...(tin ? { tin } : {}),
  }
  const { data: row, error: e2 } = await sb.from('practice_client').insert({ ...base, ...(await encryptedFields(sb, p.user_id, base, ENCRYPTED_PRACTICE_CLIENT_FIELDS)) }).select('id').single()
  if (e2) {
    await sb.from('tax_entity').delete().eq('id', ent.id)
    throw new PracticeError(500, e2.message)
  }
  return { id: row.id, entity_id: ent.id }
}

async function clientRow(sb: SupabaseClient, p: Practice, clientId: string) {
  const { data, error } = await sb.from('practice_client').select(CLIENT_COLS).eq('practice_id', p.id).eq('id', clientId).maybeSingle()
  if (error) throw new PracticeError(500, error.message)
  if (!data) throw new PracticeError(404, 'No such client in this practice.')
  return data as any
}

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex')
const SIGN_DAYS = 14

/** A fresh signature link for the client. The token is shown once; only its hash is stored. */
export async function issueSignLink(sb: SupabaseClient, p: Practice, clientId: string) {
  const c = await clientRow(sb, p, clientId)
  await hydrate(sb, c, ENCRYPTED_PRACTICE_CLIENT_FIELDS)
  // A signed client whose signer is not verified yet gets a link too: it
  // opens straight on the identity check (signed in the app, checked on the
  // signer's own phone).
  const toVerify = c.stage === 'signed' && !c.signature?.id_verified_at
  if (!['draft', 'awaiting_signature'].includes(c.stage) && !toVerify) throw new PracticeError(409, 'This client’s 8821 is already signed.')
  const token = randomBytes(24).toString('base64url')
  const expires = new Date(Date.now() + SIGN_DAYS * 86_400_000).toISOString()
  const { error } = await sb.from('practice_client').update({ sign_token_hash: hashToken(token), sign_token_expires: expires, ...(toVerify ? {} : { stage: 'awaiting_signature' }), updated_at: new Date().toISOString() }).eq('id', c.id)
  if (error) throw new PracticeError(500, error.message)
  return { token, expires }
}

/** What the signer sees: the 8821 as it will be signed. Public (token only). */
export async function signRequest(sb: SupabaseClient, token: string) {
  const { data: c } = await sb.from('practice_client').select(`id, user_id, practice_id, entity_id, stage, tin_last4, authorization_scope, sign_token_expires, signature, ${PRACTICE_CLIENT_ENC_COLS}`).eq('sign_token_hash', hashToken(token)).maybeSingle()
  if (!c || !c.sign_token_expires || new Date(c.sign_token_expires) < new Date()) throw new PracticeError(404, 'This signature link has expired or was replaced. Ask your preparer for a new one.')
  await hydrate(sb, c, ENCRYPTED_PRACTICE_CLIENT_FIELDS)
  const { data: p } = await sb.from('practice').select(PRACTICE_COLS).eq('id', c.practice_id).single()
  const { data: ent } = await sb.from('tax_entity').select('name, form_type').eq('id', c.entity_id).single()
  return {
    practice: p!.name, taxpayer: ent?.name ?? '', form_type: ent?.form_type ?? '', tin_last4: c.tin_last4,
    designee: (({ source: _s, ...d }) => d)(designeeOf(p as Practice)), scope: c.authorization_scope, expires: c.sign_token_expires,
    business: ent?.form_type !== '1040',
    // The signer is verified first, then signs (practice_filing.ts): the
    // page shows whichever step is next.
    signer: c.signature ? {
      name: c.signature.signer_name, title: c.signature.signer_title ?? '', verified: !!c.signature.id_verified_at, signed: !!c.signature.signed_at,
      print_name: c.signature.id_verified_at ? verifiedName(c.signature) : null, idv: idvView(c.signature.idv), proof: proofView(c.signature.proof),
    } : null,
  }
}

/** The client and practice behind a live signature link. */
export async function tokenClient(sb: SupabaseClient, token: string): Promise<{ clientId: string; practice: Pick<Practice, 'id' | 'provider'> }> {
  const { data: c } = await sb.from('practice_client').select('id, practice_id, sign_token_expires').eq('sign_token_hash', hashToken(token)).maybeSingle()
  if (!c || !c.sign_token_expires || new Date(c.sign_token_expires) < new Date()) throw new PracticeError(404, 'This signature link has expired or was replaced. Ask your preparer for a new one.')
  const { data: p } = await sb.from('practice').select('id, provider').eq('id', c.practice_id).single()
  return { clientId: c.id, practice: p as Pick<Practice, 'id' | 'provider'> }
}

/** Catipult staff record a check made outside Didit (a video call with the
 *  signer's ID, when the automated check cannot decide). Platform admins only
 *  (routes/practice.ts); the signer's own check is services/signer_idv.ts. */
export async function markIdVerified(sb: SupabaseClient, p: Practice, clientId: string, body: { method?: unknown; signer_name?: unknown; signer_title?: unknown }) {
  const c = await clientRow(sb, p, clientId)
  await hydrate(sb, c, ENCRYPTED_PRACTICE_CLIENT_FIELDS)
  if (c.signature?.id_verified_at) throw new PracticeError(409, 'The signer’s identity is already verified.')
  // Verified before signing: the name staff checked is the name line 6 prints.
  const name = String(c.signature?.signer_name ?? body.signer_name ?? '').trim().slice(0, 120)
  if (!name) throw new PracticeError(400, 'Enter the signer’s full legal name, as it appears on their ID.')
  const signature = {
    ...(c.signature ?? { signer_title: String(body.signer_title ?? '').trim().slice(0, 80), signed_at: null }), signer_name: name,
    id_verified_at: new Date().toISOString(), id_method: String(body.method || 'manual').slice(0, 60),
  }
  const patch = { signature, updated_at: new Date().toISOString() }
  const { error } = await sb.from('practice_client').update({ ...patch, ...(await encryptedFields(sb, c.user_id, patch, ENCRYPTED_PRACTICE_CLIENT_FIELDS)) }).eq('id', c.id)
  if (error) throw new PracticeError(500, error.message)
  return { ok: true }
}

/**
 * May a found account become this client's? Only when this practice's own
 * 8821 accounts for it: the account appeared after the submission and no
 * other practice holds it, or the submission channel has proved the 8821
 * went in. A client submitted before the snapshot existed has no list and
 * waits for proof too.
 */
export function readableVerdict(o: { accountId: string; accountsAtSubmit: string[] | null; heldElsewhere: boolean; submissionConfirmedAt: string | null }): 'readable' | 'awaiting_proof' {
  if (o.submissionConfirmedAt) return 'readable'
  if (o.heldElsewhere || !o.accountsAtSubmit || o.accountsAtSubmit.includes(o.accountId)) return 'awaiting_proof'
  return 'readable'
}

/**
 * One onboarding check: does TaxNow now hold this client? The TIN search
 * answers only when the platform org has a valid 8821 on file. When it does,
 * the client becomes readable, its TIN is wiped (last four kept), and a read
 * is queued. A found account that this practice's own 8821 does not account
 * for (readableVerdict) is treated exactly like one not found yet, so the
 * page never hints that another firm holds the client.
 *
 * Adding the account to the org's client list is a write to the platform
 * TaxNow org; it runs only with TAXNOW_ALLOW_ADD_CLIENT=1 (off until Mansoor
 * agrees), or always against the fixture.
 */
export async function onboardingCheck(sb: SupabaseClient, clientId: string): Promise<{ found: boolean }> {
  const { data: c } = await sb.from('practice_client').select(`${CLIENT_COLS}, tin, accounts_at_submit, submission_confirmed_at`).eq('id', clientId).maybeSingle() as { data: any }
  if (!c || c.stage !== 'submitted') return { found: false }
  await hydrate(sb, c, ENCRYPTED_PRACTICE_CLIENT_FIELDS)
  const { data: p } = await sb.from('practice').select(PRACTICE_COLS).eq('id', c.practice_id).single()
  const tn = await taxnowOf(p as Practice)
  const now = new Date().toISOString()
  const { data: held } = await sb.from('practice_client').select('taxnow_account_id').eq('practice_id', c.practice_id).not('taxnow_account_id', 'is', null)
  const accountId = c.tin && /^\d{9}$/.test(c.tin) ? await accountForTin(tn, c.tin, new Set((held ?? []).map(h => h.taxnow_account_id))) : null
  let verdict: 'readable' | 'awaiting_proof' | null = null
  if (accountId) {
    const { count } = await sb.from('practice_client').select('id', { count: 'exact', head: true })
      .eq('taxnow_account_id', accountId).neq('practice_id', c.practice_id).in('stage', ['readable', 'claimed'])
    verdict = readableVerdict({ accountId, accountsAtSubmit: c.accounts_at_submit ?? null, heldElsewhere: (count ?? 0) > 0, submissionConfirmedAt: c.submission_confirmed_at ?? null })
  }
  if (!accountId || verdict !== 'readable') {
    await sb.from('practice_client').update({ last_check_at: now, check_count: (c.check_count ?? 0) + 1 }).eq('id', c.id)
    return { found: false }
  }
  let clientUri: string | null = null
  if (tn.provider === 'fixture' || process.env.TAXNOW_ALLOW_ADD_CLIENT === '1') clientUri = await tn.addClient(accountId, c.id)
  const { error } = await sb.from('practice_client').update({
    stage: 'readable', taxnow_account_id: accountId, taxnow_client_uri: clientUri, readable_at: now, last_check_at: now,
    check_count: (c.check_count ?? 0) + 1, tin: null, tin_enc: null, accounts_at_submit: null, updated_at: now,
  }).eq('id', c.id)
  if (error) throw new PracticeError(500, error.message)
  return { found: true }
}

/**
 * Admin only: assign accounts already in the platform TaxNow org to a
 * practice (their 8821s were signed outside Catipult). Each becomes a client
 * of its own, with its own entity, stage 'claimed'. An account the practice
 * already holds is skipped.
 */
export async function claimAccounts(sb: SupabaseClient, p: Practice, accountIds: string[] | 'all', opts: { scope?: { income: string[]; payroll: string[] } } = {}) {
  const tn = await taxnowOf(p)
  const listed = await tn.listAccounts()
  const wanted = accountIds === 'all' ? listed : listed.filter(a => accountIds.includes(a.accountId))
  const { data: held } = await sb.from('practice_client').select('taxnow_account_id').eq('practice_id', p.id).not('taxnow_account_id', 'is', null)
  const have = new Set((held ?? []).map(h => h.taxnow_account_id))
  const created: string[] = []
  let unreadable = 0
  for (const a of wanted) {
    if (have.has(a.accountId)) continue
    let acct: AccountRecord
    try { acct = await tn.getAccount(a.accountId) } catch (e) {
      // Listed but not ours to read (the org is not a designee on its 8821).
      if (e instanceof TaxNowError && e.status === 403) { unreadable++; continue }
      throw e
    }
    const income = acct.tia.permissions.find(x => x.type === 'income')?.forms ?? []
    const form = acct.type === 'individual' ? '1040' : income.includes('1065') && !income.includes('1120') ? '1065' : income.includes('1120S') && !income.includes('1120') ? '1120S' : '1120'
    const { data: ent, error: e1 } = await sb.from('tax_entity').insert({ user_id: p.user_id, practice_id: p.id, name: acct.name || a.name || 'Unnamed client', entity_type: FORM_TO_TYPE[form], form_type: form }).select('id').single()
    if (e1) throw new PracticeError(500, e1.message)
    const { data: row, error: e2 } = await sb.from('practice_client').insert({
      practice_id: p.id, user_id: p.user_id, entity_id: ent.id, stage: 'claimed', taxnow_account_id: a.accountId,
      // TaxNow's record can overstate an 8821 (the BCL org's lists income forms
      // its 8821s do not cover — Mansoor, 2026-10-24: 941 only); the admin's
      // own scope, when given, is the record.
      authorization_scope: { ...(opts.scope ?? { income, payroll: acct.tia.permissions.find(x => x.type === 'payroll')?.forms ?? [] }), imported: true },
    }).select('id').single()
    if (e2) throw new PracticeError(500, e2.message)
    created.push(row.id)
  }
  return { claimed: created.length, skipped: wanted.length - created.length - unreadable, unreadable, client_ids: created }
}

/**
 * The forms of an IRS request that a claimed client's recorded authorization
 * does not cover. A claimed client's 8821 was signed outside Catipult, and the
 * scope recorded at the claim is what it covers (BCL's: 941 only, though its
 * TaxNow record lists more). Each request is a real IRS pull under the
 * designee's CAF, so one outside that scope is refused here, not by the IRS.
 * Clients onboarded in Catipult carry their own 8821's scope and are not
 * checked here.
 */
export function formsOutsideScope(scope: unknown, ts: Array<{ form: string | number }>): string[] {
  const s = scope as { imported?: boolean; income?: unknown; payroll?: unknown } | null
  if (!s?.imported || !Array.isArray(s.income) || !Array.isArray(s.payroll)) return []
  const covered = new Set([...s.income, ...s.payroll].map(f => irsFormFor(String(f))))
  return [...new Set(ts.map(t => String(t.form)).filter(f => !covered.has(f)))]
}

/** The entity's form as TaxNow reads it: an S-corp's transcripts are in the 1120 module. */
export function irsFormFor(formType: string): string {
  return formType === '1120S' ? '1120' : formType
}

/**
 * The client's Form 8821 as a fillable draft. `fullTin` prints the full TIN
 * while it is still held (onboarding pending, preparer only); the public
 * signature page gets the last four only. Line 6 stays blank: a signed 8821
 * exists only as the kept copy (practice_filing.ts signedCopy).
 */
export async function form8821(sb: SupabaseClient, p: Practice, clientId: string, opts: { fullTin: boolean }): Promise<{ pdf: Uint8Array; filename: string }> {
  const { data: c } = await sb.from('practice_client').select(`${CLIENT_COLS}, tin`).eq('practice_id', p.id).eq('id', clientId).maybeSingle() as { data: any }
  if (!c) throw new PracticeError(404, 'No such client in this practice.')
  await hydrate(sb, c, ENCRYPTED_PRACTICE_CLIENT_FIELDS)
  const { data: ent } = await sb.from('tax_entity').select('name, address, city, state, zip').eq('id', c.entity_id).single()
  const tin = opts.fullTin && c.tin ? c.tin : c.tin_last4 ? `XX-XXX${c.tin_last4}` : ''
  const { source: _s, ...designee } = designeeOf(p)
  const pdf = await fill8821({
    taxpayer: { name: ent?.name ?? '', address: [ent?.address, [ent?.city, ent?.state, ent?.zip].filter(Boolean).join(' ')].filter(Boolean).join('\n') || undefined },
    tin, designee, scope: c.authorization_scope ?? {},
  })
  return { pdf, filename: `${(ent?.name ?? 'client').replace(/[^A-Za-z0-9]+/g, '_')}_8821.pdf` }
}

/** The 8821 behind a signature link (last four only). */
export async function form8821ForToken(sb: SupabaseClient, token: string) {
  const { data: c } = await sb.from('practice_client').select('id, practice_id, sign_token_expires').eq('sign_token_hash', hashToken(token)).maybeSingle()
  if (!c || !c.sign_token_expires || new Date(c.sign_token_expires) < new Date()) throw new PracticeError(404, 'This signature link has expired or was replaced.')
  const { data: p } = await sb.from('practice').select(PRACTICE_COLS).eq('id', c.practice_id).single()
  return form8821(sb, p as Practice, c.id, { fullTin: false })
}
