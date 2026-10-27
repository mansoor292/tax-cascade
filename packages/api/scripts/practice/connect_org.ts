/**
 * Bring a TaxNow org Catipult holds a key for into a practice of its own,
 * under a login of its own: create (or find) the login, create its practice
 * reading through that org, claim every account the org can read, and queue
 * a read of each (the server's workers run them: GETs of what TaxNow already
 * holds, never an IRS request).
 *
 * Why (2026-10-27): Mansoor asked for the Better Choice Lenders org "as its
 * own entity under this app", synced and reachable over MCP by other
 * sessions, and chose a new login for it so that login's API key sees that
 * practice and nothing of his. HRLogics will follow the same way.
 *
 * Its accounts' 8821s were signed outside Catipult, so they come in as
 * 'claimed'. TaxNow's record of an 8821 can overstate it (BCL's lists income
 * forms; its 8821s cover Form 941 only — Mansoor, 2026-10-24), so the scope
 * is given here and recorded; IRS requests outside it are refused
 * (formsOutsideScope).
 *
 *   cd packages/api
 *   eval "$(bash scripts/load-ssm-env.sh)"   # TAXNOW_API_KEY_<ORG>, TAXNOW_ORG_ID_<ORG>, PRACTICE_<ORG>_PASSWORD
 *   DOTENV_CONFIG_PATH=.env.production npx tsx scripts/practice/connect_org.ts \
 *     --org bcl --email <login> --name "<practice name>" --payroll 941 [--income 1120,1065] [--go]
 *
 * Without --go it only counts what it would do. Re-running is safe: the
 * login and practice are found, held accounts are skipped. It prints counts,
 * never names or TINs (the org's clients are other businesses' IRS records).
 */
import '../../src/bootstrap_env.js'
import { serviceClient } from '../../src/lib/supabase.js'
import { PRACTICE_COLS, claimAccounts, type Practice } from '../../src/services/practice.js'
import { enqueue } from '../../src/services/practice_jobs.js'
import { ORG_NAME, TaxNowError, taxnowFor } from '../../src/taxnow/client.js'

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const forms = (v: string | undefined) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean)

const org = arg('org') ?? ''
const email = arg('email') ?? ''
const name = arg('name') ?? ''
const scope = { income: forms(arg('income')), payroll: forms(arg('payroll')) }
const go = process.argv.includes('--go')
if (!ORG_NAME.test(org) || org === 'platform') throw new Error('--org: the org\'s name, e.g. bcl (not platform)')
if (!/^[^@\s]+@[^@\s]+$/.test(email) || !name.trim()) throw new Error('--email and --name are required')
if (!scope.income.length && !scope.payroll.length) throw new Error('Give the scope its 8821s cover: --payroll 941 and/or --income ...')
const password = process.env[`PRACTICE_${org.toUpperCase()}_PASSWORD`]

const sb = serviceClient()

async function findUser(): Promise<string | null> {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw error
    const u = data.users.find(x => x.email?.toLowerCase() === email.toLowerCase())
    if (u) return u.id
    if (data.users.length < 200) break
  }
  return null
}

async function main() {
  const tn = await taxnowFor('taxnow', org)
  const listed = await tn.listAccounts()
  console.log(`org ${org}: ${listed.length} accounts listed`)

  let userId = await findUser()
  console.log(userId ? 'login: exists' : 'login: to create')
  if (!go) {
    let readable = 0
    for (const a of listed) {
      try { await tn.getAccount(a.accountId); readable++ } catch (e) { if (!(e instanceof TaxNowError && e.status === 403)) throw e }
    }
    console.log(`readable: ${readable}, unreadable (403): ${listed.length - readable}`)
    console.log(`scope to record: income [${scope.income}] payroll [${scope.payroll}]`)
    console.log('dry run — pass --go to create the login and practice and claim the accounts')
    return
  }

  if (!userId) {
    if (!password) throw new Error(`PRACTICE_${org.toUpperCase()}_PASSWORD is not set (SSM /tax-api/)`)
    const { data, error } = await sb.auth.admin.createUser({ email, password, email_confirm: true })
    if (error) throw error
    userId = data.user.id
    console.log('login: created')
  }

  let { data: p } = await sb.from('practice').select(PRACTICE_COLS).eq('user_id', userId).maybeSingle()
  if (p && p.taxnow_org !== org) throw new Error(`This login's practice reads through '${p.taxnow_org}', not '${org}'.`)
  if (!p) {
    const { data, error } = await sb.from('practice').insert({ user_id: userId, name: name.trim(), provider: 'taxnow', taxnow_org: org }).select(PRACTICE_COLS).single()
    if (error) throw error
    await sb.from('practice_member').insert({ practice_id: data.id, user_id: userId, role: 'owner' })
    p = data
    console.log('practice: created')
  } else console.log('practice: exists')

  const r = await claimAccounts(sb, p as Practice, 'all', { scope })
  console.log(`claimed ${r.claimed}, already held ${r.skipped}, unreadable ${r.unreadable}`)
  // Every claimed client, not only the new ones: a re-run re-reads them all.
  const { data: held } = await sb.from('practice_client').select('id').eq('practice_id', p!.id).eq('stage', 'claimed')
  for (const c of held ?? []) await enqueue(sb, { kind: 'read_client', practice_id: p!.id, user_id: userId, payload: { client_id: c.id } })
  console.log(`reads queued: ${(held ?? []).length}`)
}

main().then(() => process.exit(0), e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
