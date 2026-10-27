/**
 * Practice → Imports: bring a transaction export into an imported book, re-run
 * the analysis, and see what each import or re-run changed.
 *
 * Why (2026-10-26): Kenneth's export of his book (8,834 clients known only by
 * number) is analysed as an account of its own, with no 8821 and no IRS
 * request behind it. The file goes straight from the browser to private
 * storage; the server reads it in batches of clients, with progress here. A
 * newer export replaces each client's periods by its number and says what
 * changed. "Re-run analysis" recomputes every finding from what is stored,
 * under the current rules — after the rules change, findings carry the old
 * rules' date until it is run.
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { useRuns, practiceApi, type Run } from '@/hooks/use-practice'
import LoadError from '@/components/LoadError'
import { Button } from '@/components/ui/button'
import { PageHeader, Pill } from '@/components/ds'
import { FINDING, STATUS } from '@/lib/practice-labels'
import { usePracticeCtx } from './PracticeLayout'

const live = (r: Run) => r.status === 'uploading' || r.status === 'queued' || r.status === 'running'

export default function Imports() {
  const { practice } = usePracticeCtx()
  const imported = practice.provider === 'import'
  const { runs, loading, error, reload } = useRuns()
  const running = runs.find(live)
  // Poll while something runs.
  useEffect(() => {
    if (!running) return
    const t = setInterval(reload, 3000)
    return () => clearInterval(t)
  }, [running?.id, reload]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <PageHeader crumb={practice.name} title="Imports" actions={<RerunButton disabled={!!running} onStarted={reload} />} />
      {imported ? <Upload disabled={!!running} onStarted={reload} /> : (
        <div className="ds-card p-4 mb-3 text-muted-foreground">This practice reads its clients through their 8821s, so it takes no export. Re-running the analysis recomputes every client’s findings from the records on file under the current rules.</div>
      )}
      {running && <Progress run={running} />}
      {error ? <LoadError message={error} onRetry={reload} /> : (
        <section className="ds-card overflow-hidden" aria-label="History">
          <div className="px-3 py-2 border-b"><h2>History</h2></div>
          {loading && !runs.length ? <p className="px-3 py-3 text-muted-foreground">Loading…</p> : !runs.length ? <p className="px-3 py-3 text-muted-foreground">Nothing imported yet.</p> : (
            <div className="ds-table-wrap">
              <table className="ds-table">
                <thead><tr><th>When</th><th>What</th><th>As of</th><th>Rules</th><th className="r">Clients</th><th className="r">Periods</th><th className="r">Findings</th><th>Changed</th><th>Status</th></tr></thead>
                <tbody>{runs.map(r => <RunRow key={r.id} r={r} />)}</tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  )
}

function RunRow({ r }: { r: Run }) {
  const c = r.changes
  const newN = c ? Object.values(c.findings_new).reduce((a, b) => a + b, 0) : 0
  const goneN = c ? Object.values(c.findings_gone).reduce((a, b) => a + b, 0) : 0
  const tone = r.status === 'done' ? 'good' : r.status === 'failed' ? 'bad' : 'info'
  return (
    <tr>
      <td className="num">{(r.finished_at ?? r.created_at).slice(0, 16).replace('T', ' ')}</td>
      <td>{r.kind === 'import' ? <>Import <span className="text-muted-foreground">{r.file_name}</span></> : 'Re-run of the analysis'}</td>
      <td className="num">{r.as_of ?? '—'}</td>
      <td className="num">{r.rules_version}</td>
      <td className="r num">{(r.stats?.clients ?? c?.clients_seen ?? 0).toLocaleString()}{c?.clients_added ? <span className="block text-[11px] text-muted-foreground">{c.clients_added.toLocaleString()} new</span> : null}{c?.clients_absent ? <span className="block text-[11px] text-muted-foreground">{c.clients_absent.toLocaleString()} not in this file</span> : null}</td>
      <td className="r num">{r.stats?.periods != null ? r.stats.periods.toLocaleString() : '—'}{c && r.kind === 'import' ? <span className="block text-[11px] text-muted-foreground">{c.periods_written.toLocaleString()} written · {c.periods_unchanged.toLocaleString()} same</span> : null}</td>
      <td className="r num">{c && r.status === 'done' ? c.findings_after.toLocaleString() : '—'}</td>
      <td className="text-muted-foreground">{c && r.status === 'done' ? (
        newN || goneN ? <details><summary className="cursor-pointer">{newN.toLocaleString()} new · {goneN.toLocaleString()} gone · {c.clients_changed.toLocaleString()} clients</summary>
          <ul className="mt-1">
            {[...new Set([...Object.keys(c.findings_new), ...Object.keys(c.findings_gone)])].map(t => <li key={t}>{FINDING[t]?.label ?? t}: +{c.findings_new[t] ?? 0} / −{c.findings_gone[t] ?? 0}</li>)}
            {c.changed_clients.slice(0, 20).map(id => <li key={id}><Link className="ds-rowlink" to={`/app/practice/clients/${id}`}>a changed client</Link></li>)}
          </ul>
        </details> : 'nothing changed'
      ) : '—'}</td>
      <td><Pill tone={tone}>{r.status === 'done' ? 'Done' : r.status === 'failed' ? 'Failed' : r.status === 'uploading' ? 'Uploading' : r.status === 'queued' ? 'Queued' : 'Running'}</Pill>{r.error ? <span className="block text-[11px] text-bad">{r.error}</span> : null}</td>
    </tr>
  )
}

function Progress({ run }: { run: Run }) {
  const total = run.batches_total ?? 0
  const done = run.batches_done ?? 0
  const pct = total ? Math.round((100 * done) / total) : 0
  const what = run.status === 'uploading' ? 'Uploading the file' : run.status === 'queued' ? 'Waiting to start' : !total ? 'Reading the file' : run.kind === 'import' ? 'Importing and analysing' : 'Re-running the analysis'
  return (
    <section className="ds-card p-3 mb-3 flex flex-col gap-2" aria-label="Progress">
      <div className="flex justify-between text-sm"><span>{what}</span>{total ? <span className="num text-muted-foreground">{done} of {total} batches</span> : null}</div>
      <div className="h-2 rounded bg-muted overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><div className="h-full bg-primary transition-all" style={{ width: `${total ? pct : 5}%` }} /></div>
    </section>
  )
}

function Upload({ disabled, onStarted }: { disabled: boolean; onStarted: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [asOf, setAsOf] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const pick = (f: File | null) => {
    setFile(f)
    const m = /(\d{4}-\d{2}-\d{2})/.exec(f?.name ?? '')
    if (m) setAsOf(m[1])
  }
  const start = async () => {
    if (!file) return
    setBusy(true); setSent(0)
    try {
      const r = await practiceApi.beginImport({ file_name: file.name, bytes: file.size, ...(asOf ? { as_of: asOf } : {}) })
      onStarted()
      // Straight to private storage, with progress (fetch has none for uploads).
      await new Promise<void>((resolve, reject) => {
        const x = new XMLHttpRequest()
        x.open('PUT', r.upload_url)
        x.setRequestHeader('Content-Type', r.content_type)
        x.upload.onprogress = e => { if (e.lengthComputable) setSent(Math.round((100 * e.loaded) / e.total)) }
        x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error(`The upload failed (${x.status}).`)))
        x.onerror = () => reject(new Error('The upload failed.'))
        x.send(file)
      })
      await practiceApi.importUploaded(r.run_id)
      toast.success('Uploaded. The import runs in the background; progress shows below.')
      setFile(null)
      if (input.current) input.current.value = ''
      onStarted()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not start the import') }
    setBusy(false)
  }
  return (
    <section className="ds-card p-4 mb-3 flex flex-col gap-3" aria-label="Import an export">
      <h2>Import an export</h2>
      <p className="text-muted-foreground max-w-3xl">A transaction export (CSV): one row per IRS transaction, the client’s number first. Each client is kept by that number, so a newer export replaces its periods and the history below says what changed. Nothing is requested from the IRS. Periods read as: {(['filed', 'no_return_filed', 'no_transactions'] as const).map(s => STATUS[s].label).join(', ')}.</p>
      <div className="flex flex-wrap gap-3 items-end">
        <div className="ds-field">
          <label htmlFor="export-file">Export file</label>
          <input id="export-file" ref={input} type="file" accept=".csv,text/csv" onChange={e => pick(e.target.files?.[0] ?? null)} />
        </div>
        <div className="ds-field">
          <label htmlFor="export-asof">As of</label>
          <input id="export-asof" type="date" value={asOf} onChange={e => setAsOf(e.target.value)} />
        </div>
        <Button disabled={!file || busy || disabled} onClick={start}>{busy ? (sent ? `Uploading ${sent}%` : 'Starting…') : 'Import'}</Button>
      </div>
      <span className="text-xs text-muted-foreground">The export does not say when each period was pulled: one as-of date stands for all of them (taken from the file name when it has one).</span>
    </section>
  )
}

function RerunButton({ disabled, onStarted }: { disabled: boolean; onStarted: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <Button variant="outline" disabled={disabled || busy} onClick={async () => {
      setBusy(true)
      try { await practiceApi.rerun(); toast.info('Re-running the analysis for every client.'); onStarted() } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not start it') }
      setBusy(false)
    }}>Re-run analysis</Button>
  )
}
