/**
 * One-shot: encrypt legacy plaintext Stripe keys in place.
 *
 * routes/stripe.ts now writes keys as `enc1:<base64 AES-256-GCM envelope>`
 * inside the text column stripe_key_encrypted, and still READS legacy
 * plaintext rows — but those only re-encrypt when the entity reconnects.
 * This migrates them now.
 *
 * RUN MANUALLY against prod with the real env loaded:
 *   eval "$(bash scripts/load-ssm-env.sh)" && npx tsx scripts/migrate_stripe_enc1.ts
 *
 * Pass --apply to write; without it the script only reports.
 * Safe to re-run (enc1:-prefixed rows are skipped). Requires TAX_API_KMS_KEY.
 */
import '../src/bootstrap_env.js'
import { serviceClient } from '../src/lib/supabase.js'
import { encrypt, getDek } from '../src/lib/crypto.js'

const APPLY = process.argv.includes('--apply')
const PREFIX = 'enc1:'

async function main() {
  const supabase = serviceClient()
  if (!process.env.TAX_API_KMS_KEY) throw new Error('TAX_API_KMS_KEY required')

  const { data: rows, error } = await supabase.from('stripe_connection')
    .select('id, user_id, stripe_key_encrypted')
  if (error) throw new Error(error.message)

  const legacy = (rows || []).filter(r =>
    r.stripe_key_encrypted && !r.stripe_key_encrypted.startsWith(PREFIX))
  console.log(`${legacy.length} of ${rows?.length || 0} stripe_connection rows hold plaintext keys`)

  for (const row of legacy) {
    if (!APPLY) { console.log(`  ${row.id}: would encrypt (dry run)`); continue }
    const dek = await getDek(supabase, row.user_id)
    const sealed = PREFIX + encrypt(dek, row.stripe_key_encrypted).toString('base64')
    const { error: upErr } = await supabase.from('stripe_connection')
      .update({ stripe_key_encrypted: sealed }).eq('id', row.id)
    console.log(`  ${row.id}: ${upErr ? 'FAILED ' + upErr.message : 'encrypted'}`)
  }
  if (!APPLY) console.log('Dry run complete — re-run with --apply to write.')
}

main().catch(e => { console.error(e); process.exit(1) })
