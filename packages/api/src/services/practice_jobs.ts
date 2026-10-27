/**
 * Background work for the practice workspace, in the database (taxnow_job).
 *
 * Why a table and not a timer: the API runs as N pm2 cluster workers with no
 * shared memory (CLAUDE.md fact 3). An in-process queue or a per-worker
 * setInterval schedule would run the daily check N times, or lose a job when
 * one worker restarts. Every worker polls; claim_taxnow_job() hands each job
 * to exactly one (FOR UPDATE SKIP LOCKED), and a job whose worker died is
 * picked up again once its lock lapses (at most 3 attempts).
 *
 * The daily run is one row per day (run_key 'daily:2026-10-25', unique), so
 * however many workers notice 6:00 am Eastern, it is queued once. It fans out
 * into one job per client: a TaxNow read for readable clients, an onboarding
 * check for submitted ones. Neither asks the IRS for anything.
 *
 * 'irs_request' is the only job that does: a real IRS pull per transcript
 * under the designee's CAF. The table refuses one without confirmed_by and
 * confirmed_at (a person pressed "Send requests" in a confirmation dialog).
 *
 * An imported book (services/practice_import.ts) runs as 'import_start' then
 * one 'import_batch' per few hundred clients; a re-run of the analysis as
 * 'analysis_batch' jobs. None of them reads TaxNow: imported clients have no
 * TaxNow account and their stage, 'imported', is never in the daily run.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { serviceClient } from '../lib/supabase.js'
import { taxnowFor } from '../taxnow/client.js'
import { readClient, recordIrsOutcome, type ClientRow } from './practice_read.js'
import { onboardingCheck } from './practice.js'
import { runAnalysisBatch, runImportBatch, runImportStart } from './practice_import.js'

export type JobKind = 'read_client' | 'onboarding_check' | 'irs_request' | 'daily' | 'import_start' | 'import_batch' | 'analysis_batch'
export interface TranscriptKey { type: 'ACTR' | 'RETR'; form: string; year: number; month: number }

export async function enqueue(sb: SupabaseClient, job: { kind: JobKind; user_id?: string | null; practice_id?: string | null; payload?: Record<string, unknown>; run_key?: string; confirmed_by?: string }) {
  const row: Record<string, unknown> = {
    kind: job.kind, user_id: job.user_id ?? null, practice_id: job.practice_id ?? null, payload: job.payload ?? {},
    run_key: job.run_key ?? null,
    ...(job.confirmed_by ? { confirmed_by: job.confirmed_by, confirmed_at: new Date().toISOString() } : {}),
  }
  const { data, error } = await sb.from('taxnow_job').insert(row).select('id').maybeSingle()
  if (error) {
    if (error.code === '23505') return null // run_key taken: another worker queued it
    throw new Error(error.message)
  }
  return data?.id as string | null
}

async function clientFor(sb: SupabaseClient, clientId: string): Promise<{ client: ClientRow; provider: 'taxnow' | 'fixture'; org: string } | null> {
  const { data: c } = await sb.from('practice_client').select('id, practice_id, user_id, entity_id, stage, taxnow_account_id, tin_last4').eq('id', clientId).maybeSingle()
  if (!c) return null
  const { data: p } = await sb.from('practice').select('provider, taxnow_org').eq('id', c.practice_id).single()
  return { client: c as ClientRow, provider: (p?.provider ?? 'taxnow') as 'taxnow' | 'fixture', org: p?.taxnow_org ?? 'platform' }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function runJob(sb: SupabaseClient, job: { id: string; kind: JobKind; payload: any; practice_id: string | null; user_id: string | null; confirmed_by: string | null }): Promise<unknown> {
  switch (job.kind) {
    case 'read_client': {
      const c = await clientFor(sb, job.payload.client_id)
      if (!c || !c.client.taxnow_account_id) return { skipped: true }
      return readClient(sb, c.client, c.provider, await taxnowFor(c.provider, c.org))
    }
    case 'onboarding_check': {
      const r = await onboardingCheck(sb, job.payload.client_id)
      if (r.found) await enqueue(sb, { kind: 'read_client', practice_id: job.practice_id, user_id: job.user_id, payload: { client_id: job.payload.client_id } })
      return r
    }
    case 'irs_request': {
      if (!job.confirmed_by) throw new Error('An IRS request must be confirmed by a person.')
      const c = await clientFor(sb, job.payload.client_id)
      if (!c || !c.client.taxnow_account_id) return { skipped: true }
      const tn = await taxnowFor(c.provider, c.org)
      const results: Array<{ form: string; year: number; month: number; status: string; code?: string | number }> = []
      for (const t of (job.payload.transcripts ?? []) as TranscriptKey[]) {
        let status = 'failed'
        let code: string | number | undefined
        try {
          const task = await tn.startSync(c.client.taxnow_account_id, t)
          for (let i = 0; i < 100; i++) {
            const s = await tn.getTask(c.client.taxnow_account_id, task)
            if (s.status === 'succeeded' || s.status === 'failed') { status = s.status; code = s.code; break }
            await sleep(3000)
          }
        } catch (e: any) { code = e?.status }
        await recordIrsOutcome(sb, c.client, t, String(code) === '451')
        results.push({ form: t.form, year: t.year, month: t.month, status, ...(code !== undefined ? { code } : {}) })
      }
      await readClient(sb, c.client, c.provider, tn)
      return { results }
    }
    case 'import_start': return runImportStart(sb, job.payload.run_id, enqueue)
    case 'import_batch': return runImportBatch(sb, job.payload.run_id, job.payload.numbers ?? [])
    case 'analysis_batch': return runAnalysisBatch(sb, job.payload.run_id, job.payload.client_ids ?? [])
    case 'daily': {
      const { data: clients } = await sb.from('practice_client').select('id, practice_id, user_id, stage').in('stage', ['submitted', 'readable', 'claimed'])
      let n = 0
      for (const c of clients ?? []) {
        await enqueue(sb, { kind: c.stage === 'submitted' ? 'onboarding_check' : 'read_client', practice_id: c.practice_id, user_id: c.user_id, payload: { client_id: c.id } })
        n++
      }
      return { queued: n }
    }
  }
}

export async function runNext(sb: SupabaseClient): Promise<boolean> {
  const { data, error } = await sb.rpc('claim_taxnow_job', { lock_seconds: 900 })
  if (error) throw new Error(error.message)
  const job = (data as any[] | null)?.[0]
  if (!job) return false
  try {
    const result = await runJob(sb, job)
    await sb.from('taxnow_job').update({ status: 'done', result: result ?? null, finished_at: new Date().toISOString(), locked_until: null }).eq('id', job.id)
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 500)
    await sb.from('taxnow_job').update({ status: job.attempts >= 3 ? 'failed' : 'queued', error: msg, locked_until: null, ...(job.attempts >= 3 ? { finished_at: new Date().toISOString() } : {}) }).eq('id', job.id)
    console.error(`taxnow_job ${job.id} (${job.kind}) failed: ${msg}`)
  }
  return true
}

/** The day's run key once it is 6:00 am in New York, else null. */
export function dailyKey(now = new Date()): string | null {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(now).map(p => [p.type, p.value]))
  if (Number(parts.hour) % 24 < 6) return null
  return `daily:${parts.year}-${parts.month}-${parts.day}`
}

let started = false

/** Start this worker's share of the queue. Every pm2 worker runs one; the
 *  database decides which job each gets. Off with PRACTICE_WORKER=0. */
export function startPracticeWorker() {
  if (started || process.env.PRACTICE_WORKER === '0' || !process.env.SUPABASE_SERVICE_ROLE_KEY) return
  started = true
  let busy = false
  let lastDaily = '' // per worker, only to skip re-inserting; the unique run_key is what guarantees once
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const sb = serviceClient()
      const key = dailyKey()
      if (key && key !== lastDaily) { await enqueue(sb, { kind: 'daily', run_key: key }); lastDaily = key }
      for (let i = 0; i < 20 && await runNext(sb); i++) { /* drain a little each tick */ }
    } catch (e: any) {
      console.error('practice worker:', e?.message ?? e)
    } finally {
      busy = false
    }
  }
  setInterval(tick, 15_000).unref()
}
