/**
 * Practice → IRS access: who can be read, how fresh each client's transcripts
 * are, what the IRS refused (451), and onboarding new clients.
 *
 * Refreshing the IRS records on file never asks the IRS for anything; an IRS request is
 * made only from a client's IRS account tab, through the confirmation dialog.
 */
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { useCoverage, practiceApi, type Coverage } from '@/hooks/use-practice'
import LoadError from '@/components/LoadError'
import { Button } from '@/components/ui/button'
import { PageHeader, Pill, Tile } from '@/components/ds'
import { STAGE, STATUS, STATUS_ORDER, FORM_NAME, ago } from '@/lib/practice-labels'
import { usePracticeCtx } from './PracticeLayout'

export default function IrsAccess() {
  const { practice, admin } = usePracticeCtx()
  const { data, loading, error, reload } = useCoverage()
  const [params, setParams] = useSearchParams()
  const adding = params.get('add') === '1'
  const nav = useNavigate()

  if (error) return <LoadError message={error} onRetry={reload} />
  const cov: Coverage | null = data
  const readable = cov?.clients.filter(c => c.stage === 'readable' || c.stage === 'claimed') ?? []
  const onboarding = cov?.clients.filter(c => !(c.stage === 'readable' || c.stage === 'claimed')) ?? []
  const total = (k: keyof Coverage['ages']) => cov?.ages[k] ?? 0
  const allAges = cov ? Object.values(cov.ages).reduce((a, b) => a + b, 0) : 0
  const stages: Array<{ key: string; label: string; hint: string; match: (s: string) => boolean }> = [
    { key: 'sign', label: 'Waiting on signature', hint: '8821 filled; signature link out', match: s => s === 'draft' || s === 'awaiting_signature' },
    { key: 'signed', label: 'Signed · to submit', hint: 'Verify the signer, then submit', match: s => s === 'signed' },
    { key: 'submitted', label: 'Submitted · checked daily', hint: 'Checked every morning until readable', match: s => s === 'submitted' },
  ]

  return (
    <>
      <PageHeader crumb={practice.name} title="IRS access" actions={<>
        {admin && practice.provider === 'taxnow' && <ClaimButton onDone={reload} />}
        <Button onClick={() => setParams({ add: '1' })}>Add client</Button>
      </>} />
      <div className="ds-card px-4 py-3 mb-3 flex flex-wrap gap-4 items-center">
        <div className="flex flex-col gap-1 flex-1 min-w-[260px]">
          <div className="flex gap-2 items-center"><h2>IRS records</h2><Pill tone="good">{practice.provider === 'fixture' ? 'Demo data' : 'Connected'}</Pill></div>
          <span className="text-muted-foreground">Designee on new 8821s: {cov?.designee.name || 'not set'}{cov?.designee.caf ? ` · CAF ${cov.designee.caf}` : ''} ({cov?.designee.source === 'own' ? 'your own' : 'Catipult’s'}). Read every morning at 6:00 am Eastern; reading makes no IRS requests.</span>
        </div>
        <Button variant="outline" render={<Link to="/app/practice/settings" />}>Designee settings</Button>
      </div>
      <div className="ds-tiles mb-3">
        <Tile label="Clients readable" value={cov ? `${readable.length} of ${cov.clients.length}` : '—'} sub={`${onboarding.length} onboarding`} />
        <Tile label="Transcripts" value={allAges} sub="six answers kept apart" />
        <Tile label="Refused by the IRS" value={total('refused')} sub={`${cov?.gaps.length ?? 0} client-forms need a corrected 8821`} />
        <Tile label="Older than 90 days" value={total('d90_365') + total('over_365')} sub={`plus ${total('never')} never pulled`} />
      </div>

      {adding && <AddClient onClose={() => setParams({})} onCreated={id => { setParams({}); nav(`/app/practice/clients/${id}`) }} />}

      <section className="ds-card p-3 mb-3 flex flex-col gap-2" aria-label="Onboarding">
        <div className="flex flex-wrap items-baseline gap-2"><h2>Onboarding</h2><span className="text-xs text-muted-foreground">Submitted clients are checked every morning until their IRS records can be read.</span></div>
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          {stages.map(st => {
            const items = onboarding.filter(c => st.match(c.stage))
            return (
              <div key={st.key} className="rounded-md bg-muted p-2 flex flex-col gap-2 min-h-[110px]">
                <div className="flex justify-between"><span className="font-semibold text-[12.5px]">{st.label}</span><span className="num text-xs text-muted-foreground">{items.length}</span></div>
                <span className="text-[11.5px] text-muted-foreground">{st.hint}</span>
                {items.map(c => (
                  <Link key={c.id} to={`/app/practice/clients/${c.id}`} className="ds-card px-2.5 py-2 flex flex-col gap-1 hover:bg-background">
                    <span className="font-semibold">{c.name}</span>
                    <span className="text-[11.5px] text-muted-foreground">{c.stage === 'submitted' ? `submitted ${ago(c.submitted_at)} · checked ${c.check_count}×` : STAGE[c.stage as keyof typeof STAGE]?.label}</span>
                  </Link>
                ))}
              </div>
            )
          })}
        </div>
      </section>

      <div className="flex flex-wrap gap-3 mb-3 items-start">
        <section className="ds-card overflow-hidden flex-[1_1_520px] min-w-0" aria-label="Authorization gaps">
          <div className="px-3 py-2 border-b flex flex-wrap gap-2 items-baseline"><h2>Authorization gaps</h2><span className="text-xs text-muted-foreground">Periods the IRS refused (451): the 8821 on file does not cover them</span></div>
          <div className="ds-table-wrap">
            <table className="ds-table">
              <thead><tr><th>Client</th><th>Form</th><th>Periods refused</th></tr></thead>
              <tbody>
                {!cov?.gaps.length ? <tr><td colSpan={3} className="text-muted-foreground">{loading ? 'Loading…' : 'None. Every period requested so far was honoured.'}</td></tr> : cov.gaps.map(g => (
                  <tr key={`${g.client_id}-${g.form}`} className="clickable" onClick={() => nav(`/app/practice/clients/${g.client_id}?tab=auth`)}>
                    <td><Link className="ds-rowlink" onClick={e => e.stopPropagation()} to={`/app/practice/clients/${g.client_id}?tab=auth`}>{g.client_name}</Link></td>
                    <td className="num">{FORM_NAME[g.form] ?? g.form}</td>
                    <td className="num">{g.periods.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="ds-card p-3 flex-[1_1_340px] flex flex-col gap-2" aria-label="Transcript age">
          <h2>Transcript age</h2>
          {([['Under 30 days', 'under_30', 'var(--st-filed)'], ['30–90 days', 'd30_90', 'var(--primary)'], ['90 days–1 year', 'd90_365', 'var(--st-nrf)'], ['Over a year', 'over_365', 'var(--st-451)'], ['Never pulled', 'never', 'var(--st-never-line)'], ['Refused (451)', 'refused', 'var(--st-451)']] as const).map(([label, k, color]) => (
            <div key={k} className="grid items-center gap-2" style={{ gridTemplateColumns: '110px 1fr 44px' }}>
              <span className="text-xs text-muted-foreground">{label}</span>
              <div className="h-2.5 rounded bg-muted overflow-hidden"><div className="h-2.5" style={{ width: allAges ? `${(100 * total(k)) / allAges}%` : 0, background: color }} /></div>
              <span className="num text-right text-xs">{total(k)}</span>
            </div>
          ))}
          <p className="text-xs text-muted-foreground border-t pt-2 mt-1">Older and never-pulled transcripts need a new IRS request, sent from the client&apos;s IRS account tab.</p>
        </section>
      </div>

      <section className="ds-card overflow-hidden" aria-label="Every form-period, by client">
        <div className="px-3 py-2 border-b flex flex-wrap gap-2 items-baseline"><h2>Every form-period, by client</h2><span className="text-xs text-muted-foreground">A missing return is not the same as no IRS account or no authorization</span></div>
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead><tr><th>Client</th>{STATUS_ORDER.map(s => <th key={s} className="r">{STATUS[s].label}</th>)}<th>Oldest transcript</th></tr></thead>
            <tbody>
              {readable.map(c => (
                <tr key={c.id} className="clickable" onClick={() => nav(`/app/practice/clients/${c.id}?tab=irs`)}>
                  <td><Link className="ds-rowlink" onClick={e => e.stopPropagation()} to={`/app/practice/clients/${c.id}?tab=irs`}>{c.name}</Link></td>
                  {STATUS_ORDER.map(s => { const v = c.status_counts[s] ?? 0; return <td key={s} className={`r num ${!v ? 'text-muted-foreground' : s === 'no_return_filed' || s === 'not_authorized' ? 'text-bad font-semibold' : ''}`}>{v || '·'}</td> })}
                  <td className="text-muted-foreground">{ago(c.oldest_sync)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

function ClaimButton({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <Button variant="outline" disabled={busy} onClick={async () => {
      if (!window.confirm('Bring every IRS account Catipult already reads, and this practice does not hold yet, into this practice? Each becomes a client with its own entity. No IRS requests are made.')) return
      setBusy(true)
      try { const r = await practiceApi.claimAll(); toast.success(`${r.claimed} accounts brought in; their first read is queued.`); onDone() } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not bring them in') }
      setBusy(false)
    }}>Bring in existing IRS accounts</Button>
  )
}

function AddClient({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('')
  const [form, setForm] = useState('1120S')
  const [tin, setTin] = useState('')
  const [yem, setYem] = useState(12)
  const [income, setIncome] = useState(true)
  const [payroll, setPayroll] = useState<string[]>(['941', '940'])
  const [test, setTest] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const toggle = (f: string) => setPayroll(p => (p.includes(f) ? p.filter(x => x !== f) : [...p, f]))
  return (
    <section className="ds-card p-4 mb-3 flex flex-col gap-3 border-primary" aria-label="New client">
      <div className="flex flex-wrap items-baseline gap-2"><h2>New client</h2><span className="text-xs text-muted-foreground">Creates the client and its Form 8821 naming your designee. Once signed and submitted, Catipult checks every morning until the client’s IRS records can be read.</span></div>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <div className="ds-field"><label htmlFor="nc-name">Legal name</label><input id="nc-name" value={name} onChange={e => setName(e.target.value)} /></div>
        <div className="ds-field"><label htmlFor="nc-form">Files</label>
          <select id="nc-form" value={form} onChange={e => setForm(e.target.value)}><option value="1120S">Form 1120-S</option><option value="1120">Form 1120</option><option value="1065">Form 1065</option><option value="1040">Form 1040</option></select></div>
        <div className="ds-field"><label htmlFor="nc-tin">EIN (or SSN for a 1040)</label><input id="nc-tin" type="password" autoComplete="off" inputMode="numeric" value={tin} onChange={e => setTin(e.target.value)} /></div>
        <div className="ds-field"><label htmlFor="nc-yem">Year ends</label>
          <select id="nc-yem" value={yem} onChange={e => setYem(Number(e.target.value))}>{[12, 3, 6, 9, 1, 2, 4, 5, 7, 8, 10, 11].map(m => <option key={m} value={m}>{new Date(Date.UTC(2001, m - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })}</option>)}</select></div>
      </div>
      <div className="flex flex-wrap gap-4 items-center text-sm">
        <span className="text-xs font-medium text-muted-foreground">8821 covers</span>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={income} onChange={e => setIncome(e.target.checked)} /> Income</label>
        {['941', '940', '943'].map(f => <label key={f} className="flex items-center gap-1.5"><input type="checkbox" checked={payroll.includes(f)} onChange={() => toggle(f)} /> {f}</label>)}
      </div>
      <label className="flex items-start gap-1.5 text-sm"><input type="checkbox" className="mt-1" checked={test} onChange={e => setTest(e.target.checked)} /> <span>Test client: walk the signing flow without a real signer. The identity check runs in test mode, the 8821 is stamped “TEST — NOT FOR FILING”, and the client is never looked for at the IRS.</span></label>
      <p className="text-xs text-muted-foreground">The EIN is stored encrypted only until the client’s IRS records can be read. After that only its last four digits are kept.</p>
      {err && <p className="text-sm text-bad">{err}</p>}
      <div className="flex gap-2">
        <Button disabled={!name.trim() || busy} onClick={async () => {
          setBusy(true); setErr(null)
          try { const r = await practiceApi.createClient({ name: name.trim(), form_type: form, tin: tin.replace(/\D/g, '') || undefined, year_end_month: yem, scope: { income, payroll }, ...(test ? { test: true } : {}) }); toast.success('Client created. Next: the signature.'); onCreated(r.id) }
          catch (e) { setErr(e instanceof Error ? e.message : 'Could not create the client') }
          setBusy(false)
        }}>Create client and 8821</Button>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
      </div>
    </section>
  )
}
