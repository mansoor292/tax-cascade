/**
 * Textract document analysis with a flag-gated dual implementation.
 *
 * The start → poll → drain-NextToken → reduce pipeline existed as five
 * near-identical inline Python scripts with inconsistent timeouts (a
 * document got 3 minutes on /ingest but 2 on a manual re-extract) and a
 * failure mode where JobStatus=FAILED printed a sentinel and exited 0 —
 * parsed by Node as success and stored as extraction data.
 *
 * TAX_API_AWS_SDK=1 runs the analysis in-process via
 * @aws-sdk/client-textract; the SDK path THROWS on a failed job (the fix,
 * gated behind the flag with everything else). The Python path preserves
 * the historical sentinel behavior byte-for-byte so flag-off deploys are
 * unchanged.
 */
import {
  TextractClient,
  StartDocumentAnalysisCommand,
  GetDocumentAnalysisCommand,
} from '@aws-sdk/client-textract'
import { runPythonAsync } from './run_python.js'
import { awsSdkEnabled, s3Bucket } from './s3.js'

export interface TextractKv { key: string; value: string }
export interface TextractTable { page: number; rows: string[][]; row_count: number; col_count: number }
export interface TextractAnalysis {
  kvs: TextractKv[]
  tables: TextractTable[]
  num_pages: number
  num_blocks: number
  /** Historical Python sentinel — present only on the flag-off path when the job failed. */
  error?: string
}

function awsRegion(): string {
  return process.env.AWS_REGION || 'us-east-1'
}

let _tx: TextractClient | null = null
function textract(): TextractClient {
  if (!_tx) _tx = new TextractClient({ region: awsRegion() })
  return _tx
}

/**
 * Reduce raw Textract blocks to the {kvs, tables} shape the intake mapper
 * consumes — a faithful port of the Python reduction. Exported for tests.
 */
export function parseBlocks(blocks: any[]): Omit<TextractAnalysis, 'error'> {
  const byId = new Map<string, any>(blocks.map(b => [b.Id, b]))
  const keys: any[] = []
  const values = new Map<string, any>()
  for (const b of blocks) {
    if (b.BlockType !== 'KEY_VALUE_SET') continue
    if ((b.EntityTypes || []).includes('KEY')) keys.push(b)
    else values.set(b.Id, b)
  }

  const childText = (bl: any): string => {
    let t = ''
    for (const rel of bl?.Relationships || []) {
      if (rel.Type !== 'CHILD') continue
      for (const cid of rel.Ids) {
        const c = byId.get(cid)
        if (c?.BlockType === 'WORD') t += (c.Text || '') + ' '
      }
    }
    return t.trim()
  }

  const kvs: TextractKv[] = []
  for (const kb of keys) {
    const kt = childText(kb)
    let vb: any = null
    for (const rel of kb.Relationships || []) {
      if (rel.Type !== 'VALUE') continue
      for (const vid of rel.Ids) {
        if (values.has(vid)) { vb = values.get(vid); break }
      }
    }
    const vt = vb ? childText(vb) : ''
    if (kt || vt) kvs.push({ key: kt, value: vt })
  }

  const tables: TextractTable[] = []
  for (const b of blocks) {
    if (b.BlockType !== 'TABLE') continue
    const cells = new Map<string, string>()
    let maxR = 0, maxC = 0
    for (const rel of b.Relationships || []) {
      if (rel.Type !== 'CHILD') continue
      for (const cid of rel.Ids) {
        const cb = byId.get(cid)
        if (cb?.BlockType !== 'CELL') continue
        const r = cb.RowIndex || 0, c = cb.ColumnIndex || 0
        cells.set(`${r},${c}`, childText(cb))
        if (r > maxR) maxR = r
        if (c > maxC) maxC = c
      }
    }
    if (!cells.size) continue
    const rows: string[][] = []
    for (let r = 1; r <= maxR; r++) {
      const row: string[] = []
      for (let c = 1; c <= maxC; c++) row.push(cells.get(`${r},${c}`) || '')
      rows.push(row)
    }
    tables.push({ page: b.Page || 1, rows, row_count: maxR, col_count: maxC })
  }

  return {
    kvs,
    tables,
    num_pages: blocks.filter(b => b.BlockType === 'PAGE').length,
    num_blocks: blocks.length,
  }
}

/** Poll the analysis job until it settles; injectable client for tests. */
export async function pollAnalysis(
  jobId: string,
  opts: { maxWaitMs?: number; pollMs?: number; client?: Pick<TextractClient, 'send'> } = {},
): Promise<any[]> {
  const maxWaitMs = opts.maxWaitMs ?? 180_000
  const pollMs = opts.pollMs ?? 3_000
  const client = opts.client ?? textract()
  const deadline = Date.now() + maxWaitMs
  for (;;) {
    let resp: any = await client.send(new GetDocumentAnalysisCommand({ JobId: jobId }))
    if (resp.JobStatus === 'SUCCEEDED') {
      const blocks: any[] = [...(resp.Blocks || [])]
      let nt = resp.NextToken
      while (nt) {
        resp = await client.send(new GetDocumentAnalysisCommand({ JobId: jobId, NextToken: nt }))
        blocks.push(...(resp.Blocks || []))
        nt = resp.NextToken
      }
      return blocks
    }
    if (resp.JobStatus === 'FAILED') {
      throw new Error(`Textract analysis failed for job ${jobId}: ${resp.StatusMessage || 'no detail'}`)
    }
    if (Date.now() >= deadline) {
      throw new Error(`Textract analysis timed out after ${maxWaitMs}ms (job ${jobId})`)
    }
    await new Promise(r => setTimeout(r, pollMs))
  }
}

/**
 * Analyze an S3-resident document. `tables: true` adds TABLES to FORMS
 * (used for prior-return ingest where Schedule L lives in a table).
 */
export async function analyzeDocument(
  s3Key: string,
  opts: { tables?: boolean; maxWaitMs?: number } = {},
): Promise<TextractAnalysis> {
  const featureTypes = opts.tables ? ['FORMS', 'TABLES'] : ['FORMS']
  const maxWaitMs = opts.maxWaitMs ?? 180_000

  if (awsSdkEnabled()) {
    const start = await textract().send(new StartDocumentAnalysisCommand({
      DocumentLocation: { S3Object: { Bucket: s3Bucket(), Name: s3Key } },
      FeatureTypes: featureTypes as any,
    }))
    const blocks = await pollAnalysis(start.JobId!, { maxWaitMs })
    return parseBlocks(blocks)
  }

  const pyKey = s3Key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const script = `
import boto3, json, time
textract = boto3.client('textract', region_name='${awsRegion()}')
job = textract.start_document_analysis(
    DocumentLocation={'S3Object': {'Bucket': '${s3Bucket()}', 'Name': '${pyKey}'}},
    FeatureTypes=${JSON.stringify(featureTypes).replace(/"/g, "'")})
jid = job['JobId']
while True:
    resp = textract.get_document_analysis(JobId=jid)
    if resp['JobStatus'] == 'SUCCEEDED':
        blocks = resp.get('Blocks', [])
        nt = resp.get('NextToken')
        while nt:
            resp = textract.get_document_analysis(JobId=jid, NextToken=nt)
            blocks.extend(resp.get('Blocks', []))
            nt = resp.get('NextToken')
        break
    elif resp['JobStatus'] == 'FAILED':
        print(json.dumps({'error': 'failed'}))
        exit(0)
    time.sleep(3)
bm = {b['Id']: b for b in blocks}
km, vm = {}, {}
for b in blocks:
    if b['BlockType'] == 'KEY_VALUE_SET':
        if 'KEY' in b.get('EntityTypes', []): km[b['Id']] = b
        else: vm[b['Id']] = b
def gt(bl):
    t = ''
    for rel in bl.get('Relationships', []):
        if rel['Type'] == 'CHILD':
            for cid in rel['Ids']:
                c = bm.get(cid, {})
                if c.get('BlockType') == 'WORD': t += c.get('Text', '') + ' '
    return t.strip()
kvs = []
for kid, kb in km.items():
    kt = gt(kb); vb = None
    for rel in kb.get('Relationships', []):
        if rel['Type'] == 'VALUE':
            for vid in rel['Ids']:
                if vid in vm: vb = vm[vid]; break
    vt = gt(vb) if vb else ''
    if kt or vt: kvs.append({'key': kt, 'value': vt})
tables = []
for b in blocks:
    if b['BlockType'] != 'TABLE': continue
    cells = {}
    for rel in b.get('Relationships', []):
        if rel['Type'] == 'CHILD':
            for cid in rel['Ids']:
                cb = bm.get(cid, {})
                if cb.get('BlockType') == 'CELL':
                    r = cb.get('RowIndex', 0); c = cb.get('ColumnIndex', 0)
                    cells[(r, c)] = gt(cb)
    if not cells: continue
    max_r = max(r for r, _ in cells)
    max_c = max(c for _, c in cells)
    rows = [[cells.get((r, c), '') for c in range(1, max_c + 1)] for r in range(1, max_r + 1)]
    tables.append({'page': b.get('Page', 1), 'rows': rows, 'row_count': max_r, 'col_count': max_c})
np = sum(1 for b in blocks if b['BlockType'] == 'PAGE')
print(json.dumps({'kvs': kvs, 'tables': tables, 'num_pages': np, 'num_blocks': len(blocks)}))
`
  const out = await runPythonAsync(script, { timeout: maxWaitMs })
  return JSON.parse(out.trim())
}
