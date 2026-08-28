/**
 * Run a Python script safely by writing to a temp file.
 * Avoids shell escaping issues with inline -c scripts.
 */
import { writeFileSync, unlinkSync } from 'fs'
import { execSync, execFile } from 'child_process'
import { promisify } from 'util'
import { v4 as uuidv4 } from 'uuid'

const execFileAsync = promisify(execFile)

export function runPython(script: string, opts?: { timeout?: number; maxBuffer?: number }): string {
  const tmpFile = `/tmp/taxapi_${uuidv4().slice(0, 8)}.py`
  try {
    writeFileSync(tmpFile, script)
    const pythonBin = process.env.PYTHON_BIN || 'python3'
    return execSync(`${pythonBin} ${tmpFile}`, {
      timeout: opts?.timeout || 120000,
      encoding: 'utf-8',
      maxBuffer: opts?.maxBuffer || 50 * 1024 * 1024,
    }).trim()
  } finally {
    try { unlinkSync(tmpFile) } catch {}
  }
}

/**
 * Same, but without freezing the process.
 *
 * execSync blocks the Node event loop for the whole run — and the Textract
 * path polls a job for up to three minutes. On a two-worker cluster that took
 * half the fleet out of service for the duration: requests routed to the busy
 * worker got no answer at all, and the proxy in front served the fallback page
 * instead. Uploading a document made the rest of the app stop responding.
 *
 * Use this anywhere the script can run long, and especially for work that
 * continues after a response has already been sent.
 */
export async function runPythonAsync(
  script: string,
  opts?: { timeout?: number; maxBuffer?: number },
): Promise<string> {
  const tmpFile = `/tmp/taxapi_${uuidv4().slice(0, 8)}.py`
  try {
    writeFileSync(tmpFile, script)
    const pythonBin = process.env.PYTHON_BIN || 'python3'
    const { stdout } = await execFileAsync(pythonBin, [tmpFile], {
      timeout: opts?.timeout || 120000,
      encoding: 'utf-8',
      maxBuffer: opts?.maxBuffer || 50 * 1024 * 1024,
    })
    return stdout.trim()
  } finally {
    try { unlinkSync(tmpFile) } catch {}
  }
}
