/**
 * TaxNow, behind one interface with two implementations:
 *  - HttpTaxNow: the platform org (api.taxnow.io) under ONE platform key.
 *    Catipult segregates accounts itself (practice_client); being in this org
 *    does not make an account anybody's client.
 *  - FixtureTaxNow (fixture.ts): fictional accounts in TaxNow's own formats,
 *    in-process, never the network. The demo practice and every test use it.
 *    Dev and tests never touch the real org.
 *
 * Facts learned on the real API (2026-10-24), encoded here:
 *  - Headers `Authorization: Bearer` + `X-Org-Id`. Cloudflare rejects default
 *    library user agents (error 1010): send a plain one.
 *  - Lists are paginated with `nextToken` (transcripts too: some accounts run
 *    to a second page).
 *  - `POST …/sync` is a REAL IRS request under the designee's CAF. Only
 *    services/practice_jobs.ts calls it, for a job a person confirmed.
 *  - `POST /v1/tins/search` takes the full TIN and answers 404 unless the org
 *    holds a valid 8821 designee relationship. It returns the TIN resource (a
 *    "Secret": selfUri + ciphertext), NOT the account; the account carries
 *    taxpayer.tinUri, so a TIN is matched to an account the org can already
 *    list (accountForTin). Never log its body.
 *  - Orgs are separated by the org designees on each account's 8821 record
 *    (tia): another org's key gets 403 on reads and on sync, and the sync is
 *    refused before it reaches the IRS. The same record lists any other firms
 *    that can see the account ("who else can see this client").
 *  - Return transcripts (RETR) exist for 1120/1120S/1065, tax years 2022–2025.
 */

export interface AccountRef { accountId: string; name: string }
export interface AccountRecord {
  accountId: string
  type: string
  name: string
  tinUri: string | null
  tia: { designees: Array<{ type: string; name: string; uri?: string }>; permissions: Array<{ type: string; forms: string[]; start: string; end: string }> }
}
export interface TranscriptRef { type: 'ACTR' | 'RETR' | string; form: string; year: number; month: number; syncedAt: string | null }
export interface TaskState { status: 'pending' | 'running' | 'succeeded' | 'failed' | string; code?: string | number; message?: string }

export interface TaxNowApi {
  readonly provider: 'taxnow' | 'fixture'
  /** The TaxNow org this reads through (its own designee is left out of "who else can see"). */
  readonly orgId: string
  listAccounts(): Promise<AccountRef[]>
  getAccount(accountId: string): Promise<AccountRecord>
  listTranscripts(accountId: string): Promise<TranscriptRef[]>
  getTranscriptHtml(accountId: string, t: Pick<TranscriptRef, 'type' | 'form' | 'year' | 'month'>): Promise<string>
  getTranscriptJson(accountId: string, t: Pick<TranscriptRef, 'type' | 'form' | 'year' | 'month'>): Promise<any>
  /** Full TIN in, the TIN resource's URI out (null when the org holds no valid 8821). */
  searchTin(tin: string): Promise<string | null>
  /** Add an account to the org's clients; returns the client URI. */
  addClient(accountId: string, externalId?: string): Promise<string>
  /** A REAL IRS request. Returns the task id to poll. */
  startSync(accountId: string, t: Pick<TranscriptRef, 'type' | 'form' | 'year' | 'month'>): Promise<string>
  getTask(accountId: string, taskId: string): Promise<TaskState>
}

export class TaxNowError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

const BASE = 'https://api.taxnow.io'
const UA = 'catipult-tax/1.0'
const last = (uri: string | undefined | null) => (uri ?? '').split('/').filter(Boolean).at(-1) ?? ''

export class HttpTaxNow implements TaxNowApi {
  readonly provider = 'taxnow' as const
  constructor(private key: string, readonly orgId: string, private base = BASE) {}

  private async req(method: string, path: string, body?: unknown, accept = 'application/json'): Promise<any> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.key}`, 'X-Org-Id': this.orgId, Accept: accept, 'User-Agent': UA,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(90_000),
    })
    const text = await res.text()
    if (!res.ok) {
      // Never echo a request body (the TIN search carries a full TIN).
      throw new TaxNowError(res.status, `TaxNow ${method} ${path.replace(/\/tins\/.*/, '/tins/…')} → ${res.status}: ${text.slice(0, 200)}`)
    }
    if (accept !== 'application/json') return text
    return text.trim() ? JSON.parse(text) : null
  }

  private async all(path: string): Promise<any[]> {
    const out: any[] = []
    let tok: string | null = null
    do {
      const sep = path.includes('?') ? '&' : '?'
      const page: any = await this.req('GET', path + (tok ? `${sep}nextToken=${encodeURIComponent(tok)}` : ''))
      out.push(...(page?.items ?? []))
      tok = page?.nextToken ?? null
    } while (tok)
    return out
  }

  async listAccounts() {
    return (await this.all('/v1/accounts')).map(a => ({ accountId: last(a.accountUri), name: String(a.taxpayerName ?? '') }))
  }
  async getAccount(accountId: string): Promise<AccountRecord> {
    const a = await this.req('GET', `/v1/accounts/${accountId}`)
    const n = a?.taxpayer?.name
    return {
      accountId, type: a?.type ?? '', tinUri: a?.taxpayer?.tinUri ?? null, name: typeof n === 'object' && n ? `${n.first ?? ''} ${n.last ?? ''}`.trim() : String(n ?? '').trim(),
      tia: { designees: a?.tia?.designees ?? [], permissions: a?.tia?.permissions ?? [] },
    }
  }
  async listTranscripts(accountId: string) {
    return (await this.all(`/v1/accounts/${accountId}/transcripts`)).map(t => ({ type: t.type, form: t.form, year: Number(t.year), month: Number(t.month), syncedAt: t.syncedAt ?? null }))
  }
  private tpath(accountId: string, t: Pick<TranscriptRef, 'type' | 'form' | 'year' | 'month'>) {
    return `/v1/accounts/${accountId}/transcripts/${t.type}/${t.form}/${t.year}/${t.month}`
  }
  getTranscriptHtml(accountId: string, t: Pick<TranscriptRef, 'type' | 'form' | 'year' | 'month'>) {
    return this.req('GET', this.tpath(accountId, t) + '/html', undefined, 'text/html')
  }
  getTranscriptJson(accountId: string, t: Pick<TranscriptRef, 'type' | 'form' | 'year' | 'month'>) {
    return this.req('GET', this.tpath(accountId, t))
  }
  async searchTin(tin: string) {
    try {
      const r = await this.req('POST', '/v1/tins/search', { value: tin })
      return r?.selfUri ? String(r.selfUri) : null
    } catch (e) {
      if (e instanceof TaxNowError && e.status === 404) return null
      throw e
    }
  }
  async addClient(accountId: string, externalId?: string) {
    const r = await this.req('POST', `/v1/orgs/${this.orgId}/clients`, { accountUri: `/accounts/${accountId}`, ...(externalId ? { externalId } : {}) })
    return String(r?.selfUri ?? '')
  }
  async startSync(accountId: string, t: Pick<TranscriptRef, 'type' | 'form' | 'year' | 'month'>) {
    const r = await this.req('POST', this.tpath(accountId, t) + '/sync', {})
    return last(r?.selfUri)
  }
  async getTask(accountId: string, taskId: string) {
    return await this.req('GET', `/v1/accounts/${accountId}/tasks/${taskId}`) as TaskState
  }
}

const tinKey = (uri: string | null | undefined) => last(uri)

/**
 * The account a TIN belongs to, among those the org can list. The TIN search
 * gives the TIN resource; each account names its own (taxpayer.tinUri). Skips
 * accounts in `known` (already matched elsewhere) to save calls.
 */
export async function accountForTin(tn: TaxNowApi, tin: string, known: Set<string> = new Set()): Promise<string | null> {
  const tinUri = await tn.searchTin(tin)
  if (!tinUri) return null
  for (const a of await tn.listAccounts()) {
    if (known.has(a.accountId)) continue
    const rec = await tn.getAccount(a.accountId)
    if (rec.tinUri && tinKey(rec.tinUri) === tinKey(tinUri)) return a.accountId
  }
  return null
}

let fixture: TaxNowApi | null = null

/**
 * Which TaxNow org a practice reads through. 'platform' is the org Catipult
 * faces TaxNow under (TAXNOW_API_KEY / TAXNOW_ORG_ID). Any other name is an
 * org whose key Catipult holds for one practice — the "bring your own TaxNow
 * Pro key" case Mansoor allowed (2026-10-25) — read from
 * TAXNOW_API_KEY_<NAME> / TAXNOW_ORG_ID_<NAME> (SSM /tax-api/*). Keys never
 * live in a table: practice.taxnow_org holds only the name.
 *
 * Why (2026-10-27): the Better Choice Lenders org has its own key and its own
 * clients (accounts in one org answer 403 to the other's key), and Mansoor
 * wanted it as a practice of its own under its own login — one org per
 * practice still holds.
 */
export const ORG_NAME = /^[a-z][a-z0-9_]{0,31}$/

export function orgCredentials(org: string, env: NodeJS.ProcessEnv = process.env): { key: string; orgId: string } | null {
  if (!ORG_NAME.test(org)) return null
  const suffix = org === 'platform' ? '' : `_${org.toUpperCase()}`
  const key = env[`TAXNOW_API_KEY${suffix}`]
  const orgId = env[`TAXNOW_ORG_ID${suffix}`]
  return key && orgId ? { key, orgId } : null
}

/** The TaxNow a practice reads through. 'fixture' never leaves the process. */
export async function taxnowFor(provider: 'taxnow' | 'fixture', org = 'platform'): Promise<TaxNowApi> {
  if (provider === 'fixture') {
    if (!fixture) fixture = new (await import('./fixture.js')).FixtureTaxNow()
    return fixture
  }
  const creds = orgCredentials(org)
  if (!creds) throw new TaxNowError(503, `TaxNow org '${org}' is not configured on this server.`)
  return new HttpTaxNow(creds.key, creds.orgId)
}
