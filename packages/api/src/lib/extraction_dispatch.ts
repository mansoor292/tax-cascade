/**
 * Send extraction work to the Lambda worker, or run it here.
 *
 * The API no longer wants to do extraction itself — it is minutes of Textract
 * polling, and that is what kept the whole service on a multi-minute request
 * budget. But a deploy where the function name is wrong, the IAM policy is
 * missing, or Lambda is simply unreachable must NOT silently strand documents
 * in 'processing' forever. So dispatch degrades to the in-process path it
 * replaced.
 *
 * The fallback is the same function the worker calls, so behaviour is
 * identical either way — only where it runs changes. That also makes rollout
 * a matter of setting or unsetting one env var: with
 * TAX_API_EXTRACTION_FUNCTION unset, this is exactly the old code path.
 */
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import type { ExtractionEvent } from '../worker/extract_handler.js'

function functionName(): string {
  return process.env.TAX_API_EXTRACTION_FUNCTION || ''
}

function awsRegion(): string {
  return process.env.AWS_REGION || 'us-east-1'
}

let _lambda: LambdaClient | null = null
function lambda(): LambdaClient {
  if (!_lambda) _lambda = new LambdaClient({ region: awsRegion() })
  return _lambda
}

export type DispatchMode = 'lambda' | 'inline'

/**
 * Hand `event` to the worker. Returns how it was dispatched.
 *
 * On the lambda path this resolves as soon as the invoke is ACCEPTED
 * (InvocationType 'Event'), not when extraction finishes — the caller has
 * already answered 202 and the document row carries the outcome.
 *
 * `runInline` is awaited only on the fallback path; callers pass the same
 * work the worker would do.
 */
export async function dispatchExtraction(
  event: ExtractionEvent,
  runInline: () => Promise<unknown>,
): Promise<DispatchMode> {
  const fn = functionName()
  if (!fn) {
    await runInline()
    return 'inline'
  }

  try {
    const resp = await lambda().send(new InvokeCommand({
      FunctionName: fn,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(event)),
    }))
    // 202 is the documented success for an async invoke. Anything else means
    // it was not queued, so fall through rather than assume.
    if (resp.StatusCode !== 202) {
      throw new Error(`async invoke returned StatusCode ${resp.StatusCode}`)
    }
    return 'lambda'
  } catch (e: any) {
    console.error(
      `[dispatch] worker invoke failed for ${event.docId} (${e?.message}); running extraction in-process`,
    )
    await runInline()
    return 'inline'
  }
}
