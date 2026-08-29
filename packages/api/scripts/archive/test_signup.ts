/**
 * End-to-end signup check.
 *
 * There is no Playwright harness in this repo, so this stands in for one: it
 * exercises the real Supabase auth endpoint the SPA calls, asserts the
 * profile row the trigger is supposed to create, and cleans up after itself.
 *
 * Written for the "Database error saving new user" report (SOP 01), where
 * two stale triggers left on auth.users by the April coach-table teardown
 * referenced dropped relations and aborted every signup.
 *
 *   npx tsx scripts/test_signup.ts
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... npx tsx scripts/test_signup.ts
 *
 * Cleanup needs SUPABASE_SERVICE_ROLE_KEY; without it the test still asserts
 * signup works and just reports the orphan user id for manual removal.
 */
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ophnjqjmxeohbyydxnlg.supabase.co'
const ANON = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9waG5qcWpteGVvaGJ5eWR4bmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI2MzYyMDIsImV4cCI6MjA3ODIxMjIwMn0.ShmVLhmnCYuUBL6f6i1-TnMlpy_3MK4kezetcimA62c'
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

const email = `signup-check-${Date.now()}@example.com`
const password = 'TestPassw0rd!x9'

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const run = async () => {
  console.log(`signing up ${email}`)
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const body: any = await res.json().catch(() => ({}))

  check('signup returns 2xx', res.ok, res.ok ? '' : `${res.status} ${body?.msg || body?.error_description || ''}`)
  check('no "Database error saving new user"',
    body?.msg !== 'Database error saving new user',
    body?.msg || '')

  const userId: string | undefined = body?.id || body?.user?.id
  check('signup returns a user id', !!userId)

  // The on_auth_user_created trigger must mirror the row into user_profile;
  // a signup that "succeeds" without a profile row is still broken.
  if (userId && SERVICE) {
    const p = await fetch(
      `${SUPABASE_URL}/rest/v1/user_profile?id=eq.${userId}&select=id,email`,
      { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } },
    )
    const rows: any[] = await p.json().catch(() => [])
    check('user_profile row created by trigger', rows.length === 1, `${rows.length} row(s)`)

    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    })
    console.log('cleaned up test user')
  } else if (userId) {
    console.log(`NOTE: no SUPABASE_SERVICE_ROLE_KEY — could not verify the profile row or clean up user ${userId}`)
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall passed')
  process.exit(failures ? 1 : 0)
}

run().catch(e => { console.error(e); process.exit(1) })
