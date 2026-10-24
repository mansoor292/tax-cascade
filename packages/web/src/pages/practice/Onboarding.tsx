/**
 * A client not yet readable: the onboarding steps (Mansoor, 2026-10-24).
 * The 8821 names the practice's designee; the client signs through a link the
 * preparer copies to them, or the signer signs here; Catipult verifies the
 * signer's identity; the signed 8821 is submitted (how it goes in is still
 * being settled); then TaxNow is checked every morning until it can read the
 * client.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { practiceApi, download8821, type ClientDetail } from '@/hooks/use-practice'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/ds'
import { FORM_NAME, ago } from '@/lib/practice-labels'
import { usePracticeCtx } from './PracticeLayout'

export default function Onboarding({ detail, onChange }: { detail: ClientDetail; onChange: () => void }) {
  const { designee } = usePracticeCtx()
  const c = detail.client
  const a = c.authorization_scope ?? {}
  const [link, setLink] = useState<string | null>(null)
  const [signing, setSigning] = useState(false)
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await fn(); toast.success(ok); onChange() } catch (e) { toast.error(e instanceof Error ? e.message : 'That did not work') }
    setBusy(false)
  }
  const signed = !!c.signed_at
  const verified = !!c.signer?.id_verified_at
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
      {step(3, 'Signer’s identity verified', verified, verified ? <p className="text-muted-foreground">Verified {ago(c.signer!.id_verified_at)}.</p> : (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground">Catipult verifies who signed before the 8821 goes in.</p>
          <div><Button variant="outline" disabled={!signed || busy} onClick={() => run(() => practiceApi.idVerified(c.id, 'manual'), 'Marked verified.')}>Mark identity verified</Button></div>
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
