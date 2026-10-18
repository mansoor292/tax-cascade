/**
 * Entity-map links (services/entity_map.ts): validation, what each kind of
 * link must carry, and the version-on-edit write path.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { checkLinkComplete, checkLinkFields, updateLink } from './entity_map.js'

beforeAll(() => {
  // Plaintext path: encryptedFields/hydrate are no-ops without a KMS key.
  delete process.env.TAX_API_KMS_KEY
})

const IND = '00000000-0000-4000-8000-000000000001'
const SC = '00000000-0000-4000-8000-000000000002'
const CC = '00000000-0000-4000-8000-000000000003'
const ENTS = [{ id: IND, form_type: '1040' as const }, { id: SC, form_type: '1120S' as const }, { id: CC, form_type: '1120' as const }]

describe('link fields', () => {
  it('refuses unknown fields and bad values', () => {
    expect(checkLinkFields({ owner: 'x' })).toMatchObject({ ok: false, field: 'owner' })
    expect(checkLinkFields({ kind: 'parent' })).toMatchObject({ ok: false, field: 'kind' })
    expect(checkLinkFields({ from_entity_id: 'EV' })).toMatchObject({ ok: false, field: 'from_entity_id' })
    expect(checkLinkFields({ pct: 0 })).toMatchObject({ ok: false, field: 'pct' })
    expect(checkLinkFields({ pct: 101 })).toMatchObject({ ok: false, field: 'pct' })
    expect(checkLinkFields({ from_year: 25 })).toMatchObject({ ok: false, field: 'from_year' })
    expect(checkLinkFields({ nature: 'fee' })).toMatchObject({ ok: false, field: 'nature' })
    expect(checkLinkFields({ removed: 'yes' })).toMatchObject({ ok: false, field: 'removed' })
  })

  it('each kind carries what it needs, and nothing it does not', () => {
    const owns = { kind: 'owns' as const, from_entity_id: IND, to_entity_id: SC, subject: 'Patrick Example', pct: 100 }
    expect(checkLinkComplete(owns, ENTS)).toMatchObject({ ok: true, link: { source: 'owner', removed: false, to_name: null } })
    expect(checkLinkComplete({ ...owns, pct: null }, ENTS)).toMatchObject({ ok: false, field: 'pct' })
    expect(checkLinkComplete({ ...owns, from_entity_id: CC, subject: 'Patrick Example' }, ENTS)).toMatchObject({ ok: false, field: 'subject' })
    expect(checkLinkComplete({ ...owns, to_entity_id: IND, from_entity_id: SC, subject: null }, ENTS)).toMatchObject({ ok: false, field: 'to_entity_id' })
    expect(checkLinkComplete({ ...owns, to_name: 'Somewhere LLC' }, ENTS)).toMatchObject({ ok: false, field: 'to_entity_id' })
    expect(checkLinkComplete({ ...owns, to_entity_id: null }, ENTS)).toMatchObject({ ok: false, field: 'to_entity_id' })
    expect(checkLinkComplete({ ...owns, source: 'filed_return' }, ENTS)).toMatchObject({ ok: false, field: 'evidence' })
    expect(checkLinkComplete({ ...owns, from_year: 2025, to_year: 2024 }, ENTS)).toMatchObject({ ok: false, field: 'to_year' })

    const ic = { kind: 'intercompany' as const, from_entity_id: SC, to_entity_id: CC }
    expect(checkLinkComplete(ic, ENTS)).toMatchObject({ ok: false, field: 'nature' })
    expect(checkLinkComplete({ ...ic, nature: 'services' }, ENTS).ok).toBe(true)
    expect(checkLinkComplete({ ...ic, nature: 'loan', from_entity_id: IND }, ENTS)).toMatchObject({ ok: false, field: 'from_entity_id', error: expect.stringMatching(/^an intercompany link joins businesses/) })
    expect(checkLinkComplete({ ...ic, nature: 'loan', to_entity_id: SC }, ENTS)).toMatchObject({ ok: false, field: 'to_entity_id' })

    expect(checkLinkComplete({ kind: 'disregarded', from_entity_id: SC, to_name: 'Example Payroll LLC' }, ENTS).ok).toBe(true)
    expect(checkLinkComplete({ kind: 'disregarded', from_entity_id: SC, to_name: 'Example Payroll LLC', pct: 100 }, ENTS)).toMatchObject({ ok: false, field: 'pct' })
    expect(checkLinkComplete({ kind: 'owns', from_entity_id: '00000000-0000-4000-8000-00000000000f', to_entity_id: SC, pct: 1 }, ENTS)).toMatchObject({ ok: false, field: 'from_entity_id' })
  })
})

function fakeSupabase(rows: any[]) {
  const log: Array<{ op: string; filters: any[][]; payload?: any }> = []
  const client = {
    from(_table: string) {
      const state: { op: string; filters: any[][]; payload?: any } = { op: 'select', filters: [] }
      const b: any = {}
      for (const m of ['select', 'eq', 'is', 'in', 'order', 'single']) {
        b[m] = (...args: any[]) => {
          if (m === 'select' && state.op !== 'select') return b
          state.filters.push([m, ...args])
          return b
        }
      }
      b.insert = (row: any) => { state.op = 'insert'; state.payload = row; return b }
      b.update = (patch: any) => { state.op = 'update'; state.payload = patch; return b }
      b.then = (resolve: any, reject: any) => {
        log.push(state)
        const data = state.op === 'insert' ? { id: 'v2', recorded_at: '2026-10-18T12:00:00Z', superseded_by: null, ...state.payload }
          : state.op === 'update' ? null : rows
        return Promise.resolve({ data, error: null }).then(resolve, reject)
      }
      return b
    },
  }
  return { client: client as any, log }
}

const current = {
  id: 'v1', link_key: 'k1', user_id: 'u1', kind: 'owns', from_entity_id: IND, to_entity_id: CC, to_name: null, subject: 'Patrick Example',
  pct: '85.0000', nature: null, from_year: null, to_year: null, source: 'entity_record', evidence: 'Entity record owner list', detail: null,
  removed: false, recorded_by: 'u1', recorded_at: '2026-10-18T10:00:00Z', superseded_by: null,
}

describe('editing a link writes a new version', () => {
  it('reads the current version, inserts the merged one under the same link_key, then supersedes the old', async () => {
    const { client, log } = fakeSupabase([current])
    const out = await updateLink(client, 'u1', 'k1', { to_year: 2025 }, ENTS, 'u1')
    expect(out && 'link' in out && out.link).toMatchObject({ id: 'v2', link_key: 'k1', pct: 85, to_year: 2025, subject: 'Patrick Example' })
    expect(log.map(l => l.op)).toEqual(['select', 'insert', 'update'])
    expect(log[1].payload).toMatchObject({ link_key: 'k1', user_id: 'u1', to_year: 2025, source: 'entity_record' })
    expect(log[2].payload).toEqual({ superseded_by: 'v2' })
    for (const l of [log[0], log[2]]) expect(l.filters).toContainEqual(['eq', 'user_id', 'u1'])
  })

  it('a change that breaks the link is refused, and nothing is written', async () => {
    const { client, log } = fakeSupabase([current])
    expect(await updateLink(client, 'u1', 'k1', { pct: null }, ENTS, 'u1')).toMatchObject({ field: 'pct' })
    expect(log.map(l => l.op)).toEqual(['select'])
  })

  it('retiring a link keeps it with removed set; a missing link is null', async () => {
    const { client } = fakeSupabase([current])
    expect(await updateLink(client, 'u1', 'k1', { removed: true, detail: 'The owner list was wrong.' }, ENTS, 'u1')).toMatchObject({ link: { removed: true } })
    expect(await updateLink(fakeSupabase([]).client, 'u1', 'k1', { removed: true }, ENTS, 'u1')).toBeNull()
  })
})
