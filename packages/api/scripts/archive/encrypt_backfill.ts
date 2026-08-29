/**
 * Dual-write backfill: read plaintext columns, encrypt via per-user DEK,
 * write to the *_enc shadow columns added by the encryption_scaffold
 * migration. Leaves plaintext in place — a separate cutover pass nulls
 * those out once the app reads exclusively from *_enc.
 *
 * Idempotent: skips rows where the *_enc column is already populated unless
 * --force is passed. Batched by user_id so DEK caching amortizes.
 *
 * Usage:
 *   npx tsx packages/api/scripts/encrypt_backfill.ts --dry-run
 *   npx tsx packages/api/scripts/encrypt_backfill.ts --table tax_return
 *   npx tsx packages/api/scripts/encrypt_backfill.ts --all
 *
 * Env required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (NOT anon — we
 * bypass RLS here), TAX_API_KMS_KEY, TAX_API_BLIND_HMAC, AWS_REGION.
 */
import { createClient } from '@supabase/supabase-js'
import { getDek, encrypt, blindIndex } from '../src/lib/crypto.js'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required')
  process.exit(2)
}
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

const args = new Set(process.argv.slice(2))
const DRY  = args.has('--dry-run')
const FORCE = args.has('--force')

interface BackfillPlan {
  table:  string
  // Plain → encrypted column mapping
  cols:   Array<{ plain: string; enc: string; kind: 'json' | 'text' }>
  // Optional: plaintext → blind index mapping (e.g. ein → ein_hash)
  hashes?: Array<{ plain: string; hash: string }>
  // Aggregate numeric extraction (for tax_return's plaintext queryable cols)
  aggs?:  Array<{ extract: (row: any) => number | null; col: string }>
  // How to get the owning user_id from a row
  userIdFrom: (row: any) => Promise<string | null> | string | null
}

// tax_return.user_id is not on the row — join through tax_entity.
async function userIdForTaxReturn(row: any): Promise<string | null> {
  const { data } = await supabase.from('tax_entity')
    .select('user_id').eq('id', row.entity_id).maybeSingle()
  return data?.user_id || null
}

const PLANS: Record<string, BackfillPlan> = {
  qbo_connection: {
    table: 'qbo_connection',
    cols: [
      { plain: 'access_token',  enc: 'access_token_enc',  kind: 'text' },
      { plain: 'refresh_token', enc: 'refresh_token_enc', kind: 'text' },
    ],
    userIdFrom: async (row) => userIdForTaxReturn(row),
  },
  tax_entity: {
    table: 'tax_entity',
    cols: [
      { plain: 'ein', enc: 'ein_enc', kind: 'text' },
    ],
    hashes: [{ plain: 'ein', hash: 'ein_hash' }],
    userIdFrom: (row) => row.user_id,
  },
  tax_return: {
    table: 'tax_return',
    cols: [
      { plain: 'input_data',    enc: 'input_data_enc',    kind: 'json' },
      { plain: 'computed_data', enc: 'computed_data_enc', kind: 'json' },
      { plain: 'field_values',  enc: 'field_values_enc',  kind: 'json' },
      { plain: 'verification',  enc: 'verification_enc',  kind: 'json' },
    ],
    aggs: [
      { extract: (r) => r.computed_data?.computed?.total_income     ?? null, col: 'agg_total_income' },
      { extract: (r) => r.computed_data?.computed?.taxable_income   ?? null, col: 'agg_taxable_income' },
      { extract: (r) => r.computed_data?.computed?.total_tax        ?? null, col: 'agg_total_tax' },
      { extract: (r) => r.computed_data?.computed?.agi              ?? null, col: 'agg_agi' },
    ],
    userIdFrom: userIdForTaxReturn,
  },
  document: {
    table: 'document',
    cols: [
      { plain: 'meta',          enc: 'meta_enc',          kind: 'json' },
      { plain: 'textract_data', enc: 'textract_data_enc', kind: 'json' },
    ],
    userIdFrom: (row) => row.user_id,
  },
}

async function backfill(plan: BackfillPlan): Promise<{ total: number; encrypted: number; skipped: number; errors: number }> {
  const stats = { total: 0, encrypted: 0, skipped: 0, errors: 0 }
  const plainCols = plan.cols.map(c => c.plain)
  const encCols   = plan.cols.map(c => c.enc)
  const hashCols  = plan.hashes?.map(h => h.hash) || []
  const aggCols   = plan.aggs?.map(a => a.col) || []
  const select    = ['id', ...plainCols, ...encCols, ...hashCols, ...aggCols]
  // Pull user_id columns depending on table
  if (plan.table !== 'tax_return') select.push('user_id')
  else select.push('entity_id')

  let cursor: string | null = null
  const pageSize = 100
  while (true) {
    let q = supabase.from(plan.table).select(select.join(',')).order('id').limit(pageSize)
    if (cursor) q = q.gt('id', cursor)
    const { data: rows, error } = await q
    if (error) throw new Error(`${plan.table} fetch: ${error.message}`)
    if (!rows?.length) break

    for (const row of rows as any[]) {
      stats.total++
      const uid = await plan.userIdFrom(row)
      if (!uid) { stats.skipped++; continue }

      const updates: Record<string, any> = {}
      // Encrypt each column needing it
      for (const { plain, enc, kind } of plan.cols) {
        const existing = row[enc]
        if (existing && !FORCE) continue
        const value = row[plain]
        if (value === null || value === undefined) continue
        const dek = await getDek(supabase, uid)
        const payload = kind === 'json'
          ? encrypt(dek, value)
          : encrypt(dek, String(value))
        updates[enc] = payload
      }
      // Blind indexes
      for (const h of plan.hashes || []) {
        if (row[h.hash] && !FORCE) continue
        const v = row[h.plain]
        if (v) updates[h.hash] = blindIndex(String(v))
      }
      // Aggregates
      for (const a of plan.aggs || []) {
        const val = a.extract(row)
        if (val !== null && val !== undefined && (row[a.col] === null || FORCE)) {
          updates[a.col] = val
        }
      }

      if (Object.keys(updates).length === 0) { stats.skipped++; continue }

      if (DRY) {
        console.log(`  [dry] ${plan.table} ${row.id}: would set ${Object.keys(updates).join(', ')}`)
      } else {
        const { error: updErr } = await supabase.from(plan.table).update(updates).eq('id', row.id)
        if (updErr) { console.error(`  ERR ${plan.table} ${row.id}: ${updErr.message}`); stats.errors++; continue }
      }
      stats.encrypted++
    }
    cursor = (rows[rows.length - 1] as any).id
    if (rows.length < pageSize) break
  }
  return stats
}

async function main() {
  const tableFlag = process.argv.indexOf('--table')
  const only = tableFlag >= 0 ? process.argv[tableFlag + 1] : null
  const all = args.has('--all')
  const targets = only ? [only] : all ? Object.keys(PLANS) : []
  if (targets.length === 0) {
    console.log('Usage: --all | --table <name> [--dry-run] [--force]')
    console.log('Tables:', Object.keys(PLANS).join(', '))
    process.exit(1)
  }
  for (const t of targets) {
    const plan = PLANS[t]
    if (!plan) { console.error(`Unknown table: ${t}`); continue }
    console.log(`\n=== backfilling ${t}${DRY ? ' (DRY RUN)' : ''} ===`)
    const stats = await backfill(plan)
    console.log(`${t}:  total=${stats.total}  encrypted=${stats.encrypted}  skipped=${stats.skipped}  errors=${stats.errors}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
