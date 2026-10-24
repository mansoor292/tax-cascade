/**
 * The public 8821 signature page (/sign/:token): what the taxpayer signs when
 * their preparer sends them the link. No login; the token is the credential
 * (packages/api/src/routes/sign.ts). It shows only the last four of the TIN.
 */
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { SignHere } from '@/pages/practice/Onboarding'

interface SignRequest {
  practice: string; taxpayer: string; form_type: string; tin_last4: string | null
  designee: { name?: string; caf?: string; address?: string; city?: string; state?: string; zip?: string; phone?: string }
  scope: { income?: string[]; payroll?: string[]; from_year?: number; to_year?: number }; expires: string
}

const BASE = import.meta.env.VITE_API_URL || ''

export default function Sign() {
  const { token } = useParams()
  const [req, setReq] = useState<SignRequest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  useEffect(() => {
    fetch(`${BASE}/api/sign/${token}`).then(async r => {
      const body = await r.json().catch(() => ({}))
      if (!r.ok) setError(body.error || 'This link is not valid.'); else setReq(body)
    }).catch(() => setError('Could not load this page. Try again in a moment.'))
  }, [token])

  return (
    <div className="ds min-h-screen bg-background text-foreground flex justify-center px-4 py-10">
      <div className="w-full max-w-2xl flex flex-col gap-4">
        <div className="flex items-center gap-2"><div className="w-6 h-6 rounded bg-primary text-primary-foreground flex items-center justify-center text-xs font-semibold">C</div><span className="font-semibold">Catipult</span></div>
        {error && <div className="ds-card p-4">{error}</div>}
        {done && <div className="ds-card p-4"><h1>Signed. Thank you.</h1><p className="text-muted-foreground mt-2">Your preparer sees it signed in Catipult. You can close this page.</p></div>}
        {req && !done && (
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
              if (!r.ok) setError(j.error || 'Could not record the signature.'); else setDone(true)
            }} />
            <p className="text-xs text-muted-foreground">This link expires {new Date(req.expires).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}. Your preparer verifies your identity before the form is submitted.</p>
          </>
        )}
      </div>
    </div>
  )
}
