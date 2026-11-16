/**
 * The daily re-read must reach every client, past PostgREST's 1,000-row page.
 * Why (2026-11-16): connecting the HRLogics org added 1,266 clients; the
 * daily fan-out selected all practices' clients in one unpaged query, so
 * everything past row 1,000 would have silently gone unread every morning.
 */
import { describe, expect, it } from 'vitest'
import { runJob } from './practice_jobs.js'

function fakeDb(nClients: number) {
  const clients = Array.from({ length: nClients }, (_, i) => ({ id: `c${String(i).padStart(5, '0')}`, practice_id: 'p', user_id: 'u', stage: 'claimed' }))
  const inserted: any[] = []
  const select = () => {
    let from = 0, to = 999 // PostgREST's default page
    const q: any = {
      in: () => q, eq: () => q, order: () => q,
      range: (a: number, b: number) => { from = a; to = Math.min(b, a + 999); return q },
      then: (res: any, rej: any) => Promise.resolve({ data: clients.slice(from, to + 1), error: null }).then(res, rej),
    }
    return q
  }
  const sb: any = {
    from: (t: string) => t === 'taxnow_job'
      ? { insert: (row: any) => { inserted.push(row); return { select: () => ({ maybeSingle: async () => ({ data: { id: 'j' + inserted.length }, error: null }) }) } } }
      : { select },
  }
  return { sb, inserted }
}

describe('daily fan-out', () => {
  it('queues a read for every client, not only the first 1,000', async () => {
    const { sb, inserted } = fakeDb(2500)
    const r: any = await runJob(sb, { id: 'd', kind: 'daily', payload: {}, practice_id: null, user_id: null, confirmed_by: null })
    expect(r.queued).toBe(2500)
    expect(new Set(inserted.map(x => x.payload.client_id)).size).toBe(2500)
  })
})
