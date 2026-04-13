/**
 * Run a Python script safely by writing to a temp file.
 * Avoids shell escaping issues with inline -c scripts.
 */
import { writeFileSync, unlinkSync } from 'fs'
import { execSync } from 'child_process'
import { v4 as uuidv4 } from 'uuid'

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
