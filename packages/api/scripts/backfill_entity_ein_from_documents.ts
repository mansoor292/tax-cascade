/**
 * Backfill tax_entity.ein from already-ingested filed returns.
 *
 * Client finding (SOP-02 retest, 2026-09-02): entities created during
 * connector ingest carried no EIN even though every uploaded return's
 * extraction captured it (document.meta.ein_or_ssn) — so a model reading
 * the entity list truthfully said "no EIN on file" about records whose
 * identifier sat in the vault all along. New ingests backfill in
 * services/document_extraction.ts; this script repairs rows ingested
 * before that change.
 *
 * Rules:
 *  - Only entities whose ein is EMPTY (plaintext null and no ein_enc) are
 *    touched — an operator-entered EIN always wins over OCR.
 *  - The value comes from that entity's own prior_return_* documents,
 *    newest tax year first.
 *  - Writes go through encryptedFields + blindIndex, exactly like the
 *    entity routes.
 *
 * DRY RUN by default — prints what it would do (last-4 only). Pass --apply
 * to write. Run manually with prod env loaded:
 *   eval "$(bash scripts/load-ssm-env.sh)" && \
 *   SUPABASE_URL=... TAX_API_KMS_KEY=alias/tax-api-master \
 *   npx tsx scripts/backfill_entity_ein_from_documents.ts [--apply]
 */
import { serviceClient } from '../src/lib/supabase.js'
import {
  encryptedFields, encryptionEnabled, hydrate, hydrateAll,
  ENCRYPTED_DOC_FIELDS, ENCRYPTED_ENTITY_FIELDS,
} from '../src/lib/row_crypto.js'
import { blindIndex } from '../src/lib/crypto.js'

const APPLY = process.argv.includes('--apply')
const last4 = (v: string) => `…${v.replace(/\D/g, '').slice(-4)}`

const supabase = serviceClient()

const { data: entities, error } = await supabase.from('tax_entity').select('*')
if (error) throw new Error(error.message)

let candidates = 0
let updated = 0
for (const ent of entities || []) {
  await hydrate(supabase, ent, ENCRYPTED_ENTITY_FIELDS)
  if (ent.ein) continue // has one (possibly via decryption) — never overwrite

  const { data: docs } = await supabase.from('document')
    .select('*')
    .eq('entity_id', ent.id)
    .like('doc_type', 'prior_return_%')
    .order('tax_year', { ascending: false })
  if (!docs?.length) continue
  await hydrateAll(supabase, docs, ENCRYPTED_DOC_FIELDS)

  const source = docs.find((d: any) => d.meta?.ein_or_ssn)
  if (!source) continue

  candidates++
  const einVal = String(source.meta.ein_or_ssn)
  console.log(`${APPLY ? 'APPLY' : 'DRY'}  ${ent.name} (${ent.form_type}) ← ${last4(einVal)} from ${source.doc_type} ${source.tax_year}`)

  if (!APPLY) continue
  const einEnc = await encryptedFields(supabase, ent.user_id, { ein: einVal }, ENCRYPTED_ENTITY_FIELDS)
  const { error: upErr } = await supabase.from('tax_entity').update({
    ein: einVal,
    ein_hash: (encryptionEnabled() && process.env.TAX_API_BLIND_HMAC) ? blindIndex(einVal) : null,
    ...einEnc,
  }).eq('id', ent.id)
  if (upErr) console.error(`  FAILED: ${upErr.message}`)
  else updated++
}

console.log(`\n${candidates} candidate(s); ${APPLY ? `${updated} updated` : 'dry run, nothing written (pass --apply)'}`)
