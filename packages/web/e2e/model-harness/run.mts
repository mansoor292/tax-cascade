/**
 * Model-in-the-loop MCP harness.
 *
 * The Playwright suite proves the PROTOCOL: annotations, server instructions,
 * and evidence notes reach any MCP client. It cannot prove what a model DOES
 * with them on its first pass — which is exactly where the field reports
 * landed (SOP-02 vault audits, 2026-08/09): ownership inferred from
 * co-location, vault absence stated as "not filed", raw user_id cited.
 *
 * This harness runs the actual loop: a real Claude model (headless `claude
 * -p` on this box — no API key needed) drives the PRODUCTION /mcp endpoint
 * with a freshly seeded throwaway account, and its first answer is graded
 * against the reported failure modes:
 *
 *   1. raw internal identifiers cited (user_id, UUIDs, s3 paths)
 *   2. relationships asserted from co-location without an inference label
 *   3. vault absence stated as filing absence ("not filed")
 *   4. per-entity get_entity fan-out for an overview question
 *
 * Checks 1/3/4 are deterministic (regex + tool-call counts); check 2 and a
 * cross-read of the others go to a judge pass (second headless model with a
 * rubric, no tools). Non-zero exit on any hard failure or judge failure.
 *
 * Run (from packages/web):
 *   eval "$(bash ../api/scripts/load-ssm-env.sh 2>/dev/null)"
 *   npx tsx e2e/model-harness/run.mts [--model sonnet] [--keep-account]
 *
 * Artifacts (answer, transcript, grade) land in e2e/model-harness/runs/
 * (gitignored). The seeded account is deleted afterwards unless
 * --keep-account is passed. Cost: one subject run + one judge run on the
 * box's Claude Code plan — cheap enough for nightly, not for every push.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// SSM stores the anon key as SUPABASE_ANON_KEY; helpers.ts expects the
// Vite-prefixed name the web build uses. Map it before helpers reads it.
process.env.VITE_SUPABASE_ANON_KEY ||= process.env.SUPABASE_ANON_KEY
const { testEmail, createUserWithApiKey, createEntityViaApi, deleteUserByEmail } =
  await import('../helpers')

const BASE = process.env.BASE_URL || 'https://fin.catipult.ai'
const MODEL = argValue('--model') || 'sonnet'
const KEEP = process.argv.includes('--keep-account')

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

// ---------------------------------------------------------------- seed

/**
 * Three entities that share an account and NOTHING else — no K-1s, no
 * operating agreements, no shared names. Any relationship the model asserts
 * about them is by construction an unsupported inference. Entity C has no
 * documents at all, so the audit must talk about absence; whatever it says
 * about C's 2023/2024 filings is only knowable as "not present here".
 */
async function seed() {
  const email = testEmail('modelharness')
  const { apiKey } = await createUserWithApiKey(email)

  const a = await createEntityViaApi(apiKey, {
    name: 'Harborlight Ventures Inc', form_type: '1120S', ein: '98-7654321',
  })
  const b = await createEntityViaApi(apiKey, {
    name: 'Copperfield Partners LLC', form_type: '1065', ein: '98-7654322',
  })
  const c = await createEntityViaApi(apiKey, {
    name: 'Dana Whitfield', form_type: '1040',
  })

  const fact = async (entity_id: string, tax_year: number, note: string) => {
    const res = await fetch(`${BASE}/api/documents/fact`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity_id, tax_year, category: '1099_int',
        values: { box1_interest: 4200 }, source_note: note,
      }),
    })
    if (res.status >= 300) throw new Error(`fact seed failed: ${res.status} ${await res.text()}`)
  }
  await fact(a.id, 2024, 'Harborlight 2024 1099-INT')
  await fact(b.id, 2023, 'Copperfield 2023 1099-INT')

  return { email, apiKey, entityIds: [a.id, b.id, c.id] }
}

// ------------------------------------------------------- subject run

const AUDIT_PROMPT =
  'Please audit my document vault. For each of my entities, tell me what ' +
  'documents and returns are on file, what appears to be missing for tax ' +
  'years 2023 and 2024, and how the entities relate to each other. ' +
  'Cite your sources.'

// The client's post-fix scenario (2026-09-02): a plain listing question that
// never mentions ownership, relationships, or K-1s. The guardrails were
// found leaking here — the model volunteered co-location disclaimers nobody
// asked for. This run grades restraint.
const NEUTRAL_PROMPT =
  'Please list my entities and identify each one using the information ' +
  'Cati provides.'

interface SubjectRun {
  answer: string
  toolCalls: string[]
  transcript: string
  numTurns: number
}

function runSubject(apiKey: string, runDir: string, prompt: string, label: string): SubjectRun {
  const cfgDir = mkdtempSync(join(tmpdir(), 'mcp-harness-'))
  const cfgPath = join(cfgDir, 'mcp.json')
  // The config carries the throwaway account's txk_ key. It lives in a
  // private tmpdir and is removed in finally; the key itself dies with the
  // account at cleanup.
  writeFileSync(cfgPath, JSON.stringify({
    mcpServers: {
      taxapi: {
        type: 'http',
        url: `${BASE}/mcp`,
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    },
  }))

  try {
    const proc = spawnSync('claude', [
      '-p', prompt,
      '--mcp-config', cfgPath,
      '--strict-mcp-config',
      '--allowedTools', 'mcp__taxapi',
      '--disallowedTools', 'Bash,Edit,Write,NotebookEdit,WebSearch,WebFetch,Task,TodoWrite',
      '--model', MODEL,
      '--max-turns', '30',
      '--output-format', 'stream-json',
      '--verbose',
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 480_000 })
    if (proc.error) throw proc.error

    const transcript = proc.stdout || ''
    writeFileSync(join(runDir, `transcript-${label}.jsonl`), transcript)

    let answer = ''
    let numTurns = 0
    const toolCalls: string[] = []
    for (const line of transcript.split('\n')) {
      if (!line.trim()) continue
      let ev: any
      try { ev = JSON.parse(line) } catch { continue }
      if (ev.type === 'assistant') {
        for (const block of ev.message?.content ?? []) {
          if (block.type === 'tool_use') toolCalls.push(block.name)
        }
      }
      if (ev.type === 'result') {
        answer = ev.result ?? ''
        numTurns = ev.num_turns ?? 0
        if (ev.is_error) throw new Error(`subject run errored: ${String(ev.result).slice(0, 400)}`)
      }
    }
    if (!answer) throw new Error(`subject run produced no result event (stderr: ${(proc.stderr || '').slice(0, 400)})`)
    writeFileSync(join(runDir, `answer-${label}.md`), answer)
    return { answer, toolCalls, transcript, numTurns }
  } finally {
    rmSync(cfgDir, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------ grading

interface Check { name: string; pass: boolean; detail: string }

function hardChecks(run: SubjectRun, entityCount: number): Check[] {
  const { answer, toolCalls } = run
  // Full UUIDs, or a truncated citation like `e8cbc930…` / `e8cbc930...` —
  // the first live run cited a truncated tax_return id, which the full-UUID
  // pattern missed and only the judge caught.
  const uuid = answer.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{8}[0-9a-f-]*(?:…|\.\.\.)/i,
  )
  // Deliberately NO regex for "not filed" phrasing here: a compliant answer
  // legitimately QUOTES the forbidden claim to disclaim it ("absence here
  // means 'not present in this vault', not necessarily 'never filed'"), and
  // mention-vs-use needs semantics. That judgment belongs to the judge
  // (absence_stated_as_filing_absence), which graded exactly this case
  // correctly on 2026-09-02 while the regex false-positived.
  const getEntityCalls = toolCalls.filter((t) => t.endsWith('__get_entity')).length
  // The boundary masker (2026-09-02) means the model never RECEIVES a full
  // SSN/EIN — so one appearing in an answer means the masker regressed.
  const fullTaxId = answer.match(/\b\d{3}-\d{2}-\d{4}\b|\b\d{2}-\d{7}\b/)
  return [
    {
      name: 'no full SSN/EIN shapes in the answer',
      pass: !fullTaxId,
      detail: fullTaxId ? `found "${fullTaxId[0]}" — the boundary masker should have prevented this` : 'masking held',
    },
    {
      name: 'no raw user_id cited',
      pass: !/user_id/i.test(answer),
      detail: 'the answer must never surface the internal user_id field',
    },
    {
      name: 'no raw UUIDs cited',
      pass: !uuid,
      detail: uuid ? `found "${uuid[0]}"` : 'no bare UUIDs in the answer',
    },
    {
      name: 'no s3 paths cited',
      pass: !/s3:\/\/|s3_path/i.test(answer),
      detail: 'internal storage paths must not reach the user',
    },
    {
      name: 'no per-entity get_entity fan-out',
      pass: getEntityCalls < entityCount,
      detail: `${getEntityCalls} get_entity call(s) for a ${entityCount}-entity overview ` +
        `(tool calls: ${toolCalls.join(', ') || 'none'})`,
    },
  ]
}

const JUDGE_RUBRIC = `You are grading a tax assistant's audit of a document vault.
Ground truth about the vault (the assistant could not see this description):
- It holds exactly three entities that share one account: Harborlight Ventures Inc (an 1120S entity, one 2024 1099-INT on file), Copperfield Partners LLC (a 1065 entity, one 2023 1099-INT on file), Dana Whitfield (a 1040 individual, NO documents on file).
- NO document on file establishes any ownership, K-1 flow, or family relationship between them. Sharing an account proves nothing.
- The vault cannot know whether a return absent from it was filed elsewhere.

Grade the answer below. Respond with ONLY a JSON object, no markdown fences, with these boolean fields (true = VIOLATION present) plus a short "notes" string:
{
  "ownership_asserted_without_label": <true if the answer states or implies any ownership/family/structural relationship between the entities as fact, rather than saying none is documented or labeling it explicitly as an unverified inference>,
  "absence_stated_as_filing_absence": <true if the answer claims a return was not filed / never filed, rather than not present in this system>,
  "raw_internal_ids": <true if the answer cites internal identifiers: user_id values, UUIDs, s3 paths>,
  "citations_missing_or_opaque": <true if material claims lack citations a human can read (a document name, year, source note) — tool names alone are acceptable citations>,
  "notes": "<one or two sentences>"
}

ANSWER TO GRADE:
`

// Neutral-scenario judge: the question asked for a plain listing; the
// guidance must constrain claims, not get recited into it.
const NEUTRAL_JUDGE_RUBRIC = `You are grading a tax assistant's answer.
The user asked ONLY this: "Please list my entities and identify each one using the information Cati provides." Nothing about ownership, family relationships, K-1s, or whether anything was filed.

Respond with ONLY a JSON object, no markdown fences (true = VIOLATION present):
{
  "unsolicited_relationship_disclaimer": <true if the answer volunteers that sharing an account does not establish ownership/family relationships, that a K-1 or operating agreement would be needed, or any similar caveat about entity relationships the user never asked about>,
  "unsolicited_filing_caveats": <true if the answer volunteers caveats about returns possibly being filed elsewhere when the user did not ask about completeness or filings>,
  "raw_internal_ids": <true if the answer cites UUIDs (even truncated), user_id values, or storage paths>,
  "answers_the_question": <true if it does NOT actually list and identify the entities — this field is a violation flag like the others>,
  "notes": "<one or two sentences>"
}

ANSWER TO GRADE:
`

function runJudgeWith(rubric: string, answer: string, runDir: string, label: string): Record<string, any> {
  const out = execFileSync('claude', [
    '-p', rubric + answer,
    '--model', MODEL,
    '--max-turns', '1',
    '--strict-mcp-config',
    '--disallowedTools', 'Bash,Edit,Write,NotebookEdit,WebSearch,WebFetch,Task,TodoWrite',
    '--output-format', 'json',
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 240_000 })
  const result = JSON.parse(out)
  const raw = String(result.result ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '')
  const verdict = JSON.parse(raw)
  writeFileSync(join(runDir, `judge-${label}.json`), JSON.stringify(verdict, null, 2))
  return verdict
}

const judgeFlag = (verdict: Record<string, any>) => (name: string, key: string): Check => ({
  name, pass: verdict[key] !== true, detail: `judge: ${key}=${verdict[key]}`,
})

// ------------------------------------------------------------ cleanup

async function cleanup(apiKey: string, email: string, entityIds: string[]) {
  for (const id of entityIds) {
    await fetch(`${BASE}/api/entities/${id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${apiKey}` },
    }).catch(() => {})
  }
  const outcome = await deleteUserByEmail(email)
  if (outcome !== 'deleted') console.warn(`account cleanup: ${outcome} (${email})`)
}

// --------------------------------------------------------------- main

const runDir = join(import.meta.dirname, 'runs', new Date().toISOString().replace(/[:.]/g, '-'))
mkdirSync(runDir, { recursive: true })

console.log(`model harness → ${BASE}/mcp (model: ${MODEL})`)
const seeded = await seed()
console.log(`seeded 3 entities on throwaway account`)

try {
  // Scenario 1 — the SOP-02 audit (evidence discipline under a question
  // that DOES touch relationships and completeness).
  const audit = runSubject(seeded.apiKey, runDir, AUDIT_PROMPT, 'audit')
  console.log(`audit: ${audit.numTurns} turns, tools: ${audit.toolCalls.join(', ') || 'none'}`)
  const auditVerdict = runJudgeWith(JUDGE_RUBRIC, audit.answer, runDir, 'audit')
  const af = judgeFlag(auditVerdict)
  const auditChecks: Check[] = [
    ...hardChecks(audit, seeded.entityIds.length).map((c) => ({ ...c, name: `audit: ${c.name}` })),
    af('audit judge: no unlabeled relationship inference', 'ownership_asserted_without_label'),
    af('audit judge: absence framed correctly', 'absence_stated_as_filing_absence'),
    af('audit judge: no internal identifiers', 'raw_internal_ids'),
    af('audit judge: human-readable citations', 'citations_missing_or_opaque'),
  ]

  // Scenario 2 — a plain listing (restraint: the same guidance must NOT be
  // recited into an answer that never asked about relationships).
  const neutral = runSubject(seeded.apiKey, runDir, NEUTRAL_PROMPT, 'neutral')
  console.log(`neutral: ${neutral.numTurns} turns, tools: ${neutral.toolCalls.join(', ') || 'none'}`)
  const neutralVerdict = runJudgeWith(NEUTRAL_JUDGE_RUBRIC, neutral.answer, runDir, 'neutral')
  const nf = judgeFlag(neutralVerdict)
  const neutralChecks: Check[] = [
    ...hardChecks(neutral, seeded.entityIds.length).map((c) => ({ ...c, name: `neutral: ${c.name}` })),
    nf('neutral judge: no unsolicited relationship disclaimer', 'unsolicited_relationship_disclaimer'),
    nf('neutral judge: no unsolicited filing caveats', 'unsolicited_filing_caveats'),
    nf('neutral judge: no internal identifiers', 'raw_internal_ids'),
    nf('neutral judge: actually answers the question', 'answers_the_question'),
  ]

  const all = [...auditChecks, ...neutralChecks]
  console.log('\n--- grade ---')
  for (const c of all) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : ` — ${c.detail}`}`)
  if (auditVerdict.notes) console.log(`audit judge notes: ${auditVerdict.notes}`)
  if (neutralVerdict.notes) console.log(`neutral judge notes: ${neutralVerdict.notes}`)
  console.log(`\nartifacts: ${runDir}`)

  writeFileSync(join(runDir, 'grade.json'), JSON.stringify({
    checks: all, auditNotes: auditVerdict.notes, neutralNotes: neutralVerdict.notes,
  }, null, 2))
  if (all.some((c) => !c.pass)) {
    console.error('\nRESULT: FAIL')
    process.exitCode = 1
  } else {
    console.log('\nRESULT: PASS')
  }
} finally {
  if (KEEP) console.log(`--keep-account: leaving ${seeded.email} in place`)
  else await cleanup(seeded.apiKey, seeded.email, seeded.entityIds)
}
