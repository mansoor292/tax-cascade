/**
 * Finish the plaintext → ciphertext cutover.
 *
 * row_crypto.ts has been dual-writing plaintext AND `_enc` since encryption
 * was introduced, with the intent (stated in its own header) that "a later
 * cutover nulls plaintext". That cutover never ran, so every encrypted column
 * still has a readable twin and the threat model in crypto.ts — "DB dump /
 * backup exfiltration → ciphertext only" — does not hold.
 *
 * This is destructive, so it is staged and refuses to skip a step:
 *
 *   audit     what state is every column in
 *   backfill  encrypt values that exist ONLY as plaintext
 *   verify    decrypt every _enc and compare it to its plaintext, row by row
 *   cutover   null the plaintext — only if verify passed 100% in THIS run
 *
 * Run on the server, where TAX_API_KMS_KEY is configured:
 *   node --import tsx scripts/encryption_cutover.ts audit
 */
import '../src/bootstrap_env.js'
import { createClient } from '@supabase/supabase-js'
import { getDek, encrypt, decryptJson, decryptString, bytea, byteaWrite } from '../src/lib/crypto.js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

type Kind = 'json' | 'text'
interface Target {
  table: string
  columns: { name: string; kind: Kind }[]
  /** How to reach the owning user from a row of this table. */
  owner: 'user_id' | 'via_entity'
}

const TARGETS: Target[] = [
  {
    table: 'tax_return',
    // tax_return carries no user_id — ownership runs through its entity.
    owner: 'via_entity',
    columns: [
      { name: 'input_data', kind: 'json' },
      { name: 'computed_data', kind: 'json' },
      { name: 'field_values', kind: 'json' },
      { name: 'verification', kind: 'json' },
    ],
  },
  { table: 'tax_entity', owner: 'user_id', columns: [{ name: 'ein', kind: 'text' }] },
  {
    table: 'document', owner: 'user_id',
    columns: [{ name: 'meta', kind: 'json' }, { name: 'textract_data', kind: 'json' }],
  },
  {
    table: 'qbo_connection', owner: 'user_id',
    columns: [{ name: 'access_token', kind: 'text' }, { name: 'refresh_token', kind: 'text' }],
  },
]

/** Key order is not meaningful in JSONB; compare structure, not spelling. */
function canonical(v: unknown): string {
  const walk = (x: any): any => {
    if (x === null || typeof x !== 'object') return x
    if (Array.isArray(x)) return x.map(walk)
    return Object.keys(x).sort().reduce((o: any, k) => { o[k] = walk(x[k]); return o }, {})
  }
  return JSON.stringify(walk(v))
}

let entityOwner: Map<string, string> | null = null
async function ownerOf(target: Target, row: any): Promise<string | null> {
  if (target.owner === 'user_id') return row.user_id ?? null
  if (!entityOwner) {
    const { data } = await supabase.from('tax_entity').select('id, user_id')
    entityOwner = new Map((data || []).map((e: any) => [e.id, e.user_id]))
  }
  return entityOwner.get(row.entity_id) ?? null
}

async function loadRows(t: Target) {
  const cols = ['id', t.owner === 'user_id' ? 'user_id' : 'entity_id',
    ...t.columns.flatMap(c => [c.name, `${c.name}_enc`])].join(', ')
  const { data, error } = await supabase.from(t.table).select(cols)
  if (error) throw new Error(`${t.table}: ${error.message}`)
  return (data || []) as any[]
}

interface Stat { both: number; plaintextOnly: number; encOnly: number; empty: number; noOwner: number }
const blank = (): Stat => ({ both: 0, plaintextOnly: 0, encOnly: 0, empty: 0, noOwner: 0 })

async function audit() {
  console.log('\n=== AUDIT ===\n')
  let backfillNeeded = 0
  for (const t of TARGETS) {
    const rows = await loadRows(t)
    for (const c of t.columns) {
      const s = blank()
      for (const r of rows) {
        const hasP = r[c.name] !== null && r[c.name] !== undefined
        const hasE = r[`${c.name}_enc`] !== null && r[`${c.name}_enc`] !== undefined
        if (hasP && hasE) s.both++
        else if (hasP && !hasE) { s.plaintextOnly++; if (!(await ownerOf(t, r))) s.noOwner++ }
        else if (!hasP && hasE) s.encOnly++
        else s.empty++
      }
      backfillNeeded += s.plaintextOnly
      const flag = s.plaintextOnly ? '  <-- NEEDS BACKFILL' : ''
      console.log(
        `${(t.table + '.' + c.name).padEnd(32)} both=${String(s.both).padStart(3)} ` +
        `plaintext_only=${String(s.plaintextOnly).padStart(3)} enc_only=${String(s.encOnly).padStart(3)} ` +
        `empty=${String(s.empty).padStart(3)}${flag}`,
      )
      if (s.noOwner) console.log(`${''.padEnd(32)} ${s.noOwner} of those have no resolvable owner — cannot encrypt`)
    }
  }
  console.log(`\nrows needing backfill before cutover: ${backfillNeeded}`)
}

async function backfill(apply: boolean) {
  console.log(`\n=== BACKFILL ${apply ? '(applying)' : '(dry run)'} ===\n`)
  let done = 0, skipped = 0
  for (const t of TARGETS) {
    const rows = await loadRows(t)
    for (const r of rows) {
      const patch: Record<string, string> = {}
      for (const c of t.columns) {
        const hasP = r[c.name] !== null && r[c.name] !== undefined
        const hasE = r[`${c.name}_enc`] !== null && r[`${c.name}_enc`] !== undefined
        if (!hasP || hasE) continue
        const userId = await ownerOf(t, r)
        if (!userId) { console.log(`  SKIP ${t.table}.${c.name} ${r.id} — no owner`); skipped++; continue }
        const dek = await getDek(supabase, userId)
        const value = c.kind === 'json' ? r[c.name] : String(r[c.name])
        patch[`${c.name}_enc`] = byteaWrite(encrypt(dek, value))
      }
      if (!Object.keys(patch).length) continue
      console.log(`  ${apply ? 'encrypt' : 'would encrypt'} ${t.table} ${r.id}: ${Object.keys(patch).join(', ')}`)
      if (apply) {
        const { error } = await supabase.from(t.table).update(patch).eq('id', r.id)
        if (error) throw new Error(`backfill ${t.table} ${r.id}: ${error.message}`)
      }
      done++
    }
  }
  console.log(`\n${apply ? 'backfilled' : 'would backfill'} ${done} row(s); skipped ${skipped}`)
  return skipped === 0
}

/** Decrypt every ciphertext and compare it to the plaintext it claims to mirror. */
async function verify(): Promise<boolean> {
  console.log('\n=== VERIFY ===\n')
  let checked = 0, mismatch = 0, undecryptable = 0, unprotected = 0
  for (const t of TARGETS) {
    const rows = await loadRows(t)
    for (const r of rows) {
      for (const c of t.columns) {
        const p = r[c.name]
        const e = r[`${c.name}_enc`]
        const hasP = p !== null && p !== undefined
        const hasE = e !== null && e !== undefined
        if (!hasP) continue
        if (!hasE) {
          console.log(`  UNPROTECTED ${t.table}.${c.name} ${r.id} — plaintext with no ciphertext`)
          unprotected++
          continue
        }
        const userId = await ownerOf(t, r)
        if (!userId) { console.log(`  NO OWNER ${t.table} ${r.id}`); undecryptable++; continue }
        let got: any
        try {
          const dek = await getDek(supabase, userId)
          got = c.kind === 'json' ? decryptJson(dek, bytea(e)) : decryptString(dek, bytea(e))
        } catch (err: any) {
          console.log(`  UNDECRYPTABLE ${t.table}.${c.name} ${r.id}: ${err.message}`)
          undecryptable++
          continue
        }
        const same = c.kind === 'json'
          ? canonical(got) === canonical(p)
          : String(got) === String(p)
        checked++
        if (!same) {
          mismatch++
          // Never print the values themselves — lengths are enough to triage.
          const a = c.kind === 'json' ? canonical(got).length : String(got ?? '').length
          const b = c.kind === 'json' ? canonical(p).length : String(p).length
          console.log(`  MISMATCH ${t.table}.${c.name} ${r.id} (decrypted ${a} chars vs plaintext ${b})`)
        }
      }
    }
  }
  const ok = mismatch === 0 && undecryptable === 0 && unprotected === 0
  console.log(`\nchecked ${checked} value(s): ${mismatch} mismatch, ${undecryptable} undecryptable, ${unprotected} unprotected`)
  console.log(ok ? 'VERIFY PASSED — every plaintext is recoverable from its ciphertext'
                 : 'VERIFY FAILED — cutover must not proceed')
  return ok
}

async function cutover(apply: boolean) {
  const ok = await verify()
  if (!ok) {
    console.error('\nRefusing to null plaintext: verification did not pass.')
    process.exit(1)
  }
  console.log(`\n=== CUTOVER ${apply ? '(applying)' : '(dry run)'} ===\n`)
  let cleared = 0
  for (const t of TARGETS) {
    const rows = await loadRows(t)
    for (const r of rows) {
      const patch: Record<string, null> = {}
      for (const c of t.columns) {
        if (r[c.name] !== null && r[c.name] !== undefined) patch[c.name] = null
      }
      if (!Object.keys(patch).length) continue
      if (apply) {
        const { error } = await supabase.from(t.table).update(patch).eq('id', r.id)
        if (error) throw new Error(`cutover ${t.table} ${r.id}: ${error.message}`)
      }
      cleared++
    }
    console.log(`  ${t.table}: ${apply ? 'cleared' : 'would clear'} plaintext on ${rows.length} scanned row(s)`)
  }
  console.log(`\n${apply ? 'cleared' : 'would clear'} plaintext on ${cleared} row(s)`)
}

const mode = process.argv[2]
const apply = process.argv.includes('--apply')
const run = async () => {
  switch (mode) {
    case 'audit':    return audit()
    case 'backfill': return void (await backfill(apply))
    case 'verify':   return void (await verify())
    case 'cutover':  return cutover(apply)
    default:
      console.error('usage: encryption_cutover.ts audit|backfill|verify|cutover [--apply]')
      process.exit(1)
  }
}
run().catch(e => { console.error('FAILED:', e); process.exit(1) })
