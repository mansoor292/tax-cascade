/**
 * Textract Verification Utility
 *
 * Sends a filled PDF to AWS Textract and compares extracted values
 * against expected values. Used to validate that our PDF fill
 * pipeline produces correct output.
 *
 * Usage: Call from Node.js scripts via the Python helper
 * (Textract SDK is in the Python venv, not Node.js)
 */

import { execSync } from 'child_process'
import { writeFileSync, readFileSync } from 'fs'
import { join } from 'path'

const PYTHON = 'scripts/.venv/bin/python'
const BUCKET = 'edgewater-textract-staging-2026'

/**
 * Send a PDF to Textract and extract KV pairs.
 * Returns array of { key, value } objects.
 */
export function textractExtract(pdfPath: string, s3Key: string): Array<{key: string; value: string}> {
  const script = `
import boto3, json, time
s3 = boto3.client("s3", region_name="us-east-1")
textract = boto3.client("textract", region_name="us-east-1")
s3.upload_file("${pdfPath}", "${BUCKET}", "${s3Key}")
job = textract.start_document_analysis(
    DocumentLocation={"S3Object": {"Bucket": "${BUCKET}", "Name": "${s3Key}"}},
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
kvs = []
for kid, kb in key_map.items():
    kt = gt(kb)
    vb = None
    for rel in kb.get("Relationships", []):
        if rel["Type"] == "VALUE":
            for vid in rel["Ids"]:
                if vid in value_map: vb = value_map[vid]; break
    vt = gt(vb) if vb else ""
    if kt or vt: kvs.append({"key": kt, "value": vt})
print(json.dumps(kvs))
`
  const result = execSync(`${PYTHON} -c '${script.replace(/'/g, "\\'")}'`, {
    timeout: 120000,
    encoding: 'utf-8'
  })
  return JSON.parse(result.trim())
}

/**
 * Label all fields in a blank PDF with their field IDs,
 * send to Textract, and return the verified field map.
 */
export function textractLabelAndVerify(blankPdfPath: string, formName: string): Array<{page: number; field_id: string; label: string}> {
  // This is done via the Python + TypeScript pipeline described in the README
  // For now, use the pre-generated JSON files in data/field_maps/
  const mapPath = `tax-api/data/field_maps/${formName}_fields.json`
  return JSON.parse(readFileSync(mapPath, 'utf-8'))
}
