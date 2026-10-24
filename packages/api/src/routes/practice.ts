/**
 * Practice routes (services/practice.ts): one preparer's clients, read and
 * onboarded through the platform TaxNow org.
 *
 *   GET   /api/practice                     the practice (404 when none yet)
 *   POST  /api/practice                     create it {name}
 *   PATCH /api/practice                     name, designee_mode, designee (CAF details)
 *   GET   /api/practice/clients             every client with its roll-up
 *   POST  /api/practice/clients             new client {name, form_type, tin?, year_end_month?, scope?}
 *   GET   /api/practice/clients/:id         one client: transcripts, findings
 *   GET   /api/practice/clients/:id/8821.pdf      the client's Form 8821, filled (full TIN while pending)
 *   POST  /api/practice/clients/:id/sign-link     a fresh signature link (token shown once)
 *   POST  /api/practice/clients/:id/sign          sign in the app {signer_name, signer_title, typed_signature, agree}
 *   POST  /api/practice/clients/:id/verify        the signer is here: start their identity check {ssn} → {url}
 *   POST  /api/practice/clients/:id/proof         a business signer's proof they belong to it {file_name, content_base64}
 *   POST  /api/practice/clients/:id/id-verified   platform admins only: a check made outside Didit {method}
 *   POST  /api/practice/clients/:id/submitted     the signed 8821 went in; daily checks begin
 *   POST  /api/practice/clients/:id/check         run the onboarding check now
 *   POST  /api/practice/clients/:id/read          queue a read from TaxNow (no IRS request)
 *   POST  /api/practice/clients/:id/irs-requests  {transcripts:[{type,form,year,month}], confirm:true}
 *                                                  REAL IRS requests under the designee's CAF
 *   GET   /api/practice/opportunities       every finding across clients
 *   GET   /api/practice/coverage            the TaxNow page: access, ages, refusals, onboarding
 *   GET   /api/practice/jobs/:id            one background job's state
 *   POST  /api/practice/claim               admin only: assign platform-org accounts {account_ids | all:true}
 *
 * Nothing here returns a full TIN: it is write-only (POST clients) and wiped
 * once the client is readable. Mounted ahead of the SPA fallback (root
 * CLAUDE.md, fact 2).
 */
import { Router } from 'express'
import { sendError } from '../lib/http_error.js'
import { lazyServiceClient, requestUserId as getUser } from '../lib/supabase.js'
import {
  PracticeError, claimAccounts, clientDetail, coverage, createClient, createPractice, designeeOf, getPractice, isPlatformAdmin,
  form8821, issueSignLink, listClients, markIdVerified, markSubmitted, onboardingCheck, opportunities, requirePractice, signInApp, updatePractice,
} from '../services/practice.js'
import { enqueue, type TranscriptKey } from '../services/practice_jobs.js'
import { refreshCheck, returnOrigin, startCheck } from '../services/signer_idv.js'
import { proofView, submitProof } from '../services/signer_proof.js'

const supabase = lazyServiceClient()
const router = Router()

type Handler = (req: any, res: any, userId: string) => Promise<unknown>
const handle = (fn: Handler) => async (req: any, res: any) => {
  const userId = await getUser(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  try {
    await fn(req, res, userId)
  } catch (e: any) {
    if (e instanceof PracticeError) return res.status(e.status).json({ error: e.message })
    sendError(res, e)
  }
}

router.get('/', handle(async (_req, res, userId) => {
  const p = await getPractice(supabase, userId)
  if (!p) return res.status(404).json({ error: 'No practice yet.', admin: isPlatformAdmin(userId) })
  res.json({ practice: { id: p.id, name: p.name, designee_mode: p.designee_mode, designee: p.designee, provider: p.provider }, designee: designeeOf(p), admin: isPlatformAdmin(userId) })
}))

router.post('/', handle(async (req, res, userId) => {
  const p = await createPractice(supabase, userId, String(req.body?.name ?? ''))
  res.status(201).json({ practice: { id: p.id, name: p.name, designee_mode: p.designee_mode, designee: p.designee, provider: p.provider } })
}))

router.patch('/', handle(async (req, res, userId) => {
  const p = await updatePractice(supabase, await requirePractice(supabase, userId), req.body ?? {})
  res.json({ practice: { id: p.id, name: p.name, designee_mode: p.designee_mode, designee: p.designee, provider: p.provider }, designee: designeeOf(p) })
}))

router.get('/clients', handle(async (_req, res, userId) => {
  res.json({ clients: await listClients(supabase, await requirePractice(supabase, userId)) })
}))

router.post('/clients', handle(async (req, res, userId) => {
  const p = await requirePractice(supabase, userId)
  res.status(201).json(await createClient(supabase, p, req.body ?? {}))
}))

router.get('/clients/:id', handle(async (req, res, userId) => {
  const p = await requirePractice(supabase, userId)
  let d = await clientDetail(supabase, p, req.params.id)
  // A signer's identity check still running: pull its result from Didit.
  if (d.client.signer?.idv?.status === 'started') {
    await refreshCheck(supabase, req.params.id)
    d = await clientDetail(supabase, p, req.params.id)
  }
  res.json(d)
}))

router.get('/clients/:id/8821.pdf', handle(async (req, res, userId) => {
  const r = await form8821(supabase, await requirePractice(supabase, userId), req.params.id, { fullTin: true })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`)
  res.setHeader('Cache-Control', 'no-store')
  res.send(Buffer.from(r.pdf))
}))

router.post('/clients/:id/sign-link', handle(async (req, res, userId) => {
  const r = await issueSignLink(supabase, await requirePractice(supabase, userId), req.params.id)
  res.json({ path: `/sign/${r.token}`, expires: r.expires })
}))

router.post('/clients/:id/sign', handle(async (req, res, userId) => {
  res.json(await signInApp(supabase, await requirePractice(supabase, userId), req.params.id, req.body ?? {}, userId))
}))

router.post('/clients/:id/verify', handle(async (req, res, userId) => {
  const p = await requirePractice(supabase, userId)
  res.json(await startCheck(supabase, p, req.params.id, req.body?.ssn, `${returnOrigin(req.get('origin'))}/app/practice/clients/${req.params.id}`))
}))

router.post('/clients/:id/proof', handle(async (req, res, userId) => {
  res.json(proofView(await submitProof(supabase, await requirePractice(supabase, userId), req.params.id, req.body ?? {})))
}))

router.post('/clients/:id/id-verified', handle(async (req, res, userId) => {
  if (!isPlatformAdmin(userId)) throw new PracticeError(403, 'Only Catipult staff can record a check made outside the identity service.')
  res.json(await markIdVerified(supabase, await requirePractice(supabase, userId), req.params.id, String(req.body?.method ?? 'manual')))
}))

router.post('/clients/:id/submitted', handle(async (req, res, userId) => {
  res.json(await markSubmitted(supabase, await requirePractice(supabase, userId), req.params.id))
}))

router.post('/clients/:id/check', handle(async (req, res, userId) => {
  const p = await requirePractice(supabase, userId)
  await clientDetail(supabase, p, req.params.id) // ownership
  const r = await onboardingCheck(supabase, req.params.id)
  const job = r.found ? await enqueue(supabase, { kind: 'read_client', practice_id: p.id, user_id: userId, payload: { client_id: req.params.id } }) : null
  res.json({ ...r, job_id: job })
}))

router.post('/clients/:id/read', handle(async (req, res, userId) => {
  const p = await requirePractice(supabase, userId)
  const d = await clientDetail(supabase, p, req.params.id)
  if (!['readable', 'claimed'].includes(d.client.stage)) throw new PracticeError(409, 'TaxNow cannot read this client yet.')
  res.status(202).json({ job_id: await enqueue(supabase, { kind: 'read_client', practice_id: p.id, user_id: userId, payload: { client_id: req.params.id } }) })
}))

const FORMS = new Set(['1120', '1065', '1040', '940', '941', '943', '944', '990'])
router.post('/clients/:id/irs-requests', handle(async (req, res, userId) => {
  if (req.body?.confirm !== true) throw new PracticeError(400, 'An IRS request needs confirm: true from the person sending it.')
  const ts = (req.body?.transcripts ?? []) as TranscriptKey[]
  if (!Array.isArray(ts) || !ts.length || ts.length > 60) throw new PracticeError(400, 'transcripts: 1 to 60 periods.')
  for (const t of ts) {
    if (!['ACTR', 'RETR'].includes(t.type) || !FORMS.has(String(t.form)) || !Number.isInteger(+t.year) || !(+t.month >= 1 && +t.month <= 12)) throw new PracticeError(400, 'Each transcript is {type, form, year, month}.')
  }
  const p = await requirePractice(supabase, userId)
  const d = await clientDetail(supabase, p, req.params.id)
  if (!['readable', 'claimed'].includes(d.client.stage)) throw new PracticeError(409, 'TaxNow cannot read this client yet.')
  const job = await enqueue(supabase, {
    kind: 'irs_request', practice_id: p.id, user_id: userId, confirmed_by: userId,
    payload: { client_id: req.params.id, transcripts: ts.map(t => ({ type: t.type, form: String(t.form), year: +t.year, month: +t.month })) },
  })
  res.status(202).json({ job_id: job, count: ts.length })
}))

router.get('/opportunities', handle(async (_req, res, userId) => {
  res.json({ findings: await opportunities(supabase, await requirePractice(supabase, userId)) })
}))

router.get('/coverage', handle(async (_req, res, userId) => {
  res.json(await coverage(supabase, await requirePractice(supabase, userId)))
}))

router.get('/jobs/:id', handle(async (req, res, userId) => {
  const { data } = await supabase.from('taxnow_job').select('id, kind, status, result, error, created_at, finished_at, user_id').eq('id', req.params.id).maybeSingle()
  if (!data || data.user_id !== userId) return res.status(404).json({ error: 'No such job.' })
  const { user_id: _u, ...job } = data
  res.json({ job })
}))

router.post('/claim', handle(async (req, res, userId) => {
  if (!isPlatformAdmin(userId)) return res.status(403).json({ error: 'Admins only.' })
  const p = await requirePractice(supabase, userId)
  const ids = req.body?.all === true ? 'all' as const : (req.body?.account_ids ?? [])
  if (ids !== 'all' && (!Array.isArray(ids) || !ids.length)) throw new PracticeError(400, 'account_ids, or all: true.')
  const r = await claimAccounts(supabase, p, ids)
  for (const id of r.client_ids) await enqueue(supabase, { kind: 'read_client', practice_id: p.id, user_id: userId, payload: { client_id: id } })
  res.json(r)
}))

export default router
