/**
 * Who signed the 8821: the identity check of the signer (onboarding step 3).
 * Replaced the preparer's "Mark identity verified" button (2026-10-24).
 *
 * The IRS asks whoever submits an e-signed 8821 for a taxpayer they do not
 * know to (irs.gov, "Submit forms 2848 and 8821 online"):
 *   1. inspect a government photo ID and compare it to the person (selfie),
 *   2. record name, SSN, address and date of birth,
 *   3. verify name, address and SSN through a second source.
 * Catipult submits under the platform designee's CAF (Mansoor: Kenneth's CAF)
 * and knows none of the practices' clients, so every signer is checked; the
 * preparer vouching for a client does not count.
 *
 * The check comes BEFORE the signature (Mansoor, 2026-10-25): the signer
 * states their name and title, is verified, and only then draws the
 * signature; the 8821 prints the name read off their ID (practice.ts
 * recordSignature). Until they sign, `signature` holds the stated name and
 * the check with signed_at null.
 *
 * How it runs (lib/didit.ts):
 *   - The signer enters their name, title and SSN on our page and is sent to
 *     Didit's hosted check: photo of the ID, live selfie, face match.
 *   - When Didit approves, the name, birth date and address read off the ID go
 *     with the SSN to Didit's US identity lookup (credit bureau + financial
 *     services). The SSN must match there.
 *   - The name on the ID must be the name the signer stated; for an
 *     individual client the SSN must be the taxpayer's own.
 * Nothing is pushed to us that we then trust: results are pulled from Didit
 * (GET decision) whenever the signer comes back or the client is opened.
 *
 * What is kept, inside practice_client.signature (encrypted, row_crypto):
 * the Didit session id, each check's result, the name, birth date and address
 * as read from the ID, the document type and issuer, and the SSN's last four.
 * The full SSN is held (encrypted) only between the signer typing it and the
 * lookup running, then dropped. No ID image is stored here; Didit keeps them.
 *
 * Business clients (Mansoor, 2026-10-24): the signer is verified as a person
 * first (this file); then they prove they belong to the business
 * (signer_proof.ts). Only then is the signer verified (id_verified_at).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { encryptedFields, encryptionEnabled, hydrate, ENCRYPTED_PRACTICE_CLIENT_FIELDS, PRACTICE_CLIENT_ENC_COLS } from '../lib/row_crypto.js'
import { DiditError, createSession, getDecision, validateUsIdentity, type DiditDecision, type DiditEnv, type UsIdentityResult } from '../lib/didit.js'
import { PracticeError, type Practice } from './practice.js'

export type IdvStatus = 'started' | 'approved' | 'declined' | 'review'

export interface Idv {
  provider: 'didit'
  environment: DiditEnv
  session_id: string
  status: IdvStatus
  didit_status: string
  started_at: string
  decided_at: string | null
  attempts: number
  ssn_last4: string
  /** The full SSN, only until the lookup runs (the signature is encrypted). */
  ssn_pending?: string | null
  person?: { name: string; date_of_birth: string | null; address: string | null; document: { type: string | null; issuing_state: string | null; expires: string | null } } | null
  checks?: {
    id_document: string | null; liveness: string | null; face_match: string | null
    name_matches_signer: boolean
    ssn_lookup: { match_type: string; validations: Record<string, string>; services: string[] } | null
    ssn_matches_taxpayer: boolean | null
  } | null
  /** Why it is not approved, in the preparer's words. */
  reason?: string | null
}

const FINAL = new Set(['approved', 'declined'])

/** The environment is the practice's, never the caller's: the fictional demo
 *  practice (provider 'fixture') runs in Didit's sandbox, real ones live. */
export function envFor(p: Pick<Practice, 'provider'>): DiditEnv {
  return p.provider === 'fixture' ? 'sandbox' : 'live'
}

export function normalizeSsn(s: unknown): string | null {
  const d = String(s ?? '').replace(/[\s-]/g, '')
  return /^\d{9}$/.test(d) && !/^0{3}|^666|^9/.test(d) && d.slice(3, 5) !== '00' && d.slice(5) !== '0000' ? d : null
}

const tokens = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z]+/).filter(t => t.length > 1)

/** The signer typed a name; the ID carries one. Same person when the ID's
 *  first and last names are both in what was signed (middle names and
 *  initials may differ). */
export function nameMatches(signed: string, id: { first_name?: string; last_name?: string; full_name?: string }): boolean {
  const s = new Set(tokens(signed))
  const first = tokens(id.first_name ?? ''), last = tokens(id.last_name ?? '')
  if (first.length && last.length) return s.has(first[0]) && last.some(t => s.has(t))
  const full = tokens(id.full_name ?? '')
  return full.length >= 2 && s.has(full[0]) && s.has(full[full.length - 1])
}

export function splitName(name: string): { first_name: string; last_name: string } {
  const parts = name.trim().split(/\s+/)
  return { first_name: parts[0] ?? '', last_name: parts.length > 1 ? parts[parts.length - 1] : '' }
}

/** The verdict once Didit has decided, from everything we know. Pure. */
export function verdict(d: { diditStatus: string; nameMatchesSigner: boolean; lookup: UsIdentityResult | null; ssnMatchesTaxpayer: boolean | null }): { status: IdvStatus; reason: string | null } {
  if (d.diditStatus === 'Declined') return { status: 'declined', reason: 'The ID or selfie check failed.' }
  if (['Abandoned', 'Expired', 'Kyc Expired'].includes(d.diditStatus)) return { status: 'declined', reason: 'The signer did not finish the identity check.' }
  if (d.diditStatus !== 'Approved') return { status: 'review', reason: 'The ID check needs a manual review at Didit.' }
  if (d.ssnMatchesTaxpayer === false) return { status: 'declined', reason: 'The SSN entered is not the taxpayer’s.' }
  if (!d.nameMatchesSigner) return { status: 'review', reason: 'The name on the ID is not the name signed on the 8821.' }
  if (!d.lookup) return { status: 'review', reason: 'The SSN could not be checked.' }
  if (d.lookup.validations.identification_number !== 'full_match') {
    return { status: d.lookup.match_type === 'no_match' ? 'declined' : 'review', reason: 'Credit and financial records do not confirm this SSN for the person on the ID.' }
  }
  return { status: 'approved', reason: null }
}

export type Row = { id: string; user_id: string; practice_id: string; stage: string; signature: any; tin: string | null; form_type?: string; entity_name?: string }

export async function loadRow(sb: SupabaseClient, clientId: string, practiceId?: string): Promise<Row> {
  const { data, error } = await sb.from('practice_client').select(`id, user_id, practice_id, entity_id, stage, signature, tin, ${PRACTICE_CLIENT_ENC_COLS}`).eq('id', clientId).maybeSingle()
  if (error) throw new PracticeError(500, error.message)
  if (!data || (practiceId && (data as any).practice_id !== practiceId)) throw new PracticeError(404, 'No such client in this practice.')
  await hydrate(sb, data as any, ENCRYPTED_PRACTICE_CLIENT_FIELDS)
  const { data: ent } = await sb.from('tax_entity').select('form_type, name').eq('id', (data as any).entity_id).single()
  return { ...(data as any), form_type: ent?.form_type ?? '', entity_name: ent?.name ?? '' }
}

export async function saveSignature(sb: SupabaseClient, c: Row, signature: Record<string, unknown>) {
  const patch = { signature, updated_at: new Date().toISOString() }
  const { error } = await sb.from('practice_client').update({ ...patch, ...(await encryptedFields(sb, c.user_id, patch, ENCRYPTED_PRACTICE_CLIENT_FIELDS)) }).eq('id', c.id)
  if (error) throw new PracticeError(500, error.message)
}

export const isIndividual = (formType: string) => formType === '1040' || formType === 'individual'

export interface CheckStart { ssn?: unknown; signer_name?: unknown; signer_title?: unknown }

/** Start (or restart) the signer's check. Returns where to send the signer. */
export async function startCheck(sb: SupabaseClient, p: Pick<Practice, 'id' | 'provider'>, clientId: string, body: CheckStart, callback: string): Promise<{ url: string; session_id: string }> {
  const env = envFor(p)
  // The SSN rides in the signature until the lookup runs: never unencrypted.
  if (env === 'live' && !encryptionEnabled()) throw new PracticeError(503, 'Identity checks need row encryption, which is off on this server.')
  const c = await loadRow(sb, clientId, p.id)
  if (c.signature?.id_verified_at) throw new PracticeError(409, 'The signer’s identity is already verified.')
  // A row signed before the order changed (signed, not yet verified) keeps
  // the name it signed with; otherwise the signer states it here.
  const signed = !!c.signature?.signed_at
  if (!signed && !['draft', 'awaiting_signature'].includes(c.stage)) throw new PracticeError(409, 'This client’s 8821 is past signing.')
  const name = signed ? String(c.signature.signer_name ?? '') : String(body.signer_name ?? c.signature?.signer_name ?? '').trim().slice(0, 120)
  const title = signed ? String(c.signature.signer_title ?? '') : String(body.signer_title ?? c.signature?.signer_title ?? '').trim().slice(0, 80)
  if (!name) throw new PracticeError(400, 'Enter the signer’s full legal name, as it appears on their ID.')
  const ssn = normalizeSsn(body.ssn)
  if (!ssn) throw new PracticeError(400, 'Enter the signer’s 9-digit Social Security number.')
  // An individual signs their own 8821: the SSN is the taxpayer's TIN.
  if (isIndividual(c.form_type ?? '') && c.tin && c.tin.replace(/\D/g, '') !== ssn) throw new PracticeError(400, 'For an individual, the signer’s SSN must be the taxpayer’s own.')
  const prev = c.signature.idv as Idv | undefined
  let s
  try {
    s = await createSession(env, { vendorData: c.id, callback, metadata: { practice_client: c.id } })
  } catch (e) {
    if (e instanceof DiditError) throw new PracticeError(e.status === 503 ? 503 : 502, e.status === 503 ? e.message : 'The identity check could not start. Try again in a moment.')
    throw e
  }
  const idv: Idv = {
    provider: 'didit', environment: env, session_id: s.session_id, status: 'started', didit_status: s.status,
    started_at: new Date().toISOString(), decided_at: null, attempts: (prev?.attempts ?? 0) + 1,
    ssn_last4: ssn.slice(5), ssn_pending: ssn, person: null, checks: null, reason: null,
  }
  const base = signed ? c.signature : { ...(c.signature ?? {}), signer_name: name, signer_title: title, signed_at: null, id_verified_at: null }
  await saveSignature(sb, c, { ...base, idv })
  return { url: s.url, session_id: s.session_id }
}

/** Pull Didit's result for a check still running; record the verdict. */
export async function refreshCheck(sb: SupabaseClient, clientId: string): Promise<Idv | null> {
  const c = await loadRow(sb, clientId)
  const idv = c.signature?.idv as Idv | undefined
  if (!idv || FINAL.has(idv.status)) return idv ?? null
  let d: DiditDecision
  try { d = await getDecision(idv.environment, idv.session_id) } catch (e) {
    if (e instanceof DiditError) return idv // Didit unreachable: try again on the next look
    throw e
  }
  if (['Not Started', 'In Progress', 'Resubmitted', 'Awaiting User'].includes(d.status)) {
    if (d.status !== idv.didit_status) await saveSignature(sb, c, { ...c.signature, idv: { ...idv, didit_status: d.status } })
    return { ...idv, didit_status: d.status }
  }
  const id = d.id_verifications?.[0]
  const signedName = String(c.signature.signer_name ?? '') // as stated before the check
  // The sandbox mocks the ID reader: a session approved by simulation reads
  // no document, so the stated name stands in. Never for a live session.
  const fromId = id ?? (idv.environment === 'sandbox' ? { ...splitName(signedName), full_name: signedName } : null)
  const nameOk = !!fromId && nameMatches(signedName, fromId)
  let lookup: UsIdentityResult | null = null
  if (d.status === 'Approved' && fromId && idv.ssn_pending) {
    const a = id?.parsed_address
    try {
      lookup = await validateUsIdentity(idv.environment, {
        first_name: fromId.first_name || splitName(fromId.full_name ?? '').first_name,
        last_name: fromId.last_name || splitName(fromId.full_name ?? '').last_name,
        date_of_birth: id?.date_of_birth || undefined,
        ssn: idv.ssn_pending,
        address: a ? { street_1: a.street_1 ?? undefined, street_2: a.street_2 ?? undefined, city: a.city ?? undefined, region: a.region ?? undefined, postal_code: a.postal_code ?? undefined } : undefined,
        vendor_data: c.id,
      })
    } catch (e) {
      if (!(e instanceof DiditError)) throw e
      return idv // the lookup failed to answer: retried on the next look, the SSN still held
    }
  }
  const ssnMatchesTaxpayer = isIndividual(c.form_type ?? '') && c.tin && idv.ssn_pending ? c.tin.replace(/\D/g, '') === idv.ssn_pending : null
  const v = verdict({ diditStatus: d.status, nameMatchesSigner: nameOk, lookup, ssnMatchesTaxpayer })
  // Didit may still move a check it holds for review; keep polling those.
  const status: IdvStatus = d.status === 'In Review' ? 'started' : v.status
  const now = new Date().toISOString()
  const next: Idv = {
    ...idv, status, didit_status: d.status, decided_at: status === 'started' ? null : now, reason: v.reason,
    // The SSN goes once the lookup has run or the check has ended.
    ssn_pending: lookup || FINAL.has(status) ? null : idv.ssn_pending,
    person: fromId ? {
      name: fromId.full_name || `${fromId.first_name ?? ''} ${fromId.last_name ?? ''}`.trim(),
      date_of_birth: id?.date_of_birth ?? null, address: id?.formatted_address ?? null,
      document: { type: id?.document_type ?? null, issuing_state: id?.issuing_state ?? null, expires: id?.expiration_date ?? null },
    } : null,
    checks: {
      id_document: id?.status ?? null, liveness: d.liveness_checks?.[0]?.status ?? null, face_match: d.face_matches?.[0]?.status ?? null,
      name_matches_signer: nameOk,
      ssn_lookup: lookup ? { match_type: lookup.match_type, validations: lookup.validations, services: lookup.services_used } : null,
      ssn_matches_taxpayer: ssnMatchesTaxpayer,
    },
  }
  // An individual is verified now; a business signer once their proof that
  // they belong to the business is accepted too (signer_proof.ts).
  const done = status === 'approved' && (isIndividual(c.form_type ?? '') || c.signature.proof?.status === 'approved')
  const signature = { ...c.signature, idv: next, ...(done ? { id_verified_at: now, id_method: `didit_${idv.environment}` } : {}) }
  // The signature link is left to expire: the signer comes back to it from
  // Didit, and signs with it once verified.
  await saveSignature(sb, c, signature)
  return next
}

/** What the preparer and the signer see (no SSN beyond its last four). */
export function idvView(idv: Idv | null | undefined) {
  if (!idv) return null
  return {
    status: idv.status, didit_status: idv.didit_status, environment: idv.environment, started_at: idv.started_at, decided_at: idv.decided_at,
    attempts: idv.attempts, ssn_last4: idv.ssn_last4, reason: idv.reason ?? null,
    person: idv.person ? { name: idv.person.name, document: idv.person.document } : null,
    checks: idv.checks ? {
      id_document: idv.checks.id_document, liveness: idv.checks.liveness, face_match: idv.checks.face_match,
      name_matches_signer: idv.checks.name_matches_signer, ssn: idv.checks.ssn_lookup?.validations.identification_number ?? null,
    } : null,
  }
}

const ORIGINS = [/^https:\/\/fin\.catipult\.ai$/, /^https:\/\/tax-api\.catalogshub\.com$/, /^https:\/\/p\d{4,5}\.dev\.catalogshub\.com$/, /^http:\/\/localhost:\d+$/]

/** Where Didit sends the signer back: the page they came from, when it is one
 *  of ours; otherwise the public site. */
export function returnOrigin(origin: string | undefined): string {
  return origin && ORIGINS.some(r => r.test(origin)) ? origin : (process.env.API_BASE_URL || 'https://fin.catipult.ai')
}
