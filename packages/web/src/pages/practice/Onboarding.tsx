/**
 * A client not yet readable: the onboarding steps (Mansoor, 2026-10-24).
 * The 8821 names the practice's designee; the client signs through a link the
 * preparer copies to them, or the signer signs here; Catipult verifies the
 * signer's identity (photo ID, selfie and SSN at Didit — api
 * services/signer_idv.ts; the preparer cannot mark it done); the signed 8821 is submitted (how it goes in is still
 * being settled); then TaxNow is checked every morning until it can read the
 * client.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { practiceApi, download8821, type ClientDetail, type IdentityCheck, type MembershipProof } from '@/hooks/use-practice'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/ds'
import { FORM_NAME, ago } from '@/lib/practice-labels'
import { usePracticeCtx } from './PracticeLayout'

export default function Onboarding({ detail, onChange }: { detail: ClientDetail; onChange: () => void }) {
  const { designee, admin } = usePracticeCtx()
  const c = detail.client
  const a = c.authorization_scope ?? {}
  const [link, setLink] = useState<string | null>(null)
  const [signing, setSigning] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await fn(); toast.success(ok); onChange() } catch (e) { toast.error(e instanceof Error ? e.message : 'That did not work') }
    setBusy(false)
  }
  const signed = !!c.signed_at
  const verified = !!c.signer?.id_verified_at
  const business = c.form_type !== '1040'
  // A business signer: the person passed, their proof of membership is next.
  const personDone = c.signer?.idv?.status === 'approved'
  const step = (n: number, title: string, done: boolean, body: React.ReactNode, current: boolean) => (
    <li className={`ds-card p-4 flex flex-col gap-2 ${current ? 'border-primary' : ''}`}>
      <div className="flex items-center gap-2"><span className="num text-muted-foreground">{n}</span><h2 className="flex-1">{title}</h2>{done ? <Pill tone="good">Done</Pill> : current ? <Pill tone="info">Next</Pill> : null}</div>
      {body}
    </li>
  )
  return (
    <ol className="flex flex-col gap-3 list-none p-0 m-0">
      {step(1, 'Form 8821 prepared', true, (
        <div className="flex flex-col gap-2">
        <p className="text-muted-foreground">
          Taxpayer {c.name}{c.tin_last4 ? ` (EIN ending ${c.tin_last4})` : ''}. Designee: {designee?.name || 'the platform designee'}{designee?.caf ? `, CAF ${designee.caf}` : ''}.
          Covers income {(a.income ?? []).map(f => FORM_NAME[f] ?? f).join(', ') || '—'} and employment {(a.payroll ?? []).join(', ') || '—'}, {a.from_year}–{a.to_year}{a.year_end_month && a.year_end_month !== 12 ? `, year ending month ${a.year_end_month}` : ''}.
        </p>
        <div><Button variant="outline" size="sm" onClick={() => download8821(c.id, c.name).catch(e => toast.error(e.message))}>Download 8821</Button></div>
        </div>
      ), false)}
      {step(2, 'Signed by the taxpayer', signed, signed ? (
        <p className="text-muted-foreground">Signed by {c.signer?.name}{c.signer?.title ? `, ${c.signer.title}` : ''} {c.signed_at ? ago(c.signed_at) : ''} ({c.signer?.method === 'link' ? 'signature link' : 'in the app'}).</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground">Copy a signature link and send it to the client yourself. It works for 14 days; a new link replaces the old one.</p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={async () => {
              setBusy(true)
              try {
                const r = await practiceApi.signLink(c.id)
                const url = `${window.location.origin}${r.path}`
                setLink(url)
                await navigator.clipboard?.writeText(url).catch(() => undefined)
                toast.success('Signature link copied.')
              } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not make a link') }
              setBusy(false)
            }}>Copy signature link</Button>
            <Button variant="outline" onClick={() => setSigning(s => !s)}>The signer is here: sign now</Button>
          </div>
          {link && <input readOnly value={link} aria-label="Signature link" className="border rounded-md px-2 h-8 bg-transparent text-sm num w-full" onFocus={e => e.currentTarget.select()} />}
          {signing && <SignHere onSign={body => run(() => practiceApi.signInApp(c.id, body), 'Signed.')} />}
        </div>
      ), !signed)}
      {step(3, 'Signer’s identity verified', verified, verified ? (
        <p className="text-muted-foreground">{verifiedLine(c.signer!.idv, c.signer!.id_method, c.signer!.proof)} {ago(c.signer!.id_verified_at)}.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground">Catipult checks the signer’s photo ID, a selfie and their Social Security number before the 8821 goes in{business ? ', then a document showing they belong to the business' : ''}. Signers who used the link are taken there right after signing; anyone else can do it from a new link on their phone, or here if they are with you.</p>
          {c.signer?.idv && !personDone && <CheckState idv={c.signer.idv} />}
          {personDone && business && (
            <div className="flex flex-col gap-2">
              <p className="text-sm"><Pill tone="good">ID and SSN confirmed</Pill> {c.signer!.idv!.person?.name}. Next: a document showing they belong to {c.name}.</p>
              {c.signer?.proof && <ProofState proof={c.signer.proof} />}
              <ProofUpload who="the signer" business={c.name} onUpload={body => practiceApi.submitProof(c.id, body)} onDone={onChange} />
            </div>
          )}
          {signed && c.signer?.idv?.status !== 'started' && (
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={async () => {
                setBusy(true)
                try {
                  const r = await practiceApi.signLink(c.id)
                  const url = `${window.location.origin}${r.path}`
                  setLink(url)
                  await navigator.clipboard?.writeText(url).catch(() => undefined)
                  toast.success('Identity check link copied.')
                } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not make a link') }
                setBusy(false)
              }}>Copy identity check link</Button>
              {!personDone && <Button variant="outline" onClick={() => setVerifying(v => !v)}>The signer is here: verify now</Button>}
            </div>
          )}
          {signed && c.signer?.idv?.status === 'started' && <div><Button variant="outline" onClick={onChange}>Refresh</Button></div>}
          {link && signed && <input readOnly value={link} aria-label="Identity check link" className="border rounded-md px-2 h-8 bg-transparent text-sm num w-full" onFocus={e => e.currentTarget.select()} />}
          {verifying && <IdentityStart who="the signer" onStart={ssn => practiceApi.verifySigner(c.id, ssn)} />}
          {admin && signed && <div><Button variant="ghost" size="sm" disabled={busy} onClick={() => {
            if (window.confirm('Record that Catipult staff checked this signer’s photo ID and SSN on a video call?')) run(() => practiceApi.idVerified(c.id, 'staff_video_call'), 'Recorded.')
          }}>Staff: record a video-call check</Button></div>}
        </div>
      ), signed && !verified)}
      {step(4, 'Submitted', c.stage === 'submitted', c.stage === 'submitted' ? <p className="text-muted-foreground">Submitted {ago(c.submitted_at)}.</p> : (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground">Once the signed 8821 has gone in, mark it submitted. Catipult then checks TaxNow every morning.</p>
          <div><Button disabled={c.stage !== 'signed' || !verified || busy} onClick={() => run(() => practiceApi.submitted(c.id), 'Marked submitted. Checked every morning from now.')}>Mark submitted</Button></div>
        </div>
      ), signed && verified && c.stage === 'signed')}
      {step(5, 'Readable in TaxNow', false, (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground">{c.stage === 'submitted' ? `Checked ${c.check_count} time${c.check_count === 1 ? '' : 's'}${c.last_check_at ? `, last ${ago(c.last_check_at)}` : ''}. Next check tomorrow at 6:00 am Eastern.` : 'Checked daily once submitted.'}</p>
          <div><Button variant="outline" disabled={c.stage !== 'submitted' || busy} onClick={async () => {
            setBusy(true)
            try { const r = await practiceApi.check(c.id); if (r.found) toast.success('TaxNow can read this client now. Its first read has started.'); else toast.info('Not readable yet. Checked again tomorrow.'); onChange() } catch (e) { toast.error(e instanceof Error ? e.message : 'The check failed') }
            setBusy(false)
          }}>Check now</Button></div>
        </div>
      ), c.stage === 'submitted')}
    </ol>
  )
}

export function SignHere({ onSign }: { onSign: (b: { signer_name: string; signer_title: string; typed_signature: string; agree: boolean }) => void }) {
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [typed, setTyped] = useState('')
  const [agree, setAgree] = useState(false)
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted p-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="ds-field"><label htmlFor="sig-name">Signer&apos;s name</label><input id="sig-name" value={name} onChange={e => setName(e.target.value)} /></div>
        <div className="ds-field"><label htmlFor="sig-title">Title</label><input id="sig-title" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. President" /></div>
        <div className="ds-field"><label htmlFor="sig-typed">Signature (type your name)</label><input id="sig-typed" value={typed} onChange={e => setTyped(e.target.value)} /></div>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} /> I am authorized to sign this Form 8821 for the taxpayer.</label>
      <div><Button disabled={!name.trim() || !typed.trim() || !agree} onClick={() => onSign({ signer_name: name, signer_title: title, typed_signature: typed, agree })}>Sign</Button></div>
    </div>
  )
}

function verifiedLine(idv: IdentityCheck | null, method: string | null, proof?: MembershipProof | null): string {
  if (idv?.status === 'approved') {
    const d = idv.person?.document
    const doc = d?.type ? `${d.type.toLowerCase()}${d.issuing_state ? ` (${d.issuing_state})` : ''}` : 'photo ID'
    const p = proof?.status === 'approved' ? `; ${proof.read.doc_kind?.toLowerCase() || 'document'} names them${proof.read.role ? ` (${proof.read.role.toLowerCase()})` : ''} for EIN ending ${proof.read.ein_last4}` : ''
    return `Verified: ${doc} and selfie match ${idv.person?.name || 'the signer'}; SSN ending ${idv.ssn_last4} confirmed${p}${idv.environment === 'sandbox' ? ' (test check)' : ''},`
  }
  return method === 'staff_video_call' ? 'Verified by Catipult staff on a video call,' : 'Verified'
}

/** What the proof of membership showed, when it did not pass. */
function ProofState({ proof }: { proof: MembershipProof }) {
  if (proof.status === 'approved') return null
  return <p className="text-sm"><Pill tone={proof.status === 'declined' ? 'bad' : 'warn'}>{proof.status === 'declined' ? 'Proof not accepted' : 'Proof needs review'}</Pill> {proof.file_name}: {proof.reason}</p>
}

/** A business signer's proof they belong to the business: one document, read by Didit. */
export function ProofUpload({ onUpload, onDone, business, who = 'you' }: { onUpload: (b: { file_name: string; content_base64: string }) => Promise<MembershipProof>; onDone: (p: MembershipProof) => void; business: string; who?: string }) {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted p-3">
      <p className="text-sm">Upload one document from {business} that names {who === 'you' ? 'you' : 'the signer'}: a Schedule K-1, the IRS letter that assigned the EIN (CP 575 or 147C), or a signed page of the business’s tax return. A photo is fine. It is read by our verification provider, Didit, and kept there.</p>
      <div className="ds-field max-w-md"><label htmlFor="proof-file">Document (PDF or photo)</label><input id="proof-file" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.tif,.tiff" onChange={e => setFile(e.target.files?.[0] ?? null)} /></div>
      <div><Button disabled={!file || busy} onClick={async () => {
        if (!file) return
        if (file.size > 7 * 1024 * 1024) { toast.error('The file is over 7 MB. A photo or a single page is enough.'); return }
        setBusy(true)
        try {
          const b64 = await new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = () => bad(r.error); r.readAsDataURL(file) })
          const proof = await onUpload({ file_name: file.name, content_base64: b64 })
          if (proof.status === 'approved') toast.success('Proof accepted.'); else toast.error(proof.reason ?? 'The document was not accepted.')
          onDone(proof)
        } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not upload the document') }
        setBusy(false)
      }}>{busy ? 'Reading the document…' : 'Upload proof'}</Button></div>
    </div>
  )
}

/** Where a signer's identity check stands, for the preparer. */
function CheckState({ idv }: { idv: IdentityCheck }) {
  if (idv.status === 'started' && idv.didit_status === 'In Review') return <p className="text-sm"><Pill tone="warn">Under review at Didit</Pill> The ID check is being looked at by a person; it updates when they decide.</p>
  if (idv.status === 'started') return <p className="text-sm">Identity check in progress (started {ago(idv.started_at)}). It updates when the signer finishes.</p>
  if (idv.status === 'review') return <p className="text-sm"><Pill tone="warn">Needs review</Pill> {idv.reason}</p>
  if (idv.status === 'declined') return <p className="text-sm"><Pill tone="bad">Not verified</Pill> {idv.reason} The signer can try again.</p>
  return null
}

/** The signer's SSN, then off to the hosted ID + selfie check. */
export function IdentityStart({ onStart, who = 'you' }: { onStart: (ssn: string) => Promise<{ url: string }>; who?: string }) {
  const [ssn, setSsn] = useState('')
  const [busy, setBusy] = useState(false)
  const digits = ssn.replace(/\D/g, '')
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted p-3">
      <p className="text-sm">{who === 'you' ? 'You' : 'The signer'} will photograph a driver’s license or passport and take a selfie (about two minutes), and the Social Security number is matched against credit records. The ID photos are kept by our verification provider, Didit, not by Catipult or the preparer.</p>
      <div className="ds-field max-w-xs"><label htmlFor="idv-ssn">{who === 'you' ? 'Your' : 'The signer’s'} Social Security number</label><input id="idv-ssn" inputMode="numeric" autoComplete="off" value={ssn} onChange={e => setSsn(e.target.value)} placeholder="123-45-6789" /></div>
      <div><Button disabled={digits.length !== 9 || busy} onClick={async () => {
        setBusy(true)
        try { const r = await onStart(digits); window.location.assign(r.url) } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not start the check'); setBusy(false) }
      }}>Start identity check</Button></div>
    </div>
  )
}
