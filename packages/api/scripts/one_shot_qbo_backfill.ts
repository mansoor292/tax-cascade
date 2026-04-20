/**
 * One-shot backfill: encrypt the 3 existing qbo_connection rows' tokens
 * into access_token_enc / refresh_token_enc. Idempotent — skips rows
 * that already have *_enc populated unless --force is passed.
 *
 * Uses the local AWS creds (via default provider chain) for KMS, and the
 * Supabase anon key for DB access (qbo_connection's RLS is open; the app
 * enforces auth at the API layer).
 *
 * Run: TAX_API_KMS_KEY=alias/tax-api-master TAX_API_BLIND_HMAC=$(openssl rand -hex 32) \
 *   npx tsx packages/api/scripts/one_shot_qbo_backfill.ts [--dry-run] [--force]
 */
import { createClient } from '@supabase/supabase-js'
import { getDek, encrypt, byteaWrite } from '../src/lib/crypto.js'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ophnjqjmxeohbyydxnlg.supabase.co'
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9waG5qcWpteGVvaGJ5eWR4bmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI2MzYyMDIsImV4cCI6MjA3ODIxMjIwMn0.ShmVLhmnCYuUBL6f6i1-TnMlpy_3MK4kezetcimA62c'

const DRY   = process.argv.includes('--dry-run')
const FORCE = process.argv.includes('--force')

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON)

  const { data: rows, error } = await supabase.from('qbo_connection')
    .select('id, user_id, entity_id, realm_id, access_token, refresh_token, access_token_enc, refresh_token_enc')
  if (error) throw new Error(`fetch failed: ${error.message}`)
  if (!rows?.length) { console.log('no qbo_connection rows'); return }

  for (const row of rows) {
    const hasEnc = !!(row.access_token_enc && row.refresh_token_enc)
    if (hasEnc && !FORCE) { console.log(`  [skip] ${row.id} — already encrypted`); continue }
    if (!row.access_token || !row.refresh_token) { console.log(`  [skip] ${row.id} — missing plaintext`); continue }

    const dek = await getDek(supabase, row.user_id)
    const at_enc = encrypt(dek, row.access_token)
    const rt_enc = encrypt(dek, row.refresh_token)

    if (DRY) {
      console.log(`  [dry] ${row.id} user=${row.user_id} realm=${row.realm_id} — would write ${at_enc.length}+${rt_enc.length}b encrypted`)
      continue
    }

    const { error: updErr } = await supabase.from('qbo_connection').update({
      access_token_enc:  byteaWrite(at_enc),
      refresh_token_enc: byteaWrite(rt_enc),
    }).eq('id', row.id)
    if (updErr) { console.error(`  ERR ${row.id}: ${updErr.message}`); continue }
    console.log(`  [ok]  ${row.id} user=${row.user_id} realm=${row.realm_id} → ${at_enc.length}+${rt_enc.length}b encrypted`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
