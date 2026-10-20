/**
 * One return year, every source side by side on the golden schema
 * (GET /api/golden): the filed return, the IRS's record of it (as filed and
 * as the IRS recomputed it), the books (QuickBooks classified to return
 * lines, before any tax computation), the source documents (W-2s, 1099s,
 * and for a 1040 the K-1s the group's S corporations issued), the returns
 * stored here and the scenarios. Differences first; a row opens to where each figure came from.
 *
 * Why it exists (2026-10-20): the owner asked for one schema everything maps
 * to for apples-to-apples comparison. The Year-over-year tab compares stored
 * returns only; this is the comparison across sources. Text from the
 * documents (descriptions, QuickBooks account names, provenance) goes through
 * maskTaxIdsInText — it can quote a return header.
 */
import { Fragment, useMemo, useState } from 'react'
import { AlertTriangle, ChevronRight, Loader2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import LoadError from '@/components/LoadError'
import { fmtMoney } from '@/lib/format'
import { GOLDEN_STATUS_LABEL } from '@/lib/labels'
import { maskTaxIdsInText } from '@/lib/mask'
import { useGolden, type Cell, type GoldenRow, type GoldenValue } from '@/hooks/use-golden'
import { hasDifference, lineRef, offGolden, shortLabel, sourceLabel } from './sources'

const STATUS_STYLE: Record<string, string> = {
  agrees: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  differs: 'bg-red-500/15 text-red-400 border-red-500/30',
  irs_only: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  irs_recomputed: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
  filed_only: 'bg-muted text-muted-foreground',
  returns_only: 'bg-muted text-muted-foreground',
}

function show(v: GoldenValue | undefined): string {
  if (v === undefined || v === null || v === '') return '—'
  if (typeof v === 'number') return fmtMoney(v, '—')
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return maskTaxIdsInText(String(v))
}

type Filter = 'diff' | 'headline' | 'all'

function ValueCell({ v, golden, title, mark }: { v: GoldenValue | undefined; golden: GoldenValue | undefined; title?: string; mark?: string }) {
  return (
    <td className={`px-3 py-2 text-right font-mono text-sm whitespace-nowrap ${offGolden(v, golden) ? 'text-amber-400' : ''}`} title={title}>
      {show(v)}{v !== undefined && mark ? ` ${mark}` : ''}
    </td>
  )
}

function Provenance({ r, returns, scenarios }: { r: GoldenRow; returns: string[]; scenarios: string[] }) {
  const items: Array<[string, Cell | undefined]> = [
    ['Filed return', r.filed], ['IRS, as filed', r.irs], ['IRS, recomputed', r.irs_computed], ['Books', r.books], ['Documents', r.documents],
    ...returns.map(l => [sourceLabel(l), r.returns?.[l]] as [string, Cell | undefined]),
    ...scenarios.map(l => [`Scenario: ${l}`, r.scenarios?.[l]] as [string, Cell | undefined]),
  ]
  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted-foreground">{maskTaxIdsInText(r.label)}</p>
      <ul className="space-y-1 text-xs text-muted-foreground">
        {items.filter(([, c]) => c).map(([name, c]) => (
          <li key={name}><span className="text-foreground">{name}:</span> {show(c!.value)} — {maskTaxIdsInText(c!.where)}</li>
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
      {r.golden_from && <p className="text-xs text-muted-foreground">Golden value from {r.golden_from === 'irs' ? 'the IRS record' : r.golden_from === 'filed' ? 'the filed return' : 'a stored return'}.</p>}
    </div>
  )
}

export default function SourcesView({ entityId, years, year, onYear }: { entityId: string; years: number[]; year: number | null; onYear: (y: number) => void }) {
  const { data, loading, error, reload } = useGolden(entityId, year)
  const [filter, setFilter] = useState<Filter>('diff')
  const [open, setOpen] = useState<string | null>(null)
  const returns = data?.sources.returns.map(r => r.label) ?? []
  const scenarios = data?.sources.scenarios.map(s => s.label) ?? []
  const rows = useMemo(() => (data?.rows ?? []).filter(r => filter === 'all' || (filter === 'headline' ? r.headline : hasDifference(r))), [data, filter])
  const diffCount = (data?.rows ?? []).filter(hasDifference).length
  const books = data?.sources.books
  const t = data?.sources.irs_return_transcript

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
              <div><span className="text-muted-foreground">Stored returns: </span>{returns.length ? returns.map(sourceLabel).join(', ') : 'none'}</div>
              <div><span className="text-muted-foreground">Documents: </span>{data.sources.documents && (data.sources.documents.count || data.sources.documents.k1s_from_group_returns.length) ? `${data.sources.documents.count} on file${data.sources.documents.types.length ? ` (${data.sources.documents.types.map(t => t.replace(/_/g, '-').toUpperCase()).join(', ')})` : ''}${data.sources.documents.k1s_from_group_returns.length ? `; K-1 from ${data.sources.documents.k1s_from_group_returns.map(n => maskTaxIdsInText(n)).join(', ')}` : ''}` : 'none on file'}</div>
              {!!data.sources.documents?.notes.length && <div className="sm:col-span-2 text-xs text-muted-foreground" data-testid="documents-notes">{data.sources.documents.notes.map(n => maskTaxIdsInText(n)).join(' · ')}</div>}
              {!!scenarios.length && <div><span className="text-muted-foreground">Scenarios: </span>{scenarios.join(', ')}</div>}
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['Lines', data.summary.keys],
              ['Agree with the IRS', data.summary.agrees],
              ['Differ (headline)', `${data.summary.differs} (${data.summary.headline_differs})`],
              ['Books / documents don’t support', `${data.summary.books_differ_from_golden} / ${data.summary.documents_differ_from_golden ?? 0}`],
            ].map(([k, v]) => (
              <Card key={String(k)}><CardContent className="pt-4"><div className="text-xs text-muted-foreground">{k}</div><div className="text-xl font-semibold" data-testid={`tile-${k}`}>{v}</div></CardContent></Card>
            ))}
          </div>

          <div className="flex flex-wrap gap-2" role="group" aria-label="Rows to show">
            <Button size="sm" variant={filter === 'diff' ? 'default' : 'outline'} onClick={() => setFilter('diff')}>Differences ({diffCount})</Button>
            <Button size="sm" variant={filter === 'headline' ? 'default' : 'outline'} onClick={() => setFilter('headline')}>Headline</Button>
            <Button size="sm" variant={filter === 'all' ? 'default' : 'outline'} onClick={() => setFilter('all')}>All lines ({data.rows.length})</Button>
          </div>

          {data.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center" data-testid="sources-empty">Nothing is on file for {data.year} yet: no filed return, IRS transcript, books or stored return.</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center" data-testid="sources-no-diff">Every source agrees for {data.year}.</p>
          ) : (
            <Card>
              <CardContent className="px-0 pt-0">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[800px] text-sm" data-testid="sources-table">
                    <thead className="text-xs text-muted-foreground">
                      <tr className="border-b">
                        <th className="px-3 py-2 text-left font-medium">Line</th>
                        <th className="px-3 py-2 text-right font-medium">Filed</th>
                        <th className="px-3 py-2 text-right font-medium">IRS</th>
                        <th className="px-3 py-2 text-right font-medium">IRS recomputed</th>
                        <th className="px-3 py-2 text-right font-medium">Books</th>
                        <th className="px-3 py-2 text-right font-medium">Documents</th>
                        {returns.map(l => <th key={l} className="px-3 py-2 text-right font-medium" title={l}>{sourceLabel(l)}</th>)}
                        {scenarios.map(l => <th key={l} className="px-3 py-2 text-right font-medium">Scenario: {l}</th>)}
                        <th className="px-3 py-2 text-right font-medium">Golden</th>
                        <th className="px-3 py-2 text-left font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(r => {
                        const id = `${r.form}|${r.key}|${r.instance ?? ''}`
                        const isOpen = open === id
                        return (
                          <Fragment key={id}>
                            <tr className="border-b last:border-0 hover:bg-muted/30 cursor-pointer" onClick={() => setOpen(isOpen ? null : id)} data-testid="source-row" data-key={r.key}>
                              <td className="px-3 py-2">
                                <div className="flex items-start gap-1.5">
                                  <ChevronRight className={`h-4 w-4 mt-0.5 shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                                  <div>
                                    <div className={r.headline ? 'font-medium' : ''}>{maskTaxIdsInText(shortLabel(r.label))}</div>
                                    <div className="text-xs text-muted-foreground">{lineRef(r)}</div>
                                  </div>
                                </div>
                              </td>
                              <ValueCell v={r.filed?.value} golden={r.golden} />
                              <ValueCell v={r.irs?.value} golden={r.golden} />
                              <ValueCell v={r.irs_computed?.value} golden={r.golden} />
                              <ValueCell v={r.books?.value} golden={r.golden} title={r.books?.summed ? 'Sum of the lines mapped from the books' : undefined} mark={r.books?.summed ? 'Σ' : undefined} />
                              <ValueCell v={r.documents?.value} golden={r.golden} title={r.documents?.sources?.join('; ')} />
                              {returns.map(l => <ValueCell key={l} v={r.returns?.[l]?.value} golden={r.golden} />)}
                              {scenarios.map(l => <td key={l} className="px-3 py-2 text-right font-mono text-sm whitespace-nowrap">{show(r.scenarios?.[l]?.value)}</td>)}
                              <td className="px-3 py-2 text-right font-mono text-sm font-semibold whitespace-nowrap">{show(r.golden)}</td>
                              <td className="px-3 py-2"><Badge variant="outline" className={`text-xs ${STATUS_STYLE[r.status] ?? ''}`}>{GOLDEN_STATUS_LABEL[r.status] ?? r.status}</Badge></td>
                            </tr>
                            {isOpen && (
                              <tr className="border-b bg-muted/20">
                                <td colSpan={8 + returns.length + scenarios.length} className="px-9 py-3"><Provenance r={r} returns={returns} scenarios={scenarios} /></td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="px-3 pt-2 text-xs text-muted-foreground sm:hidden">Scroll sideways to see every source.</p>
                <p className="px-3 pt-1 text-xs text-muted-foreground">Amber: differs from the golden value. A books total marked Σ is the sum of the lines mapped from the books, not a computed return.</p>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
