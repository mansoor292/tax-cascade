/**
 * Practice → Opportunities: every finding across clients. Income tax first,
 * payroll in its own section after it, then the risks read from the returns
 * (Mansoor, 2026-10-24). Grouped by kind with the rule that produced it; each
 * row says why it shows; the client's name opens the client, the row opens
 * the evidence behind it with the reviewer's verdict (Evidence.tsx).
 *
 * An imported book holds ~20,000 findings (2026-10-26): each kind shows its
 * largest 50 until asked for all, and a search and a verdict filter narrow it.
 */
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useOpportunities, type Finding } from '@/hooks/use-practice'
import LoadError from '@/components/LoadError'
import { PageHeader, Pill, Tabs, Tile } from '@/components/ds'
import { FINDING, FINDING_ORDER, PENALTIES, SECTION, FORM_NAME, VERDICT, money, periodLabel } from '@/lib/practice-labels'
import { usePracticeCtx } from './PracticeLayout'
import Evidence from './Evidence'

type Section = 'income' | 'payroll' | 'risk'
type Reviewed = 'all' | 'open' | 'valid' | 'invalid' | 'unsure'
const SHOWN = 50

export default function Opportunities() {
  const { practice } = usePracticeCtx()
  const { findings: loaded, loading, error, reload } = useOpportunities()
  // Verdicts given here, laid over what was loaded, so a long list need not reload.
  const [verdicts, setVerdicts] = useState<Record<string, Finding['verdict']>>({})
  const findings = useMemo(() => loaded.map(f => (f.id in verdicts ? { ...f, verdict: verdicts[f.id] } : f)), [loaded, verdicts])
  const [open, setOpen] = useState<Finding | null>(null)
  const [q, setQ] = useState('')
  const [reviewed, setReviewed] = useState<Reviewed>('all')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [params, setParams] = useSearchParams()
  const section = (['income', 'payroll', 'risk'].includes(params.get('section') ?? '') ? params.get('section') : 'income') as Section

  const bySection = useMemo(() => {
    const m: Record<Section, Finding[]> = { income: [], payroll: [], risk: [] }
    for (const f of findings) m[f.section as Section]?.push(f)
    return m
  }, [findings])
  const sum = (fs: Finding[], types: string[]) => fs.filter(f => types.includes(f.type)).reduce((a, f) => a + (f.amount_cents ?? 0), 0)
  // A penalty's worth splits into money back and money no longer owed.
  const split = (types: string[], part: 'refund_cents' | 'lowers_owed_cents') => findings.filter(f => types.includes(f.type)).reduce((a, f) => a + (f[part] ?? 0), 0)
  const match = (f: Finding) => (!q || (f.client_name ?? '').toLowerCase().includes(q.toLowerCase()))
    && (reviewed === 'all' || (reviewed === 'open' ? !f.verdict : f.verdict?.verdict === reviewed))
  const groups = FINDING_ORDER
    .map(type => ({ type, rows: bySection[section].filter(f => f.type === type && match(f)).sort((a, b) => (b.amount_cents ?? 0) - (a.amount_cents ?? 0)) }))
    .filter(g => g.rows.length)
  const counts = { open: findings.filter(f => !f.verdict).length, valid: 0, invalid: 0, unsure: 0 } as Record<Reviewed, number>
  for (const f of findings) if (f.verdict) counts[f.verdict.verdict]++
  const versions = [...new Set(findings.map(f => f.rules_version).filter(Boolean))].sort() as string[]
  const unknown = bySection[section].filter(f => !FINDING[f.type])

  return (
    <>
      <PageHeader crumb={practice.name} title="Opportunities" />
      <div className="ds-tiles mb-4">
        <Tile label="IRS holds" value={money(sum(findings, ['credit_held', 'refund_not_reissued']), '$0')} sub={`income ${money(sum(bySection.income, ['credit_held', 'refund_not_reissued']), '$0')} · payroll ${money(sum(bySection.payroll, ['credit_held', 'refund_not_reissued']), '$0')}`} />
        <Tile label="Penalties that can come off" value={money(sum(findings, PENALTIES), '$0')} sub={`refunds ${money(split(PENALTIES, 'refund_cents'), '$0')} · off balances due ${money(split(PENALTIES, 'lowers_owed_cents'), '$0')}${sum(findings, ['penalty_covid_kwong']) ? ` · COVID window ${money(sum(findings, ['penalty_covid_kwong']), '$0')} more, contested` : ''}`} />
        <Tile label="Missing returns" value={findings.filter(f => f.type === 'missing_return').length} sub={`${findings.filter(f => f.type === 'missing_return_unclear').length} unclear · ${findings.filter(f => f.type === 'missing_return_pending').length} recent`} />
        <Tile label="Claims in flight" value={findings.filter(f => f.type === 'claim_pending').length} sub={`${findings.filter(f => f.type === 'claim_disallowed').length} disallowed`} />
        <Tile label="Amendment candidates" value={findings.filter(f => f.type === 'erc_refund_as_income').length} sub="retention credit booked as income" />
        <Tile label="Risks" value={bySection.risk.filter(f => f.severity === 'risk').length} sub="officer pay · distributions · loans" />
      </div>
      <Tabs<Section> value={section} onChange={s => setParams({ section: s })} tabs={(['income', 'payroll', 'risk'] as Section[]).map(s => ({ value: s, label: <>{SECTION[s].label} <span className="num text-[11px] text-muted-foreground">{bySection[s].length}</span></> }))} />
      <p className="text-muted-foreground my-3 max-w-3xl">{SECTION[section].intro}</p>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="text-sm text-muted-foreground">Reviewed:</span>
        {(['all', 'open', 'valid', 'invalid', 'unsure'] as Reviewed[]).map(r => (
          <button key={r} type="button" onClick={() => setReviewed(r)} className={`ds-pill ${reviewed === r ? 'info' : 'mute'} cursor-pointer`} aria-pressed={reviewed === r}>
            {r === 'all' ? `All ${findings.length}` : r === 'open' ? `Not reviewed ${counts.open}` : `${VERDICT[r].label} ${counts[r]}`}
          </button>
        ))}
        <span className="flex-1" />
        {versions.length > 0 && <span className="text-[11.5px] text-muted-foreground">rules of {versions.join(', ')}</span>}
        <label className="sr-only" htmlFor="finding-search">Find a client</label>
        <input id="finding-search" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Find a client" className="border rounded-md px-2 h-8 bg-transparent text-sm min-w-[180px]" />
      </div>
      {error ? <LoadError message={error} onRetry={reload} /> : loading && !findings.length ? <p className="text-muted-foreground">Loading…</p> : !groups.length && !unknown.length ? (
        <div className="ds-card p-4 text-muted-foreground">Nothing in this section yet. Findings appear once clients&apos; transcripts are read.</div>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map(g => {
            const meta = FINDING[g.type]
            const total = g.rows.reduce((a, f) => a + (f.amount_cents ?? 0), 0)
            const money_ = ['claim_pending', 'claim_disallowed', 'revenue_swing'].includes(g.type) ? `${g.rows.length} ${g.rows.length === 1 ? 'client-period' : 'client-periods'}` : money(total)
            return (
              <section key={g.type} className="ds-card overflow-hidden" aria-label={meta.label}>
                <div className="flex flex-wrap items-baseline gap-2 px-3 py-2 border-b">
                  <Pill tone={meta.tone}>{meta.kind}</Pill>
                  <h2>{meta.label}</h2>
                  <span className="text-xs text-muted-foreground flex-1 min-w-[240px]">{meta.rule}</span>
                  <span className="num font-medium">{money_}</span>
                </div>
                <div className="ds-table-wrap">
                  <table className="ds-table">
                    <thead><tr><th style={{ width: '26%' }}>Client</th><th>Form</th><th>Period</th><th className="r">Amount</th><th>Why it shows</th></tr></thead>
                    <tbody>
                      {(expanded[g.type] ? g.rows : g.rows.slice(0, SHOWN)).map(f => (
                        <tr key={f.id} className="clickable" onClick={() => setOpen(f)}>
                          <td>
                            <Link className="ds-rowlink" onClick={e => e.stopPropagation()} to={`/app/practice/clients/${f.practice_client_id}?form=${f.form}&year=${f.tax_year}${f.period_month ? `&month=${f.period_month}` : ''}`}>{f.client_name}</Link>
                            {f.verdict && <> <Pill tone={VERDICT[f.verdict.verdict].tone}>{VERDICT[f.verdict.verdict].label}</Pill></>}
                          </td>
                          <td className="num">{FORM_NAME[f.form] ?? f.form}</td>
                          <td className="num">{periodLabel(f.form, f.tax_year, f.period_month)}</td>
                          <td className="r num">
                            {money(f.amount_cents)}
                            {f.refund_cents != null && (
                              <span className="block text-[11px] text-muted-foreground">{[f.refund_cents ? `refund ${money(f.refund_cents)}` : '', f.lowers_owed_cents ? `off balance ${money(f.lowers_owed_cents)}` : ''].filter(Boolean).join(' · ')}</span>
                            )}
                          </td>
                          <td className="text-muted-foreground">{f.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {g.rows.length > SHOWN && !expanded[g.type] && (
                  <div className="px-3 py-2 border-t"><button type="button" className="ds-rowlink text-sm" onClick={() => setExpanded(e => ({ ...e, [g.type]: true }))}>Show all {g.rows.length.toLocaleString()} (the largest {SHOWN} are shown)</button></div>
                )}
              </section>
            )
          })}
        </div>
      )}
      <Evidence finding={open} onClose={() => setOpen(null)} onVerdict={(f, v) => setVerdicts(m => ({ ...m, [loaded.find(x => x.practice_client_id === f.practice_client_id && x.key === f.key)?.id ?? f.id]: v }))} />
    </>
  )
}
