/**
 * The public 8821 signature link (services/practice.ts signRequest,
 * submitSignature). No login: the token in the path is the only credential.
 * A preparer copies the link to the client (2026-10-24: copy and paste, no
 * email from the product). Only the token's hash is stored, it expires in 14
 * days, a new link replaces the old one, and signing consumes it.
 *
 *   GET  /api/sign/:token    what will be signed (taxpayer, last four, designee, scope)
 *   GET  /api/sign/:token/8821.pdf   the form itself, TIN shown as its last four
 *   POST /api/sign/:token    {signer_name, signer_title, typed_signature, agree}
 *
 * The /api gate lets /sign/* through without a key (server.ts); nothing else
 * under this router is reachable.
 */
import { Router } from 'express'
import { sendError } from '../lib/http_error.js'
import { lazyServiceClient } from '../lib/supabase.js'
import { PracticeError, form8821ForToken, signRequest, submitSignature } from '../services/practice.js'

const supabase = lazyServiceClient()
const router = Router()
const TOKEN = /^[A-Za-z0-9_-]{20,64}$/

router.get('/:token', async (req, res) => {
  if (!TOKEN.test(req.params.token)) return res.status(404).json({ error: 'This signature link is not valid.' })
  try {
    res.json(await signRequest(supabase, req.params.token))
  } catch (e: any) {
    if (e instanceof PracticeError) return res.status(e.status).json({ error: e.message })
    sendError(res, e)
  }
})

router.get('/:token/8821.pdf', async (req, res) => {
  if (!TOKEN.test(req.params.token)) return res.status(404).json({ error: 'This signature link is not valid.' })
  try {
    const r = await form8821ForToken(supabase, req.params.token)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${r.filename}"`)
    res.setHeader('Cache-Control', 'no-store')
    res.send(Buffer.from(r.pdf))
  } catch (e: any) {
    if (e instanceof PracticeError) return res.status(e.status).json({ error: e.message })
    sendError(res, e)
  }
})

router.post('/:token', async (req, res) => {
  if (!TOKEN.test(req.params.token)) return res.status(404).json({ error: 'This signature link is not valid.' })
  try {
    res.json(await submitSignature(supabase, req.params.token, req.body ?? {}, { ip: req.ip, userAgent: req.get('user-agent') }))
  } catch (e: any) {
    if (e instanceof PracticeError) return res.status(e.status).json({ error: e.message })
    sendError(res, e)
  }
})

export default router
