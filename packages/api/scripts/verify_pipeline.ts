#!/usr/bin/env npx tsx
/**
 * Form Verification Pipeline
 *
 * For each form: label → textract → map → fill → textract → compare
 *
 * Usage:
 *   npx tsx scripts/verify_pipeline.ts label <form> <year>    # Step 1: Label fields
 *   npx tsx scripts/verify_pipeline.ts map <form> <year>      # Step 2: Textract labels → JSON map
 *   npx tsx scripts/verify_pipeline.ts fill <form> <year>     # Step 3: Fill with test data
 *   npx tsx scripts/verify_pipeline.ts verify <form> <year>   # Step 4: Textract filled → compare
 *   npx tsx scripts/verify_pipeline.ts all <form> <year>      # Run all steps
 */

import { PDFDocument, PDFTextField } from 'pdf-lib'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { execSync } from 'child_process'

const FORMS_DIR = 'data/irs_forms'
const MAPS_DIR = 'data/field_maps'
const OUTPUT_DIR = 'output/verify'
const PYTHON = '../scripts/.venv/bin/python'
const S3_BUCKET = 'edgewater-textract-staging-2026'

const [,, command, form, yearStr] = process.argv
const year = parseInt(yearStr || '2025')

if (!command || !form) {
  console.log('Usage: npx tsx scripts/verify_pipeline.ts <label|map|fill|verify|all> <form> <year>')
  console.log('  form: f1040, f1120, f1120s, f1040s1, f1040s2, f8959, f8960, etc.')
  console.log('  year: 2024 or 2025 (default: 2025)')
  process.exit(1)
}

const formFile = `${form}_${year}`
const blankPdf = `${FORMS_DIR}/${formFile}.pdf`
const labelPdf = `${OUTPUT_DIR}/labels/${formFile}_LABELS.pdf`
const mapJson = `${MAPS_DIR}/${formFile}_fields.json`

mkdirSync(`${OUTPUT_DIR}/labels`, { recursive: true })
mkdirSync(`${OUTPUT_DIR}/filled`, { recursive: true })
mkdirSync(MAPS_DIR, { recursive: true })

// ─── Step 1: Label ───
async function label() {
  if (!existsSync(blankPdf)) {
    console.error(`Blank form not found: ${blankPdf}`)
    process.exit(1)
  }
  const pdf = await PDFDocument.load(readFileSync(blankPdf))
  const form = pdf.getForm()
  let count = 0
  for (const f of form.getFields()) {
    if (f instanceof PDFTextField) {
      const short = f.getName().match(/\.(f\d+_\d+)\[/)?.[1] || ''
      if (short) {
        try {
          const ml = f.getMaxLength()
          if (ml !== undefined) f.setMaxLength(50)
          f.setText(short)
          count++
        } catch {}
      }
    }
  }
  writeFileSync(labelPdf, await pdf.save())
  console.log(`✓ Labeled ${count} fields → ${labelPdf}`)
}

// ─── Step 2: Textract labels → JSON map ───
function map() {
  if (!existsSync(labelPdf)) {
    console.error(`Labeled PDF not found: ${labelPdf}. Run 'label' first.`)
    process.exit(1)
  }

  const s3Key = `verify/labels/${formFile}_LABELS.pdf`
  const script = `
import boto3, json, time
s3 = boto3.client("s3", region_name="us-east-1")
textract = boto3.client("textract", region_name="us-east-1")
s3.upload_file("${labelPdf}", "${S3_BUCKET}", "${s3Key}")
job = textract.start_document_analysis(
    DocumentLocation={"S3Object": {"Bucket": "${S3_BUCKET}", "Name": "${s3Key}"}},
    FeatureTypes=["FORMS"])
jid = job["JobId"]
while True:
    resp = textract.get_document_analysis(JobId=jid)
    if resp["JobStatus"] == "SUCCEEDED":
        blocks = resp.get("Blocks", [])
        nt = resp.get("NextToken")
        while nt:
            resp = textract.get_document_analysis(JobId=jid, NextToken=nt)
            blocks.extend(resp.get("Blocks", []))
            nt = resp.get("NextToken")
        break
    elif resp["JobStatus"] == "FAILED": exit(1)
    time.sleep(3)

block_map = {b["Id"]: b for b in blocks}
key_map, value_map = {}, {}
for b in blocks:
    if b["BlockType"] == "KEY_VALUE_SET":
        if "KEY" in b.get("EntityTypes", []): key_map[b["Id"]] = b
        else: value_map[b["Id"]] = b
def gt(block):
    t = ""
    for rel in block.get("Relationships", []):
        if rel["Type"] == "CHILD":
            for cid in rel["Ids"]:
                c = block_map.get(cid, {})
                if c.get("BlockType") == "WORD": t += c.get("Text","") + " "
    return t.strip()

results = []
for kid, kb in key_map.items():
    kt = gt(kb); page = kb.get("Page", 0); vb = None
    for rel in kb.get("Relationships", []):
        if rel["Type"] == "VALUE":
            for vid in rel["Ids"]:
                if vid in value_map: vb = value_map[vid]; break
    vt = gt(vb) if vb else ""
    if vt.startswith("f") and "_" in vt: results.append({"page": page, "field_id": vt, "label": kt})
    elif kt.startswith("f") and "_" in kt: results.append({"page": page, "field_id": kt, "label": vt})
results.sort(key=lambda x: (x["page"], x["field_id"]))
with open("${mapJson}", "w") as f:
    json.dump(results, f, indent=2)
print(json.dumps({"count": len(results)}))
`
  console.log(`Sending to Textract...`)
  const result = execSync(`${PYTHON} -c '${script.replace(/'/g, "\\'")}'`, {
    timeout: 120000, encoding: 'utf-8', cwd: process.cwd()
  })
  const { count } = JSON.parse(result.trim())
  console.log(`✓ Mapped ${count} fields → ${mapJson}`)
}

// ─── Run ───
async function run() {
  switch (command) {
    case 'label':
      await label()
      break
    case 'map':
      map()
      break
    case 'all':
      await label()
      map()
      break
    default:
      console.error(`Unknown command: ${command}`)
      process.exit(1)
  }
}

run()
