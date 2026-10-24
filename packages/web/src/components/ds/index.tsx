/**
 * Design-system components (styles/ds.css). Small on purpose: tiles, pills,
 * tabs, the page header and the IRS-request confirmation every IRS pull must
 * go through. Pages compose these with plain markup.
 */
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export function PageHeader({ crumb, title, actions }: { crumb?: string; title: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-3 mb-4">
      <div className="flex-1 min-w-[240px]">
        {crumb && <div className="text-xs text-muted-foreground">{crumb}</div>}
        <h1>{title}</h1>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

export function Tile({ label, value, sub, to, onClick }: { label: string; value: ReactNode; sub?: string; to?: string; onClick?: () => void }) {
  const body = (<><span className="label">{label}</span><span className="value num">{value}</span>{sub && <span className="sub">{sub}</span>}</>)
  if (to) return <Link to={to} className="ds-tile">{body}</Link>
  if (onClick) return <button type="button" onClick={onClick} className="ds-tile cursor-pointer">{body}</button>
  return <div className="ds-tile">{body}</div>
}

export function Pill({ tone = 'mute', children }: { tone?: 'good' | 'warn' | 'bad' | 'info' | 'mute'; children: ReactNode }) {
  return <span className={`ds-pill ${tone}`}>{children}</span>
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: Array<{ value: T; label: ReactNode }> }) {
  return (
    <div className="ds-tabs" role="tablist">
      {tabs.map(t => (
        <button key={t.value} type="button" role="tab" aria-selected={value === t.value} className="ds-tab" onClick={() => onChange(t.value)}>{t.label}</button>
      ))}
    </div>
  )
}

/**
 * The one way to send IRS requests. Each is a real pull under the designee's
 * CAF with its own tracking number, so the person ticks that they understand
 * before the button works.
 */
export function IrsRequestDialog({ open, onOpenChange, count, scope, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; count: number; scope: ReactNode; onConfirm: () => Promise<void>
}) {
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) setAck(false); onOpenChange(o) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request transcripts from the IRS?</DialogTitle>
          <DialogDescription>
            TaxNow will ask the IRS for <strong>{count} transcript{count === 1 ? '' : 's'}</strong> under your designee&apos;s CAF number. Each one is a real IRS request with its own tracking number. Periods the 8821 does not cover come back refused (451).
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">{scope}</div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />
          I understand these are real IRS requests
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!ack || busy} onClick={async () => { setBusy(true); try { await onConfirm(); onOpenChange(false) } finally { setBusy(false); setAck(false) } }}>Send requests</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
