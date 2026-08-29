/**
 * The focused filed-vs-amended view — one layout for both entry points
 * (?amendment_id=<id> and ?year=YYYY), which used to be two near-identical
 * 65-line render branches in Compare.tsx.
 */
import { ArrowLeft, BarChart3, GitBranch } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { TaxReturn } from '@taxengine/shared'
import LineByLineMatrix from './LineByLineMatrix'

interface Props {
  entityId?: string
  title: string
  subtitle?: string
  emptyMessage: string
  filedRow?: TaxReturn
  amendRow?: TaxReturn
  year: number
}

export default function FocusedCompare({ entityId, title, subtitle, emptyMessage, filedRow, amendRow, year }: Props) {
  const nav = useNavigate()
  const canCompare = Boolean(filedRow && amendRow)
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => nav(-1)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <GitBranch className="h-4 w-4 text-amber-400" />
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight truncate">{title}</h1>
          </div>
          {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => nav(`/app/compare/${entityId}`)}
          className="gap-1"
          title="See all years side-by-side"
        >
          <BarChart3 className="h-4 w-4" />
          All years
        </Button>
      </div>

      {!canCompare ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {emptyMessage}
          </CardContent>
        </Card>
      ) : (
        <LineByLineMatrix filedId={filedRow!.id} amendId={amendRow!.id} year={year} />
      )}
    </div>
  )
}
