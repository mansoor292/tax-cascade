/**
 * Remove production rows left behind by the e2e suite.
 *
 * `deleteUserByEmail` deletes the auth user and nothing else, and the
 * tax_entity → auth.users reference does not cascade, so every run against
 * prod leaves its entity, returns, documents and scenarios behind. They
 * accumulated at one 1120-S per CI run.
 *
 * Identification is by the suite's OWN marker — `testEmail()` mints
 * `e2e-<tag>-<ms>-<rand>@example.com`, and example.com is reserved by RFC 2606
 * so no real account can hold one. Names are useless for this ('Owner',
 * 'Compute'), and orphanhood turned out to be useless too: the accounts are
 * still live, so nothing was orphaned in the first place.
 *
 * Dry run by default. Pass --apply to delete.
 */
import '../src/bootstrap_env.js'
import { serviceClient } from '../src/lib/supabase.js'

const APPLY = process.argv.includes('--apply')
const sb = serviceClient()

const SUPABASE_URL = process.env.SUPABASE_URL!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!

/** Exactly what testEmail() mints — nothing else may match. */
const E2E_EMAIL = /^e2e-[a-z0-9-]+-\d{13}-\d{1,4}@example\.com$/i

// ── Auth users ──
const allUsers: Array<{ id: string; email: string }> = []
for (let page = 1; ; page++) {
  const res = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=1000`,
    { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } },
  )
  if (!res.ok) { console.error('auth list failed:', res.status, await res.text()); process.exit(1) }
  const body: any = await res.json()
  const users: any[] = body?.users || []
  for (const u of users) allUsers.push({ id: u.id, email: u.email || '' })
  if (users.length < 1000) break
}
const liveUserIds = new Set(allUsers.map(u => u.id))
const e2eUsers = allUsers.filter(u => E2E_EMAIL.test(u.email))
const e2eUserIds = new Set(e2eUsers.map(u => u.id))
console.log(`auth users: ${allUsers.length} total, ${e2eUsers.length} minted by the e2e suite`)

// ── Entities owned by an e2e account, or by nobody at all ──
const { data: entities, error } = await sb.from('tax_entity').select('id, name, user_id, created_at')
if (error) { console.error('entity query failed:', error.message); process.exit(1) }

const orphans = (entities || []).filter((e: any) =>
  (e.user_id && e2eUserIds.has(e.user_id)) || !e.user_id || !liveUserIds.has(e.user_id))
console.log(`entities: ${entities?.length ?? 0} total, ${orphans.length} owned by e2e accounts or orphaned\n`)
if (!orphans.length && !e2eUsers.length) process.exit(0)

const orphanIds = orphans.map((e: any) => e.id)

// ── What hangs off them ──
const chunk = <T,>(xs: T[], n: number) => xs.length <= n ? [xs]
  : Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))

async function idsFor(table: string): Promise<string[]> {
  const out: string[] = []
  for (const batch of chunk(orphanIds, 100)) {
    const { data, error: e } = await sb.from(table).select('id').in('entity_id', batch)
    if (e) { console.error(`${table} query failed:`, e.message); process.exit(1) }
    out.push(...(data || []).map((r: any) => r.id))
  }
  return out
}

const returnIds = await idsFor('tax_return')
const documentIds = await idsFor('document')
const scenarioIds = await idsFor('scenario')
const obligationIds = await idsFor('obligation')

const byName = new Map<string, number>()
for (const e of orphans as any[]) byName.set(e.name, (byName.get(e.name) || 0) + 1)
console.log('entities to REMOVE, by name:')
for (const [name, n] of [...byName].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${name}`)
}
console.log(`\nattached rows — returns ${returnIds.length}, documents ${documentIds.length}, ` +
  `scenarios ${scenarioIds.length}, obligations ${obligationIds.length}`)

// Always print the other side of the ledger: a cleanup that silently widened
// its net would be invisible from the list above alone.
const doomed = new Set(orphanIds)
console.log('\nentities to KEEP:')
for (const e of (entities || []) as any[]) {
  if (doomed.has(e.id)) continue
  console.log(`  ${e.name}  (${e.created_at?.slice(0, 10)})`)
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing deleted. Re-run with --apply to remove the above.')
  process.exit(0)
}

// ── Delete children before parents ──
async function del(table: string, ids: string[]) {
  let n = 0
  for (const batch of chunk(ids, 100)) {
    if (!batch.length) continue
    const { error: e } = await sb.from(table).delete().in('id', batch)
    if (e) { console.error(`delete ${table} failed:`, e.message); process.exit(1) }
    n += batch.length
  }
  console.log(`deleted ${n} from ${table}`)
}

await del('tax_return', returnIds)
await del('document', documentIds)
await del('scenario', scenarioIds)
await del('obligation', obligationIds)
await del('tax_entity', orphanIds)

// Finally the accounts themselves, which is what teardown was meant to do.
let deletedUsers = 0
for (const u of e2eUsers) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, {
    method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  })
  if (res.ok) deletedUsers++
  else console.error(`  user ${u.id}: ${res.status} ${await res.text()}`)
}
console.log(`deleted ${deletedUsers}/${e2eUsers.length} e2e auth users`)
console.log('\ndone.')
