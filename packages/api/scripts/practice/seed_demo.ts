/**
 * The fictional demo practice: a login whose practice reads the in-process
 * fixture TaxNow (src/taxnow/fixture.ts), so the practice journeys can be
 * clicked through — and tested on prod — without any real taxpayer's data.
 *
 * Kept small on purpose (Mansoor, 2026-10-24: "just something to run tests
 * on"): the seven fixture accounts, brought in and read; one client waiting
 * on a signature; one submitted and still being checked; Calloway Imaging's
 * fiscal 1065 periods requested and refused (451), as the IRS does when an
 * 8821 lists December year-ends.
 *
 * Rebuilt from scratch on every run: the practice is deleted first (its
 * entities, clients, transcripts and findings go with it).
 *
 *   eval "$(bash scripts/load-ssm-env.sh)"            # PRACTICE_DEMO_* (bootstrap_env loads the rest)
 *   DOTENV_CONFIG_PATH=.env.production
 *   npx tsx scripts/practice/seed_demo.ts
 *
 * Needs PRACTICE_DEMO_EMAIL and PRACTICE_DEMO_PASSWORD (SSM /tax-api/PRACTICE_DEMO_*),
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, and TAX_API_KMS_KEY (the pending
 * TIN is stored encrypted or not at all).
 */
import '../../src/bootstrap_env.js'
import { serviceClient } from '../../src/lib/supabase.js'
import { claimAccounts, createClient, issueSignLink, signInApp, markIdVerified, markSubmitted, type Practice } from '../../src/services/practice.js'
import { readClient, type ClientRow } from '../../src/services/practice_read.js'
import { runJob } from '../../src/services/practice_jobs.js'

const EMAIL = process.env.PRACTICE_DEMO_EMAIL
const PASSWORD = process.env.PRACTICE_DEMO_PASSWORD
if (!EMAIL || !PASSWORD) throw new Error('PRACTICE_DEMO_EMAIL / PRACTICE_DEMO_PASSWORD are not set')

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

async function main() {
  const userId = await demoUser()
  await sb.from('practice').delete().eq('user_id', userId)
  const { data: p, error } = await sb.from('practice').insert({
    user_id: userId, name: 'Harborview Tax Group (demo)', provider: 'fixture', designee_mode: 'own',
    designee: { name: 'Dana Fictional, EA', caf: '0000-00000R', address: '1 Example Way', city: 'Springfield', state: 'IL', zip: '62701', phone: '555-0100' },
  }).select('id, user_id, name, designee_mode, designee, provider').single()
  if (error) throw error
  await sb.from('practice_member').insert({ practice_id: p.id, user_id: userId, role: 'owner' })
  const practice = p as Practice

  const claimed = await claimAccounts(sb, practice, 'all')
  for (const id of claimed.client_ids) {
    const { data: c } = await sb.from('practice_client').select('id, practice_id, user_id, entity_id, stage, taxnow_account_id, tin_last4').eq('id', id).single()
    const r = await readClient(sb, c as ClientRow, 'fixture')
    console.log(`read ${c!.taxnow_account_id}: ${r.transcripts} transcripts, ${r.findings} findings`)
  }

  // Calloway Imaging: its fiscal 1065 periods, requested and refused (IRS 451).
  const { data: calloway } = await sb.from('practice_client').select('id').eq('practice_id', p.id).eq('taxnow_account_id', 'fx-calloway').single()
  await runJob(sb, {
    id: 'seed', kind: 'irs_request', practice_id: p.id, user_id: userId, confirmed_by: userId,
    payload: { client_id: calloway!.id, transcripts: [3, 6, 9].map(m => ({ type: 'ACTR', form: '1065', year: 2024, month: m })) },
  })

  // Onboarding: one waiting on a signature, one submitted and not found yet
  // (an odd last digit: the fixture's TIN search does not find it).
  const waiting = await createClient(sb, practice, { name: 'Tallow & Pine Interiors', form_type: '1120S' })
  await issueSignLink(sb, practice, waiting.id)
  const submitted = await createClient(sb, practice, { name: 'Bluegill Landscaping LLC', form_type: '1120S', tin: '000000003' })
  await signInApp(sb, practice, submitted.id, { signer_name: 'Pat Example', signer_title: 'Managing member', typed_signature: 'Pat Example', agree: true }, userId)
  await markIdVerified(sb, practice, submitted.id, 'demo')
  await markSubmitted(sb, practice, submitted.id)
  console.log(`demo practice ${p.id}: ${claimed.claimed} clients read, 2 onboarding`)
}

main().catch(e => { console.error(e); process.exit(1) })
