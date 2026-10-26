/**
 * Practice → Opportunities: every finding across clients. Income tax first,
 * payroll in its own section after it, then the risks read from the returns
 * (Mansoor, 2026-10-24). Grouped by kind with the rule that produced it; each
 * row says why it shows and opens the client.
 */
import { useMemo } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useOpportunities, type Finding } from '@/hooks/use-practice'
import LoadError from '@/components/LoadError'
import { PageHeader, Pill, Tabs, Tile } from '@/components/ds'
import { FINDING, FINDING_ORDER, PENALTIES, SECTION, FORM_NAME, money, periodLabel } from '@/lib/practice-labels'
import { usePracticeCtx } from './PracticeLayout'

type Section = 'income' | 'payroll' | 'risk'

export default function Opportunities() {
  const { practice } = usePracticeCtx()
  const { findings, loading, error, reload } = useOpportunities()
  const [params, setParams] = useSearchParams()
  const section = (['income', 'payroll', 'risk'].includes(params.get('section') ?? '') ? params.get('section') : 'income') as Section
  const nav = useNavigate()

  const bySection = useMemo(() => {
    const m: Record<Section, Finding[]> = { income: [], payroll: [], risk: [] }
    for (const f of findings) m[f.section as Section]?.push(f)
    return m
  }, [findings])
  const sum = (fs: Finding[], types: string[]) => fs.filter(f => types.includes(f.type)).reduce((a, f) => a + (f.amount_cents ?? 0), 0)
  // A penalty's worth splits into money back and money no longer owed.
  const split = (types: string[], part: 'refund_cents' | 'lowers_owed_cents') => findings.filter(f => types.includes(f.type)).reduce((a, f) => a + (f[part] ?? 0), 0)
  const groups = FINDING_ORDER
    .map(type => ({ type, rows: bySection[section].filter(f => f.type === type).sort((a, b) => (b.amount_cents ?? 0) - (a.amount_cents ?? 0)) }))
    .filter(g => g.rows.length)
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
                      {g.rows.map(f => (
                        <tr key={f.id} className="clickable" onClick={() => nav(`/app/practice/clients/${f.practice_client_id}?form=${f.form}&year=${f.tax_year}${f.period_month ? `&month=${f.period_month}` : ''}`)}>
                          <td><Link className="ds-rowlink" onClick={e => e.stopPropagation()} to={`/app/practice/clients/${f.practice_client_id}?form=${f.form}&year=${f.tax_year}${f.period_month ? `&month=${f.period_month}` : ''}`}>{f.client_name}</Link></td>
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
              </section>
            )
          })}
        </div>
      )}
    </>
  )
}
