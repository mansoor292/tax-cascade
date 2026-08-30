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
 * TWO-PHASE BOOTSTRAP, and it has to stay that way. bootstrap_env's SSM
 * loader shells out to the `aws` CLI, which exists on EC2 and does NOT exist
 * in the Lambda runtime image — there the execSync throws, the error is
 * swallowed, and every secret silently stays unset. That surfaces far from
 * its cause as "SUPABASE_ANON_KEY is not set", because serviceClient() falls
 * back to the anon key when the service role key is missing.
 *
 * So: await loadSsmParametersAsync() FIRST, then dynamically import
 * services/document_extraction — it reads GEMINI_API_KEY at module scope, and
 * a static import would be hoisted above the await and capture nothing.
 * Do not turn that dynamic import into a top-level one.
 */
import '../bootstrap_env.js'
import { loadSsmParametersAsync } from '../lib/ssm.js'

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

  // Phase 1: secrets. Idempotent and only fills what is unset, so warm
  // invocations re-enter it cheaply and Lambda env vars still win.
  const ssm = await loadSsmParametersAsync()
  if (ssm.error) console.warn(`[worker] ssm load failed: ${ssm.error}`)
  else if (ssm.loaded.length) console.log(`[worker] ssm loaded ${ssm.loaded.length} params`)
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is unset after the SSM load. Refusing to run: ' +
      'serviceClient() would fall back to the anon key and every RLS-protected ' +
      'query would return nothing, marking the document done with no data.',
    )
  }

  // Phase 2: only now import the module that reads env at load.
  const { extractAndArchive, reextractDocument } =
    await import('../services/document_extraction.js')

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
