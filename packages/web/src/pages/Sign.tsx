/**
 * The public 8821 signature page (/sign/:token): what the taxpayer's signer
 * opens when their preparer sends them the link. No login; the token is the
 * credential (packages/api/src/routes/sign.ts). It shows only the last four
 * of the TIN.
 *
 * Verified first, signed second (2026-10-25): the signer gives their name,
 * title and SSN and goes through the identity check at Didit (photo ID,
 * selfie); Didit sends them back here. A business's signer then uploads one
 * document showing they belong to it. Only then do they draw their
 * signature, under the name read from their ID.
 */
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { SignHere, IdentityStart, ProofUpload } from '@/pages/practice/Onboarding'
import type { IdentityCheck, MembershipProof } from '@/hooks/use-practice'
import { PdfPages } from '@/components/PdfPages'

interface SignRequest {
  practice: string; taxpayer: string; form_type: string; tin_last4: string | null; business: boolean
  designee: { name?: string; caf?: string; address?: string; city?: string; state?: string; zip?: string; phone?: string }
  scope: { income?: string[]; payroll?: string[]; from_year?: number; to_year?: number }; expires: string
  /** A test client: test-mode identity check, a stamped 8821, the signed copy shown at the end. */
  test?: boolean; signed_copy?: boolean
  signer: { name: string; title: string; verified: boolean; signed: boolean; print_name: string | null; idv: IdentityCheck | null; proof: MembershipProof | null } | null
}

const BASE = import.meta.env.VITE_API_URL || ''
/** Didit's states for a check the signer never got going with. */
const NOT_BEGUN = ['Not Started', 'Abandoned', 'Expired', 'Kyc Expired']

async function post<T>(path: string, body: unknown, fallback: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || fallback)
  return j
}

export default function Sign() {
  const { token } = useParams()
  const [req, setReq] = useState<SignRequest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadedAt, setLoadedAt] = useState(0)
  const load = () => fetch(`${BASE}/api/sign/${token}`).then(async r => {
    const body = await r.json().catch(() => ({}))
    if (!r.ok) setError(body.error || 'This link is not valid.'); else { setError(null); setReq(body); setLoadedAt(Date.now()) }
  }).catch(() => setError('Could not load this page. Try again in a moment.'))
  useEffect(() => { load() }, [token]) // eslint-disable-line react-hooks/exhaustive-deps
  const s = req?.signer
  const idv = s?.idv
  // Back from Didit before its decision is in: wait for it here rather than
  // offer the form, whose resubmission started a new check over an approved
  // one (2026-10-27). The form shows only if the signer never got going.
  // Half an hour on, an unfinished check may be started again (the server's
  // rule too: signer_idv.ts restartBlocked); Didit's "In Review" can take hours.
  const recent = !!idv && loadedAt - new Date(idv.started_at).getTime() < 30 * 60_000
  const inReview = idv?.status === 'started' && idv.didit_status === 'In Review'
  const finishing = idv?.status === 'started' && !NOT_BEGUN.includes(idv.didit_status) && !inReview && recent
  useEffect(() => {
    if (!finishing) return
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [finishing]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="ds min-h-screen bg-background text-foreground flex justify-center px-4 py-10">
      <div className="w-full max-w-2xl flex flex-col gap-4">
        <div className="flex items-center gap-2"><div className="w-6 h-6 rounded bg-primary text-primary-foreground flex items-center justify-center text-xs font-semibold">C</div><span className="font-semibold">Catipult</span></div>
        {req?.test && (
          <div className="ds-card p-3 text-sm" role="note" style={{ background: 'var(--ds-warn-weak)', borderColor: 'var(--ds-warn)' }}>
            <strong>Test mode.</strong> Nothing here is real: the identity check runs in Didit’s test mode, and this Form 8821 is stamped “TEST — NOT FOR FILING”.
          </div>
        )}
        {error && <div className="ds-card p-4">{error}</div>}
        {req && s?.signed && (
          <div className="ds-card p-4 flex flex-col gap-3">
            <div><h1>Signed. Thank you.</h1><p className="text-muted-foreground mt-2">Your identity was verified and your Form 8821 is signed. {req.practice} sees it in Catipult. You can close this page.</p></div>
            {req.signed_copy && (
              <>
                <PdfPages title="Signed Form 8821" url={`${BASE}/api/sign/${token}/signed.pdf`} />
                <a className="ds-rowlink text-sm" href={`${BASE}/api/sign/${token}/signed.pdf`} target="_blank" rel="noreferrer">Open the signed PDF</a>
              </>
            )}
          </div>
        )}
        {req && !s?.signed && (
          <>
            <h1>Form 8821 — Tax Information Authorization</h1>
            <p className="text-muted-foreground">{req.practice} asks you to authorize the designee below to receive your IRS tax information. A designee can read your records; they cannot act for you or change anything with the IRS.</p>
            <div className="ds-card p-4 grid gap-3 sm:grid-cols-2">
              <div><div className="text-xs text-muted-foreground">Taxpayer</div><div className="font-medium">{req.taxpayer}</div><div className="text-sm text-muted-foreground">{req.tin_last4 ? `EIN ending ${req.tin_last4}` : ''}</div></div>
              <div><div className="text-xs text-muted-foreground">Designee</div><div className="font-medium">{req.designee.name || '—'}</div><div className="text-sm text-muted-foreground">{req.designee.caf ? `CAF ${req.designee.caf}` : ''}{req.designee.city ? ` · ${req.designee.city}, ${req.designee.state ?? ''}` : ''}</div></div>
              <div className="sm:col-span-2"><div className="text-xs text-muted-foreground">Information covered</div><div className="text-sm">Income tax ({(req.scope.income ?? []).join(', ') || '—'}) and employment tax ({(req.scope.payroll ?? []).join(', ') || '—'}), tax years {req.scope.from_year}–{req.scope.to_year}.</div></div>
            </div>
            <a className="ds-rowlink text-sm" href={`${BASE}/api/sign/${token}/8821.pdf`} target="_blank" rel="noreferrer">View the form you are signing (PDF)</a>

            <ol className="flex flex-col gap-3 list-none p-0 m-0">
              <li className="ds-card p-4 flex flex-col gap-3">
                <h2>1. Confirm who you are</h2>
                {s?.verified ? <p><strong>Your identity is verified.</strong></p> : (
                  <>
                    <p className="text-muted-foreground">Catipult sends this form to the IRS for {req.practice} and must first confirm the identity of the person signing it.</p>
                    {idv?.status === 'approved' && req.business && (
                      <div className="flex flex-col gap-2">
                        <p><strong>Your ID and SSN are confirmed.</strong> Next: show that you belong to {req.taxpayer}.</p>
                        {s?.proof && s.proof.status !== 'approved' && <p>Your last document was not accepted: {s.proof.reason} You can upload another.</p>}
                        <ProofUpload business={req.taxpayer} onDone={() => { load() }} onUpload={body => post<MembershipProof>(`/api/sign/${token}/proof`, body, 'Could not upload the document.')} />
                      </div>
                    )}
                    {req.test && idv?.status === 'started' && idv.environment === 'sandbox' && (
                      <div className="flex flex-col gap-2">
                        <p>Test mode: approve the check here, in place of the photo ID and selfie.</p>
                        <div><button className="ds-rowlink text-sm" onClick={async () => {
                          try { await post(`/api/sign/${token}/test-approve`, {}, 'Could not approve the test check.'); await load() } catch (e) { setError(e instanceof Error ? e.message : 'Could not approve the test check.') }
                        }}>Approve the check (test mode)</button></div>
                      </div>
                    )}
                    {finishing && (
                      <div className="flex flex-col gap-2" role="status">
                        <p><strong>Finishing your identity check…</strong> This page updates on its own; it can take a minute.</p>
                        <div><button className="ds-rowlink text-sm" onClick={load}>Check now</button></div>
                      </div>
                    )}
                    {inReview && <p>Your check is with Didit for a closer look. There is nothing more to do now; this page will show the result.</p>}
                    {idv?.status === 'started' && !finishing && !inReview && <p>Your identity check was not started or not finished. Start it again below.</p>}
                    {idv?.status === 'review' && <p>Your check needs a closer look. Your preparer will be in touch; there is nothing more to do now.</p>}
                    {idv?.status === 'declined' && <p>That check did not go through: {idv.reason} You can try again.</p>}
                    {idv?.status !== 'review' && idv?.status !== 'approved' && !finishing && !inReview && (
                      <IdentityStart stated={s ? { name: s.name, title: s.title } : null} onStart={body => post<{ url: string }>(`/api/sign/${token}/verify`, body, 'Could not start the check.')} />
                    )}
                  </>
                )}
              </li>
              <li className="ds-card p-4 flex flex-col gap-3">
                <h2>2. Sign</h2>
                {s?.verified ? (
                  <SignHere printName={s.print_name ?? s.name} title={s.title} onSign={async body => {
                    try { await post(`/api/sign/${token}`, body, 'Could not record the signature.'); await load() } catch (e) { setError(e instanceof Error ? e.message : 'Could not record the signature.') }
                  }} />
                ) : <p className="text-muted-foreground">Once your identity is confirmed, you draw your signature here.</p>}
              </li>
            </ol>
            <p className="text-xs text-muted-foreground">This link expires {new Date(req.expires).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.</p>
          </>
        )}
      </div>
    </div>
  )
}
