/**
 * Practice → Filing desk (Catipult staff only; api services/practice_filing.ts).
 * Every practice's signed 8821s: download the kept signed copy, send it to
 * the filing partner yourself (the product sends no email), record where it
 * went, then record the partner's confirmation that it was submitted. That
 * confirmation is the proof a client waiting on it needs to become readable;
 * preparers cannot give it.
 *
 * The page names no back-end (decision 16): the fictional demo practice acts
 * as its own staff, so preparers' tests walk it too.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { useFilingDesk, practiceApi, downloadSigned8821, type FilingItem } from '@/hooks/use-practice'
import LoadError from '@/components/LoadError'
import { Button } from '@/components/ui/button'
import { PageHeader, Pill } from '@/components/ds'
import { ago } from '@/lib/practice-labels'
import { usePracticeCtx } from './PracticeLayout'

export default function FilingDesk() {
  const { practice, staff } = usePracticeCtx()
  const { items, loading, error, reload } = useFilingDesk()
  if (!staff) return <><PageHeader crumb={practice.name} title="Filing desk" /><div className="ds-card p-4">Only Catipult staff can open the filing desk.</div></>
  const toSend = items.filter(i => !i.submission)
  const waiting = items.filter(i => i.submission && !i.confirmed_at)
  return (
    <>
      <PageHeader crumb={practice.name} title="Filing desk" />
      <p className="text-muted-foreground mb-3">Signed 8821s from every practice. Download the signed copy, send it to the filing partner, record it as sent; when they confirm it was submitted, record that too.</p>
      {error ? <LoadError message={error} onRetry={reload} /> : (
        <div className="flex flex-col gap-4">
          <Section title="To send" empty="Nothing to send." loading={loading} items={toSend} onChange={reload} />
          <Section title="Sent, waiting for confirmation" empty="Nothing waiting." loading={loading} items={waiting} onChange={reload} />
        </div>
      )}
    </>
  )
}

function Section({ title, empty, loading, items, onChange }: { title: string; empty: string; loading: boolean; items: FilingItem[]; onChange: () => void }) {
  return (
    <section className="ds-card overflow-hidden" aria-label={title}>
      <h2 className="px-3 py-2 border-b">{title} <span className="text-muted-foreground num">{loading ? '' : items.length}</span></h2>
      {loading ? <p className="p-3 text-muted-foreground">Loading…</p> : !items.length ? <p className="p-3 text-muted-foreground">{empty}</p> : (
        <ul className="list-none m-0 p-0">{items.map(i => <Item key={i.id} item={i} onChange={onChange} />)}</ul>
      )}
    </section>
  )
}

function Item({ item: i, onChange }: { item: FilingItem; onChange: () => void }) {
  const [sentTo, setSentTo] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await fn(); toast.success(ok); onChange() } catch (e) { toast.error(e instanceof Error ? e.message : 'That did not work') }
    setBusy(false)
  }
  return (
    <li className="border-b last:border-b-0 p-3 flex flex-col gap-2" aria-label={i.client}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{i.client}</span>
        <span className="text-sm text-muted-foreground">{i.practice}{i.tin_last4 ? ` · EIN ending ${i.tin_last4}` : ''}</span>
        {i.test_check && <Pill tone="warn">Test check</Pill>}
      </div>
      <p className="text-sm text-muted-foreground">
        Signed by {i.signer} {ago(i.signed_at)}. Copy fingerprint <span className="num">{i.sha256.slice(0, 12)}</span>.
        {i.submission && ` Sent ${ago(i.submission.sent_at)} to ${i.submission.sent_to}.`}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Button variant="outline" size="sm" onClick={() => downloadSigned8821(i.id, i.client).catch(e => toast.error(e.message))}>Download signed 8821</Button>
        {!i.submission ? (
          <>
            <div className="ds-field"><label htmlFor={`to-${i.id}`}>Sent to</label><input id={`to-${i.id}`} value={sentTo} onChange={e => setSentTo(e.target.value)} placeholder="Filing partner’s address" /></div>
            <div className="ds-field"><label htmlFor={`note-${i.id}`}>Note</label><input id={`note-${i.id}`} value={note} onChange={e => setNote(e.target.value)} /></div>
            <Button size="sm" disabled={!sentTo.trim() || busy} onClick={() => run(() => practiceApi.filingSent(i.id, { sent_to: sentTo.trim(), note: note.trim() || undefined }), 'Recorded as sent. Its IRS records are checked every morning from now.')}>Record as sent</Button>
          </>
        ) : (
          <>
            <div className="ds-field"><label htmlFor={`cnote-${i.id}`}>Confirmation note</label><input id={`cnote-${i.id}`} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. their reply, date" /></div>
            <Button size="sm" disabled={busy} onClick={() => {
              if (window.confirm(`Record that the filing partner confirmed submitting ${i.client}'s 8821?`)) run(() => practiceApi.filingConfirmed(i.id, { note: note.trim() || undefined }), 'Filing confirmed.')
            }}>Record filing confirmed</Button>
          </>
        )}
      </div>
    </li>
  )
}
