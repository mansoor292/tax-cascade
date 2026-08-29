/**
 * S3 access via @aws-sdk/client-s3.
 *
 * Historically every S3 operation here was an inline Python boto3 script run
 * through lib/run_python — ~15 copies across the routes, each interpolating
 * keys and even whole base64 bodies into Python source (an injection surface:
 * a single quote in the data terminated the string literal and the rest
 * executed as Python under the server's IAM role).
 *
 * That path is gone. It was kept behind TAX_API_AWS_SDK while the SDK
 * implementation was unproven; both were then run against the same object and
 * produced byte-identical reads and deep-equal Textract output, so the flag
 * and the Python branches were removed rather than left as a second
 * implementation nobody exercises. Extraction now runs in a Node Lambda, which
 * cannot shell out to python3/boto3 at all.
 *
 * Bucket + region are read lazily (bootstrap_env ordering) and live only
 * here — the per-route S3_BUCKET copies are gone.
 */
import { createHash } from 'crypto'
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export function s3Bucket(): string {
  return process.env.S3_BUCKET || 'tax-api-storage-2026'
}

function awsRegion(): string {
  return process.env.AWS_REGION || 'us-east-1'
}

let _s3: S3Client | null = null
function s3(): S3Client {
  if (!_s3) _s3 = new S3Client({ region: awsRegion() })
  return _s3
}

export async function s3PresignPut(key: string, contentType: string, expiresIn = 300): Promise<string> {
  return getSignedUrl(s3(), new PutObjectCommand({
    Bucket: s3Bucket(), Key: key, ContentType: contentType,
  }), { expiresIn })
}

export async function s3PresignGet(key: string, expiresIn = 3600): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: s3Bucket(), Key: key }), { expiresIn })
}

export async function s3PresignGetMany(keys: string[], expiresIn = 3600): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const key of keys) out[key] = await s3PresignGet(key, expiresIn)
  return out
}

/** Upload a buffer; returns its byte length and sha256 (hex). */
export async function s3PutObject(
  key: string, body: Buffer, contentType: string,
): Promise<{ bytes: number; sha256: string }> {
  const sha256 = createHash('sha256').update(body).digest('hex')
  await s3().send(new PutObjectCommand({
    Bucket: s3Bucket(), Key: key, Body: body, ContentType: contentType,
  }))
  return { bytes: body.length, sha256 }
}

export async function s3GetObject(key: string): Promise<Buffer> {
  const resp = await s3().send(new GetObjectCommand({ Bucket: s3Bucket(), Key: key }))
  return Buffer.from(await resp.Body!.transformToByteArray())
}
