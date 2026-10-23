/**
 * Return notes (services/notes.ts): validation, the version-on-edit write
 * path, and the listing order that review_summary relies on.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { checkComplete, checkNoteFields, listNotes, updateNote } from './notes.js'

beforeAll(() => {
  // Plaintext path: encryptedFields/hydrate are no-ops without a KMS key, so
  // the calls below are exactly the database traffic.
  delete process.env.TAX_API_KMS_KEY
})

/** Minimal stand-in for the supabase-js builder: records every call, answers from fixtures. */
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

const open = {
  id: 'v1', note_key: 'k1', user_id: 'u1', entity_id: 'e1', tax_year: null, status: 'open', waiting_on: 'owner',
  title: 'Refund 2,450.00 reissued — confirm deposited', body: 'Reissued 3/2/2026; not in the books.',
  fact_key: null, finding_fingerprint: null, due_date: null, recorded_by: 'u1', recorded_at: '2026-10-18T10:00:00Z', superseded_by: null,
}

describe('note validation', () => {
  it('refuses unknown fields, bad enums, unknown facts and bad dates', () => {
    expect(checkNoteFields({ titel: 'x' })).toMatchObject({ ok: false, field: 'titel' })
    expect(checkNoteFields({ status: 'pending' })).toMatchObject({ ok: false, field: 'status' })
    expect(checkNoteFields({ waiting_on: 'cpa' })).toMatchObject({ ok: false, field: 'waiting_on' })
    expect(checkNoteFields({ fact_key: 'irs.no_such_fact' })).toMatchObject({ ok: false, field: 'fact_key' })
    expect(checkNoteFields({ due_date: '2026-13-40' })).toMatchObject({ ok: false, field: 'due_date' })
    expect(checkNoteFields({ tax_year: 26 })).toMatchObject({ ok: false, field: 'tax_year' })
  })

  it('accepts registry facts, entity-wide notes and finding fingerprints', () => {
    const r = checkNoteFields({ tax_year: null, fact_key: 'irs.refund_received', finding_fingerprint: 'irs.account_status|2023|credit', due_date: '2026-12-11', title: '  Refund stuck  ' })
    expect(r).toMatchObject({ ok: true, fields: { tax_year: null, fact_key: 'irs.refund_received', title: 'Refund stuck' } })
  })

  it('an open note must say who it waits on; context and closed notes need not', () => {
    expect(checkComplete({ title: 'Call the PPS' })).toMatchObject({ ok: false, field: 'waiting_on' })
    expect(checkComplete({ title: 'Call the PPS', waiting_on: 'owner' })).toMatchObject({ ok: true, note: { status: 'open', tax_year: null } })
    expect(checkComplete({ title: 'The 2021 entries are paper 1120-S filings', status: 'info' }).ok).toBe(true)
    expect(checkComplete({ waiting_on: 'owner' })).toMatchObject({ ok: false, field: 'title' })
  })
})

describe('editing a note writes a new version', () => {
  it('reads the current version, inserts the merged one under the same note_key, then supersedes the old', async () => {
    const { client, log } = fakeSupabase([open])
    const out = await updateNote(client, 'u1', 'e1', 'k1', { status: 'closed', body: 'Deposited 5/12/2026 per the bank statement.' }, 'u1')
    expect(out && 'note' in out && out.note).toMatchObject({ id: 'v2', note_key: 'k1', status: 'closed', title: open.title, waiting_on: 'owner' })
    expect(log.map(l => l.op)).toEqual(['select', 'insert', 'update'])
    expect(log[0].filters).toContainEqual(['eq', 'note_key', 'k1'])
    expect(log[0].filters).toContainEqual(['is', 'superseded_by', null])
    expect(log[1].payload).toMatchObject({ note_key: 'k1', user_id: 'u1', entity_id: 'e1', status: 'closed' })
    expect(log[2].payload).toEqual({ superseded_by: 'v2' })
    expect(log[2].filters).toContainEqual(['eq', 'id', 'v1'])
    for (const l of [log[0], log[2]]) expect(l.filters).toContainEqual(['eq', 'user_id', 'u1'])
    expect((out as any).note).not.toHaveProperty('user_id')
  })

  it('reopening without saying who it waits on is refused, and nothing is written', async () => {
    const { client, log } = fakeSupabase([{ ...open, status: 'info', waiting_on: null }])
    expect(await updateNote(client, 'u1', 'e1', 'k1', { status: 'open' }, 'u1')).toMatchObject({ field: 'waiting_on' })
    expect(log.map(l => l.op)).toEqual(['select'])
  })

  it('a note that does not exist is null', async () => {
    const { client } = fakeSupabase([])
    expect(await updateNote(client, 'u1', 'e1', 'missing', { status: 'closed' }, 'u1')).toBeNull()
  })
})

describe('listing', () => {
  it('a year keeps its own notes and the entity-wide ones; open first, then by due date', async () => {
    const rows = [
      { ...open, id: 'a', tax_year: 2024, status: 'info', waiting_on: null, recorded_at: '2026-10-18T09:00:00Z' },
      { ...open, id: 'b', tax_year: 2023 },
      { ...open, id: 'c', tax_year: null, due_date: '2026-12-11' },
      { ...open, id: 'd', tax_year: 2024, due_date: '2026-11-01' },
      { ...open, id: 'e', tax_year: 2024, status: 'closed' },
    ]
    const { client } = fakeSupabase(rows)
    expect((await listNotes(client, 'u1', ['e1'], { years: [2024] })).map(n => n.id)).toEqual(['d', 'c', 'a', 'e'])
  })
})
