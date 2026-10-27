/**
 * The fictional imported book: a login whose practice is an imported book
 * (provider 'import', services/practice_import.ts), for the import journeys
 * and their tests on prod. Its export is the fixture book written as one
 * (taxnow/fixture.ts fixtureExportCsv): no real taxpayer anywhere.
 *
 * Rebuilt from scratch on every run: the practice is deleted first (its
 * clients, entities, periods, findings, runs and verdicts go with it). With
 * --import 1 (or 2) it also imports that variant of the export, in this
 * process (no job queue); without it the book starts empty and the journey
 * imports through the page.
 *
 *   eval "$(bash scripts/load-ssm-env.sh)"            # PRACTICE_IMPORT_DEMO_* (bootstrap_env loads the rest)
 *   DOTENV_CONFIG_PATH=.env.production npx tsx scripts/practice/seed_import_demo.ts [--import 1|2]
 *
 * Needs PRACTICE_IMPORT_DEMO_EMAIL / _PASSWORD (SSM /tax-api/PRACTICE_IMPORT_DEMO_*),
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, TAX_API_KMS_KEY, and S3 access.
 */
import '../../src/bootstrap_env.js'
import { serviceClient } from '../../src/lib/supabase.js'
import { importInline } from '../../src/services/practice_import.js'
import { PRACTICE_COLS, type Practice } from '../../src/services/practice.js'
import { fixtureExportCsv } from '../../src/taxnow/fixture.js'

const EMAIL = process.env.PRACTICE_IMPORT_DEMO_EMAIL
const PASSWORD = process.env.PRACTICE_IMPORT_DEMO_PASSWORD
if (!EMAIL || !PASSWORD) throw new Error('PRACTICE_IMPORT_DEMO_EMAIL / PRACTICE_IMPORT_DEMO_PASSWORD are not set')
const variant = process.argv.includes('--import') ? Number(process.argv[process.argv.indexOf('--import') + 1]) : 0

const sb = serviceClient()

async function demoUser(): Promise<string> {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw error
    const u = data.users.find(x => x.email?.toLowerCase() === EMAIL!.toLowerCase())
    if (u) return u.id
    if (data.users.length < 200) break
  }
  const { data, error } = await sb.auth.admin.createUser({ email: EMAIL!, password: PASSWORD!, email_confirm: true })
  if (error) throw error
  return data.user.id
}

const userId = await demoUser()
await sb.auth.admin.updateUserById(userId, { password: PASSWORD! })
// In chunks: one cascade over a book of thousands of clients outlasts the
// statement timeout — the practice's entities (the "Client N" shells an
// import makes) included, which would otherwise go in its delete's cascade.
async function ids(table: string, col: string, val: string): Promise<string[]> {
  const out: string[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select('id').eq(col, val).order('id').range(from, from + 999)
    if (error) throw error
    out.push(...(data ?? []).map((r: { id: string }) => r.id))
    if ((data ?? []).length < 1000) return out
  }
}
const del = async (table: string, col: string, vals: string[]) => {
  const { error } = await sb.from(table).delete().in(col, vals)
  if (error) throw error
}
const { data: old } = await sb.from('practice').select('id').eq('user_id', userId)
for (const { id } of old ?? []) {
  const clients = await ids('practice_client', 'practice_id', id)
  for (let i = 0; i < clients.length; i += 100) {
    const part = clients.slice(i, i + 100)
    for (const t of ['taxnow_transcript', 'practice_finding', 'practice_finding_verdict']) await del(t, 'practice_client_id', part)
    await del('practice_client', 'id', part)
  }
  const entities = await ids('tax_entity', 'practice_id', id)
  for (let i = 0; i < entities.length; i += 100) await del('tax_entity', 'id', entities.slice(i, i + 100))
  await del('practice', 'id', [id])
  console.log(`cleared a practice: ${clients.length} clients`)
}
const { data: p, error: pe } = await sb.from('practice').insert({ user_id: userId, name: 'Fictional Imported Book', provider: 'import' }).select(PRACTICE_COLS).single()
if (pe) throw pe
await sb.from('practice_member').insert({ practice_id: p.id, user_id: userId, role: 'owner' })
console.log('practice ready (provider import)')
if (variant === 1 || variant === 2) {
  const run = await importInline(sb, p as Practice, userId, `fictional_export_v${variant}_2026-10-26.csv`, fixtureExportCsv(variant as 1 | 2), '2026-10-26')
  console.log('imported:', run.status, JSON.stringify({ stats: { clients: run.stats?.clients, periods: run.stats?.periods }, findings: run.changes?.findings_after }))
}
