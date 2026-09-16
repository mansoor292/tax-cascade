/**
 * No two canonical keys may point at the same PDF field.
 *
 * When they do, whichever the model iterates last decides what prints. That is
 * how Schedule K line 18 came to show 0 on a return whose computed
 * reconciliation was $1,302,595, and how lines 11 and 12a were sitting on the
 * same fault waiting for a non-zero value to expose it. The 2024 maps never
 * had a collision; the 2025 maps picked up three.
 *
 * Where two spellings genuinely exist for one line, exactly one is mapped and
 * the other reaches the box through SCHED_K_TWINS in build_return_pdf, which
 * is order-independent in both directions.
 */
import { describe, it, expect } from 'vitest'
import * as maps2024 from './pdf_field_map_2024.js'
import * as maps2025 from './pdf_field_map_2025.js'

describe('PDF field maps', () => {
  const tables: Array<[string, Record<string, string>]> = []
  for (const mod of [maps2024, maps2025]) {
    for (const [name, table] of Object.entries(mod)) {
      if (table && typeof table === 'object' && !Array.isArray(table)) {
        tables.push([name, table as Record<string, string>])
      }
    }
  }

  it('has tables to check', () => expect(tables.length).toBeGreaterThan(4))

  it.each(tables)('%s maps each field id exactly once', (name, table) => {
    const byField = new Map<string, string[]>()
    for (const [key, field] of Object.entries(table)) {
      if (typeof field !== 'string') continue
      byField.set(field, [...(byField.get(field) || []), key])
    }
    const collisions = [...byField.entries()]
      .filter(([, keys]) => keys.length > 1)
      .map(([field, keys]) => `${field} <- ${keys.join(', ')}`)
    expect(collisions, `${name}: two canonical keys share a field, so print order decides which wins:\n${collisions.join('\n')}`)
      .toHaveLength(0)
  })
})
