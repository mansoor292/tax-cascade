/**
 * The practice workspace's frame: loads the practice, offers to create one
 * when this login has none, and gives every practice page the design-system
 * scope (.ds) and the practice itself (useOutletContext).
 */
import { useState } from 'react'
import { Outlet, useOutletContext } from 'react-router-dom'
import { usePractice, practiceApi, type Practice, type Designee } from '@/hooks/use-practice'
import LoadError from '@/components/LoadError'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ds'

export interface PracticeCtx { practice: Practice; designee: Designee | null; admin: boolean; reload: () => void }
export const usePracticeCtx = () => useOutletContext<PracticeCtx>()

export default function PracticeLayout() {
  const { practice, designee, admin, none, loading, error, reload } = usePractice()
  if (loading) return <div className="ds text-muted-foreground">Loading the practice…</div>
  if (error) return <LoadError message={error} onRetry={reload} />
  if (none || !practice) return <div className="ds"><CreatePractice onCreated={reload} /></div>
  return <div className="ds"><Outlet context={{ practice, designee, admin, reload } satisfies PracticeCtx} /></div>
}

function CreatePractice({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <div className="max-w-xl">
      <PageHeader crumb="Practice" title="Set up your practice" />
      <div className="ds-card p-4 flex flex-col gap-3">
        <p className="text-muted-foreground">A practice holds your clients. Each client gets its own entity, its IRS records are read through TaxNow once its Form 8821 is on file, and you see every client&apos;s status, deadlines and opportunities in one place.</p>
        <div className="ds-field">
          <label htmlFor="practice-name">Practice name</label>
          <input id="practice-name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Your firm's name" />
        </div>
        {err && <p className="text-sm text-bad">{err}</p>}
        <div>
          <Button disabled={!name.trim() || busy} onClick={async () => {
            setBusy(true); setErr(null)
            try { await practiceApi.create(name.trim()); onCreated() } catch (e) { setErr(e instanceof Error ? e.message : 'Could not create the practice') }
            setBusy(false)
          }}>Create practice</Button>
        </div>
      </div>
    </div>
  )
}
