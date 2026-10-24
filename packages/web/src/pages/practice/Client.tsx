/**
 * Practice → one client. Overview (its findings), IRS account (every form ×
 * year in the six statuses; a period opens its transactions), Returns (the
 * entity's own pages), Authorization (the 8821 and its gaps). A client still
 * onboarding opens on its onboarding steps instead.
 */
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { usePracticeClient, practiceApi, download8821, type Transcript, type ClientDetail } from '@/hooks/use-practice'
import LoadError from '@/components/LoadError'
import { Button } from '@/components/ui/button'
import { IrsRequestDialog, PageHeader, Pill, Tabs } from '@/components/ds'
import { FINDING, FORM_NAME, STAGE, STATUS, STATUS_ORDER, money, periodLabel, ago } from '@/lib/practice-labels'
import { usePracticeCtx } from './PracticeLayout'
import Onboarding from './Onboarding'

type Tab = 'overview' | 'irs' | 'returns' | 'auth'

export default function Client() {
  const { id } = useParams()
  const { practice } = usePracticeCtx()
  const { data, loading, error, reload } = usePracticeClient(id)
  const [params, setParams] = useSearchParams()
  const tab = ((params.get('tab') as Tab) || (params.get('form') ? 'irs' : 'overview'))
  const setTab = (t: Tab) => setParams(p => { const n = new URLSearchParams(p); n.set('tab', t); return n })

  if (error) return <LoadError message={error} onRetry={reload} />
  if (loading || !data) return <p className="text-muted-foreground">Loading…</p>
  const c = data.client
  const readable = c.stage === 'readable' || c.stage === 'claimed'
  const s = c.summary

  return (
    <>
      <PageHeader crumb={`${practice.name} · Clients`} title={c.name} actions={readable ? <ReadButton id={c.id} onDone={reload} /> : undefined} />
      <div className="ds-card px-4 py-3 mb-3 flex flex-wrap gap-5 items-center">
        <div className="flex flex-col gap-1 flex-1 min-w-[240px]">
          <div className="flex gap-2 items-center flex-wrap"><span className="num text-muted-foreground">{FORM_NAME[s?.income_form ?? c.form_type] ?? c.form_type}</span><Pill tone={STAGE[c.stage].tone}>{STAGE[c.stage].label}</Pill></div>
          <span className="text-xs text-muted-foreground">{c.tin_last4 ? `EIN ••-•••${c.tin_last4}` : 'EIN not on file'} · {readable ? `read from TaxNow ${ago(c.last_read_at)}` : 'not readable yet'}</span>
        </div>
        {readable && [
          ['Balance due', money(s?.balance_due_cents ?? null)],
          ['IRS holds', money(s?.credit_held_cents ?? null)],
          ['Deposits waiting on a return', money(s?.deposits_awaiting_cents ?? null)],
          ['Filed through', s?.filed_through ?? '—'],
        ].map(([l, v]) => (
          <div key={String(l)} className="flex flex-col min-w-[110px]"><span className="text-[11.5px] text-muted-foreground">{l}</span><span className="num text-base font-medium">{v}</span></div>
        ))}
      </div>
      {!readable ? <Onboarding detail={data} onChange={reload} /> : (
        <>
          <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ value: 'overview', label: 'Overview' }, { value: 'irs', label: 'IRS account' }, { value: 'returns', label: 'Returns' }, { value: 'auth', label: 'Authorization' }]} />
          <div className="mt-3">
            {tab === 'overview' && <Overview data={data} onOpen={(form, year, month) => setParams({ tab: 'irs', form, year: String(year), ...(month ? { month: String(month) } : {}) })} />}
            {tab === 'irs' && <IrsAccount data={data} onRequested={reload} />}
            {tab === 'returns' && <Returns data={data} />}
            {tab === 'auth' && <Authorization data={data} />}
          </div>
        </>
      )}
    </>
  )
}

function ReadButton({ id, onDone }: { id: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <Button variant="outline" disabled={busy} onClick={async () => {
      setBusy(true)
      try {
        const { job_id } = await practiceApi.read(id)
        toast.info('Reading from TaxNow. No IRS requests are made.')
        for (let i = 0; i < 40; i++) {
          await new Promise(r => setTimeout(r, 3000))
          const { job } = await practiceApi.job(job_id)
          if (job.status === 'done') { toast.success('Read from TaxNow.'); onDone(); break }
          if (job.status === 'failed') { toast.error(job.error || 'The read failed.'); break }
        }
      } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not start the read') }
      setBusy(false)
    }}>{busy ? 'Reading…' : 'Refresh from TaxNow'}</Button>
  )
}

function Overview({ data, onOpen }: { data: ClientDetail; onOpen: (form: string, year: number, month: number | null) => void }) {
  const rows = [...data.findings].sort((a, b) => ['income', 'payroll', 'risk'].indexOf(a.section) - ['income', 'payroll', 'risk'].indexOf(b.section) || b.tax_year - a.tax_year)
  return (
    <div className="ds-card overflow-hidden">
      <div className="px-3 py-2 border-b"><h2>Opportunities and risks</h2></div>
      {rows.length ? (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead><tr><th>Kind</th><th>Finding</th><th>Form</th><th>Period</th><th className="r">Amount</th><th>Why it shows</th></tr></thead>
            <tbody>
              {rows.map(f => (
                <tr key={f.id} className="clickable" onClick={() => onOpen(f.form, f.tax_year, f.period_month)}>
                  <td><Pill tone={FINDING[f.type]?.tone ?? 'mute'}>{FINDING[f.type]?.kind ?? f.type}</Pill></td>
                  <td className="font-medium">{FINDING[f.type]?.label ?? f.type}</td>
                  <td className="num">{FORM_NAME[f.form] ?? f.form}</td>
                  <td className="num">{periodLabel(f.form, f.tax_year, f.period_month)}</td>
                  <td className="r num">{money(f.amount_cents)}</td>
                  <td className="text-muted-foreground">{f.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="px-3 py-4 text-muted-foreground">Nothing found on the transcripts read so far. Never-pulled periods can be requested on the IRS account tab.</p>}
    </div>
  )
}

const ROW_ORDER = ['1120', '1065', '1040', '990', '941:3', '941:6', '941:9', '941:12', '940', '943', '944']

function IrsAccount({ data, onRequested }: { data: ClientDetail; onRequested: () => void }) {
  const [params, setParams] = useSearchParams()
  const [asking, setAsking] = useState<Array<{ type: 'ACTR'; form: string; year: number; month: number }> | null>(null)
  const actr = data.transcripts.filter(t => t.type === 'ACTR')
  const years = useMemo(() => [...new Set(actr.map(t => t.tax_year))].sort().slice(-8), [actr])
  const rowKey = (t: Pick<Transcript, 'form' | 'period_month'>) => (t.form === '941' ? `941:${t.period_month}` : t.form)
  const rows = useMemo(() => [...new Set(actr.map(rowKey))].sort((a, b) => (ROW_ORDER.indexOf(a) + 100 * +(ROW_ORDER.indexOf(a) < 0)) - (ROW_ORDER.indexOf(b) + 100 * +(ROW_ORDER.indexOf(b) < 0))), [actr])
  const at = (row: string, year: number) => actr.find(t => rowKey(t) === row && t.tax_year === year)
  const selForm = params.get('form'), selYear = Number(params.get('year')), selMonth = params.get('month') ? Number(params.get('month')) : null
  const selected = actr.find(t => t.form === selForm && t.tax_year === selYear && (selMonth == null || t.period_month === selMonth)) ?? null
  const never = actr.filter(t => t.status === 'never_synced')
  const rowLabel = (r: string) => (r.startsWith('941:') ? `941 Q${Math.ceil(Number(r.slice(4)) / 3)}` : FORM_NAME[r] ?? r)
  const nav = useNavigate()

  return (
    <div className="flex flex-wrap gap-3 items-start">
      <div className="ds-card p-3 flex-[1_1_520px] min-w-0 overflow-x-auto">
        <div className="grid gap-1 items-center min-w-[460px]" style={{ gridTemplateColumns: `96px repeat(${years.length}, minmax(44px, 1fr))` }}>
          <span />
          {years.map(y => <span key={y} className="num text-center text-[11px] text-muted-foreground">{y}</span>)}
          {rows.map(r => (
            <Row key={r} label={rowLabel(r)} cells={years.map(y => at(r, y))} selected={selected} onPick={t => setParams({ tab: 'irs', form: t.form, year: String(t.tax_year), month: String(t.period_month) })} />
          ))}
        </div>
        <div className="flex flex-wrap gap-3 mt-3 text-[11.5px] text-muted-foreground">
          {STATUS_ORDER.map(s => <span key={s} className="inline-flex items-center gap-1.5" title={STATUS[s].meaning}><span className={`ds-swatch st-${s}`}>{STATUS[s].glyph}</span>{STATUS[s].label}</span>)}
        </div>
        {never.length > 0 && (
          <div className="mt-3 pt-3 border-t flex flex-wrap gap-2 items-center">
            <span className="text-muted-foreground text-sm flex-1">{never.length} period{never.length === 1 ? '' : 's'} TaxNow has never pulled.</span>
            <Button variant="outline" size="sm" onClick={() => setAsking(never.map(t => ({ type: 'ACTR', form: t.form, year: t.tax_year, month: t.period_month })))}>Request {never.length} from IRS…</Button>
          </div>
        )}
      </div>
      <div className="ds-card flex-[1_1_380px] min-w-0 overflow-hidden">
        {!selected ? <p className="px-3 py-4 text-muted-foreground">Pick a period to see its transactions.</p> : (
          <>
            <div className="px-3 py-2 border-b flex flex-wrap gap-2 items-baseline">
              <h2>{FORM_NAME[selected.form] ?? selected.form} · {periodLabel(selected.form, selected.tax_year, selected.period_month)}</h2>
              <Pill tone={selected.status === 'filed' ? 'info' : selected.status === 'not_authorized' || selected.status === 'no_return_filed' ? 'bad' : 'mute'}>{STATUS[selected.status].label}</Pill>
              <span className="flex-1" />
              {selected.response_date && <span className="text-[11.5px] text-muted-foreground">IRS response {selected.response_date}</span>}
            </div>
            {selected.parsed && selected.parsed.txns.length ? (
              <>
                <table className="ds-table">
                  <thead><tr><th>Code</th><th>Explanation</th><th>Date</th><th className="r">Amount</th></tr></thead>
                  <tbody>{selected.parsed.txns.map(t => <tr key={t.seq}><td className="num">{t.code}</td><td>{t.explanation}</td><td className="num">{t.date ?? ''}</td><td className="r num">{money(t.amountCents)}</td></tr>)}</tbody>
                </table>
                <div className="flex justify-between px-3 py-2 text-sm border-t"><span className="text-muted-foreground">Account balance</span><span className="num font-medium">{money(selected.parsed.balanceCents, '$0')}</span></div>
              </>
            ) : (
              <div className="px-3 py-4 flex flex-col gap-3">
                <p className="text-muted-foreground">{STATUS[selected.status].meaning}</p>
                {selected.status === 'never_synced' && <div><Button variant="outline" size="sm" onClick={() => setAsking([{ type: 'ACTR', form: selected.form, year: selected.tax_year, month: selected.period_month }])}>Request from IRS…</Button></div>}
                {selected.status === 'not_authorized' && <div><Button variant="outline" size="sm" onClick={() => nav(`?tab=auth`)}>See the authorization</Button></div>}
              </div>
            )}
          </>
        )}
      </div>
      <IrsRequestDialog
        open={!!asking} onOpenChange={o => { if (!o) setAsking(null) }} count={asking?.length ?? 0}
        scope={<>{data.client.name} · {asking?.slice(0, 6).map(t => `${FORM_NAME[t.form] ?? t.form} ${periodLabel(t.form, t.year, t.month)}`).join(', ')}{(asking?.length ?? 0) > 6 ? ` and ${asking!.length - 6} more` : ''}</>}
        onConfirm={async () => {
          const r = await practiceApi.irsRequests(data.client.id, asking!)
          toast.success(`${r.count} request${r.count === 1 ? '' : 's'} queued. Results arrive as TaxNow reports them.`)
          setTimeout(onRequested, 4000)
        }}
      />
    </div>
  )
}

function Row({ label, cells, selected, onPick }: { label: string; cells: Array<Transcript | undefined>; selected: Transcript | null; onPick: (t: Transcript) => void }) {
  return (
    <>
      <span className="num text-xs text-muted-foreground">{label}</span>
      {cells.map((t, i) => t ? (
        <button key={i} type="button" className={`ds-cell st-${t.status}`} aria-pressed={selected === t} aria-label={`${label} ${t.tax_year}: ${STATUS[t.status].label}`} onClick={() => onPick(t)}>{STATUS[t.status].glyph}</button>
      ) : <span key={i} className="ds-cell st-empty" aria-hidden="true" />)}
    </>
  )
}

function Returns({ data }: { data: ClientDetail }) {
  const filed = data.transcripts.filter(t => t.type === 'ACTR' && ['1120', '1065', '1040'].includes(t.form)).sort((a, b) => b.tax_year - a.tax_year)
  const retrYears = new Set(data.transcripts.filter(t => t.type === 'RETR').map(t => t.tax_year))
  return (
    <div className="ds-card overflow-hidden">
      <div className="ds-table-wrap">
        <table className="ds-table">
          <thead><tr><th>Year</th><th>Return</th><th>IRS shows</th><th>Return transcript</th></tr></thead>
          <tbody>
            {filed.map(t => (
              <tr key={`${t.tax_year}-${t.period_month}`}><td className="num">{periodLabel(t.form, t.tax_year, t.period_month)}</td><td className="num">{FORM_NAME[data.client.summary?.income_form ?? t.form] ?? t.form}</td><td><Pill tone={t.status === 'filed' ? 'good' : t.status === 'no_return_filed' ? 'bad' : 'mute'}>{STATUS[t.status].label}</Pill></td><td className="text-muted-foreground">{retrYears.has(t.tax_year) ? 'On file' : '—'}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-3 border-t flex flex-wrap gap-2 items-center">
        <span className="text-sm text-muted-foreground flex-1">Each client is a Catipult entity: its returns, documents, compare and review pages are the same ones an owner uses.</span>
        <Button variant="outline" size="sm" render={<Link to={`/app/entities/${data.client.entity_id}`} />}>Open returns and documents</Button>
        <Button variant="outline" size="sm" render={<Link to={`/app/compare/${data.client.entity_id}?view=sources`} />}>Compare sources</Button>
      </div>
    </div>
  )
}

function Authorization({ data }: { data: ClientDetail }) {
  const a = data.client.authorization_scope ?? {}
  const refused = data.transcripts.filter(t => t.status === 'not_authorized')
  const byForm = new Map<string, string[]>()
  for (const t of refused) byForm.set(t.form, [...(byForm.get(t.form) ?? []), periodLabel(t.form, t.tax_year, t.period_month)])
  return (
    <div className="flex flex-wrap gap-3">
      <div className="ds-card p-4 flex-[1_1_360px] flex flex-col gap-2">
        <h2>Form 8821 on file</h2>
        <span className="text-muted-foreground">Income: {(a.income ?? []).map(f => FORM_NAME[f] ?? f).join(', ') || '—'} · Employment: {(a.payroll ?? []).join(', ') || '—'}{a.from_year ? ` · ${a.from_year}–${a.to_year}` : ''}</span>
        {a.imported && <span className="text-xs text-muted-foreground">Signed outside Catipult and brought in from TaxNow.</span>}
        {data.client.signer && <span className="text-xs text-muted-foreground">Signed by {data.client.signer.name}{data.client.signer.title ? `, ${data.client.signer.title}` : ''} · ID {data.client.signer.id_verified_at ? 'verified' : 'not yet verified'}</span>}
        <span className="text-xs text-muted-foreground">What the IRS actually honours shows in the period grid: a 451 refusal means the 8821 on file does not cover that form or period.</span>
        {!a.imported && <div><Button variant="outline" size="sm" onClick={() => download8821(data.client.id, data.client.name).catch(e => toast.error(e.message))}>Download 8821</Button></div>}
      </div>
      <div className="ds-card p-4 flex-[1_1_360px] flex flex-col gap-2">
        <h2>Gaps</h2>
        {byForm.size ? [...byForm].map(([form, ps]) => <span key={form} className="text-muted-foreground"><span className="num">{FORM_NAME[form] ?? form}</span>: {ps.join(', ')} refused (451)</span>)
          : <span className="text-muted-foreground">None. Every period requested so far was honoured.</span>}
        <h2 className="mt-2">Who else can see this client</h2>
        {data.client.summary?.other_viewers?.length
          ? <span className="text-muted-foreground">{data.client.summary.other_viewers.join(', ')}</span>
          : <span className="text-muted-foreground">No other firm is named on the 8821 record.</span>}
        {byForm.size > 0 && <span className="text-xs text-muted-foreground">A corrected 8821 naming these forms and periods (fiscal year-ends included) closes the gap. Add it as a new client record to start its signature.</span>}
      </div>
    </div>
  )
}
