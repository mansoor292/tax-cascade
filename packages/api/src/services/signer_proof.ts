/**
 * A business's 8821 signer: proof they belong to the business (Mansoor,
 * 2026-10-24: "first we verify the person against their SSN, and next we get
 * them to show proof that they are a member of the EIN"). The IRS asks the
 * submitter to confirm the individual signing has authority to sign for the
 * entity, and to verify the entity's name, EIN and address with a document
 * such as an information return or IRS letter.
 *
 * Runs only after the signer passed the person check (signer_idv.ts): the
 * name on the proof is compared to the name read off their ID.
 *
 * Accepted (one is enough): a Schedule K-1 from this business in the signer's
 * name, the IRS letter assigning or confirming the EIN (CP 575 / 147C) naming
 * them, or a signed page of the business's return. Didit's Document AI reads
 * the business name, EIN and the person named; then:
 *   - the EIN on the document must be this client's EIN (the full TIN, held
 *     encrypted while onboarding is pending) — otherwise refused;
 *   - the document must name the verified signer, and the business name must
 *     agree — otherwise held for review by Catipult;
 *   - a document Didit finds altered is refused.
 * The document itself stays at Didit (kept with the request as evidence); we
 * record what was read, the EIN's last four, and the verdict.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { DiditError, readDocument, type DocField, type DocumentResult } from '../lib/didit.js'
import { PracticeError, type Practice } from './practice.js'
import { envFor, isIndividual, loadRow, nameMatches, saveSignature, splitName, type Idv } from './signer_idv.js'

export type ProofStatus = 'approved' | 'declined' | 'review'

export interface Proof {
  provider: 'didit'
  environment: 'live' | 'sandbox'
  request_id: string
  status: ProofStatus
  file_name: string
  uploaded_at: string
  attempts: number
  read: { doc_kind: string | null; entity_name: string | null; ein_last4: string | null; person_name: string | null; role: string | null }
  checks: { didit_status: string; ein_matches: boolean | null; entity_name_score: number | null; entity_name_matches: boolean; person_matches: boolean; warnings: string[] }
  reason: string | null
}

const FIELDS: DocField[] = [
  { key: 'doc_kind', name: 'Document', instruction: 'What this document is: "Schedule K-1", "IRS EIN letter" (CP 575 or 147C), "Tax return", or "Other"', type: 'text', required: true },
  { key: 'entity_name', name: 'Business name', instruction: 'Legal name of the business (corporation, partnership, LLC or trust) the document is about', type: 'text', required: true, is_full_name: true },
  { key: 'ein', name: 'EIN', instruction: 'The business’s Employer Identification Number (9 digits, often written NN-NNNNNNN)', type: 'text', required: true },
  { key: 'person_name', name: 'Person named', instruction: 'Full name of the individual the document names for this business: the shareholder or partner on a K-1, the responsible party or addressee on an IRS letter, or the officer who signed a return', type: 'text', required: true },
  { key: 'person_role', name: 'Role', instruction: 'That person’s role as the document states it (shareholder, partner, member, officer, president, responsible party …)', type: 'text' },
]

const MIME: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff' }
const MAX_BYTES = 7 * 1024 * 1024

const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(t => t && !['llc', 'inc', 'corp', 'corporation', 'co', 'company', 'the', 'ltd', 'lp', 'llp', 'pc', 'pllc'].includes(t))

/** Business names agree when every significant word of the shorter is in
 *  the longer ("Juniper Freight LLC" ~ "JUNIPER FREIGHT, L.L.C."). */
export function entityNamesMatch(a: string, b: string): boolean {
  const x = tokens(a), y = new Set(tokens(b))
  const z = tokens(b), xs = new Set(x)
  if (!x.length || !z.length) return false
  return x.length <= z.length ? x.every(t => y.has(t)) : z.every(t => xs.has(t))
}

/** The verdict on a proof. Pure. */
export function proofVerdict(d: { diditStatus: string; einMatches: boolean | null; entityNameMatches: boolean; personMatches: boolean }): { status: ProofStatus; reason: string | null } {
  if (d.diditStatus === 'Declined') return { status: 'declined', reason: 'The document could not be accepted (it may have been altered).' }
  if (d.einMatches === false) return { status: 'declined', reason: 'The EIN on the document is not this client’s EIN.' }
  if (d.einMatches === null) return { status: 'review', reason: 'No EIN could be read from the document, or none is on file for this client.' }
  if (!d.personMatches) return { status: 'review', reason: 'The document does not name the person who signed.' }
  if (!d.entityNameMatches) return { status: 'review', reason: 'The business name on the document differs from the client’s name.' }
  if (d.diditStatus !== 'Approved') return { status: 'review', reason: 'Parts of the document could not be read.' }
  return { status: 'approved', reason: null }
}

const sandboxValue = (v: unknown) => typeof v === 'string' && v.startsWith('SANDBOX')

/** The signer (or the preparer, with the signer present) hands over one document. */
export async function submitProof(sb: SupabaseClient, p: Pick<Practice, 'id' | 'provider'>, clientId: string, body: { file_name?: unknown; content_base64?: unknown }): Promise<Proof> {
  const c = await loadRow(sb, clientId, p.id)
  if (isIndividual(c.form_type ?? '')) throw new PracticeError(409, 'An individual’s signer needs no proof of membership.')
  const idv = c.signature?.idv as Idv | undefined
  if (!c.signature || idv?.status !== 'approved') throw new PracticeError(409, 'Verify the signer’s ID and SSN first.')
  if (c.signature.id_verified_at) throw new PracticeError(409, 'The signer is already verified.')
  const fileName = String(body.file_name ?? '').slice(-120) || 'document'
  const mime = MIME[(fileName.split('.').pop() ?? '').toLowerCase()]
  if (!mime) throw new PracticeError(400, 'Upload a PDF or a photo (JPG, PNG, WebP or TIFF).')
  const file = Buffer.from(String(body.content_base64 ?? ''), 'base64')
  if (!file.length) throw new PracticeError(400, 'The file is empty.')
  if (file.length > MAX_BYTES) throw new PracticeError(413, 'The file is over 7 MB. A photo or a single page is enough.')

  const env = envFor(p)
  let r: DocumentResult
  try {
    r = await readDocument(env, { file, fileName, mime, fields: FIELDS, expectedCompanyName: c.entity_name || undefined, vendorData: c.id })
  } catch (e) {
    if (e instanceof DiditError) throw new PracticeError(e.status === 503 ? 503 : 502, e.status === 503 ? e.message : 'The document could not be read just now. Try again in a moment.')
    throw e
  }
  // The sandbox reads no document: its placeholder values stand for a
  // document that says what it should. Never for a live check.
  const sandbox = env === 'sandbox'
  const x = r.extracted
  const ein = sandbox && sandboxValue(x.ein) ? (c.tin ?? '') : String(x.ein ?? '')
  const entityName = sandbox && sandboxValue(x.entity_name) ? (c.entity_name ?? '') : String(x.entity_name ?? '')
  const personName = sandbox && sandboxValue(x.person_name) ? (idv.person?.name ?? '') : String(x.person_name ?? '')
  const einDigits = ein.replace(/\D/g, '')
  const tin = (c.tin ?? '').replace(/\D/g, '')
  const einMatches = einDigits.length === 9 && tin.length === 9 ? einDigits === tin : null
  const verifiedName = idv.person?.name ?? String(c.signature.signer_name ?? '')
  const personMatches = !!personName && nameMatches(personName, splitName(verifiedName))
  const entityNameMatches = !!entityName && entityNamesMatch(entityName, c.entity_name ?? '')
  const v = proofVerdict({ diditStatus: r.status, einMatches, entityNameMatches, personMatches })
  const prev = c.signature.proof as Proof | undefined
  const now = new Date().toISOString()
  const proof: Proof = {
    provider: 'didit', environment: env, request_id: r.request_id, status: v.status, file_name: fileName, uploaded_at: now, attempts: (prev?.attempts ?? 0) + 1,
    read: {
      doc_kind: sandbox && sandboxValue(x.doc_kind) ? 'Schedule K-1' : (x.doc_kind as string | null) ?? null,
      entity_name: entityName || null, ein_last4: einDigits.length >= 4 ? einDigits.slice(-4) : null,
      person_name: personName || null, role: sandbox && sandboxValue(x.person_role) ? 'Shareholder' : (x.person_role as string | null) ?? null,
    },
    checks: { didit_status: r.status, ein_matches: einMatches, entity_name_score: r.name_match_score, entity_name_matches: entityNameMatches, person_matches: personMatches, warnings: r.warnings.map(w => String(w.risk ?? w.short_description ?? '')).filter(Boolean) },
    reason: v.reason,
  }
  const signature = { ...c.signature, proof, ...(v.status === 'approved' ? { id_verified_at: now, id_method: `didit_${env}` } : {}) }
  await saveSignature(sb, c, signature)
  return proof
}

/** What the preparer and the signer see. */
export function proofView(p: Proof | null | undefined) {
  if (!p) return null
  return { status: p.status, environment: p.environment, uploaded_at: p.uploaded_at, attempts: p.attempts, file_name: p.file_name, read: p.read, reason: p.reason, checks: { ein_matches: p.checks.ein_matches, person_matches: p.checks.person_matches, entity_name_matches: p.checks.entity_name_matches } }
}
