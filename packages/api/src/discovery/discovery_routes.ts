/**
 * Discovery API routes
 */
import { Router } from 'express'
import { discoverForm, getDiscoveryStatus } from './form_discovery.js'

const router = Router()

// Trigger discovery pipeline
// Body (optional): { base64?, s3_key? } — caller supplies the PDF directly (for state/
// non-IRS forms). Without a body, falls back to fetching from irs.gov.
router.post('/:form/:year', async (req, res) => {
  const { form, year } = req.params
  const yearNum = parseInt(year)
  const { base64, s3_key } = req.body || {}
  const source: { base64?: string; s3_key?: string } = {}
  if (base64) source.base64 = base64
  if (s3_key) source.s3_key = s3_key

  // Check if already discovered
  const existing = await getDiscoveryStatus(form, yearNum)
  if (existing?.status === 'active') {
    return res.json({ status: 'already_active', discovery: existing })
  }

  // Check if currently running
  if (existing && ['pending', 'downloading', 'labeling', 'mapping', 'verifying'].includes(existing.status)) {
    return res.json({ status: 'in_progress', discovery: existing })
  }

  // Start discovery async
  const jobId = existing?.id || 'new'
  res.json({
    status: 'started',
    form_name: form,
    tax_year: yearNum,
    job_id: jobId,
    source: base64 ? 'base64' : s3_key ? 's3_key' : 'irs',
  })

  // Run in background (don't await — response already sent)
  discoverForm(form, yearNum, source).then(result => {
    console.log(`Discovery ${form}/${year}: ${result.status}${result.error ? ' - ' + result.error : ''}`)
  }).catch(err => {
    console.error(`Discovery ${form}/${year} error:`, err.message)
  })
})

// Get discovery status
router.get('/:form/:year/status', async (req, res) => {
  const { form, year } = req.params
  const status = await getDiscoveryStatus(form, parseInt(year))
  if (!status) return res.status(404).json({ error: 'No discovery found' })
  res.json({ discovery: status })
})

// Retry failed discovery
router.post('/:form/:year/retry', async (req, res) => {
  const { form, year } = req.params
  const yearNum = parseInt(year)
  const { base64, s3_key } = req.body || {}
  const source: { base64?: string; s3_key?: string } = {}
  if (base64) source.base64 = base64
  if (s3_key) source.s3_key = s3_key

  res.json({ status: 'retrying', form_name: form, tax_year: yearNum })

  discoverForm(form, yearNum, source).then(result => {
    console.log(`Discovery retry ${form}/${year}: ${result.status}`)
  }).catch(err => {
    console.error(`Discovery retry ${form}/${year} error:`, err.message)
  })
})

export default router
