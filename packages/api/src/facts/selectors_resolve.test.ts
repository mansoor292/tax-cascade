/**
 * Every catalog line the fact registry points at must exist on the IRS form
 * it names. The registry was first written from memory, and 22 selectors
 * pointed at boxes that don't exist (Form 7203 "line 5" for distributions is
 * line 6; K-1 box 16 needs code D). Resolved against the line dictionaries
 * built from the IRS's own blanks, so a wrong line fails here, not months
 * later as a silently missed contradiction.
 */
import { describe, it, expect } from 'vitest'
import { FACT_DEFS } from '@taxengine/shared'
import { loadIndex, loadDictPages } from '../catalog/dicts.js'

describe('fact registry selectors resolve on the IRS forms', () => {
  it('every selector names a real box on the latest revision of its form', () => {
    const index = loadIndex()
    const missing: string[] = []
    for (const def of FACT_DEFS) {
      for (const s of def.catalog ?? []) {
        const revs = index.filter(e => e.form === s.form).sort((a, b) => Number(b.rev) - Number(a.rev))
        if (!revs.length) { missing.push(`${def.key}: no dictionary for ${s.form}`); continue }
        const widgets = loadDictPages(revs[0].file).flatMap(p => p.widgets)
        const hit = widgets.some(w => w.line === s.line &&
          (s.section === undefined || w.section === s.section) &&
          (s.col === undefined || w.col === s.col) &&
          (s.row === undefined || w.row === s.row))
        if (!hit) missing.push(`${def.key}: ${s.form}--${revs[0].rev} ${s.section ?? ''} line ${s.line}${s.col ? ' col ' + s.col : ''}${s.row ? ' row ' + s.row : ''}`)
      }
    }
    expect(missing).toEqual([])
  }, 60_000)
})
