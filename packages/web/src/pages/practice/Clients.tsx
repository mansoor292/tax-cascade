/**
 * Practice → Clients: where the preparer starts (docs/USER_PERSONAS.md P2).
 * Every client with its IRS access, filed-through year, balances, what the
 * IRS holds and its opportunities; the totals above link to the rows behind them.
 */
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { usePracticeClients, useOpportunities, type ClientRow } from '@/hooks/use-practice'
import LoadError from '@/components/LoadError'
import { Button } from '@/components/ui/button'
import { PageHeader, Pill, Tile } from '@/components/ds'
import { STAGE, FORM_NAME, money, ago } from '@/lib/practice-labels'
import { usePracticeCtx } from './PracticeLayout'

type Filter = 'all' | 'readable' | 'onboarding' | 'opportunities'

export default function Clients() {
  const { practice } = usePracticeCtx()
  const { clients, loading, error, reload } = usePracticeClients()
  const { findings } = useOpportunities()
  const nav = useNavigate()
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')

  const readable = (c: ClientRow) => c.stage === 'readable' || c.stage === 'claimed'
  const totals = useMemo(() => {
    const sum = (types: string[]) => findings.filter(f => types.includes(f.type)).reduce((a, f) => a + (f.amount_cents ?? 0), 0)
    const count = (types: string[]) => findings.filter(f => types.includes(f.type)).length
    return {
      holds: sum(['credit_held', 'refund_not_reissued']),
      penalties: sum(['penalty_fta', 'penalty_reasonable_cause']),
      missing: count(['deposits_no_return']),
      claims: count(['claim_pending']),
      amend: count(['erc_refund_as_income']),
      risks: findings.filter(f => f.section === 'risk' && f.severity === 'risk').length,
    }
  }, [findings])

  const shown = clients
    .filter(c => filter === 'all' || (filter === 'readable' ? readable(c) : filter === 'onboarding' ? !readable(c) : c.findings.count > 0))
    .filter(c => !q || c.name.toLowerCase().includes(q.toLowerCase()) || (c.tin_last4 ?? '').includes(q))

  return (
    <>
      <PageHeader crumb={practice.name} title="Clients" actions={<Button render={<Link to="/app/practice/taxnow?add=1" />}>Add client</Button>} />
      <div className="ds-tiles mb-4">
        <Tile label="IRS holds" value={money(totals.holds, '$0')} sub="credits and refunds not received" to="/app/practice/opportunities?section=income" />
        <Tile label="Penalties that can come off" value={money(totals.penalties, '$0')} sub="unpaid or still refundable" to="/app/practice/opportunities?section=income" />
        <Tile label="Missing returns" value={totals.missing} sub="IRS shows no return, deposits on file" to="/app/practice/opportunities?section=income" />
        <Tile label="Claims in flight" value={totals.claims} sub="forwarded, nothing posted" to="/app/practice/opportunities?section=income" />
        <Tile label="Amendment candidates" value={totals.amend} sub="retention credit booked as income" to="/app/practice/opportunities?section=income" />
        <Tile label="Risks" value={totals.risks} sub="read from the returns" to="/app/practice/opportunities?section=risk" />
      </div>
      {error ? <LoadError message={error} onRetry={reload} /> : (
        <div className="ds-card overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b">
            {(['all', 'readable', 'onboarding', 'opportunities'] as Filter[]).map(f => (
              <button key={f} type="button" onClick={() => setFilter(f)} className={`ds-pill ${filter === f ? 'info' : 'mute'} cursor-pointer`} aria-pressed={filter === f}>
                {{ all: `All ${clients.length}`, readable: `Readable ${clients.filter(readable).length}`, onboarding: `Onboarding ${clients.filter(c => !readable(c)).length}`, opportunities: `Has opportunities ${clients.filter(c => c.findings.count > 0).length}` }[f]}
              </button>
            ))}
            <span className="flex-1" />
            <label className="sr-only" htmlFor="client-search">Find a client</label>
            <input id="client-search" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Find a client or last four" className="border rounded-md px-2 h-8 bg-transparent text-sm min-w-[200px]" />
          </div>
          <div className="ds-table-wrap">
            <table className="ds-table">
              <thead><tr><th>Client</th><th>Return</th><th>IRS access</th><th>Filed through</th><th className="r">Balance due</th><th className="r">IRS holds</th><th className="r">Opportunities</th><th>Transcripts</th></tr></thead>
              <tbody>
                {loading && !clients.length ? <tr><td colSpan={8} className="text-muted-foreground">Loading clients…</td></tr> : null}
                {!loading && !clients.length ? <tr><td colSpan={8} className="text-muted-foreground">No clients yet. <Link className="ds-rowlink" to="/app/practice/taxnow?add=1">Add the first one</Link>.</td></tr> : null}
                {shown.map(c => {
                  const s = c.summary
                  const stage = STAGE[c.stage]
                  const held = s ? s.credit_held_cents : null
                  return (
                    <tr key={c.id} className="clickable" onClick={() => nav(`/app/practice/clients/${c.id}`)}>
                      <td>
                        <Link className="ds-rowlink" to={`/app/practice/clients/${c.id}`} onClick={e => e.stopPropagation()}>{c.name}</Link>
                        <div className="text-[11.5px] text-muted-foreground">{c.tin_last4 ? `EIN ••-•••${c.tin_last4}` : 'EIN not on file'}</div>
                      </td>
                      <td className="num">{FORM_NAME[s?.income_form ?? c.form_type] ?? c.form_type}</td>
                      <td><Pill tone={stage.tone}>{stage.label}</Pill>{readable(c) && (c.status_counts.not_authorized ?? 0) > 0 ? <> <Pill tone="warn">{c.status_counts.not_authorized} refused</Pill></> : null}</td>
                      <td className="num">{s?.filed_through ?? '—'}</td>
                      <td className="r num">{s ? money(s.balance_due_cents, '—') : '—'}</td>
                      <td className="r num">{held ? money(held) : s?.deposits_awaiting_cents ? <span title="Deposits waiting on a return, not money held">{money(s.deposits_awaiting_cents)} waiting</span> : '—'}</td>
                      <td className="r num">{c.findings.count ? `${c.findings.count}${c.findings.amount_cents ? ` · ${money(c.findings.amount_cents)}` : ''}` : '—'}</td>
                      <td className="text-muted-foreground">{readable(c) ? (c.last_read_at ? `read ${ago(c.last_read_at)}` : 'first read pending') : c.stage === 'submitted' ? `checked ${c.check_count}×` : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}
