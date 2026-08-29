/**
 * One-shot backfill across all sensitive tables. Idempotent — skips rows
 * already encrypted unless --force is passed. Uses the local AWS creds
 * (instance role or dev keys) for KMS; anon Supabase for DB reads/writes
 * (RLS is open — app enforces auth).
 *
 * Usage:
 *   TAX_API_KMS_KEY=alias/tax-api-master \
 *   TAX_API_BLIND_HMAC=<hex64> \
 *   AWS_REGION=us-east-1 \
 *   npx tsx packages/api/scripts/backfill_all.ts [--dry-run] [--force] [--tables=entity,document,return,api_key]
 */
import { createClient } from '@supabase/supabase-js'
import { getDek, encrypt, byteaWrite, blindIndex } from '../src/lib/crypto.js'

const SUPABASE_URL  = process.env.SUPABASE_URL || 'https://ophnjqjmxeohbyydxnlg.supabase.co'
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9waG5qcWpteGVvaGJ5eWR4bmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI2MzYyMDIsImV4cCI6MjA3ODIxMjIwMn0.ShmVLhmnCYuUBL6f6i1-TnMlpy_3MK4kezetcimA62c'

const DRY   = process.argv.includes('--dry-run')
const FORCE = process.argv.includes('--force')
const TABLES = (() => {
  const flag = process.argv.find(a => a.startsWith('--tables='))
  return flag ? flag.slice('--tables='.length).split(',') : ['entity', 'document', 'return', 'api_key']
})()

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON)

async function encryptStringCol(userId: string, value: string): Promise<string> {
  const dek = await getDek(supabase, userId)
  return byteaWrite(encrypt(dek, value))
}
async function encryptJsonCol(userId: string, value: any): Promise<string> {
  const dek = await getDek(supabase, userId)
  return byteaWrite(encrypt(dek, value))
}

async function doEntities() {
  console.log('\n=== tax_entity ===')
  const { data, error } = await supabase.from('tax_entity').select('id, user_id, ein, ein_enc, ein_hash')
  if (error) throw new Error(error.message)
  let n = 0, skip = 0
  for (const row of data || []) {
    if (!row.ein) { skip++; continue }
    if (row.ein_enc && row.ein_hash && !FORCE) { skip++; continue }
    const updates: any = {}
    if (!row.ein_enc || FORCE) updates.ein_enc = await encryptStringCol(row.user_id, String(row.ein))
    if (!row.ein_hash || FORCE) updates.ein_hash = blindIndex(String(row.ein))
    if (DRY) { console.log(`  [dry] ${row.id}: ${Object.keys(updates).join(',')}`); n++; continue }
    const { error: e } = await supabase.from('tax_entity').update(updates).eq('id', row.id)
    if (e) { console.error(`  ERR ${row.id}: ${e.message}`); continue }
    n++
  }
  console.log(`  encrypted=${n}, skipped=${skip}`)
}

async function doDocuments() {
  console.log('\n=== document (meta, textract_data) ===')
  const { data, error } = await supabase.from('document')
    .select('id, user_id, meta, textract_data, meta_enc, textract_data_enc')
  if (error) throw new Error(error.message)
  let n = 0, skip = 0
  for (const row of data || []) {
    const updates: any = {}
    if (row.meta && (!row.meta_enc || FORCE)) {
      updates.meta_enc = await encryptJsonCol(row.user_id, row.meta)
    }
    if (row.textract_data && (!row.textract_data_enc || FORCE)) {
      updates.textract_data_enc = await encryptJsonCol(row.user_id, row.textract_data)
    }
    if (!Object.keys(updates).length) { skip++; continue }
    if (DRY) { console.log(`  [dry] ${row.id}: ${Object.keys(updates).join(',')}`); n++; continue }
    const { error: e } = await supabase.from('document').update(updates).eq('id', row.id)
    if (e) { console.error(`  ERR ${row.id}: ${e.message}`); continue }
    n++
  }
  console.log(`  encrypted=${n}, skipped=${skip}`)
}

async function doReturns() {
  console.log('\n=== tax_return (4 JSON cols + 4 aggregates) ===')
  // tax_return has no user_id — resolve via tax_entity join
  const { data, error } = await supabase.from('tax_return')
    .select(`id, entity_id,
      input_data, computed_data, field_values, verification,
      input_data_enc, computed_data_enc, field_values_enc, verification_enc,
      agg_total_income, agg_taxable_income, agg_total_tax, agg_agi,
      tax_entity!inner(user_id)`)
  if (error) throw new Error(error.message)
  let n = 0, skip = 0
  for (const row of (data as any[]) || []) {
    const userId: string | undefined = row.tax_entity?.user_id
    if (!userId) { skip++; continue }
    const updates: any = {}
    for (const col of ['input_data', 'computed_data', 'field_values', 'verification']) {
      const enc = `${col}_enc`
      if (row[col] && (!row[enc] || FORCE)) {
        updates[enc] = await encryptJsonCol(userId, row[col])
      }
    }
    // Extract aggregates if plaintext columns are still empty
    const c = row.computed_data?.computed || {}
    if ((row.agg_total_income   == null || FORCE) && c.total_income   != null) updates.agg_total_income   = c.total_income
    if ((row.agg_taxable_income == null || FORCE) && c.taxable_income != null) updates.agg_taxable_income = c.taxable_income
    if ((row.agg_total_tax      == null || FORCE) && c.total_tax      != null) updates.agg_total_tax      = c.total_tax
    if ((row.agg_agi            == null || FORCE) && c.agi            != null) updates.agg_agi            = c.agi

    if (!Object.keys(updates).length) { skip++; continue }
    if (DRY) { console.log(`  [dry] ${row.id}: ${Object.keys(updates).join(',')}`); n++; continue }
    const { error: e } = await supabase.from('tax_return').update(updates).eq('id', row.id)
    if (e) { console.error(`  ERR ${row.id}: ${e.message}`); continue }
    n++
  }
  console.log(`  encrypted=${n}, skipped=${skip}`)
}

async function doApiKeys() {
  console.log('\n=== api_key (argon2id hash + prefix) ===')
  const argon2 = await import('argon2')
  const { data, error } = await supabase.from('api_key')
    .select('id, key_value, key_value_hash, key_prefix')
  if (error) throw new Error(error.message)
  let n = 0, skip = 0
  for (const row of data || []) {
    if (!row.key_value) { skip++; continue }
    if (row.key_value_hash && row.key_prefix && !FORCE) { skip++; continue }
    const updates: any = {}
    if (!row.key_value_hash || FORCE) {
      updates.key_value_hash = await argon2.hash(String(row.key_value), { type: argon2.argon2id })
    }
    if (!row.key_prefix || FORCE) updates.key_prefix = String(row.key_value).slice(0, 8)
    if (DRY) { console.log(`  [dry] ${row.id}: ${Object.keys(updates).join(',')}`); n++; continue }
    const { error: e } = await supabase.from('api_key').update(updates).eq('id', row.id)
    if (e) { console.error(`  ERR ${row.id}: ${e.message}`); continue }
    n++
  }
  console.log(`  hashed=${n}, skipped=${skip}`)
}

async function main() {
  if (!process.env.TAX_API_KMS_KEY) throw new Error('TAX_API_KMS_KEY required')
  if (!process.env.TAX_API_BLIND_HMAC) throw new Error('TAX_API_BLIND_HMAC required')
  console.log(`Backfill mode: ${DRY ? 'DRY-RUN' : 'LIVE'}, force=${FORCE}, tables=${TABLES.join(',')}`)
  if (TABLES.includes('entity'))   await doEntities()
  if (TABLES.includes('document')) await doDocuments()
  if (TABLES.includes('return'))   await doReturns()
  if (TABLES.includes('api_key'))  await doApiKeys()
  console.log('\ndone.')
}

main().catch(e => { console.error(e); process.exit(1) })
