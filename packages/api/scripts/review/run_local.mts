/**
 * Run the review framework over catalogs on disk (no database).
 *
 *   npx tsx scripts/review/run_local.mts CONFIG.json OUT.json [--ai]
 *
 * CONFIG: { "entities": [{ "entity": EntityInfo, "catalogs": [{ "file": path,
 * "kind": "filed_return"|"irs_transcript", "tax_year": 2023 }], "years": [..] }],
 * "facts": { "<entity id>": StoredFactLike[] }, "documents": {...}, "today": "YYYY-MM-DD" }
 *
 * Writes every finding (real values — keep OUT outside the repo, mode 600) and
 * prints a summary with identifiers masked.
 */
import { readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { buildContext, type EntityBundle } from '../../src/review/context.js'
import { runFramework } from '../../src/review/framework.js'
import { computeFactGaps } from '../../src/services/facts.js'
import type { CatalogView } from '../../src/review/types.js'
import { keyEntries } from '../../src/schema/index.js'

const [cfgPath, outPath] = process.argv.slice(2).filter(a => !a.startsWith('--'))
const ai = process.argv.includes('--ai')
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))

const bundles: Array<EntityBundle & { years: number[] }> = cfg.entities.map((e: any) => ({
  entity: e.entity,
  years: e.years,
  catalogs: e.catalogs.map((c: any): CatalogView => {
    const j = JSON.parse(readFileSync(c.file, 'utf8'))
    return { id: c.file.split('/').pop(), kind: c.kind, tax_year: c.tax_year, source_filename: j.source?.filename, status: j.coverage?.complete ? 'complete' : 'incomplete', coverage: j.coverage, entries: keyEntries(j.entries), transcript_type: j.transcript?.type ?? null, as_of: j.transcript?.as_of ?? null }
  }),
}))

const mask = (s: string) => s.replace(/\b\d{2}-?\d{7}\b/g, '[ID]').replace(/\b\d{3}-?\d{2}-?\d{4}\b/g, '[ID]')
const report: any[] = []
for (const b of bundles) {
  for (const year of b.years) {
    const facts = (cfg.facts?.[b.entity.id] ?? [])
    const gaps = computeFactGaps({ formType: b.entity.form_type, taxYear: year, facts: facts.map((f: any, i: number) => ({ id: String(i), entity_id: b.entity.id, evidence_document_id: null, recorded_by: null, source_note: null, superseded_by: null, recorded_at: f.recorded_at ?? '2026-10-17T00:00:00Z', source: f.source ?? 'owner', ...f })) })
    const ctx = buildContext({
      self: b, others: bundles.filter(x => x !== b), year, facts,
      documents: cfg.documents?.[b.entity.id] ?? [], factGaps: gaps.map(g => ({ key: g.key, question: g.question, status: g.status })),
      today: cfg.today ? new Date(cfg.today + 'T12:00:00Z') : undefined,
    })
    const { version, findings } = await runFramework(ctx, { ai })
    report.push({ entity: b.entity.name, form: b.entity.form_type, year, version, linked: ctx.linked.map(l => `${l.relation}: ${l.entity.name} (${l.evidence})`), findings })
    const act = findings.filter(f => f.status === 'finding' || f.status === 'gap' || f.status === 'error')
    console.log(`\n=== ${b.entity.name} ${b.entity.form_type} ${year} — ${act.length} to act on (${findings.filter(f => f.status === 'pass').length} passed)`)
    for (const l of ctx.linked) console.log(`   linked ${l.relation}: ${l.entity.name} — ${l.evidence}`)
    const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const
    for (const f of act.sort((a, c) => order[a.severity] - order[c.severity])) {
      console.log(`   [${f.status} ${f.severity}] ${mask(f.title)}${f.dollar_effect ? `  ($${Math.round(f.dollar_effect).toLocaleString('en-US')})` : ''}${f.deadline ? `  by ${f.deadline}` : ''}`)
    }
  }
}
writeFileSync(outPath, JSON.stringify(report, null, 1))
chmodSync(outPath, 0o600)
