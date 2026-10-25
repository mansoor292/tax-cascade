/**
 * A client not yet readable: the onboarding steps (Mansoor, 2026-10-24/25).
 * The 8821 names the practice's designee. Its signer is verified FIRST —
 * photo ID, selfie and SSN at Didit, and for a business a document showing
 * they belong to it (api services/signer_idv.ts, signer_proof.ts; the
 * preparer cannot mark it done) — and only then draws a signature, on their
 * link or here; the name printed is the one read off their ID. The signed
 * copy is kept, and Catipult sends it for filing and records the
 * confirmation (api services/practice_filing.ts): the preparer sees where
 * that stands but cannot do it. Then the client's IRS records are checked
 * every morning until they can be read.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { practiceApi, download8821, type ClientDetail, type CheckStart, type DrawnSignature, type IdentityCheck, type MembershipProof } from '@/hooks/use-practice'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/ds'
import SignaturePad from '@/components/SignaturePad'
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
  const verified = !!c.signer?.id_verified_at
  const signed = !!c.signed_at
  const sent = !!c.filing?.sent_at
  const business = c.form_type !== '1040'
  // A business signer: the person passed, their proof of membership is next.
  const personDone = c.signer?.idv?.status === 'approved'
  const copyLink = async (what: string) => {
    setBusy(true)
    try {
      const r = await practiceApi.signLink(c.id)
      const url = `${window.location.origin}${r.path}`
      setLink(url)
      await navigator.clipboard?.writeText(url).catch(() => undefined)
      toast.success(`${what} copied.`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not make a link') }
    setBusy(false)
  }
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
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => download8821(c.id, c.name, signed).catch(e => toast.error(e.message))}>{signed ? 'Download signed 8821' : 'Download 8821'}</Button>
          {!signed && <span className="text-xs text-muted-foreground self-center">A fillable draft. The signed copy is made when the signer signs.</span>}
        </div>
        </div>
      ), false)}
      {step(2, 'Signer’s identity verified', verified, verified ? (
        <p className="text-muted-foreground">{verifiedLine(c.signer!.idv, c.signer!.id_method, c.signer!.proof)} {ago(c.signer!.id_verified_at)}.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground">Before anyone signs, Catipult checks the signer’s photo ID, a selfie and their Social Security number{business ? ', then a document showing they belong to the business' : ''}. Copy a signature link and send it to the client yourself: it takes them through the check and then the signature. It works for 14 days; a new link replaces the old one.</p>
          {c.signer?.idv && !personDone && <CheckState idv={c.signer.idv} />}
          {personDone && business && (
            <div className="flex flex-col gap-2">
              <p className="text-sm"><Pill tone="good">ID and SSN confirmed</Pill> {c.signer!.idv!.person?.name}. Next: a document showing they belong to {c.name}.</p>
              {c.signer?.proof && <ProofState proof={c.signer.proof} />}
              <ProofUpload who="the signer" business={c.name} onUpload={body => practiceApi.submitProof(c.id, body)} onDone={onChange} />
            </div>
          )}
          {c.signer?.idv?.status !== 'started' && (
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => copyLink('Signature link')}>Copy signature link</Button>
              {!personDone && <Button variant="outline" onClick={() => setVerifying(v => !v)}>The signer is here: verify now</Button>}
            </div>
          )}
          {c.signer?.idv?.status === 'started' && <div><Button variant="outline" onClick={onChange}>Refresh</Button></div>}
          {link && <input readOnly value={link} aria-label="Signature link" className="border rounded-md px-2 h-8 bg-transparent text-sm num w-full" onFocus={e => e.currentTarget.select()} />}
          {verifying && <IdentityStart who="the signer" stated={c.signer ? { name: c.signer.name, title: c.signer.title } : null} onStart={body => practiceApi.verifySigner(c.id, body)} />}
          {admin && <StaffVideoCheck stated={c.signer?.name ?? null} busy={busy} onRecord={body => run(() => practiceApi.idVerified(c.id, { method: 'staff_video_call', ...body }), 'Recorded.')} />}
        </div>
      ), !verified)}
      {step(3, 'Signed by the taxpayer', signed, signed ? (
        <p className="text-muted-foreground">Signed by {c.signer?.print_name ?? c.signer?.name}{c.signer?.title ? `, ${c.signer.title}` : ''} {c.signed_at ? ago(c.signed_at) : ''} ({c.signer?.method === 'link' ? 'on the signature link' : 'in the app'}). The signed copy is kept as sent.</p>
      ) : verified ? (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground">The signer draws their signature on their link, or here if they are with you. The form prints the name read from their ID: {c.signer?.print_name ?? c.signer?.name}.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setSigning(s => !s)}>The signer is here: sign now</Button>
          </div>
          {signing && <SignHere printName={c.signer?.print_name ?? c.signer?.name ?? ''} title={c.signer?.title ?? ''} onSign={body => run(() => practiceApi.signInApp(c.id, body), 'Signed.')} />}
        </div>
      ) : <p className="text-muted-foreground">Once the signer is verified.</p>, verified && !signed)}
      {step(4, 'Sent for filing', sent, (
        <p className="text-muted-foreground">
          {c.filing?.confirmed_at ? `Sent ${ago(c.filing.sent_at)}; filing confirmed ${ago(c.filing.confirmed_at)}.`
            : sent ? `Sent ${ago(c.filing.sent_at)}. Catipult records the confirmation when the filing is done.`
            : signed ? 'Catipult sends the signed 8821 for filing. There is nothing for you to do.'
            : 'Catipult sends it for filing once it is signed.'}
        </p>
      ), signed && !sent)}
      {step(5, 'Readable', false, (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground">{c.stage === 'submitted' ? `Checked ${c.check_count} time${c.check_count === 1 ? '' : 's'}${c.last_check_at ? `, last ${ago(c.last_check_at)}` : ''}. Next check tomorrow at 6:00 am Eastern.` : 'Checked every morning once it has been sent.'}</p>
          <div><Button variant="outline" disabled={c.stage !== 'submitted' || busy} onClick={async () => {
            setBusy(true)
            try { const r = await practiceApi.check(c.id); if (r.found) toast.success('This client’s IRS records can be read now. The first read has started.'); else toast.info('Not readable yet. Checked again tomorrow.'); onChange() } catch (e) { toast.error(e instanceof Error ? e.message : 'The check failed') }
            setBusy(false)
          }}>Check now</Button></div>
        </div>
      ), c.stage === 'submitted')}
    </ol>
  )
}

/** The verified signer draws. The name is the verified one and cannot be changed here. */
export function SignHere({ printName, title: title0, onSign }: { printName: string; title: string; onSign: (b: DrawnSignature) => void }) {
  const [title, setTitle] = useState(title0)
  const [png, setPng] = useState<string | null>(null)
  const [agree, setAgree] = useState(false)
  return (
    <div className="flex flex-col gap-3 rounded-md bg-muted p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="ds-field"><label htmlFor="sig-name">Name (from the verified ID)</label><input id="sig-name" value={printName} readOnly aria-readonly /></div>
        <div className="ds-field"><label htmlFor="sig-title">Title</label><input id="sig-title" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. President" /></div>
      </div>
      <SignaturePad onChange={setPng} />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} /> I am authorized to sign this Form 8821 for the taxpayer.</label>
      <div><Button disabled={!png || !agree} onClick={() => png && onSign({ signature_png: png, signer_title: title, agree })}>Sign</Button></div>
    </div>
  )
}

/** Staff only: a check made outside Didit, on a video call with the signer's ID. */
function StaffVideoCheck({ stated, busy, onRecord }: { stated: string | null; busy: boolean; onRecord: (b: { signer_name?: string; signer_title?: string }) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  if (!open) return <div><Button variant="ghost" size="sm" onClick={() => setOpen(true)}>Staff: record a video-call check</Button></div>
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      {stated ? <p className="text-sm">Signer: {stated}</p> : (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="ds-field"><label htmlFor="vc-name">Name as on the ID</label><input id="vc-name" value={name} onChange={e => setName(e.target.value)} /></div>
          <div className="ds-field"><label htmlFor="vc-title">Title</label><input id="vc-title" value={title} onChange={e => setTitle(e.target.value)} /></div>
        </div>
      )}
      <div><Button size="sm" disabled={busy || (!stated && !name.trim())} onClick={() => {
        if (window.confirm('Record that Catipult staff checked this signer’s photo ID and SSN on a video call?')) onRecord(stated ? {} : { signer_name: name, signer_title: title })
      }}>Record the check</Button></div>
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

/** Who is signing (name and title, once), their SSN, then off to the hosted
 *  ID + selfie check. The name must be as on their ID: it is checked against it. */
export function IdentityStart({ onStart, who = 'you', stated }: { onStart: (b: CheckStart) => Promise<{ url: string }>; who?: string; stated: { name: string; title: string } | null }) {
  const [name, setName] = useState(stated?.name ?? '')
  const [title, setTitle] = useState(stated?.title ?? '')
  const [ssn, setSsn] = useState('')
  const [busy, setBusy] = useState(false)
  const digits = ssn.replace(/\D/g, '')
  const you = who === 'you'
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted p-3">
      <p className="text-sm">{you ? 'You' : 'The signer'} will photograph a driver’s license or passport and take a selfie (about two minutes), and the Social Security number is matched against credit records. The ID photos are kept by our verification provider, Didit, not by Catipult or the preparer.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="ds-field"><label htmlFor="idv-name">{you ? 'Your full legal name' : 'The signer’s full legal name'} (as on the ID)</label><input id="idv-name" autoComplete="name" value={name} onChange={e => setName(e.target.value)} /></div>
        <div className="ds-field"><label htmlFor="idv-title">Title</label><input id="idv-title" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. President" /></div>
      </div>
      <div className="ds-field max-w-xs"><label htmlFor="idv-ssn">{you ? 'Your' : 'The signer’s'} Social Security number</label><input id="idv-ssn" inputMode="numeric" autoComplete="off" value={ssn} onChange={e => setSsn(e.target.value)} placeholder="123-45-6789" /></div>
      <div><Button disabled={digits.length !== 9 || !name.trim() || busy} onClick={async () => {
        setBusy(true)
        try { const r = await onStart({ signer_name: name.trim(), signer_title: title.trim(), ssn: digits }); window.location.assign(r.url) } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not start the check'); setBusy(false) }
      }}>Start identity check</Button></div>
    </div>
  )
}
