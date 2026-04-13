/**
 * Label → Textract → Save field maps for ALL form PDFs.
 * Produces verified JSON field maps in data/field_maps/.
 */
import { PDFDocument, PDFTextField } from 'pdf-lib'
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'

const FORMS_DIR = 'data/irs_forms'
const MAPS_DIR = 'data/field_maps'
const TMP_DIR = '/tmp/label_textract'
const BUCKET = 'tax-api-storage-2026'

mkdirSync(TMP_DIR, { recursive: true })

// Get all PDFs
const pdfs = readdirSync(FORMS_DIR)
  .filter(f => f.endsWith('.pdf') && !f.includes('LABEL') && !f.includes('fl_'))
  .sort()

console.log(`Found ${pdfs.length} form PDFs to process\n`)

async function labelAndExtract(filename: string): Promise<number> {
  const formKey = filename.replace('.pdf', '')
  const inputPath = `${FORMS_DIR}/${filename}`
  const labeledPath = `${TMP_DIR}/${formKey}_LABELED.pdf`
  const mapPath = `${MAPS_DIR}/${formKey}_fields.json`

  // 1. Label all fields
  const pdf = await PDFDocument.load(readFileSync(inputPath))
  const form = pdf.getForm()
  const allFields: string[] = []
  for (const f of form.getFields()) {
    if (f instanceof PDFTextField) {
      const name = f.getName()
      const short = name.match(/\.(f\d+_\d+)\[/)?.[1]
      if (short) {
        try {
          const ml = f.getMaxLength()
          if (ml !== undefined) f.setMaxLength(50)
          f.setText(short)
          allFields.push(short)
        } catch {}
      }
    }
  }
  writeFileSync(labeledPath, await pdf.save())

  // 2. Upload to S3
  const s3Key = `field_maps/${formKey}_LABELED.pdf`
  execSync(`aws s3 cp "${labeledPath}" "s3://${BUCKET}/${s3Key}" --region us-east-1 --quiet`)

  // 3. Run Textract
  const startResult = JSON.parse(execSync(
    `aws textract start-document-analysis --document-location '{"S3Object":{"Bucket":"${BUCKET}","Name":"${s3Key}"}}' --feature-types '["FORMS"]' --region us-east-1`,
    { encoding: 'utf-8' }
  ))
  const jobId = startResult.JobId

  // 4. Wait for completion
  let blocks: any[] = []
  while (true) {
    await new Promise(r => setTimeout(r, 3000))
    const statusResult = JSON.parse(execSync(
      `aws textract get-document-analysis --job-id ${jobId} --region us-east-1`,
      { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
    ))
    if (statusResult.JobStatus === 'SUCCEEDED') {
      blocks = statusResult.Blocks || []
      let nextToken = statusResult.NextToken
      while (nextToken) {
        const more = JSON.parse(execSync(
          `aws textract get-document-analysis --job-id ${jobId} --next-token "${nextToken}" --region us-east-1`,
          { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
        ))
        blocks.push(...(more.Blocks || []))
        nextToken = more.NextToken
      }
      break
    } else if (statusResult.JobStatus === 'FAILED') {
      console.log(`  ✗ Textract FAILED for ${formKey}`)
      return 0
    }
  }

  // 5. Extract KV pairs
  const bm: Record<string, any> = {}
  const km: Record<string, any> = {}
  const vm: Record<string, any> = {}
  for (const b of blocks) {
    bm[b.Id] = b
    if (b.BlockType === 'KEY_VALUE_SET') {
      if ((b.EntityTypes || []).includes('KEY')) km[b.Id] = b
      else vm[b.Id] = b
    }
  }

  function getText(bl: any): string {
    let t = ''
    for (const rel of bl.Relationships || []) {
      if (rel.Type === 'CHILD') {
        for (const cid of rel.Ids) {
          const c = bm[cid]
          if (c?.BlockType === 'WORD') t += (c.Text || '') + ' '
        }
      }
    }
    return t.trim()
  }

  const results: Array<{page: number; field_id: string; label: string}> = []
  for (const [kid, kb] of Object.entries(km) as [string, any][]) {
    const label = getText(kb)
    const page = kb.Page || 0
    let vb: any = null
    for (const rel of kb.Relationships || []) {
      if (rel.Type === 'VALUE') {
        for (const vid of rel.Ids) {
          if (vm[vid]) { vb = vm[vid]; break }
        }
      }
    }
    const value = vb ? getText(vb) : ''
    if (value && value.match(/^f\d+_\d+/)) {
      results.push({ page, field_id: value.split(' ')[0], label })
    }
  }

  results.sort((a, b) => a.page - b.page || a.field_id.localeCompare(b.field_id))

  // 6. Save
  writeFileSync(mapPath, JSON.stringify(results, null, 2))
  return results.length
}

async function main() {
  let total = 0
  for (const pdf of pdfs) {
    process.stdout.write(`${pdf.replace('.pdf','')}: `)
    try {
      const count = await labelAndExtract(pdf)
      console.log(`${count} fields ✓`)
      total += count
    } catch (e: any) {
      console.log(`FAILED: ${e.message.slice(0, 60)}`)
    }
  }
  console.log(`\nDone. ${total} total field mappings across ${pdfs.length} forms.`)
}

main()
