/**
 * Textract document analysis via @aws-sdk/client-textract.
 *
 * The start → poll → drain-NextToken → reduce pipeline existed as five
 * near-identical inline Python scripts with inconsistent timeouts (a
 * document got 3 minutes on /ingest but 2 on a manual re-extract) and a
 * failure mode where JobStatus=FAILED printed a sentinel and exited 0 —
 * parsed by Node as success and stored as extraction data. This
 * implementation THROWS on a failed job instead.
 *
 * Both implementations were run against the same object and produced
 * deep-equal kvs/tables/pages, so the Python path and its TAX_API_AWS_SDK
 * flag were removed rather than kept as a second implementation nobody
 * exercises. Extraction now runs in a Node Lambda, which cannot shell out to
 * python3/boto3 at all.
 *
 * pollAnalysis blocks for as long as the job takes. That is deliberate: it
 * runs in the worker, not in an HTTP request, where waiting costs a fraction
 * of a cent and holds nothing open.
 */
import {
  TextractClient,
  StartDocumentAnalysisCommand,
  GetDocumentAnalysisCommand,
} from '@aws-sdk/client-textract'
import { s3Bucket } from './s3.js'

export interface TextractKv { key: string; value: string }
/** A key/value pair that remembers which page it came from (discovery needs it). */
export interface TextractKvPage extends TextractKv { page: number }
export interface TextractTable { page: number; rows: string[][]; row_count: number; col_count: number }
export interface TextractAnalysis {
  kvs: TextractKv[]
  tables: TextractTable[]
  num_pages: number
  num_blocks: number
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
export function parseKeyValuePairs(blocks: any[]): TextractKvPage[] {
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

  const out: TextractKvPage[] = []
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
    if (kt || vt) out.push({ key: kt, value: vt, page: kb.Page || 0 })
  }
  return out
}

export function parseBlocks(blocks: any[]): TextractAnalysis {
  // page is dropped here on purpose: textract_data is persisted, and the
  // intake mapper's shape should not change because discovery needs a page.
  const kvs: TextractKv[] = parseKeyValuePairs(blocks).map(({ key, value }) => ({ key, value }))

  const byId = new Map<string, any>(blocks.map(b => [b.Id, b]))
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
  return parseBlocks(await analyzeToBlocks(s3Key, opts))
}

/**
 * Start an analysis and return the raw blocks. Discovery needs the blocks
 * themselves (it pairs key/value by page to recover PDF field ids), so the
 * start → poll → drain sequence lives here once rather than being repeated
 * with its own timeout — which is how /ingest and a manual re-extract ended
 * up with different deadlines for the same document.
 */
export async function analyzeToBlocks(
  s3Key: string,
  opts: { tables?: boolean; maxWaitMs?: number } = {},
): Promise<any[]> {
  const featureTypes = opts.tables ? ['FORMS', 'TABLES'] : ['FORMS']
  const maxWaitMs = opts.maxWaitMs ?? 180_000
  const start = await textract().send(new StartDocumentAnalysisCommand({
    DocumentLocation: { S3Object: { Bucket: s3Bucket(), Name: s3Key } },
    FeatureTypes: featureTypes as any,
  }))
  return pollAnalysis(start.JobId!, { maxWaitMs })
}
