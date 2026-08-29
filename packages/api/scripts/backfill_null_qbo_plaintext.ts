/**
 * One-shot: finish the qbo_connection token cutover.
 *
 * For every row still carrying plaintext access_token/refresh_token:
 *   - if the *_enc columns are missing, encrypt the plaintext into them
 *   - null the plaintext columns
 *
 * RUN MANUALLY against prod with the real env loaded:
 *   eval "$(bash scripts/load-ssm-env.sh)" && npx tsx scripts/backfill_null_qbo_plaintext.ts
 *
 * Pass --apply to write; without it the script only reports what it would do.
 * Safe to re-run. Requires TAX_API_KMS_KEY and SUPABASE_SERVICE_ROLE_KEY.
 */
import '../src/bootstrap_env.js'
import { serviceClient } from '../src/lib/supabase.js'
import { encrypt, getDek, byteaWrite } from '../src/lib/crypto.js'

const APPLY = process.argv.includes('--apply')

async function main() {
  const supabase = serviceClient()
  if (!process.env.TAX_API_KMS_KEY) throw new Error('TAX_API_KMS_KEY required')

  const { data: rows, error } = await supabase.from('qbo_connection')
    .select('id, user_id, access_token, refresh_token, access_token_enc, refresh_token_enc')
    .or('access_token.not.is.null,refresh_token.not.is.null')
  if (error) throw new Error(error.message)

  console.log(`${rows?.length || 0} qbo_connection rows still carry plaintext tokens`)
  for (const row of rows || []) {
    const patch: Record<string, any> = { access_token: null, refresh_token: null }
    if ((!row.access_token_enc || !row.refresh_token_enc) && row.access_token && row.refresh_token) {
      const dek = await getDek(supabase, row.user_id)
      patch.access_token_enc = byteaWrite(encrypt(dek, row.access_token))
      patch.refresh_token_enc = byteaWrite(encrypt(dek, row.refresh_token))
    } else if (!row.access_token_enc || !row.refresh_token_enc) {
      console.warn(`  ${row.id}: no ciphertext AND incomplete plaintext — skipping (needs reconnect)`)
      continue
    }
    if (APPLY) {
      const { error: upErr } = await supabase.from('qbo_connection').update(patch).eq('id', row.id)
      console.log(`  ${row.id}: ${upErr ? 'FAILED ' + upErr.message : 'nulled plaintext' + (patch.access_token_enc ? ' + encrypted' : '')}`)
    } else {
      console.log(`  ${row.id}: would ${patch.access_token_enc ? 'encrypt + ' : ''}null plaintext (dry run)`)
    }
  }
  if (!APPLY) console.log('Dry run complete — re-run with --apply to write.')
}

main().catch(e => { console.error(e); process.exit(1) })
