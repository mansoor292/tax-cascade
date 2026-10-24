/**
 * Practice → Settings: the practice's name and the designee its 8821s name —
 * Catipult's CAF (for practitioners without one) or the practice's own,
 * editable here (Mansoor, 2026-10-24).
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { practiceApi, type Designee } from '@/hooks/use-practice'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ds'
import { usePracticeCtx } from './PracticeLayout'

const FIELDS: Array<[keyof Designee, string]> = [['name', 'Designee name'], ['caf', 'CAF number'], ['ptin', 'PTIN (optional)'], ['address', 'Street address'], ['city', 'City'], ['state', 'State'], ['zip', 'ZIP'], ['phone', 'Phone'], ['fax', 'Fax (optional)']]

export default function PracticeSettings() {
  const { practice, designee, reload } = usePracticeCtx()
  const [name, setName] = useState(practice.name)
  const [mode, setMode] = useState(practice.designee_mode)
  const [d, setD] = useState<Designee>(practice.designee ?? {})
  const [busy, setBusy] = useState(false)
  return (
    <>
      <PageHeader crumb={practice.name} title="Practice settings" />
      <div className="ds-card p-4 flex flex-col gap-4 max-w-3xl">
        <div className="ds-field max-w-md"><label htmlFor="ps-name">Practice name</label><input id="ps-name" value={name} onChange={e => setName(e.target.value)} /></div>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-medium text-muted-foreground mb-1">Designee on your clients&apos; Form 8821</legend>
          <label className="flex items-center gap-2"><input type="radio" name="mode" checked={mode === 'platform'} onChange={() => setMode('platform')} /> Catipult&apos;s designee{mode === 'platform' && designee?.name ? ` (${designee.name}${designee.caf ? `, CAF ${designee.caf}` : ''})` : ''}: for practitioners without a CAF number</label>
          <label className="flex items-center gap-2"><input type="radio" name="mode" checked={mode === 'own'} onChange={() => setMode('own')} /> Our own designee</label>
        </fieldset>
        {mode === 'own' && (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            {FIELDS.map(([k, label]) => (
              <div key={k} className="ds-field"><label htmlFor={`d-${k}`}>{label}</label><input id={`d-${k}`} value={d[k] ?? ''} onChange={e => setD({ ...d, [k]: e.target.value })} /></div>
            ))}
          </div>
        )}
        <div><Button disabled={busy} onClick={async () => {
          setBusy(true)
          try { await practiceApi.update({ name, designee_mode: mode, designee: d }); toast.success('Saved.'); reload() } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not save') }
          setBusy(false)
        }}>Save</Button></div>
      </div>
    </>
  )
}
