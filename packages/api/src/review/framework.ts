/**
 * The review framework: every check, in order, and the runner.
 *
 * FRAMEWORK_VERSION changes whenever a check is added, removed or its version
 * bumped, so a later run can say a new finding came from the framework, not
 * from a new document or fact.
 */
import { createHash } from 'node:crypto'
import type { Check, CheckResult, ReviewContext } from './types.js'
import { catalogChecks } from './checks/catalog.js'
import { passthroughChecks } from './checks/passthrough.js'
import { continuityChecks } from './checks/continuity.js'
import { irsChecks } from './checks/irs.js'
import { entityChecks } from './checks/entity.js'
import { aiChecks, type AskJson } from './ai.js'

export function frameworkChecks(ask?: AskJson): Check[] {
  return [...catalogChecks, ...entityChecks, ...passthroughChecks, ...continuityChecks, ...irsChecks, ...aiChecks(ask)]
}

export function frameworkVersion(checks: Check[]): string {
  return createHash('sha256').update(checks.map(c => `${c.id}@${c.version}`).join('|')).digest('hex').slice(0, 12)
}

export interface RunOptions {
  ai?: boolean
  ask?: AskJson
  only?: string[]
}

export interface Finding extends CheckResult {
  fingerprint: string
  check_version: number
  area: string
  kind: 'rule' | 'ai' | 'fact'
  tax_year: number
}

/** Run every applicable check. A check that throws is reported as status
 *  'error' — never swallowed, never allowed to stop the others. */
export async function runFramework(ctx: ReviewContext, opts: RunOptions = {}): Promise<{ version: string; findings: Finding[] }> {
  const checks = frameworkChecks(opts.ask)
  const version = frameworkVersion(checks)
  const findings: Finding[] = []
  const applicable = checks.filter(c => c.applies.includes(ctx.entity.form_type) && (!opts.only || opts.only.includes(c.id)))
  const rules = applicable.filter(c => c.kind !== 'ai')
  const ai = opts.ai === false ? [] : applicable.filter(c => c.kind === 'ai')
  const runOne = async (c: Check) => {
    let results: CheckResult[]
    try {
      results = await c.run(ctx)
    } catch (e: any) {
      results = [{ check: c.id, status: 'error', severity: 'low', title: `Check ${c.id} failed: ${e?.message ?? e}`, detail: String(e?.stack ?? '').split('\n').slice(0, 3).join(' | '), evidence: [] }]
    }
    for (const r of results) {
      findings.push({
        ...r, check_version: c.version, area: c.area, kind: c.kind, tax_year: ctx.year,
        fingerprint: `${c.id}|${ctx.year}|${r.key ?? ''}`,
      })
    }
  }
  for (const c of rules) await runOne(c)
  ctx.priorTitles = findings.filter(f => f.status === 'finding' || f.status === 'gap').map(f => f.title)
  for (const c of ai) await runOne(c)
  return { version, findings }
}

export type DiffStatus = 'new' | 'unchanged' | 'changed' | 'resolved'

export interface DiffInput {
  previous?: { findings: Finding[]; catalog_ids: string[]; facts_at: string | null; version: string }
  current: { findings: Finding[]; catalog_ids: string[]; facts_at: string | null; version: string }
}

/** Compare a run with the previous one and say WHY each new finding is new:
 *  a new or re-catalogued document, a newly recorded fact, a framework change
 *  — or none of those, which means the earlier run missed it. */
export function diffRuns({ previous, current }: DiffInput): Array<Finding & { change: DiffStatus; cause?: 'new_document' | 'new_fact' | 'framework' | 'first_run' | 'miss' }> {
  const actionable = (f: Finding) => f.status === 'finding' || f.status === 'gap' || f.status === 'error'
  if (!previous) return current.findings.map(f => ({ ...f, change: 'new' as const, ...(actionable(f) ? { cause: 'first_run' as const } : {}) }))
  // A finding the previous run already marked resolved is history, not an
  // open item — carrying it again would make it reappear in every run.
  const prev = new Map(previous.findings.filter(f => actionable(f) && (f as { change?: string }).change !== 'resolved').map(f => [f.fingerprint, f]))
  const docsChanged = current.catalog_ids.some(id => !previous.catalog_ids.includes(id))
  const factsChanged = (current.facts_at ?? '') > (previous.facts_at ?? '')
  const frameworkChanged = current.version !== previous.version
  const out: Array<Finding & { change: DiffStatus; cause?: 'new_document' | 'new_fact' | 'framework' | 'first_run' | 'miss' }> = []
  const seen = new Set<string>()
  for (const f of current.findings) {
    seen.add(f.fingerprint)
    if (!actionable(f)) { out.push({ ...f, change: prev.has(f.fingerprint) ? 'resolved' : 'unchanged' }); continue }
    const p = prev.get(f.fingerprint)
    if (!p) {
      const cause = docsChanged ? 'new_document' : factsChanged ? 'new_fact' : frameworkChanged ? 'framework' : 'miss'
      out.push({ ...f, change: 'new', cause })
    } else {
      out.push({ ...f, change: p.title === f.title && p.status === f.status ? 'unchanged' : 'changed' })
    }
  }
  for (const [fp, f] of prev) if (!seen.has(fp)) out.push({ ...f, change: 'resolved' })
  return out
}
