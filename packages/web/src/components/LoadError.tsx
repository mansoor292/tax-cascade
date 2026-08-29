/**
 * Inline load-failure state with a retry.
 *
 * The resource hooks used to swallow load errors into empty arrays, so a
 * network failure rendered as "no documents yet" / "QuickBooks not
 * connected" — a page that loads and quietly shows nothing (the exact
 * symptom the e2e suite hunts). Hooks now surface `error` and already
 * return `reload`; render this instead of the empty state when error is
 * set.
 */
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

export default function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Card className="border-red-500/30">
      <CardContent className="py-8 text-center">
        <AlertTriangle className="h-6 w-6 mx-auto mb-2 text-red-400" />
        <p className="text-sm text-muted-foreground mb-3">{message}</p>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry} className="gap-1">
            <RotateCcw className="h-3.5 w-3.5" />
            Retry
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
