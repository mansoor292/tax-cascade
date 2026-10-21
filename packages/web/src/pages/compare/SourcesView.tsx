/**
 * One return year, every source side by side on the golden schema
 * (GET /api/golden): the filed return, the IRS's record of it (as filed and
 * as the IRS recomputed it), the books (QuickBooks classified to return
 * lines, before any tax computation), the source documents (W-2s, 1099s,
 * and for a 1040 the K-1s the group's S corporations issued), the returns
 * stored here and the scenarios. A row opens to where each figure came from.
 *
 * Why it exists (2026-10-20): the owner asked for one schema everything maps
 * to for apples-to-apples comparison. The Year-over-year tab compares stored
 * returns only; this is the comparison across sources.
 *
 * 2026-10-21: the owner read a three-column breakdown (filed · IRS · books)
 * and asked for it here, plus a way to pick the BASE return and choose which
 * sources sit beside it. So: a base and a "compare with" set (kept in the URL,
 * ?base=&with=), the filed return against the IRS and the books by default,
 * differences measured against the base, a "Key lines" view first, and rows in
 * the order the form prints them, with that year's line numbers (the API
 * labels each row from the revision the year was filed on).
 *
 * Text from the documents (descriptions, QuickBooks account names,
 * provenance) goes through maskTaxIdsInText — it can quote a return header.
 */
import { Fragment, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle, Check, ChevronRight, Loader2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import LoadError from '@/components/LoadError'
import { fmtDelta, fmtMoney } from '@/lib/format'
import { GOLDEN_STATUS_LABEL } from '@/lib/labels'
import { maskTaxIdsInText } from '@/lib/mask'
import { useGolden, type Cell, type GoldenRow, type GoldenValue } from '@/hooks/use-golden'
import { availableSources, cellOf, chooseSources, inFormOrder, lineRef, near, shortLabel, sourceLabel, versusBase, type Source, type Versus } from './sources'

function show(v: GoldenValue | undefined): string {
  if (v === undefined || v === null || v === '') return '—'
  if (typeof v === 'number') return fmtMoney(v, '—')
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return maskTaxIdsInText(String(v))
}

type Filter = 'key' | 'diff' | 'all'

const VERSUS: Record<Exclude<Versus, 'none'>, { label: string; style: string }> = {
  matches: { label: 'Matches', style: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
  differs: { label: 'Differs', style: 'bg-red-500/15 text-red-400 border-red-500/30' },
  not_in_base: { label: 'Not in base', style: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
  only_base: { label: 'Only in base', style: 'bg-muted text-muted-foreground' },
}

function ValueCell({ r, s, base }: { r: GoldenRow; s: Source; base?: Source }) {
  const c = cellOf(r, s)
  const b = base ? cellOf(r, base).value : undefined
  const off = base && c.value !== undefined && c.value !== null && b !== undefined && b !== null && !near(c.value, b)
  return (
    <td className={`px-3 py-2 text-right font-mono text-sm whitespace-nowrap align-top ${off ? 'text-amber-400' : ''} ${base ? '' : 'bg-muted/30 font-semibold'}`} title={c.title}>
      <div>{show(c.value)}{c.value !== undefined && c.mark ? ` ${c.mark}` : ''}</div>
      {off && typeof c.value === 'number' && typeof b === 'number' && <div className="text-xs text-amber-400/80" data-testid="delta">{fmtDelta(c.value - b)}</div>}
      {c.note && <div className="text-xs text-muted-foreground">{c.note}</div>}
    </td>
  )
}

function Provenance({ r, sources }: { r: GoldenRow; sources: Source[] }) {
  const items: Array<[string, Cell | undefined]> = [
    ['Filed return', r.filed], ['IRS, as filed', r.irs], ['IRS, own calculation', r.irs_computed], ['Books', r.books], ['Documents', r.documents],
    ...sources.filter(s => s.kind === 'return').map(s => [s.name, r.returns?.[s.label!]] as [string, Cell | undefined]),
    ...sources.filter(s => s.kind === 'scenario').map(s => [s.name, r.scenarios?.[s.label!]] as [string, Cell | undefined]),
  ]
  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted-foreground">{maskTaxIdsInText(r.label)}</p>
      <ul className="space-y-1 text-xs text-muted-foreground">
        {items.filter(([, c]) => c).map(([name, c]) => (
          <li key={name}><span className="text-foreground">{maskTaxIdsInText(name)}:</span> {show(c!.value)} — {maskTaxIdsInText(c!.where)}</li>
        ))}
      </ul>
      {!!r.books?.accounts?.length && (
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Accounts in the books</div>
          <ul className="space-y-0.5 text-xs" data-testid="books-accounts">
            {r.books.accounts.map((a, i) => (
              <li key={i} className="flex gap-3"><span className="font-mono w-28 text-right shrink-0">{fmtMoney(a.amount, '—')}</span><span>{maskTaxIdsInText(a.account)}</span><span className="text-muted-foreground">{a.rule}</span></li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Filed return against the IRS: {GOLDEN_STATUS_LABEL[r.status] ?? r.status}.
        {r.golden_from && ` Golden value from ${r.golden_from === 'irs' ? 'the IRS record' : r.golden_from === 'filed' ? 'the filed return' : 'a stored return'}.`}
      </p>
    </div>
  )
}

function Picker({ sources, base, others, onChange }: { sources: Source[]; base: Source; others: Source[]; onChange: (base: Source, others: Source[]) => void }) {
  const inOrder = (list: Source[]) => sources.filter(s => list.some(o => o.id === s.id))
  const pickBase = (s: Source) => {
    if (s.id === base.id) return
    // a compared source made the base trades places with the old base
    const wasCompared = others.some(o => o.id === s.id)
    onChange(s, inOrder([...others.filter(o => o.id !== s.id), ...(wasCompared ? [base] : [])]))
  }
  const toggle = (s: Source) => {
    const on = others.some(o => o.id === s.id)
    onChange(base, inOrder(on ? others.filter(o => o.id !== s.id) : [...others, s]))
  }
  return (
    <Card data-testid="source-picker">
      <CardContent className="pt-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Base">
          <span className="w-full sm:w-28 text-xs uppercase tracking-wide text-muted-foreground">Base</span>
          {sources.map(s => (
            <Button key={s.id} size="sm" variant={s.id === base.id ? 'default' : 'outline'} aria-pressed={s.id === base.id} onClick={() => pickBase(s)}>{maskTaxIdsInText(s.name)}</Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Compare with">
          <span className="w-full sm:w-28 text-xs uppercase tracking-wide text-muted-foreground">Compare with</span>
          {sources.filter(s => s.id !== base.id).map(s => {
            const on = others.some(o => o.id === s.id)
            return (
              <Button key={s.id} size="sm" variant={on ? 'secondary' : 'outline'} aria-pressed={on} onClick={() => toggle(s)}>
                {on && <Check className="h-3.5 w-3.5" />}{maskTaxIdsInText(s.name)}
              </Button>
            )
          })}
          {sources.length < 2 && <span className="text-sm text-muted-foreground">Nothing else is on file for this year.</span>}
        </div>
      </CardContent>
    </Card>
  )
}

export default function SourcesView({ entityId, years, year, onYear }: { entityId: string; years: number[]; year: number | null; onYear: (y: number) => void }) {
  const { data, loading, error, reload } = useGolden(entityId, year)
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = useState<Filter>('key')
  const [open, setOpen] = useState<string | null>(null)
  const sources = useMemo(() => (data ? availableSources(data) : []), [data])
  const wantBase = params.get('base')
  const wantWith = params.get('with')
  const { base, others } = useMemo(() => chooseSources(sources, { base: wantBase, with: wantWith }), [sources, wantBase, wantWith])
  const choose = (b: Source, w: Source[]) => setParams(p => {
    const n = new URLSearchParams(p)
    n.set('base', b.id)
    n.set('with', w.map(s => s.id).join(','))
    return n
  }, { replace: true })

  // every row the chosen sources say something on, in the order the form prints it
  const compared = useMemo(() => {
    if (!data || !base) return []
    return inFormOrder(data.rows, data.entity.form_type)
      .map(r => ({ r, vs: versusBase(r, base, others) }))
      .filter(x => x.vs.state !== 'none')
  }, [data, base, others])
  const isDiff = (vs: { state: Versus }) => vs.state === 'differs' || vs.state === 'not_in_base'
  const counts = { key: compared.filter(x => x.r.key_line || x.r.headline).length, diff: compared.filter(x => isDiff(x.vs)).length, all: compared.length }
  const rows = compared.filter(x => filter === 'all' || (filter === 'key' ? x.r.key_line || x.r.headline : isDiff(x.vs)))
  const books = data?.sources.books
  const t = data?.sources.irs_return_transcript
  const tally = (s: Source) => {
    let match = 0, differ = 0, extra = 0
    for (const { r } of compared) {
      const v = cellOf(r, s).value, b = base ? cellOf(r, base).value : undefined
      const hv = v !== undefined && v !== null && v !== '', hb = b !== undefined && b !== null && b !== ''
      if (hv && hb) { if (near(v, b)) match++; else differ++ } else if (hv && v !== 0) extra++
    }
    return { match, differ, extra }
  }

  return (
    <div className="space-y-4" data-testid="sources-view">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Tax year">
        {years.map(y => (
          <Button key={y} size="sm" variant={y === year ? 'default' : 'outline'} onClick={() => onYear(y)} data-testid="sources-year">{y}</Button>
        ))}
      </div>

      {!year && <p className="text-sm text-muted-foreground">Choose a year.</p>}
      {loading && <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}
      {error && <LoadError message={error} onRetry={reload} />}

      {data && !loading && (
        <>
          {t?.holds_return_of !== undefined && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm" data-testid="irs-holds">
              <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-400 shrink-0" />
              <span>The IRS holds the {t.holds_return_of} return in the {data.year} period. Its figures are shown but never used as the golden value.</span>
            </div>
          )}

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Sources for {data.year}</CardTitle></CardHeader>
            <CardContent className="grid gap-2 text-sm sm:grid-cols-2" data-testid="sources-list">
              <div><span className="text-muted-foreground">Filed return: </span>{data.sources.filed_return ? maskTaxIdsInText(data.sources.filed_return.filename ?? 'catalogued') : 'none catalogued'}</div>
              <div><span className="text-muted-foreground">IRS return transcript: </span>{t ? `dated ${t.as_of ?? '?'}` : 'none catalogued'}</div>
              <div><span className="text-muted-foreground">Books: </span>{books === null || books === undefined ? 'not used for this return type' : books.available === false ? `not available — ${books.why}` : `QuickBooks, ${books.lines} lines${books.pnl_as_of ? `, as of ${books.pnl_as_of.slice(0, 10)}` : ''}`}</div>
              <div><span className="text-muted-foreground">Stored returns: </span>{data.sources.returns.length ? data.sources.returns.map(r => sourceLabel(r.label)).join(', ') : 'none'}</div>
              <div><span className="text-muted-foreground">Documents: </span>{data.sources.documents && (data.sources.documents.count || data.sources.documents.k1s_from_group_returns.length) ? `${data.sources.documents.count} on file${data.sources.documents.types.length ? ` (${data.sources.documents.types.map(t => t.replace(/_/g, '-').toUpperCase()).join(', ')})` : ''}${data.sources.documents.k1s_from_group_returns.length ? `; K-1 from ${data.sources.documents.k1s_from_group_returns.map(n => maskTaxIdsInText(n)).join(', ')}` : ''}` : 'none on file'}</div>
              {!!data.sources.documents?.notes.length && <div className="sm:col-span-2 text-xs text-muted-foreground" data-testid="documents-notes">{data.sources.documents.notes.map(n => maskTaxIdsInText(n)).join(' · ')}</div>}
              {!!data.sources.scenarios.length && <div><span className="text-muted-foreground">Scenarios: </span>{data.sources.scenarios.map(s => maskTaxIdsInText(s.label)).join(', ')}</div>}
            </CardContent>
          </Card>

          {data.rows.length === 0 || !base ? (
            <p className="text-sm text-muted-foreground py-6 text-center" data-testid="sources-empty">Nothing is on file for {data.year} yet: no filed return, IRS transcript, books or stored return.</p>
          ) : (
            <>
              <Picker sources={sources} base={base} others={others} onChange={choose} />

              {!!others.length && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {others.map(s => {
                    const n = tally(s)
                    return (
                      <Card key={s.id}><CardContent className="pt-4" data-testid={`tile-${s.id}`}>
                        <div className="text-xs text-muted-foreground">{maskTaxIdsInText(s.name)} against the base</div>
                        <div className="text-xl font-semibold">{n.differ} differ</div>
                        <div className="text-xs text-muted-foreground">{n.match} match{n.extra ? ` · ${n.extra} not in base` : ''}</div>
                      </CardContent></Card>
                    )
                  })}
                </div>
              )}

              <div className="flex flex-wrap gap-2" role="group" aria-label="Rows to show">
                <Button size="sm" variant={filter === 'key' ? 'default' : 'outline'} onClick={() => setFilter('key')}>Key lines ({counts.key})</Button>
                <Button size="sm" variant={filter === 'diff' ? 'default' : 'outline'} onClick={() => setFilter('diff')}>Differences ({counts.diff})</Button>
                <Button size="sm" variant={filter === 'all' ? 'default' : 'outline'} onClick={() => setFilter('all')}>All lines ({counts.all})</Button>
              </div>

              {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center" data-testid="sources-no-diff">
                  {filter === 'diff' ? `Every chosen source matches the base for ${data.year}.` : `None of the chosen sources has a figure on these lines for ${data.year}.`}
                </p>
              ) : (
                <Card>
                  <CardContent className="px-0 pt-0">
                    <div className="overflow-x-auto">
                      <table className={`w-full text-sm ${others.length > 3 ? 'min-w-[800px]' : 'min-w-[560px]'}`} data-testid="sources-table">
                        <thead className="text-xs text-muted-foreground">
                          <tr className="border-b">
                            <th className="px-3 py-2 text-left font-medium">Line</th>
                            <th className="px-3 py-2 text-right font-medium bg-muted/30" data-testid="base-column">{maskTaxIdsInText(base.name)} <span className="font-normal">(base)</span></th>
                            {others.map(s => <th key={s.id} className="px-3 py-2 text-right font-medium">{maskTaxIdsInText(s.name)}</th>)}
                            {!!others.length && <th className="px-3 py-2 text-left font-medium">Against base</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map(({ r, vs }) => {
                            const id = `${r.form}|${r.key}|${r.instance ?? ''}`
                            const isOpen = open === id
                            const v = vs.state === 'none' ? undefined : VERSUS[vs.state]
                            return (
                              <Fragment key={id}>
                                <tr className="border-b last:border-0 hover:bg-muted/30 cursor-pointer" onClick={() => setOpen(isOpen ? null : id)} data-testid="source-row" data-key={r.key}>
                                  <td className="px-3 py-2 align-top">
                                    <div className="flex items-start gap-1.5">
                                      <ChevronRight className={`h-4 w-4 mt-0.5 shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                                      <div>
                                        <div className={r.headline ? 'font-medium' : ''}>{maskTaxIdsInText(shortLabel(r.label))}</div>
                                        <div className="text-xs text-muted-foreground" data-testid="line-ref">{lineRef(r)}</div>
                                      </div>
                                    </div>
                                  </td>
                                  <ValueCell r={r} s={base} />
                                  {others.map(s => <ValueCell key={s.id} r={r} s={s} base={base} />)}
                                  {!!others.length && (
                                    <td className="px-3 py-2 align-top">
                                      {v && <Badge variant="outline" className={`text-xs ${v.style}`}>{v.label}{vs.state === 'differs' && others.length > 1 ? `: ${vs.differ.map(s => maskTaxIdsInText(s.name)).join(', ')}` : ''}</Badge>}
                                    </td>
                                  )}
                                </tr>
                                {isOpen && (
                                  <tr className="border-b bg-muted/20">
                                    <td colSpan={3 + others.length} className="px-9 py-3"><Provenance r={r} sources={sources} /></td>
                                  </tr>
                                )}
                              </Fragment>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                    <p className="px-3 pt-2 text-xs text-muted-foreground sm:hidden">Scroll sideways to see every source.</p>
                    <p className="px-3 pt-1 text-xs text-muted-foreground" data-testid="sources-legend">
                      Amber: differs from the base by more than $1; the line under it is the difference. Σ: a books total, the sum of the lines mapped from the books.
                      ¹: the IRS's own calculation, where the transcript does not carry the figure as filed. A blank is not counted as a difference — the IRS transcript, the documents and imported returns each carry only some lines.
                    </p>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
