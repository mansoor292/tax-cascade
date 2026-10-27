/**
 * How a client's 8821 is signed and goes in (Mansoor, 2026-10-25).
 *
 * TaxNow's API cannot take an 8821, so for now the signed PDF goes to
 * TaxNow's staff, who submit it to the IRS ("in the future there may be a
 * better process"). The order, every step of which this file enforces:
 *
 *   1. The signer is verified first (signer_idv.ts, signer_proof.ts):
 *      photo ID, selfie and SSN at Didit, plus proof of membership for a
 *      business. Nobody can sign before that.
 *   2. The signer draws a signature. The name on line 6 is the name read off
 *      their verified ID, never one they type ("a signature from a
 *      pre-verified source").
 *   3. The signed copy is made at that moment (f8821.ts signed8821: filled,
 *      flattened, the drawing on the line, a last page recording who signed
 *      and how they were verified) and kept: encrypted with the practice
 *      owner's key, in S3, its sha256 in the (encrypted) signature. It is the
 *      record of exactly what was sent, and the only copy anyone sends.
 *   4. Catipult staff send it to TaxNow's staff and record that (markSent:
 *      stage 'submitted'; the daily check starts). The preparer cannot.
 *   5. When TaxNow's staff confirm they submitted it, staff record that
 *      (confirmFiled), which writes submission_confirmed_at: the proof that
 *      lets a client whose account was already in the org become readable
 *      (practice.ts readableVerdict). The preparer can never set it.
 *
 * Staff are the platform admins (PLATFORM_ADMIN_USER_IDS). The one exception:
 * a practice on the fictional TaxNow (provider 'fixture', the demo practice
 * the tests run on) acts as staff for its own clients, since there is no
 * TaxNow staff behind a fictional org. A real practice never can.
 *
 * Preparers never see TaxNow named (decision 16): their pages say the form
 * was "sent for filing" and "filing confirmed"; only the staff page names
 * where it went.
 */
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { encrypt, decrypt, getDek } from '../lib/crypto.js'
import { encryptedFields, encryptionEnabled, hydrate, hydrateAll, ENCRYPTED_PRACTICE_CLIENT_FIELDS, PRACTICE_CLIENT_ENC_COLS } from '../lib/row_crypto.js'
import { s3GetObject, s3PutObject } from '../lib/s3.js'
import { signed8821, type F8821Input } from './f8821.js'
import { PRACTICE_COLS, PracticeError, designeeOf, getPractice, isPlatformAdmin, taxnowOf, type Practice } from './practice.js'
import { isIndividual, type Idv } from './signer_idv.js'
import type { Proof } from './signer_proof.js'

const ROW_COLS = `id, user_id, practice_id, entity_id, stage, tin, tin_last4, authorization_scope, signature, signed_at, submitted_at, submission, submission_confirmed_at, sign_token_expires, ${PRACTICE_CLIENT_ENC_COLS}`

/** What the signer sends: the drawing, and the title if it changed. */
export interface DrawnSignature { signature_png?: unknown; signer_title?: unknown; agree?: unknown }

/** Where the signed copy lives and what it was (inside the encrypted signature). */
export interface SignedCopy { s3_key: string; sha256: string; bytes: number; encrypted: boolean; made_at: string }

/** Who sent the signed copy and who recorded TaxNow's confirmation. */
export interface Submission { sent_at: string; sent_by: string; sent_to: string; note: string | null; confirmed_at?: string; confirmed_by?: string; confirmation_note?: string | null }

const MAX_PNG = 300 * 1024

/** The drawing as PNG bytes, or a 400. Accepts a data URL or bare base64. */
export function pngFrom(v: unknown): Uint8Array {
  const b64 = String(v ?? '').replace(/^data:image\/png;base64,/, '')
  const buf = Buffer.from(b64, 'base64')
  if (buf.length < 100 || buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new PracticeError(400, 'Draw your signature in the box.')
  if (buf.length > MAX_PNG) throw new PracticeError(413, 'The signature image is too large.')
  return new Uint8Array(buf)
}

/** The name line 6 prints: as read off the verified ID; for a check made by
 *  staff on a video call (no ID read by Didit), the name the signer stated
 *  and staff confirmed. */
export function verifiedName(signature: any): string {
  const idv = signature?.idv as Idv | undefined
  return (idv?.status === 'approved' && idv.person?.name) || String(signature?.signer_name ?? '')
}

/** Signing is allowed only for a verified signer who has not signed yet. */
export function signable(row: { stage: string; signature: any }): string | null {
  if (row.signature?.signed_at) return 'This 8821 is already signed.'
  if (!['draft', 'awaiting_signature'].includes(row.stage)) return 'This 8821 is past signing.'
  if (!row.signature?.id_verified_at) return 'The signer’s identity must be verified before they sign.'
  return null
}

async function loadClient(sb: SupabaseClient, clientId: string): Promise<any> {
  const { data, error } = await sb.from('practice_client').select(ROW_COLS).eq('id', clientId).maybeSingle()
  if (error) throw new PracticeError(500, error.message)
  if (!data) throw new PracticeError(404, 'No such client.')
  await hydrate(sb, data as any, ENCRYPTED_PRACTICE_CLIENT_FIELDS)
  return data
}

async function loadPractice(sb: SupabaseClient, id: string): Promise<Practice> {
  const { data } = await sb.from('practice').select(PRACTICE_COLS).eq('id', id).single()
  return data as Practice
}

/** Sign: from the signature link (meta carries the signer's IP and browser)
 *  or in the app with the signer present (meta.userId is the preparer). */
export async function sign(sb: SupabaseClient, clientId: string, body: DrawnSignature, meta: { method: 'link' | 'in_app'; ip?: string | null; userAgent?: string | null; userId?: string }) {
  const c = await loadClient(sb, clientId)
  const refused = signable(c)
  if (refused) throw new PracticeError(409, refused)
  if (body.agree !== true) throw new PracticeError(400, 'Confirm you are authorized to sign for the taxpayer.')
  const png = pngFrom(body.signature_png)
  const p = await loadPractice(sb, c.practice_id)
  const now = new Date().toISOString()
  const title = body.signer_title != null ? String(body.signer_title).trim().slice(0, 80) : String(c.signature.signer_title ?? '')
  const signature = {
    ...c.signature, signer_title: title, print_name: verifiedName(c.signature), method: meta.method, signed_at: now,
    ...(meta.method === 'link' ? { signed_ip: meta.ip ?? null, user_agent: (meta.userAgent ?? '').slice(0, 200) } : { signed_by_user: meta.userId ?? null }),
  }
  const pdf = await signed8821(await draftInput(sb, p, c), {
    name: signature.print_name, title, signedAt: now, png, audit: await auditLines(sb, p, c, signature),
  })
  signature.signed_copy = await storeCopy(sb, c, pdf, now)
  // The link stays valid until it expires: once signed it only shows that.
  const patch = { signature, stage: 'signed', signed_at: now, updated_at: now }
  const { error } = await sb.from('practice_client').update({ ...patch, ...(await encryptedFields(sb, c.user_id, patch, ENCRYPTED_PRACTICE_CLIENT_FIELDS)) }).eq('id', c.id)
  if (error) throw new PracticeError(500, error.message)
  return { ok: true, sha256: signature.signed_copy.sha256 }
}

/** The draft's values for this client, full TIN included (the signed copy is
 *  what the IRS receives). */
async function draftInput(sb: SupabaseClient, p: Practice, c: any): Promise<F8821Input> {
  const { data: ent } = await sb.from('tax_entity').select('name, address, city, state, zip').eq('id', c.entity_id).single()
  const { source: _s, ...designee } = designeeOf(p)
  return {
    taxpayer: { name: ent?.name ?? '', address: [ent?.address, [ent?.city, ent?.state, ent?.zip].filter(Boolean).join(' ')].filter(Boolean).join('\n') || undefined },
    tin: c.tin ?? (c.tin_last4 ? `XX-XXX${c.tin_last4}` : ''), designee, scope: c.authorization_scope ?? {},
  }
}

/** The last page of the signed copy. Plain words; no SSN beyond its last four. */
export async function auditLines(sb: SupabaseClient, p: Practice, c: any, s: any): Promise<Array<[string, string]>> {
  const { data: ent } = await sb.from('tax_entity').select('name, form_type').eq('id', c.entity_id).single()
  const idv = s.idv as Idv | undefined
  const proof = s.proof as Proof | undefined
  const test = idv?.environment === 'sandbox' ? ' (TEST CHECK, sandbox: not a real verification)' : ''
  const lines: Array<[string, string]> = [
    ['Taxpayer', `${ent?.name ?? ''}${c.tin_last4 ? `, TIN ending ${c.tin_last4}` : ''}`],
    ['Prepared for', p.name],
    ['Signed by', `${s.print_name}${s.signer_title ? `, ${s.signer_title}` : ''} (name as read from the verified ID)`],
    ['Signed at', `${s.signed_at.replace('T', ' ').slice(0, 19)} UTC`],
    ['How signed', s.method === 'link' ? `Drawn on a single-use signature link (no login)${s.signed_ip ? ` from IP ${s.signed_ip}` : ''}` : 'Drawn in Catipult, with the preparer present'],
  ]
  if (s.method === 'link' && s.user_agent) lines.push(['Device', s.user_agent])
  if (idv?.status === 'approved') {
    const d = idv.person?.document
    lines.push(['Identity verified', `${idv.decided_at?.replace('T', ' ').slice(0, 19) ?? ''} UTC by Didit${test}: ${d?.type ? d.type.toLowerCase() : 'government photo ID'}${d?.issuing_state ? ` (${d.issuing_state})` : ''} inspected, live selfie matched to it, SSN ending ${idv.ssn_last4} confirmed against credit and financial records`])
    lines.push(['Verification ref.', `Didit session ${idv.session_id}`])
  } else if (s.id_method === 'staff_video_call') {
    lines.push(['Identity verified', `${String(s.id_verified_at).replace('T', ' ').slice(0, 19)} UTC by Catipult staff, photo ID and SSN checked on a video call`])
  }
  if (!isIndividual(ent?.form_type ?? '') && proof?.status === 'approved') {
    lines.push(['Authority to sign', `${proof.read.doc_kind ?? 'Document'} names ${proof.read.person_name ?? 'the signer'}${proof.read.role ? ` (${proof.read.role.toLowerCase()})` : ''} for EIN ending ${proof.read.ein_last4 ?? ''}; read by Didit${test}, ref. ${proof.request_id}`])
  }
  lines.push(['Catipult record', c.id])
  return lines
}

async function storeCopy(sb: SupabaseClient, c: any, pdf: Uint8Array, at: string): Promise<SignedCopy> {
  const buf = Buffer.from(pdf)
  const enc = encryptionEnabled()
  // Under documents/<owner>/ like every other stored document (the server's S3 access is scoped there).
  const key = `documents/${c.user_id}/practice-8821/${c.id}-${at.replace(/[:.]/g, '-')}.pdf${enc ? '.enc' : ''}`
  const body = enc ? encrypt(await getDek(sb, c.user_id), buf) : buf
  await s3PutObject(key, body, enc ? 'application/octet-stream' : 'application/pdf')
  return { s3_key: key, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length, encrypted: enc, made_at: at }
}

/** The kept signed copy, decrypted, checked against its recorded hash. */
export async function signedCopy(sb: SupabaseClient, clientId: string): Promise<{ pdf: Buffer; filename: string; sha256: string }> {
  const c = await loadClient(sb, clientId)
  const copy = c.signature?.signed_copy as SignedCopy | undefined
  if (!copy) throw new PracticeError(404, 'This 8821 has not been signed yet.')
  const raw = await s3GetObject(copy.s3_key)
  const pdf = copy.encrypted ? decrypt(await getDek(sb, c.user_id), raw) : raw
  if (createHash('sha256').update(pdf).digest('hex') !== copy.sha256) throw new PracticeError(500, 'The kept signed copy does not match its record.')
  const { data: ent } = await sb.from('tax_entity').select('name').eq('id', c.entity_id).single()
  return { pdf, filename: `${(ent?.name ?? 'client').replace(/[^A-Za-z0-9]+/g, '_')}_8821_signed.pdf`, sha256: copy.sha256 }
}

// ─── Staff ──────────────────────────────────────────────────────────────────

/** Which practices' 8821s this user may send: every one for platform admins;
 *  for the owner of a practice on the fictional TaxNow, that one only. */
export async function staffScope(sb: SupabaseClient, userId: string): Promise<'all' | string[]> {
  if (isPlatformAdmin(userId)) return 'all'
  const p = await getPractice(sb, userId)
  return p?.provider === 'fixture' ? [p.id] : []
}

export async function requireStaff(sb: SupabaseClient, userId: string, practiceId?: string): Promise<'all' | string[]> {
  const scope = await staffScope(sb, userId)
  if (scope !== 'all' && (!scope.length || (practiceId && !scope.includes(practiceId)))) throw new PracticeError(403, 'Only Catipult staff can do this.')
  return scope
}

/** Signed 8821s to send, and sent ones waiting for TaxNow's confirmation. */
export async function filingQueue(sb: SupabaseClient, userId: string) {
  const scope = await requireStaff(sb, userId)
  let q = sb.from('practice_client').select(`id, user_id, practice_id, entity_id, stage, tin_last4, signed_at, submitted_at, submission, submission_confirmed_at, signature, ${PRACTICE_CLIENT_ENC_COLS}`)
    .in('stage', ['signed', 'submitted', 'readable']).not('signed_at', 'is', null).order('signed_at', { ascending: false }).limit(200)
  if (scope !== 'all') q = q.in('practice_id', scope)
  const { data, error } = await q
  if (error) throw new PracticeError(500, error.message)
  // A readable client is listed only while its confirmation is outstanding.
  const rows = (data ?? []).filter((r: any) => r.stage !== 'readable' || (r.submission && !r.submission_confirmed_at))
  await hydrateAll(sb, rows as any[], ENCRYPTED_PRACTICE_CLIENT_FIELDS)
  const ids = [...new Set(rows.map((r: any) => r.entity_id))], pids = [...new Set(rows.map((r: any) => r.practice_id))]
  const { data: ents } = ids.length ? await sb.from('tax_entity').select('id, name, form_type').in('id', ids) : { data: [] as any[] }
  const { data: prs } = pids.length ? await sb.from('practice').select('id, name').in('id', pids) : { data: [] as any[] }
  const ent = new Map((ents ?? []).map((e: any) => [e.id, e])), pr = new Map((prs ?? []).map((x: any) => [x.id, x.name]))
  return rows.filter((r: any) => r.signature?.signed_copy).map((r: any) => ({
    id: r.id, client: ent.get(r.entity_id)?.name ?? '', form_type: ent.get(r.entity_id)?.form_type ?? '', practice: pr.get(r.practice_id) ?? '',
    tin_last4: r.tin_last4, stage: r.stage, signed_at: r.signed_at, signer: r.signature.print_name ?? r.signature.signer_name,
    test_check: r.signature.idv?.environment === 'sandbox', sha256: r.signature.signed_copy.sha256,
    submission: (r.submission ?? null) as Submission | null, confirmed_at: r.submission_confirmed_at,
  }))
}

/** Staff sent the signed copy to TaxNow's staff. From now the daily check
 *  looks for the client. The accounts the org lists right now are kept: one
 *  of them turning out to be this client's TIN is an account someone else's
 *  8821 put there, not proof of this one. */
export async function markSent(sb: SupabaseClient, userId: string, clientId: string, body: { sent_to?: unknown; note?: unknown }) {
  const c = await loadClient(sb, clientId)
  await requireStaff(sb, userId, c.practice_id)
  if (c.stage !== 'signed') throw new PracticeError(409, c.stage === 'submitted' ? 'Already sent.' : 'Not signed yet.')
  if (!c.signature?.id_verified_at || !c.signature?.signed_copy) throw new PracticeError(409, 'Only a verified, signed 8821 can be sent.')
  const sentTo = String(body.sent_to ?? '').trim().slice(0, 200)
  if (!sentTo) throw new PracticeError(400, 'Say where it was sent (the filing partner’s address).')
  const p = await loadPractice(sb, c.practice_id)
  let listed: string[]
  try { listed = (await (await taxnowOf(p)).listAccounts()).map(a => a.accountId) } catch {
    throw new PracticeError(502, 'IRS records could not be reached right now. Try again in a few minutes.')
  }
  const now = new Date().toISOString()
  const submission: Submission = { sent_at: now, sent_by: userId, sent_to: sentTo, note: String(body.note ?? '').trim().slice(0, 500) || null }
  const { error } = await sb.from('practice_client').update({ stage: 'submitted', submitted_at: now, submission, accounts_at_submit: listed, updated_at: now }).eq('id', c.id)
  if (error) throw new PracticeError(500, error.message)
  return { ok: true }
}

/** TaxNow's staff confirmed they submitted THIS 8821: the proof that lets a
 *  client become readable even when its account was already in the org. */
export async function confirmFiled(sb: SupabaseClient, userId: string, clientId: string, body: { note?: unknown }) {
  const c = await loadClient(sb, clientId)
  await requireStaff(sb, userId, c.practice_id)
  if (!c.submission) throw new PracticeError(409, 'Record that it was sent first.')
  if (c.submission_confirmed_at) throw new PracticeError(409, 'Already confirmed.')
  const now = new Date().toISOString()
  const submission: Submission = { ...c.submission, confirmed_at: now, confirmed_by: userId, confirmation_note: String(body.note ?? '').trim().slice(0, 500) || null }
  const { error } = await sb.from('practice_client').update({ submission, submission_confirmed_at: now, updated_at: now }).eq('id', c.id)
  if (error) throw new PracticeError(500, error.message)
  return { ok: true }
}
