/**
 * An imported book: a TaxNow transaction export brought into a practice of
 * its own, and the analysis re-run over a practice's stored transcripts.
 *
 * Why (2026-10-26): Kenneth's export of his book (8,834 clients known only
 * by number, ~845,000 transactions) is to be analysed in the product, as an
 * account of its own. Nothing here reads TaxNow or asks the IRS for anything:
 * the clients are stage 'imported', which the daily run never picks up.
 *
 * Shape of the work, for N pm2 workers and a 768 MB restart limit:
 *   1. beginImport: a practice_run row and a presigned S3 PUT; the browser
 *      uploads the file straight to the private bucket (52 MB does not go
 *      through the API).
 *   2. 'import_start' job: reads the whole file once for its client numbers
 *      and counts, makes the missing clients (each with an entity of its
 *      own, "Client 12345"), and queues one 'import_batch' job per
 *      IMPORT_BATCH clients.
 *   3. 'import_batch' jobs, on whichever workers claim them: each re-reads
 *      the file, builds only its own clients' periods, writes the periods that
 *      changed, recomputes the findings and records what changed.
 *   4. runStatus reads progress off the batch jobs and closes the run once
 *      they have all finished.
 * A refresh is the same flow with a newer export: periods are replaced per
 * client number; a client missing from the newer file is kept and counted.
 *
 * 'analysis_batch' jobs (startAnalysis) recompute findings from what is
 * stored, under the current rules (RULES_VERSION), with the same progress.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { s3GetObject, s3PresignPut } from '../lib/s3.js'
import { encryptedFields, hydrateAll, ENCRYPTED_FINDING_FIELDS, ENCRYPTED_PRACTICE_CLIENT_FIELDS, ENCRYPTED_TRANSCRIPT_FIELDS, FINDING_ENC_COLS, PRACTICE_CLIENT_ENC_COLS, TRANSCRIPT_ENC_COLS } from '../lib/row_crypto.js'
import { ExportFormatError, packParsed, parseExport, unpackParsed, type ExportClient } from '../taxnow/export.js'
import { RULES_VERSION } from '../taxnow/opportunities.js'
import { computeFindings, findingKeys, replaceFindingsMany, statusCountsOf, type ClientSummary, type FindingRow, type StoredTranscript } from './practice_read.js'
import { PracticeError, type Practice } from './practice.js'

/** Clients per batch job: ~4,500 periods, written in a minute or two. */
export const IMPORT_BATCH = 400
const MAX_BYTES = 200 * 1024 * 1024

export interface RunRow {
  id: string
  practice_id: string
  user_id: string
  kind: 'import' | 'analysis'
  status: 'uploading' | 'queued' | 'running' | 'done' | 'failed'
  file_name: string | null
  s3_key: string | null
  bytes: number | null
  sha256: string | null
  as_of: string | null
  rules_version: string
  stats: Record<string, any> | null
  batches_total: number | null
  changes: Changes | null
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

/** What a run changed: counts only (no amounts), so the row needs no encryption. */
export interface Changes {
  clients_added: number
  clients_absent: number
  clients_seen: number
  clients_changed: number
  periods_written: number
  periods_unchanged: number
  periods_removed: number
  findings_before: number
  findings_after: number
  findings_new: Record<string, number>
  findings_gone: Record<string, number>
  /** Up to 200 clients whose findings changed, to open from the run. */
  changed_clients: string[]
}

const RUN_COLS = 'id, practice_id, user_id, kind, status, file_name, s3_key, bytes, sha256, as_of, rules_version, stats, batches_total, changes, error, created_at, started_at, finished_at'

type Enqueue = (sb: SupabaseClient, job: { kind: any; user_id?: string | null; practice_id?: string | null; payload?: Record<string, unknown> }) => Promise<string | null>

function requireImport(p: Practice) {
  if (p.provider !== 'import') throw new PracticeError(400, 'Only an imported book takes an export. This practice reads its clients through their 8821s.')
}

async function inFlight(sb: SupabaseClient, p: Practice): Promise<RunRow | null> {
  const { data } = await sb.from('practice_run').select(RUN_COLS).eq('practice_id', p.id).in('status', ['uploading', 'queued', 'running']).order('created_at', { ascending: false }).limit(1)
  const r = (data?.[0] ?? null) as RunRow | null
  // An upload abandoned for an hour no longer blocks the next one.
  if (r && r.status === 'uploading' && Date.now() - new Date(r.created_at).getTime() > 3_600_000) {
    await sb.from('practice_run').update({ status: 'failed', error: 'The upload was not finished.', finished_at: new Date().toISOString() }).eq('id', r.id)
    return null
  }
  return r
}

/** The as-of date an export stands for: given, else the date in its file name, else today. */
export function asOfFor(fileName: string, given?: unknown, today = new Date()): string {
  const t = today.toISOString().slice(0, 10)
  const v = typeof given === 'string' && given ? given : /(\d{4}-\d{2}-\d{2})/.exec(fileName)?.[1] ?? t
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new PracticeError(400, 'The as-of date is YYYY-MM-DD.')
  if (v > t) throw new PracticeError(400, 'The as-of date cannot be in the future.')
  return v
}

export async function beginImport(sb: SupabaseClient, p: Practice, userId: string, body: { file_name?: unknown; bytes?: unknown; as_of?: unknown }) {
  requireImport(p)
  const fileName = String(body.file_name ?? '').trim().slice(0, 200)
  const bytes = Number(body.bytes)
  if (!/\.csv$/i.test(fileName)) throw new PracticeError(400, 'Choose the export as a .csv file.')
  if (!(bytes > 0 && bytes <= MAX_BYTES)) throw new PracticeError(400, 'The file must be under 200 MB.')
  const asOf = asOfFor(fileName, body.as_of)
  if (await inFlight(sb, p)) throw new PracticeError(409, 'An import or analysis is already running. Wait for it to finish.')
  const id = randomUUID()
  const key = `practice-imports/${p.user_id}/${id}.csv`
  const { error } = await sb.from('practice_run').insert({
    id, practice_id: p.id, user_id: p.user_id, kind: 'import', status: 'uploading', file_name: fileName, s3_key: key, bytes, as_of: asOf,
    rules_version: RULES_VERSION, created_by: userId,
  })
  if (error) throw new PracticeError(500, error.message)
  return { run_id: id, upload_url: await s3PresignPut(key, 'text/csv', 900), content_type: 'text/csv' }
}

export async function uploadDone(sb: SupabaseClient, p: Practice, runId: string, enqueue: Enqueue) {
  requireImport(p)
  const run = await getRun(sb, p, runId)
  if (run.status !== 'uploading') throw new PracticeError(409, 'This import has already started.')
  const { error } = await sb.from('practice_run').update({ status: 'queued' }).eq('id', run.id).eq('status', 'uploading')
  if (error) throw new PracticeError(500, error.message)
  await enqueue(sb, { kind: 'import_start', practice_id: p.id, user_id: p.user_id, payload: { run_id: run.id } })
  return runView({ ...run, status: 'queued' })
}

/** Recompute every client's findings from what is stored, under the current rules. */
export async function startAnalysis(sb: SupabaseClient, p: Practice, userId: string, enqueue: Enqueue) {
  if (await inFlight(sb, p)) throw new PracticeError(409, 'An import or analysis is already running. Wait for it to finish.')
  const ids: string[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('practice_client').select('id').eq('practice_id', p.id).order('created_at').range(from, from + 999)
    if (error) throw new PracticeError(500, error.message)
    ids.push(...(data ?? []).map(r => r.id))
    if ((data ?? []).length < 1000) break
  }
  if (!ids.length) throw new PracticeError(400, 'There are no clients to analyse yet.')
  const id = randomUUID()
  const batches = chunk(ids, IMPORT_BATCH)
  const { error } = await sb.from('practice_run').insert({
    id, practice_id: p.id, user_id: p.user_id, kind: 'analysis', status: 'running', rules_version: RULES_VERSION, created_by: userId,
    batches_total: batches.length, started_at: new Date().toISOString(), stats: { clients: ids.length },
  })
  if (error) throw new PracticeError(500, error.message)
  for (const b of batches) await enqueue(sb, { kind: 'analysis_batch', practice_id: p.id, user_id: p.user_id, payload: { run_id: id, client_ids: b } })
  return runView((await getRun(sb, p, id)))
}

export async function getRun(sb: SupabaseClient, p: Practice, runId: string): Promise<RunRow> {
  const { data, error } = await sb.from('practice_run').select(RUN_COLS).eq('practice_id', p.id).eq('id', runId).maybeSingle()
  if (error) throw new PracticeError(500, error.message)
  if (!data) throw new PracticeError(404, 'No such import or analysis.')
  return data as RunRow
}

export async function listRuns(sb: SupabaseClient, p: Practice) {
  const { data, error } = await sb.from('practice_run').select(RUN_COLS).eq('practice_id', p.id).order('created_at', { ascending: false }).limit(50)
  if (error) throw new PracticeError(500, error.message)
  const runs = (data ?? []) as RunRow[]
  // Keep the running one's progress current.
  const live = runs.find(r => r.status === 'running' || r.status === 'queued')
  const progress = live ? await runProgress(sb, live) : null
  return runs.map(r => runView(r.id === live?.id && progress ? progress.run : r, r.id === live?.id ? progress?.done : undefined))
}

/** A run with its progress; closes it once every batch has finished. */
export async function runStatus(sb: SupabaseClient, p: Practice, runId: string) {
  const { run, done } = await runProgress(sb, await getRun(sb, p, runId))
  return runView(run, done)
}

function runView(r: RunRow, batchesDone?: number) {
  return {
    id: r.id, kind: r.kind, status: r.status, file_name: r.file_name, bytes: r.bytes, as_of: r.as_of, rules_version: r.rules_version,
    stats: r.stats, changes: r.changes, error: r.error, created_at: r.created_at, started_at: r.started_at, finished_at: r.finished_at,
    batches_total: r.batches_total, batches_done: batchesDone ?? (r.status === 'done' ? r.batches_total : null),
    sha256: r.sha256,
  }
}

async function runProgress(sb: SupabaseClient, run: RunRow): Promise<{ run: RunRow; done: number }> {
  if (run.status !== 'running' && run.status !== 'queued') return { run, done: run.status === 'done' ? run.batches_total ?? 0 : 0 }
  const { data: jobs, error } = await sb.from('taxnow_job').select('kind, status, result, error').eq('payload->>run_id', run.id)
  if (error) throw new PracticeError(500, error.message)
  const start = (jobs ?? []).find(j => j.kind === 'import_start')
  if (start?.status === 'failed') return { run: await closeRun(sb, run, 'failed', null, start.error ?? 'The file could not be read.'), done: 0 }
  const batches = (jobs ?? []).filter(j => j.kind === 'import_batch' || j.kind === 'analysis_batch')
  const done = batches.filter(j => j.status === 'done').length
  const failed = batches.filter(j => j.status === 'failed')
  if (run.status === 'running' && run.batches_total != null && done + failed.length >= run.batches_total) {
    const changes = mergeChanges(run.changes, batches.filter(j => j.status === 'done').map(j => j.result as Changes))
    return { run: await closeRun(sb, run, failed.length ? 'failed' : 'done', changes, failed.length ? `${failed.length} of ${run.batches_total} batches failed: ${failed[0].error ?? ''}`.slice(0, 500) : null), done }
  }
  return { run, done }
}

async function closeRun(sb: SupabaseClient, run: RunRow, status: 'done' | 'failed', changes: Changes | null, err: string | null): Promise<RunRow> {
  const patch = { status, changes: changes ?? run.changes, error: err, finished_at: new Date().toISOString() }
  // Only the first reader to see it finished closes it.
  await sb.from('practice_run').update(patch).eq('id', run.id).in('status', ['queued', 'running'])
  return { ...run, ...patch }
}

export function emptyChanges(): Changes {
  return { clients_added: 0, clients_absent: 0, clients_seen: 0, clients_changed: 0, periods_written: 0, periods_unchanged: 0, periods_removed: 0, findings_before: 0, findings_after: 0, findings_new: {}, findings_gone: {}, changed_clients: [] }
}

export function mergeChanges(base: Changes | null, parts: Array<Partial<Changes> | null>): Changes {
  const out = { ...emptyChanges(), ...(base ?? {}) }
  out.findings_new = { ...out.findings_new }
  out.findings_gone = { ...out.findings_gone }
  out.changed_clients = [...out.changed_clients]
  for (const c of parts) {
    if (!c) continue
    for (const k of ['clients_seen', 'clients_changed', 'periods_written', 'periods_unchanged', 'periods_removed', 'findings_before', 'findings_after'] as const) out[k] += c[k] ?? 0
    for (const [t, n] of Object.entries(c.findings_new ?? {})) out.findings_new[t] = (out.findings_new[t] ?? 0) + n
    for (const [t, n] of Object.entries(c.findings_gone ?? {})) out.findings_gone[t] = (out.findings_gone[t] ?? 0) + n
    for (const id of c.changed_clients ?? []) if (out.changed_clients.length < 200) out.changed_clients.push(id)
  }
  return out
}

// ─── Jobs ───────────────────────────────────────────────────────────────────

async function runOf(sb: SupabaseClient, runId: string): Promise<RunRow> {
  const { data, error } = await sb.from('practice_run').select(RUN_COLS).eq('id', runId).maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('The run is gone.')
  return data as RunRow
}

async function readFile(run: RunRow): Promise<{ text: string; sha256: string }> {
  if (!run.s3_key) throw new Error('This run has no file.')
  const buf = await s3GetObject(run.s3_key)
  return { text: buf.toString('utf8'), sha256: createHash('sha256').update(buf).digest('hex') }
}

export async function runImportStart(sb: SupabaseClient, runId: string, enqueue: Enqueue): Promise<unknown> {
  const run = await runOf(sb, runId)
  if (run.status !== 'queued') return { skipped: run.status }
  await sb.from('practice_run').update({ status: 'running', started_at: new Date().toISOString() }).eq('id', run.id)
  const { text, sha256 } = await readFile(run)
  let parsed: ReturnType<typeof parseExport>
  try {
    parsed = parseExport(text, run.as_of!, new Set())
  } catch (e) {
    if (e instanceof ExportFormatError) {
      await closeRun(sb, run, 'failed', null, e.message)
      return { failed: e.message }
    }
    throw e
  }
  const { numbers, stats } = parsed

  const existing = new Map<string, string>()   // import_key → client id
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('practice_client').select('id, import_key').eq('practice_id', run.practice_id).not('import_key', 'is', null).range(from, from + 999)
    if (error) throw new Error(error.message)
    for (const r of data ?? []) existing.set(r.import_key, r.id)
    if ((data ?? []).length < 1000) break
  }
  const fresh = [...numbers.keys()].filter(n => !existing.has(n))
  for (const part of chunk(fresh, 500)) {
    const ents = part.map(n => ({ id: randomUUID(), number: n }))
    const { error: e1 } = await sb.from('tax_entity').insert(ents.map(e => {
      // The export does not say what kind of business it is; the forms it holds do, roughly.
      const kind = numbers.get(e.number)
      return { id: e.id, user_id: run.user_id, practice_id: run.practice_id, name: `Client ${e.number}`, entity_type: kind === 'individual' ? 'individual' : 'c_corp', form_type: kind === 'individual' ? '1040' : '1120' }
    }))
    if (e1) throw new Error(e1.message)
    const { error: e2 } = await sb.from('practice_client').insert(ents.map(e => ({
      practice_id: run.practice_id, user_id: run.user_id, entity_id: e.id, stage: 'imported', import_key: e.number, import_run_id: run.id,
    })))
    if (e2) throw new Error(e2.message)
  }
  const absent = [...existing.keys()].filter(n => !numbers.has(n)).length
  const batches = chunk([...numbers.keys()], IMPORT_BATCH)
  const changes = { ...emptyChanges(), clients_added: fresh.length, clients_absent: absent }
  const { error } = await sb.from('practice_run').update({ sha256, stats, batches_total: batches.length, changes }).eq('id', run.id)
  if (error) throw new Error(error.message)
  for (const b of batches) await enqueue(sb, { kind: 'import_batch', practice_id: run.practice_id, user_id: run.user_id, payload: { run_id: run.id, numbers: b } })
  return { clients: numbers.size, added: fresh.length, absent, batches: batches.length }
}

interface ClientRef { id: string; practice_id: string; user_id: string; entity_id: string; stage: string; import_key: string | null; summary: ClientSummary | null }

async function clientsBy(sb: SupabaseClient, practiceId: string, col: 'import_key' | 'id', values: string[]): Promise<ClientRef[]> {
  const out: any[] = []
  for (const part of chunk(values, 100)) {
    const { data, error } = await sb.from('practice_client').select(`id, practice_id, user_id, entity_id, stage, import_key, summary, ${PRACTICE_CLIENT_ENC_COLS}`).eq('practice_id', practiceId).in(col, part)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
  }
  return hydrateAll(sb, out, ENCRYPTED_PRACTICE_CLIENT_FIELDS)
}

const tKey = (t: { type: string; form: string; tax_year: number; period_month: number }) => `${t.type}|${t.form}|${t.tax_year}|${t.period_month}`

/** One batch of an import: write its clients' periods, recompute their findings. */
export async function runImportBatch(sb: SupabaseClient, runId: string, numbers: string[], today = new Date()): Promise<Changes> {
  const run = await runOf(sb, runId)
  const { text } = await readFile(run)
  const { clients } = parseExport(text, run.as_of!, new Set(numbers))
  const refs = new Map((await clientsBy(sb, run.practice_id, 'import_key', numbers)).map(c => [c.import_key!, c]))

  // What is stored now, plain columns only: a period whose packed form hashes the same is not rewritten.
  const stored = new Map<string, Map<string, { id: string; sha: string | null }>>()
  for (const part of chunk([...refs.values()].map(c => c.id), 50)) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('taxnow_transcript').select('id, practice_client_id, type, form, tax_year, period_month, source_sha256').in('practice_client_id', part).order('id').range(from, from + 999)
      if (error) throw new Error(error.message)
      for (const r of data ?? []) (stored.get(r.practice_client_id) ?? stored.set(r.practice_client_id, new Map()).get(r.practice_client_id)!).set(tKey(r), { id: r.id, sha: r.source_sha256 })
      if ((data ?? []).length < 1000) break
    }
  }

  const changes = emptyChanges()
  const upserts: Record<string, any>[] = []
  const removals: string[] = []
  const computed: Computed[] = []
  for (const ec of clients) {
    const client = refs.get(ec.number)
    if (!client) continue // made by import_start; missing only if deleted since
    changes.clients_seen++
    const have = stored.get(client.id) ?? new Map()
    const rows: StoredTranscript[] = []
    for (const p of ec.periods) {
      const packed = packParsed(p.form, p.parsed)
      const sha = createHash('sha256').update(p.status + JSON.stringify(packed)).digest('hex')
      const k = tKey({ type: 'ACTR', form: p.form, tax_year: p.taxYear, period_month: p.periodMonth })
      const prev = have.get(k)
      have.delete(k)
      rows.push({ id: prev?.id ?? '', type: 'ACTR', form: p.form, tax_year: p.taxYear, period_month: p.periodMonth, status: p.status, synced_at: null, source_sha256: sha, parsed: p.parsed })
      if (prev?.sha === sha) { changes.periods_unchanged++; continue }
      upserts.push({
        user_id: client.user_id, practice_client_id: client.id, entity_id: client.entity_id, type: 'ACTR', form: p.form, tax_year: p.taxYear, period_month: p.periodMonth,
        status: p.status, listed: true, synced_at: null, response_date: run.as_of, source_sha256: sha, parsed: packed, read_at: new Date().toISOString(),
      })
    }
    for (const gone of have.values()) removals.push(gone.id)
    const { findings, summary } = await computeFindings(sb, client, rows, today, { returns: false })
    computed.push({ client, findings, summary, counts: statusCountsOf(rows) })
  }

  for (const part of chunk(upserts, 500)) {
    const enc = []
    for (const u of part) enc.push({ ...u, ...(await encryptedFields(sb, u.user_id, u, ENCRYPTED_TRANSCRIPT_FIELDS)) })
    const { error } = await sb.from('taxnow_transcript').upsert(enc, { onConflict: 'practice_client_id,type,form,tax_year,period_month' })
    if (error) throw new Error(error.message)
  }
  for (const part of chunk(removals, 100)) {
    const { error } = await sb.from('taxnow_transcript').delete().in('id', part)
    if (error) throw new Error(error.message)
  }
  changes.periods_written = upserts.length
  changes.periods_removed = removals.length

  await writeFindings(sb, computed, changes, { import_run_id: run.id })
  return changes
}

/** One batch of a re-run: recompute from the stored transcripts. */
export async function runAnalysisBatch(sb: SupabaseClient, runId: string, clientIds: string[], today = new Date()): Promise<Changes> {
  const run = await runOf(sb, runId)
  const { data: practice } = await sb.from('practice').select('provider').eq('id', run.practice_id).single()
  const imported = practice?.provider === 'import'
  const clients = await clientsBy(sb, run.practice_id, 'id', clientIds)
  const changes = emptyChanges()
  const computed: Computed[] = []
  for (const part of chunk(clients, 25)) {
    const rows: any[] = []
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('taxnow_transcript').select(`id, user_id, practice_client_id, type, form, tax_year, period_month, status, synced_at, source_sha256, parsed, ${TRANSCRIPT_ENC_COLS}`).in('practice_client_id', part.map(c => c.id)).order('id').range(from, from + 999)
      if (error) throw new Error(error.message)
      rows.push(...(data ?? []))
      if ((data ?? []).length < 1000) break
    }
    await hydrateAll(sb, rows, ENCRYPTED_TRANSCRIPT_FIELDS)
    for (const client of part) {
      changes.clients_seen++
      const mine: StoredTranscript[] = rows.filter(r => r.practice_client_id === client.id).map(r => ({ ...r, parsed: unpackParsed(r.parsed) }))
      const { findings, summary } = await computeFindings(sb, client, mine, today, { returns: !imported })
      // A read's other_viewers comes from TaxNow, not the transcripts: keep it.
      computed.push({ client, findings, summary: { ...summary, ...(client.summary?.other_viewers ? { other_viewers: client.summary.other_viewers } : {}) }, counts: statusCountsOf(mine) })
    }
  }
  await writeFindings(sb, computed, changes, {})
  return changes
}

interface Computed { client: ClientRef; findings: FindingRow[]; summary: ClientSummary; counts: Record<string, number> }

/** Replace the batch's findings and summaries, counting what changed against what was there. */
async function writeFindings(sb: SupabaseClient, computed: Computed[], changes: Changes, clientPatch: Record<string, unknown>) {
  const before = new Map<string, Map<string, number>>()   // client → finding key|amount → count
  for (const part of chunk(computed.map(c => c.client.id), 100)) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('practice_finding').select(`id, user_id, practice_client_id, type, form, tax_year, period_month, detail, ${FINDING_ENC_COLS}`).in('practice_client_id', part).order('id').range(from, from + 999)
      if (error) throw new Error(error.message)
      const rows = await hydrateAll(sb, (data ?? []) as any[], ENCRYPTED_FINDING_FIELDS)
      const byClient = new Map<string, any[]>()
      for (const r of rows) (byClient.get(r.practice_client_id) ?? byClient.set(r.practice_client_id, []).get(r.practice_client_id)!).push({ ...r, note: r.detail?.note ?? '', amount_cents: r.detail?.amount_cents ?? null })
      for (const [cid, fs] of byClient) {
        const m = before.get(cid) ?? new Map<string, number>()
        findingKeys(fs).forEach((k, i) => { const kk = `${k}|${fs[i].amount_cents ?? ''}`; m.set(kk, (m.get(kk) ?? 0) + 1) })
        before.set(cid, m)
      }
      if ((data ?? []).length < 1000) break
    }
  }
  for (const { client, findings } of computed) {
    const old = new Map(before.get(client.id) ?? [])
    changes.findings_before += [...old.values()].reduce((a, b) => a + b, 0)
    changes.findings_after += findings.length
    let changed = false
    findingKeys(findings).forEach((k, i) => {
      const kk = `${k}|${findings[i].amount_cents ?? ''}`
      const n = old.get(kk) ?? 0
      if (n > 0) old.set(kk, n - 1)
      else { changes.findings_new[findings[i].type] = (changes.findings_new[findings[i].type] ?? 0) + 1; changed = true }
    })
    for (const [kk, n] of old) if (n > 0) { const type = kk.split('|')[0]; changes.findings_gone[type] = (changes.findings_gone[type] ?? 0) + n; changed = true }
    if (changed) { changes.clients_changed++; if (changes.changed_clients.length < 200) changes.changed_clients.push(client.id) }
  }
  await replaceFindingsMany(sb, computed.map(c => ({ client: c.client, findings: c.findings })))

  const now = new Date().toISOString()
  const ups = []
  for (const { client, summary, counts } of computed) {
    const row = { id: client.id, practice_id: client.practice_id, user_id: client.user_id, entity_id: client.entity_id, stage: client.stage, summary, status_counts: counts, last_read_at: now, updated_at: now, ...clientPatch }
    ups.push({ ...row, ...(await encryptedFields(sb, client.user_id, row, ENCRYPTED_PRACTICE_CLIENT_FIELDS)) })
  }
  for (const part of chunk(ups, 500)) {
    const { error } = await sb.from('practice_client').upsert(part, { onConflict: 'id' })
    if (error) throw new Error(error.message)
  }
}

export function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

export type { ExportClient }

/**
 * For scripts (the fictional demo's seed): an import run start to finish in
 * this process, without the job queue. The queue is shared with every
 * deployed worker, so a script must not put work on it that a worker running
 * other code might take.
 */
export async function importInline(sb: SupabaseClient, p: Practice, userId: string, fileName: string, csv: string, asOf: string): Promise<RunRow> {
  requireImport(p)
  const id = randomUUID()
  const key = `practice-imports/${p.user_id}/${id}.csv`
  const { s3PutObject } = await import('../lib/s3.js')
  const put = await s3PutObject(key, Buffer.from(csv, 'utf8'), 'text/csv')
  const { error } = await sb.from('practice_run').insert({
    id, practice_id: p.id, user_id: p.user_id, kind: 'import', status: 'queued', file_name: fileName, s3_key: key, bytes: put.bytes, as_of: asOf,
    rules_version: RULES_VERSION, created_by: userId,
  })
  if (error) throw new Error(error.message)
  const batches: string[][] = []
  await runImportStart(sb, id, async (_sb, job) => { batches.push(job.payload!.numbers as string[]); return null })
  const parts: Changes[] = []
  for (const b of batches) parts.push(await runImportBatch(sb, id, b))
  const run = await runOf(sb, id)
  return closeRun(sb, run, 'done', mergeChanges(run.changes, parts), null)
}
