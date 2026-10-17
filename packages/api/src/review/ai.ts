/**
 * AI judgement checks: the parts of the framework a rule can't decide (is
 * this business a specified service? does anything in this return look wrong
 * that no rule covers?).
 *
 * Grounded or rejected: the model sees an evidence pack of catalog entries,
 * each with an id, and must cite those ids. A conclusion citing anything not
 * in the pack is dropped — the same discipline as gemini_gap_fill, because a
 * finding nobody can trace to a line on the return is worse than none.
 *
 * Gemini, because it is the provider already configured server-side
 * (GEMINI_API_KEY). REVIEW_AI_MODEL overrides the model.
 */
import { GoogleGenerativeAI } from '@google/generative-ai'
import type { CatalogEntry } from '../catalog/types.js'
import type { Check, CheckResult, Severity, Area } from './types.js'
import { filed, formEntries, find, cite } from './lookup.js'
import { scheduleERows, issuedK1s } from './k1.js'

const MODEL = () => process.env.REVIEW_AI_MODEL || 'gemini-3.1-pro-preview'

export type AskJson = (prompt: string) => Promise<unknown>

/** Default transport. Tests and offline runs pass their own. */
/** The model sometimes wraps its object in an array; unwrap one level. */
export function unwrap(raw: unknown): any {
  return Array.isArray(raw) && raw.length === 1 && raw[0] && typeof raw[0] === 'object' ? raw[0] : raw
}

export const geminiJson: AskJson = async (prompt) => {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY not set — AI checks cannot run')
  const model = new GoogleGenerativeAI(key).getGenerativeModel({ model: MODEL() })
  const res = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  })
  return JSON.parse(res.response.text())
}

interface PackEntry { id: string; where: string; label: string; value: unknown }

/** Identity boxes never go to the model, and any 9-digit run (SSN/EIN) is
 *  masked — the same rule as the MCP boundary: a model never needs them. */
const IDENTITY_LABEL = /identif|social security|S S N|E I N|\bEIN\b|address|Z I P|ZIP code|name|phone|P T I N|routing|account number|signature/i
const maskIds = (v: unknown) => typeof v === 'string' ? v.replace(/\d{3}-?\d{2}-?\d{4}|\d{2}-?\d{7}|\b\d{9}\b/g, '[ID]') : v

function pack(entries: Array<{ cat: Parameters<typeof cite>[0]; e: CatalogEntry }>): PackEntry[] {
  return entries
    .filter(({ e }) => !IDENTITY_LABEL.test(e.label) && !IDENTITY_LABEL.test(e.desc.slice(0, 80)))
    .map(({ cat, e }) => {
      if (e.kind === 'check') {
        // A ticked box's answer is the END of its label ("… — No"); cut from
        // the front, never the back, and say it first: the model once read a
        // ticked "No" as "Yes" because the label was truncated before "— No".
        const parts = e.label.split(' — ')
        const answer = parts.length > 1 ? parts[parts.length - 1] : e.label.slice(-40)
        const question = parts.length > 1 ? parts.slice(0, -1).join(' — ') : e.label
        return { id: e.id, where: cite(cat, e), label: `☒ ${answer}: ${question.slice(-160)}`, value: `ticked: ${answer}` }
      }
      return { id: e.id, where: cite(cat, e), label: e.label.slice(0, 140), value: maskIds(e.kind === 'row' ? e.raw.slice(0, 200) : e.value) }
    })
}

/** Models name the citation field differently from run to run. */
function citedOf(o: any): string[] {
  const v = o?.cited ?? o?.citations ?? o?.cited_ids ?? o?.evidence_ids ?? o?.ids ?? []
  return Array.isArray(v) ? v.map((x: any) => String(typeof x === 'object' && x ? x.id ?? '' : x)) : []
}

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info']

/** Drop citations the pack doesn't contain; drop the item if none remain. */
export function grounded<T extends { cited?: unknown }>(items: T[], ids: Set<string>): Array<T & { cited: string[] }> {
  return items
    .map(i => ({ ...i, cited: (Array.isArray(i.cited) ? i.cited : []).map(String).filter(id => ids.has(id)) }))
    .filter(i => i.cited.length > 0)
}

export function aiChecks(ask: AskJson = geminiJson): Check[] {
  const sstb: Check = {
    id: 'ai.sstb_judgement',
    version: 1,
    area: 'qbi',
    title: 'Is the business a specified service (AI, grounded in the return)?',
    applies: ['1120S', '1065'],
    kind: 'ai',
    description: 'Reads what the return says the business does (activity code, Schedule B description, the §199A statement, the kinds of income and expense) and the recorded description, and judges whether it is a §199A(d)(2) specified service — with the reasons and the lines relied on. A non-SSTB QBI position that the evidence does not support is a finding.',
    async run(ctx) {
      const cat = filed(ctx.catalogs, ctx.year)
      if (!cat) return [{ check: this.id, status: 'n/a', severity: 'info', title: 'No return', detail: '', evidence: [] }]
      const form = ctx.entity.form_type === '1065' ? 'f1065' : 'f1120s'
      const picks: CatalogEntry[] = [
        find(cat, form, { line: 'B' }), find(cat, form, { line: 'A' }),
        ...formEntries(cat, form).filter(e => e.section === 'Schedule B' && /^2/.test(e.line)),
        ...formEntries(cat, form).filter(e => !e.section && /^(1a|1c|2|7|8|16|20)$/.test(e.line)),
      ].filter((e): e is CatalogEntry => !!e)
      const stmt = cat.entries.filter(e => e.form === 'statement' && /199A|SSTB|specified service|QBI|deduction|statement/i.test(e.section + ' ' + e.raw)).slice(0, 80)
      const items = pack([...picks, ...stmt].map(e => ({ cat, e })))
      const desc = ctx.facts.get('entity.business_description', { year: ctx.year })
      const rationale = ctx.facts.get('entity.sstb_rationale', { year: ctx.year })
      const prompt = `You are reviewing a US ${ctx.entity.form_type} return for tax year ${ctx.year} for "${ctx.entity.name}".
Decide whether its trade or business is a specified service trade or business (SSTB) under IRC §199A(d)(2) and Treas. Reg. §1.199A-5(b): health, law, accounting (including tax return preparation), actuarial science, performing arts, consulting, athletics, financial services, brokerage services, investing/trading, or any business whose principal asset is the reputation or skill of its employees or owners. Sales and marketing are not consulting (Reg. 1.199A-5(b)(2)(vii)).
Use ONLY the evidence below. Each item has an id; cite the ids you rely on.
Owner's recorded description: ${desc?.status === 'answered' ? JSON.stringify(desc.value) : 'none recorded'}
Owner's recorded SSTB rationale: ${rationale?.status === 'answered' ? JSON.stringify(rationale.value) : 'none recorded'}
EVIDENCE:
${JSON.stringify(items)}
Answer as JSON: {"verdict": "sstb" | "not_sstb" | "uncertain", "field": string, "reasoning": string, "cited": [ids], "missing": [string]}`
      const raw = unwrap(await ask(prompt)) as any
      const res = { ...raw, verdict: String(raw?.verdict ?? raw?.Verdict ?? '').toLowerCase(), reasoning: raw?.reasoning ?? raw?.Reasoning, cited: citedOf(raw) } as { verdict?: string; field?: string; reasoning?: string; cited?: string[]; missing?: string[] }
      const ids = new Set(items.map(i => i.id))
      const [g] = grounded([res], ids)
      if (!g) return [{ check: this.id, status: 'error', severity: 'low', title: 'AI SSTB judgement cited nothing on the return; discarded', detail: `${String(res?.reasoning ?? '').slice(0, 300)} | reply keys: ${Object.keys(raw ?? {}).join(', ')} | cited: ${JSON.stringify(res.cited).slice(0, 120)}`, evidence: [] }]
      const position = (() => {
        for (const l of ctx.linked.filter(x => x.relation === 'k1_recipient')) {
          const rc = filed(l.catalogs, ctx.year)
          const ded = formEntries(rc, 'f8995a').find(e => e.section === 'Part IV' && e.line === '39')
          if (ded && typeof ded.value === 'number' && ded.value > 0) return { owner: l.entity.name, deduction: ded.value }
        }
        return null
      })()
      const evidence = g.cited.map(id => { const e = cat.entries.find(x => x.id === id)!; return { where: cite(cat, e), entry_id: id, catalog_id: cat.id } })
      const conflict = position && g.verdict !== 'not_sstb'
      // An SSTB reading is worth reporting even with no 1040 linked to compare
      // against: above the threshold it means no QBI deduction for any owner.
      const status = conflict || g.verdict === 'sstb' ? 'finding' : g.verdict === 'uncertain' ? 'gap' : 'pass'
      return [{
        check: this.id, status,
        severity: conflict ? (g.verdict === 'sstb' ? 'high' : 'medium') : g.verdict === 'sstb' ? 'medium' : 'info',
        title: `${ctx.year}: AI reads the business as ${g.verdict === 'sstb' ? `an SSTB (${g.field})` : g.verdict === 'not_sstb' ? 'not an SSTB' : 'uncertain'}${conflict ? ` — but ${position!.owner} took a ${position!.deduction.toLocaleString('en-US')} QBI deduction as non-SSTB` : ''}`,
        detail: `${g.reasoning ?? ''}${g.missing?.length ? `\nWould settle it: ${g.missing.join('; ')}` : ''}`,
        evidence, asks: g.verdict === 'not_sstb' ? undefined : ['entity.business_description', 'entity.sstb_determination', 'entity.sstb_rationale'],
      }]
    },
  }

  const scan: Check = {
    id: 'ai.framework_scan',
    version: 1,
    area: 'catalog',
    title: 'Anything else wrong in this return (AI, grounded in the return)',
    applies: ['1040', '1120', '1120S', '1065'],
    kind: 'ai',
    description: 'Gives the model the year\'s catalogued return (every amount, check and statement row), last year\'s key figures and what the rule checks already found, and asks for anything else that looks wrong or risky in the framework\'s areas — each with the lines it relies on. Ungrounded items are discarded.',
    async run(ctx) {
      const cat = filed(ctx.catalogs, ctx.year)
      if (!cat) return [{ check: this.id, status: 'n/a', severity: 'info', title: 'No return', detail: '', evidence: [] }]
      const entries = cat.entries.filter(e => !/^copy/.test(e.instance) && e.section !== '(unassigned)' && (e.kind !== 'text' || e.raw.length < 60))
      const ranked = [
        ...entries.filter(e => e.form !== 'statement' && e.kind !== 'row'),
        ...entries.filter(e => e.form === 'statement' && typeof e.value === 'number'),
      ].slice(0, 900)
      const items = pack(ranked.map(e => ({ cat, e })))
      const prev = filed(ctx.catalogs, ctx.year - 1)
      const prevItems = prev ? pack(prev.entries.filter(e => e.kind === 'amount' && e.form !== 'statement' && !/^copy/.test(e.instance)).slice(0, 250).map(e => ({ cat: prev, e }))) : []
      const k = ctx.entity.form_type === '1040' ? scheduleERows(cat).map(r => `${r.name} (${r.type}) passive ${r.passive_income} nonpassive ${r.nonpassive_income}`) : issuedK1s(cat).map(x => JSON.stringify(x.box))
      const prompt = `You are a senior US tax reviewer. Review this filed ${ctx.entity.form_type} for tax year ${ctx.year} ("${ctx.entity.name}", ${ctx.entity.entity_type}).
Areas to cover: corporate status and elections, income completeness, deductions and their timing (state taxes deductible when paid for cash-basis taxpayers), Schedule K/K-1 consistency, balance sheet and M-1/M-2, shareholder/partner basis and loans, NIIT, QBI/SSTB, carryovers, intercompany transactions, IRS filing compliance, preparer and signature blocks.
Report ONLY concrete problems or material risks you can tie to specific lines below (cite their ids). Do not repeat issues already found: ${JSON.stringify(ctx.priorTitles ?? [])}.
K-1 summary: ${JSON.stringify(k)}
THIS YEAR (id, where, label, value):
${JSON.stringify(items)}
PRIOR YEAR KEY AMOUNTS:
${JSON.stringify(prevItems)}
Answer as JSON: {"issues": [{"title": string, "detail": string, "area": string, "severity": "high"|"medium"|"low", "dollar_effect": number|null, "cited": [ids]}]}`
      const got = await ask(prompt)
      const res = (Array.isArray(got) ? { issues: got } : got) as { issues?: Array<{ title?: string; detail?: string; area?: string; severity?: string; dollar_effect?: number | null; cited?: string[] }> }
      const ids = new Set([...items.map(i => i.id), ...prevItems.map(i => i.id)])
      const issues = grounded((res?.issues ?? []).map(i => ({ ...i, cited: citedOf(i) })), ids)
      if (!issues.length) return [{ check: this.id, status: 'pass', severity: 'info', title: 'AI scan found nothing further', detail: '', evidence: [] }]
      return issues.slice(0, 15).map((i, n): CheckResult => ({
        check: this.id, status: 'finding', key: `ai${n}:${(i.title ?? '').slice(0, 40)}`,
        severity: (SEVERITIES.includes(i.severity as Severity) ? i.severity : 'medium') as Severity,
        title: `${ctx.year}: ${i.title ?? 'Issue'} (AI)`,
        detail: `${i.detail ?? ''}\nArea: ${(i.area as Area) ?? 'other'}. Raised by the AI scan — verify before acting.`,
        evidence: i.cited.map(id => { const c = cat.entries.find(x => x.id === id) ? cat : prev!; const e = c.entries.find(x => x.id === id)!; return { where: cite(c, e), entry_id: id, catalog_id: c.id } }),
        ...(typeof i.dollar_effect === 'number' ? { dollar_effect: i.dollar_effect } : {}),
      }))
    },
  }
  return [sstb, scan]
}

declare module './types.js' {
  interface ReviewContext {
    /** Titles of rule findings already raised in this run (so the AI scan doesn't repeat them) */
    priorTitles?: string[]
  }
}
