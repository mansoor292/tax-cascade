/**
 * The evidence behind one finding, and the reviewer's verdict on it.
 *
 * Why (2026-10-26): Mansoor reviewed the findings of a 8,834-client export on
 * a dashboard on the build box (~/taxnow-data/dashboard), judging each one
 * valid or not against the transactions behind it. This is that review in the
 * product, so the box dashboard can retire: the period as the IRS shows it and
 * its transactions, the client's other periods of the form (each opens), the
 * penalty history on the form, what abatement refunds vs takes off the balance
 * due, the client's other findings, and Valid / Not valid / Unsure with a note.
 * Everything is read from the client's own record (GET /clients/:id); the
 * verdict is kept per finding and survives the findings being recomputed.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { usePracticeClient, practiceApi, type ClientDetail, type Finding, type Transcript, type Verdict } from '@/hooks/use-practice'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/ds'
import { FINDING, FORM_NAME, STATUS, VERDICT, money, periodLabel } from '@/lib/practice-labels'

type Pick_ = { form: string; year: number; month: number | null }

export default function Evidence({ finding, onClose, onVerdict }: { finding: Finding | null; onClose: () => void; onVerdict: (f: Finding, v: Verdict | null) => void }) {
  return (
    <Sheet open={!!finding} onOpenChange={o => { if (!o) onClose() }}>
      <SheetContent side="right" className="w-full sm:max-w-[min(920px,100vw)] data-[side=right]:sm:max-w-[min(920px,100vw)] p-0 overflow-y-auto">
        {finding && <Body key={finding.id} finding={finding} onVerdict={onVerdict} />}
      </SheetContent>
    </Sheet>
  )
}

function Body({ finding: initial, onVerdict }: { finding: Finding; onVerdict: (f: Finding, v: Verdict | null) => void }) {
  const { data, loading, error } = usePracticeClient(initial.practice_client_id)
  const [finding, setFinding] = useState(initial)
  const [at, setAt] = useState<Pick_>({ form: initial.form, year: initial.tax_year, month: initial.period_month })
  const meta = FINDING[finding.type]
  return (
    <div className="ds flex flex-col gap-3 p-4" aria-label="Evidence">
      <div className="flex flex-col gap-1 pr-8">
        <span className="text-xs text-muted-foreground">{data?.client.name ?? initial.client_name}</span>
        <SheetTitle className="text-base font-semibold">{meta?.label ?? finding.type} · {FORM_NAME[finding.form] ?? finding.form} {periodLabel(finding.form, finding.tax_year, finding.period_month)}</SheetTitle>
      </div>
      <FindingCard key={`${finding.practice_client_id}|${finding.key}`} finding={finding} onVerdict={(v) => { const f = { ...finding, verdict: v }; setFinding(f); onVerdict(f, v) }} />
      {error ? <p className="text-bad">{error}</p> : loading || !data ? <p className="text-muted-foreground">Loading the client’s record…</p> : (
        <Record data={data} finding={finding} at={at} setAt={setAt} onFinding={f => { setFinding({ ...f, client_name: data.client.name }); setAt({ form: f.form, year: f.tax_year, month: f.period_month }) }} />
      )}
    </div>
  )
}

function FindingCard({ finding, onVerdict }: { finding: Finding; onVerdict: (v: Verdict | null) => void }) {
  const [note, setNote] = useState(finding.verdict?.note ?? '')
  const [busy, setBusy] = useState(false)
  const v = finding.verdict
  const save = async (verdict: 'valid' | 'invalid' | 'unsure' | 'clear') => {
    setBusy(true)
    try {
      const r = await practiceApi.verdict({ client_id: finding.practice_client_id, key: finding.key, verdict, note })
      onVerdict(r.verdict)
      toast.success(verdict === 'clear' ? 'Verdict cleared.' : `Marked ${VERDICT[verdict].label.toLowerCase()}.`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not save the verdict') }
    setBusy(false)
  }
  return (
    <div className="ds-card p-3 flex flex-col gap-2">
      <div className="flex flex-wrap gap-4 items-baseline">
        <div className="flex flex-col"><span className="text-[11.5px] text-muted-foreground">Amount</span><span className="num text-base font-medium">{money(finding.amount_cents)}</span></div>
        {finding.refund_cents != null && <>
          <div className="flex flex-col"><span className="text-[11.5px] text-muted-foreground">Refund if abated</span><span className="num text-base font-medium">{money(finding.refund_cents, '$0')}</span></div>
          <div className="flex flex-col"><span className="text-[11.5px] text-muted-foreground">Off the balance due</span><span className="num text-base font-medium">{money(finding.lowers_owed_cents ?? 0, '$0')}</span></div>
        </>}
        <span className="flex-1" />
        {finding.rules_version && <span className="text-[11.5px] text-muted-foreground">rules of {finding.rules_version}</span>}
      </div>
      <p className="text-muted-foreground">{finding.note}</p>
      <div className="flex flex-wrap gap-2 items-center border-t pt-2" role="group" aria-label="Verdict">
        <span className="text-sm">Is this finding right?</span>
        {(['valid', 'invalid', 'unsure'] as const).map(k => (
          <Button key={k} size="sm" variant={v?.verdict === k ? 'default' : 'outline'} aria-pressed={v?.verdict === k} disabled={busy} onClick={() => save(k)}>{VERDICT[k].label}</Button>
        ))}
        {v && <Button size="sm" variant="ghost" disabled={busy} onClick={() => save('clear')}>Clear</Button>}
        {v && <span className="text-[11.5px] text-muted-foreground">{VERDICT[v.verdict].label} {v.decided_at.slice(0, 10)}{v.amount_cents != null && v.amount_cents !== finding.amount_cents ? ` · judged at ${money(v.amount_cents)}, now ${money(finding.amount_cents)}` : ''}</span>}
      </div>
      <label className="sr-only" htmlFor="verdict-note">Note</label>
      <textarea id="verdict-note" value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="Why (optional, saved with the verdict)" className="border rounded-md px-2 py-1 bg-transparent text-sm" />
    </div>
  )
}

const isPenalty = (t: { family: string; action: string | null }) => t.family === 'penalty' || (t.action ?? '').startsWith('first_time_abatement')

function Record({ data, finding, at, setAt, onFinding }: { data: ClientDetail; finding: Finding; at: Pick_; setAt: (p: Pick_) => void; onFinding: (f: Finding) => void }) {
  const actr = data.transcripts.filter(t => t.type === 'ACTR')
  const form = at.form === '1120S' ? '1120' : at.form
  const ofForm = useMemo(() => actr.filter(t => t.form === form).sort((a, b) => a.tax_year - b.tax_year || a.period_month - b.period_month), [actr, form])
  const period: Transcript | undefined = ofForm.find(t => t.tax_year === at.year && (at.month == null || t.period_month === at.month))
  const penalties = ofForm.flatMap(t => (t.parsed?.txns ?? []).filter(isPenalty).map(x => ({ t, x })))
  const forms = useMemo(() => {
    const m = new Map<string, { periods: number; filed: number; nrf: number; years: Set<number> }>()
    for (const t of actr) {
      const e = m.get(t.form) ?? { periods: 0, filed: 0, nrf: 0, years: new Set<number>() }
      e.periods++
      if (t.status === 'filed') { e.filed++; e.years.add(t.tax_year) }
      if (t.status === 'no_return_filed') e.nrf++
      m.set(t.form, e)
    }
    return [...m.entries()].sort()
  }, [actr])
  const others = data.findings.filter(f => !(f.key === finding.key))

  return (
    <>
      <section className="ds-card overflow-hidden" aria-label="The period">
        <div className="px-3 py-2 border-b flex flex-wrap gap-2 items-baseline">
          <h2>{FORM_NAME[form] ?? form} · {periodLabel(form, at.year, at.month)}</h2>
          {period && <Pill tone={period.status === 'filed' ? 'info' : period.status === 'no_return_filed' ? 'bad' : 'mute'}>{STATUS[period.status].label}</Pill>}
          <span className="flex-1" />
          {period?.response_date && <span className="text-[11.5px] text-muted-foreground">as of {period.response_date}</span>}
        </div>
        {!period ? <p className="px-3 py-3 text-muted-foreground">No transcript for this period.</p> : period.parsed?.txns.length ? (
          <>
            <div className="ds-table-wrap">
              <table className="ds-table">
                <thead><tr><th>Date</th><th>Code</th><th>Explanation</th><th className="r">Amount</th></tr></thead>
                <tbody>{period.parsed.txns.map(t => <tr key={t.seq} className={isPenalty(t) ? 'font-medium' : undefined}><td className="num">{t.date ?? ''}</td><td className="num">{t.code}</td><td>{t.explanation}</td><td className="r num">{money(t.amountCents)}</td></tr>)}</tbody>
              </table>
            </div>
            <div className="flex justify-between px-3 py-2 text-sm border-t"><span className="text-muted-foreground">Account balance</span><span className="num font-medium">{money(period.parsed.balanceCents, '$0')}</span></div>
          </>
        ) : <p className="px-3 py-3 text-muted-foreground">{STATUS[period.status].meaning}</p>}
      </section>

      <section className="ds-card p-3 flex flex-col gap-2" aria-label="Every period of the form">
        <h2>{FORM_NAME[form] ?? form}, every period</h2>
        <div className="flex flex-wrap gap-1.5">
          {ofForm.map(t => {
            const on = t.tax_year === at.year && t.period_month === (at.month ?? t.period_month)
            const codes = [...new Set((t.parsed?.txns ?? []).filter(x => x.family !== 'representative').map(x => x.code))].join(' ')
            return (
              <button key={`${t.tax_year}-${t.period_month}`} type="button" aria-pressed={on} title={`${STATUS[t.status].label}${codes ? ` · codes ${codes}` : ''}`}
                onClick={() => setAt({ form, year: t.tax_year, month: t.period_month })}
                className={`flex flex-col items-start rounded-md border px-2 py-1 text-left ${on ? 'border-primary' : ''}`}>
                <span className="num text-xs">{periodLabel(form, t.tax_year, t.period_month)}</span>
                <span className="flex items-center gap-1"><span className={`ds-swatch st-${t.status}`}>{STATUS[t.status].glyph}</span><span className="num text-[11px] text-muted-foreground">{money(t.parsed?.balanceCents ?? null, '')}</span></span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="ds-card overflow-hidden" aria-label="Penalty history">
        <div className="px-3 py-2 border-b"><h2>Penalty history on the {FORM_NAME[form] ?? form}</h2></div>
        {penalties.length ? (
          <div className="ds-table-wrap">
            <table className="ds-table">
              <thead><tr><th>Period</th><th>Date</th><th>Code</th><th>Explanation</th><th className="r">Amount</th></tr></thead>
              <tbody>{penalties.map(({ t, x }) => (
                <tr key={`${t.tax_year}-${t.period_month}-${x.seq}`} className="clickable" onClick={() => setAt({ form, year: t.tax_year, month: t.period_month })}>
                  <td className="num">{periodLabel(form, t.tax_year, t.period_month)}</td><td className="num">{x.date ?? ''}</td><td className="num">{x.code}{x.reverses ? ` (reverses ${x.reverses})` : ''}</td><td>{x.explanation}</td><td className="r num">{money(x.amountCents)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p className="px-3 py-3 text-muted-foreground">No penalty on this form in any period.</p>}
      </section>

      <div className="flex flex-wrap gap-3">
        <section className="ds-card overflow-hidden flex-[1_1_300px]" aria-label="Forms">
          <div className="px-3 py-2 border-b"><h2>Forms on the account</h2></div>
          <table className="ds-table">
            <thead><tr><th>Form</th><th className="r">Periods</th><th className="r">Filed</th><th className="r">No return</th><th>Filed years</th></tr></thead>
            <tbody>{forms.map(([f, e]) => <tr key={f}><td className="num">{FORM_NAME[f] ?? f}</td><td className="r num">{e.periods}</td><td className="r num">{e.filed}</td><td className="r num">{e.nrf}</td><td className="num text-muted-foreground">{[...e.years].sort().join(' ')}</td></tr>)}</tbody>
          </table>
        </section>
        <section className="ds-card overflow-hidden flex-[1_1_300px]" aria-label="Other findings">
          <div className="px-3 py-2 border-b"><h2>Other findings on this client</h2></div>
          {others.length ? (
            <table className="ds-table">
              <tbody>{others.map(f => (
                <tr key={f.id} className="clickable" onClick={() => onFinding(f)}>
                  <td>{FINDING[f.type]?.label ?? f.type}{f.verdict ? <> <Pill tone={VERDICT[f.verdict.verdict].tone}>{VERDICT[f.verdict.verdict].label}</Pill></> : null}</td>
                  <td className="num">{FORM_NAME[f.form] ?? f.form} {periodLabel(f.form, f.tax_year, f.period_month)}</td>
                  <td className="r num">{money(f.amount_cents)}</td>
                </tr>
              ))}</tbody>
            </table>
          ) : <p className="px-3 py-3 text-muted-foreground">None.</p>}
        </section>
      </div>
      <div><Link className="ds-rowlink text-sm" to={`/app/practice/clients/${data.client.id}?tab=irs&form=${form}&year=${at.year}${at.month ? `&month=${at.month}` : ''}`}>Open the client</Link></div>
    </>
  )
}
