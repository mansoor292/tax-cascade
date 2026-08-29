/**
 * S3 access with a flag-gated dual implementation.
 *
 * Historically every S3 operation here was an inline Python boto3 script
 * run through lib/run_python — ~15 copies across the routes, each
 * interpolating keys and even whole base64 bodies into Python source
 * (an injection surface: a single quote in the data terminated the string
 * literal and the rest executed as Python under the server's IAM role).
 *
 * TAX_API_AWS_SDK=1 switches every operation in this module to
 * @aws-sdk/client-s3 in-process. The Python path remains the default until
 * ops flips the flag in prod and confirms; both paths use the same IAM
 * role (SDK via the default provider chain, boto3 via the same instance
 * profile), so no credential work is involved in the switch.
 *
 * Bucket + region are read lazily (bootstrap_env ordering) and live only
 * here — the per-route S3_BUCKET copies are gone.
 */
import { createHash } from 'crypto'
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { runPythonAsync } from './run_python.js'

export function awsSdkEnabled(): boolean {
  return process.env.TAX_API_AWS_SDK === '1'
}

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

/** Escape a value being interpolated into a Python single-quoted string. */
function py(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export async function s3PresignPut(key: string, contentType: string, expiresIn = 300): Promise<string> {
  if (awsSdkEnabled()) {
    return getSignedUrl(s3(), new PutObjectCommand({
      Bucket: s3Bucket(), Key: key, ContentType: contentType,
    }), { expiresIn })
  }
  const out = await runPythonAsync(`
import boto3, json
s3 = boto3.client('s3', region_name='${awsRegion()}')
url = s3.generate_presigned_url('put_object', Params={
    'Bucket': '${py(s3Bucket())}',
    'Key': '${py(key)}',
    'ContentType': '${py(contentType)}',
}, ExpiresIn=${expiresIn})
print(json.dumps({'url': url}))
`, { timeout: 10000 })
  return JSON.parse(out.trim()).url
}

export async function s3PresignGet(key: string, expiresIn = 3600): Promise<string> {
  if (awsSdkEnabled()) {
    return getSignedUrl(s3(), new GetObjectCommand({ Bucket: s3Bucket(), Key: key }), { expiresIn })
  }
  const out = await runPythonAsync(`
import boto3, json
s3 = boto3.client('s3', region_name='${awsRegion()}')
url = s3.generate_presigned_url('get_object', Params={'Bucket': '${py(s3Bucket())}', 'Key': '${py(key)}'}, ExpiresIn=${expiresIn})
print(json.dumps({'url': url}))
`, { timeout: 10000 })
  return JSON.parse(out.trim()).url
}

export async function s3PresignGetMany(keys: string[], expiresIn = 3600): Promise<Record<string, string>> {
  if (awsSdkEnabled()) {
    const out: Record<string, string> = {}
    for (const key of keys) out[key] = await s3PresignGet(key, expiresIn)
    return out
  }
  const out = await runPythonAsync(`
import boto3, json
s3 = boto3.client('s3', region_name='${awsRegion()}')
keys = json.loads('${py(JSON.stringify(keys))}')
print(json.dumps({k: s3.generate_presigned_url('get_object', Params={'Bucket': '${py(s3Bucket())}', 'Key': k}, ExpiresIn=${expiresIn}) for k in keys}))
`, { timeout: 15000 })
  return JSON.parse(out.trim())
}

/** Upload a buffer; returns its byte length and sha256 (hex). */
export async function s3PutObject(
  key: string, body: Buffer, contentType: string,
): Promise<{ bytes: number; sha256: string }> {
  const sha256 = createHash('sha256').update(body).digest('hex')
  if (awsSdkEnabled()) {
    await s3().send(new PutObjectCommand({
      Bucket: s3Bucket(), Key: key, Body: body, ContentType: contentType,
    }))
    return { bytes: body.length, sha256 }
  }
  await runPythonAsync(`
import boto3, base64
s3 = boto3.client('s3', region_name='${awsRegion()}')
data = base64.b64decode('${body.toString('base64')}')
s3.put_object(Bucket='${py(s3Bucket())}', Key='${py(key)}', Body=data, ContentType='${py(contentType)}')
print('ok')
`, { timeout: 60000, maxBuffer: 100 * 1024 * 1024 })
  return { bytes: body.length, sha256 }
}

export async function s3GetObject(key: string): Promise<Buffer> {
  if (awsSdkEnabled()) {
    const resp = await s3().send(new GetObjectCommand({ Bucket: s3Bucket(), Key: key }))
    return Buffer.from(await resp.Body!.transformToByteArray())
  }
  const base64 = await runPythonAsync(`
import boto3, base64, sys
s3 = boto3.client('s3', region_name='${awsRegion()}')
obj = s3.get_object(Bucket='${py(s3Bucket())}', Key='${py(key)}')
sys.stdout.write(base64.b64encode(obj['Body'].read()).decode())
`, { timeout: 30000, maxBuffer: 100 * 1024 * 1024 })
  return Buffer.from(base64.trim(), 'base64')
}
