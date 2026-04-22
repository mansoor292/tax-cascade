/**
 * Synchronous SSM secret loader via the aws CLI.
 *
 * Called at boot before any route module captures process.env. Uses execSync
 * so no refactor of route-level env captures is needed. The aws CLI is
 * already on EC2 (for AWS operations); in dev environments without it, the
 * call fails and we fall through to whatever dotenv provided.
 *
 * SDK-free by design: adding @aws-sdk/client-ssm means an async path, which
 * forces splitting server.ts into a two-phase bootstrap before any import
 * of a route that captures env at module-load (qbo.ts, etc.). execSync
 * keeps this a one-liner in the boot sequence.
 *
 * Parameter naming: `/tax-api/QUICKBOOKS_CLIENT_ID` → `QUICKBOOKS_CLIENT_ID`.
 * Precedence: only fills vars NOT already set, so dotenv / ambient env can
 * override for local dev.
 */
import { execSync } from 'child_process'

const PATH_PREFIX = '/tax-api/'

export interface LoadResult {
  loaded:  string[]
  skipped: string[]
  error?:  string
}

export function loadSsmParametersSync(): LoadResult {
  const loaded:  string[] = []
  const skipped: string[] = []
  const region = process.env.AWS_REGION || 'us-east-1'
  try {
    const out = execSync(
      `aws ssm get-parameters-by-path --path ${PATH_PREFIX} --with-decryption --recursive --region ${region} --query 'Parameters[*].{Name:Name,Value:Value}' --output json`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
    )
    const items = JSON.parse(out) as Array<{ Name: string; Value: string }>
    for (const p of items) {
      const key = p.Name.startsWith(PATH_PREFIX) ? p.Name.slice(PATH_PREFIX.length) : p.Name
      if (!key) continue
      if (process.env[key] !== undefined && process.env[key] !== '') {
        skipped.push(key)
        continue
      }
      process.env[key] = p.Value
      loaded.push(key)
    }
  } catch (e: any) {
    return { loaded, skipped, error: e.message?.slice(0, 200) || String(e).slice(0, 200) }
  }
  return { loaded, skipped }
}
