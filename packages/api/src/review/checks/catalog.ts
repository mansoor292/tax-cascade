/**
 * Catalog checks: is the return fully read, does it add up, are its printed
 * copies consistent, and do we hold the IRS's own record of it. Everything
 * else in the framework stands on these.
 */
import { checkTies } from '../../catalog/ties.js'
import type { Check, CheckResult } from '../types.js'
import { filed, transcript, transactions, money } from '../lookup.js'
import { filedReturnExpected } from './irs.js'

const ALL = ['1040', '1120', '1120S', '1065'] as const

export const catalogChecks: Check[] = [
  {
    id: 'catalog.return_present',
    version: 3,
    area: 'catalog',
    title: 'The filed return is catalogued, completely',
    applies: [...ALL],
    kind: 'rule',
    description: 'Every question about a return is answered from its catalog, so a year whose filed return is missing from the catalog, or catalogued with blocking problems, cannot be reviewed — and nothing said about it is grounded.',
    run(ctx) {
      const cat = filed(ctx.catalogs, ctx.year)
      const expected = filedReturnExpected(ctx)
      if (!cat && !expected.expected) {
        // Not asked for — but when the IRS shows the return processed (TC150),
        // the copy is worth having, at low priority: the owner's 2016–2021
        // returns were filed, the transcripts say so, and no copy is here
        // (Mansoor, 2026-10-23: "yea").
        const t = transcript(ctx.catalogs, ctx.year)
        const tc150 = transactions(t).find(x => x.code === '150')
        if (tc150) {
          return [{
            check: this.id, status: 'gap', severity: 'low',
            title: `The IRS has a ${ctx.year} return; no copy is on file here`,
            detail: `The ${ctx.year} account transcript shows the return processed (TC150${tc150.date ? ` on ${tc150.date}` : ''}). Upload the filed PDF if you have it; otherwise a copy can be requested from the IRS on Form 4506. Not asked for as a filing: ${expected.why}.`,
            evidence: [{ where: `${ctx.year} IRS account transcript${t?.source_filename ? ` (${t.source_filename})` : ''}`, catalog_id: t!.id }],
          }]
        }
        return [{ check: this.id, status: 'n/a', severity: 'info', title: `No filed ${ctx.year} return expected — ${expected.why}`, detail: '', evidence: [] }]
      }
      if (!cat) {
        return [{
          check: this.id, status: 'gap', severity: 'high',
          title: `No filed ${ctx.year} return is catalogued`,
          detail: `There is no catalogued filed return for ${ctx.year}. Upload the filed PDF with catalog_upload (or catalogue the stored document with catalog_document). If the return itself cannot be found, request a copy from the IRS on Form 4506; an account transcript proves whether it was filed.`,
          evidence: [],
        }]
      }
      if (cat.status !== 'complete') {
        return [{
          check: this.id, status: 'finding', severity: 'high',
          title: `The ${ctx.year} return's catalog is incomplete`,
          detail: `Blocking problems: ${(cat.coverage?.problems ?? []).join('; ') || 'see catalog_status'}. Values on those pages are stored as unassigned text, not on lines, so checks may miss them.`,
          evidence: [{ where: `${ctx.year} catalog (${cat.source_filename ?? cat.id})`, catalog_id: cat.id }],
        }]
      }
      return [{ check: this.id, status: 'pass', severity: 'info', title: `${ctx.year} return catalogued completely`, detail: '', evidence: [{ where: `${ctx.year} catalog`, catalog_id: cat.id }] }]
    },
  },
  {
    id: 'catalog.arithmetic',
    version: 1,
    tie: true,
    area: 'catalog',
    title: "The return's own arithmetic holds",
    applies: [...ALL],
    kind: 'rule',
    description: "Each form's internal sums (1120-S line 22 = 6 − 21, Schedule L assets = liabilities + equity, M-2 rollforward, 1040 AGI/taxable income/total tax…). A break is either a cataloguing error or the filer's own arithmetic error; both need a person to look.",
    run(ctx) {
      const cat = filed(ctx.catalogs, ctx.year)
      if (!cat) return [{ check: this.id, status: 'n/a', severity: 'info', title: 'No return to check', detail: '', evidence: [] }]
      const ties = checkTies(cat.entries)
      const out: CheckResult[] = ties.filter(t => !t.ok).map(t => ({
        check: this.id, status: 'finding' as const, severity: 'medium' as const, key: `${t.form}:${t.instance}:${t.expr}`,
        title: `${ctx.year} ${t.form}${t.instance ? ' [' + t.instance + ']' : ''}: ${t.expr} does not hold`,
        detail: `Left side ${money(t.left)}, right side ${money(t.right)}, difference ${money(t.difference)}.${t.note ? ' (' + t.note + ')' : ''} Either a line was read into the wrong box or the return was filed with an arithmetic error.`,
        evidence: [{ where: `${ctx.year} ${t.form} ${t.expr}`, catalog_id: cat.id, value: t.difference }],
      }))
      if (!out.length) out.push({ check: this.id, status: 'pass', severity: 'info', title: `${ties.length} arithmetic ties hold`, detail: '', evidence: [] })
      return out
    },
  },
  {
    id: 'catalog.printed_copies_agree',
    version: 1,
    area: 'catalog',
    title: 'Every printed copy of a page says the same thing',
    applies: [...ALL],
    kind: 'rule',
    description: 'A filed PDF that carries two different versions of the same page (EV 2023/2024: one copy of the 1120 with the paid-preparer block filled, one without) means it is unclear which version the IRS received.',
    run(ctx) {
      const cat = filed(ctx.catalogs, ctx.year)
      const n = cat?.coverage?.copy_conflicts ?? 0
      if (!cat || !n) return [{ check: this.id, status: cat ? 'pass' : 'n/a', severity: 'info', title: 'Printed copies agree', detail: '', evidence: [] }]
      const msgs = (cat.coverage?.warnings ?? []).filter(w => /second copy/.test(w))
      return [{
        check: this.id, status: 'finding', severity: 'low',
        title: `${ctx.year} return contains ${n} page(s) printed twice with different contents`,
        detail: `${msgs.join('; ')}. Confirm which version was filed (the IRS transcript or e-file acknowledgement shows what was received) and keep only that one as the filed copy.`,
        evidence: [{ where: `${ctx.year} catalog warnings`, catalog_id: cat.id }],
      }]
    },
  },
  {
    id: 'catalog.transcript_present',
    version: 1,
    area: 'irs_account',
    title: "The IRS's record of the year is on file",
    applies: [...ALL],
    kind: 'rule',
    description: 'Only the account transcript shows what the IRS actually received and when (statute dates run from it), duplicates, penalties and balances. EZA\'s 2021 transcript was the only proof the return had been filed.',
    run(ctx) {
      if (transcript(ctx.catalogs, ctx.year)) return [{ check: this.id, status: 'pass', severity: 'info', title: `${ctx.year} account transcript catalogued`, detail: '', evidence: [] }]
      return [{
        check: this.id, status: 'gap', severity: 'medium',
        title: `No ${ctx.year} IRS account transcript is catalogued`,
        detail: `Pull the ${ctx.year} account transcript (Transcript Delivery System or IRS online account) and upload it with catalog_upload, doc_type tax_transcript. Without it the filing date, any duplicate or misposted return, penalties and balance due for ${ctx.year} are unknown.`,
        evidence: [],
      }]
    },
  },
]
