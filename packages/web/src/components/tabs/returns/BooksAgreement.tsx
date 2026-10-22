/**
 * Does this amendment agree with the books? Shown beside it, never merged
 * into it (Mansoor, 2026-10-22): an amendment starts from the filed return;
 * a clean-up must end in agreement with the books, a scenario need not. The
 * lines are read from the golden view, where the books are mapped to the
 * same IRS lines as the return.
 */
import { useGolden } from '@/hooks/use-golden'
import { fmtMoney } from '@/lib/format'
import { booksAgreement } from './helpers'

export default function BooksAgreement({ entityId, year, returnId }: { entityId: string; year: number; returnId: string }) {
  const { data, loading, error } = useGolden(entityId, year)
  if (loading) return <p className="text-xs text-muted-foreground">Checking against the books…</p>
  if (error) return <p className="text-xs text-red-400">Couldn't check against the books: {error}</p>
  if (!data) return null
  const a = booksAgreement(data, returnId)
  if (!a.available) return <p className="text-xs text-muted-foreground" data-testid="books-agreement">Books: nothing to check against ({a.why}).</p>
  if (!a.differ.length) {
    return <p className="text-xs text-emerald-400" data-testid="books-agreement">Agrees with the books on all {a.compared} lines they carry.</p>
  }
  return (
    <div className="text-xs space-y-1" data-testid="books-agreement">
      <p className="text-amber-400">
        {a.differ.length} of {a.compared} lines differ from the books. A clean-up must agree with them — correct the books or the amendment.
      </p>
      <ul className="text-muted-foreground space-y-0.5">
        {a.differ.slice(0, 6).map(r => {
          const label = data.sources.returns.find(x => x.id === returnId)!.label
          return (
            <li key={`${r.form}|${r.key}`}>
              {r.label.split('.')[0].slice(0, 70)} ({r.section ? `${r.section} ` : ''}line {r.line}): amendment {fmtMoney(r.returns?.[label]?.value)}, books {fmtMoney(r.books?.value)}
            </li>
          )
        })}
        {a.differ.length > 6 && <li>…and {a.differ.length - 6} more (Compare vs filed shows them all)</li>}
      </ul>
    </div>
  )
}
