/**
 * The public 8821 signature page (/sign/:token): what the taxpayer signs when
 * their preparer sends them the link. No login; the token is the credential
 * (packages/api/src/routes/sign.ts). It shows only the last four of the TIN.
 *
 * After signing, the same link takes the signer through the identity check
 * Catipult must make before it submits the form (photo ID, selfie, SSN at
 * Didit); Didit sends them back here, and the page shows the outcome.
 */
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { SignHere, IdentityStart } from '@/pages/practice/Onboarding'
import type { IdentityCheck } from '@/hooks/use-practice'

interface SignRequest {
  practice: string; taxpayer: string; form_type: string; tin_last4: string | null
  designee: { name?: string; caf?: string; address?: string; city?: string; state?: string; zip?: string; phone?: string }
  scope: { income?: string[]; payroll?: string[]; from_year?: number; to_year?: number }; expires: string
  signed: { name: string; verified: boolean; idv: IdentityCheck | null } | null
}

const BASE = import.meta.env.VITE_API_URL || ''

export default function Sign() {
  const { token } = useParams()
  const [req, setReq] = useState<SignRequest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () => fetch(`${BASE}/api/sign/${token}`).then(async r => {
    const body = await r.json().catch(() => ({}))
    if (!r.ok) setError(body.error || 'This link is not valid.'); else { setError(null); setReq(body) }
  }).catch(() => setError('Could not load this page. Try again in a moment.'))
  useEffect(() => { load() }, [token]) // eslint-disable-line react-hooks/exhaustive-deps
  const idv = req?.signed?.idv

  return (
    <div className="ds min-h-screen bg-background text-foreground flex justify-center px-4 py-10">
      <div className="w-full max-w-2xl flex flex-col gap-4">
        <div className="flex items-center gap-2"><div className="w-6 h-6 rounded bg-primary text-primary-foreground flex items-center justify-center text-xs font-semibold">C</div><span className="font-semibold">Catipult</span></div>
        {error && <div className="ds-card p-4">{error}</div>}
        {req?.signed && (req.signed.verified ? (
          <div className="ds-card p-4"><h1>Signed and verified. Thank you.</h1><p className="text-muted-foreground mt-2">Your preparer sees it in Catipult. You can close this page.</p></div>
        ) : (
          <div className="ds-card p-4 flex flex-col gap-3">
            <h1>Signed. One more step: confirm it was you</h1>
            <p className="text-muted-foreground">Catipult sends this form to the IRS for {req.practice} and must first confirm the identity of the person who signed it.</p>
            {idv?.status === 'started' && (
              <div className="flex flex-col gap-2">
                <p>Your identity check has not finished yet. If you closed it before the end, start it again.</p>
                <div><button className="ds-rowlink text-sm" onClick={load}>Check again</button></div>
              </div>
            )}
            {idv?.status === 'review' && <p>Your check needs a closer look. Your preparer will be in touch; there is nothing more to do now.</p>}
            {idv?.status === 'declined' && <p>That check did not go through: {idv.reason} You can try again.</p>}
            {idv?.status !== 'review' && <IdentityStart onStart={async ssn => {
              const r = await fetch(`${BASE}/api/sign/${token}/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ssn }) })
              const j = await r.json().catch(() => ({}))
              if (!r.ok) throw new Error(j.error || 'Could not start the check.')
              return j
            }} />}
          </div>
        ))}
        {req && !req.signed && (
          <>
            <h1>Form 8821 — Tax Information Authorization</h1>
            <p className="text-muted-foreground">{req.practice} asks you to authorize the designee below to receive your IRS tax information. A designee can read your records; they cannot act for you or change anything with the IRS.</p>
            <div className="ds-card p-4 grid gap-3 sm:grid-cols-2">
              <div><div className="text-xs text-muted-foreground">Taxpayer</div><div className="font-medium">{req.taxpayer}</div><div className="text-sm text-muted-foreground">{req.tin_last4 ? `EIN ending ${req.tin_last4}` : ''}</div></div>
              <div><div className="text-xs text-muted-foreground">Designee</div><div className="font-medium">{req.designee.name || '—'}</div><div className="text-sm text-muted-foreground">{req.designee.caf ? `CAF ${req.designee.caf}` : ''}{req.designee.city ? ` · ${req.designee.city}, ${req.designee.state ?? ''}` : ''}</div></div>
              <div className="sm:col-span-2"><div className="text-xs text-muted-foreground">Information covered</div><div className="text-sm">Income tax ({(req.scope.income ?? []).join(', ') || '—'}) and employment tax ({(req.scope.payroll ?? []).join(', ') || '—'}), tax years {req.scope.from_year}–{req.scope.to_year}.</div></div>
            </div>
            <a className="ds-rowlink text-sm" href={`${BASE}/api/sign/${token}/8821.pdf`} target="_blank" rel="noreferrer">View the form you are signing (PDF)</a>
            <SignHere onSign={async body => {
              const r = await fetch(`${BASE}/api/sign/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
              const j = await r.json().catch(() => ({}))
              if (!r.ok) setError(j.error || 'Could not record the signature.'); else await load()
            }} />
            <p className="text-xs text-muted-foreground">This link expires {new Date(req.expires).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}. After you sign, you confirm your identity with a photo ID and a selfie.</p>
          </>
        )}
      </div>
    </div>
  )
}
