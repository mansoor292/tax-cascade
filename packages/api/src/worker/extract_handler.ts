/**
 * Lambda entrypoint for document extraction.
 *
 * This is a second entrypoint onto the SAME codebase, not a second service.
 * extractAndArchive reaches into the intake mapper, canonical schema, row
 * crypto, field maps and form discovery; reimplementing that behind a queue
 * would fork the tax logic, which is the one thing worth avoiding here. So
 * the worker imports services/document_extraction and calls it.
 *
 * Why a Lambda at all: the work is minutes long (Textract on a 30-50 page
 * prior return), and holding an HTTP request open for it is what forced the
 * whole API onto a multi-minute request budget. Moved here, the API's slowest
 * route is ~600ms and its hosting stops being constrained by extraction.
 *
 * pollAnalysis still blocks — deliberately. Waiting inside a Lambda costs a
 * fraction of a cent and holds nothing open, so an SNS completion callback
 * would add a topic and a second function to save almost nothing.
 *
 * bootstrap_env MUST stay the first import, exactly as in server.ts: route
 * and service modules read process.env at module scope, and ESM evaluates
 * imports before anything else runs.
 */
import '../bootstrap_env.js'
import { extractAndArchive, reextractDocument } from '../services/document_extraction.js'

/** Ingest: classify + extract + archive a freshly uploaded document. */
export interface IngestEvent {
  kind: 'ingest'
  docId: string
  userId: string
  s3_key: string
  filename: string
  file_size?: number
  ext: string
  entity_id: string | null
  content_hash?: string
  _deduped_textract?: any
}

/** Extract: re-run Textract for a document that already exists. */
export interface ExtractEvent {
  kind: 'extract'
  docId: string
  userId: string
  s3_path: string
  needsTables: boolean
}

export type ExtractionEvent = IngestEvent | ExtractEvent

export async function handler(event: ExtractionEvent): Promise<{ ok: true; docId: string }> {
  if (!event || typeof event !== 'object' || !('kind' in event)) {
    throw new Error(`extraction worker: unrecognised event ${JSON.stringify(event)?.slice(0, 200)}`)
  }

  const started = Date.now()
  console.log(`[worker] ${event.kind} ${event.docId} starting`)

  // Both callees already record their own outcome on the document row
  // (processing_status done | failed, processing_error). Rethrow so the
  // invocation is marked failed and lands on the on-failure destination —
  // a row stuck in 'processing' with nothing in the log is the failure mode
  // worth avoiding.
  switch (event.kind) {
    case 'ingest':
      await extractAndArchive({
        docId: event.docId,
        userId: event.userId,
        s3_key: event.s3_key,
        filename: event.filename,
        file_size: event.file_size,
        ext: event.ext,
        entity_id: event.entity_id,
        content_hash: event.content_hash,
        _deduped_textract: event._deduped_textract,
      })
      break
    case 'extract':
      await reextractDocument({
        docId: event.docId,
        userId: event.userId,
        s3_path: event.s3_path,
        needsTables: event.needsTables,
      })
      break
    default:
      throw new Error(`extraction worker: unknown kind ${(event as any).kind}`)
  }

  console.log(`[worker] ${event.kind} ${event.docId} done in ${Date.now() - started}ms`)
  return { ok: true, docId: event.docId }
}
