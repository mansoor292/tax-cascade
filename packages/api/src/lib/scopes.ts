/**
 * API key scopes — a key that can read the books but not move money.
 *
 * Why (2026-11-10): the catalogs.com billing worker calls this API with a
 * txk_ key to fill QuickBooks invoices, create and charge Stripe invoices
 * and record payments. Until now every key was all-powerful: the same key
 * that reads a P&L could void an invoice or charge a card. Scopes split
 * that: a key provisioned with ['read'] answers every GET and is refused at
 * every route that writes to QuickBooks or Stripe.
 *
 * The scope set is tiny on purpose — '*' (everything, the default for every
 * key that predates the column), 'read', 'write'. Per-resource scopes can
 * come later if a caller ever needs them; today the only question anyone
 * asks is "can this key change anything".
 *
 * `req.apiKeyScopes` is set by the /api auth middleware in server.ts on
 * every success path: static TAX_API_KEYS and Supabase JWT callers get
 * ['*'], provisioned api_key rows get their stored `scopes`. requireWrite
 * fails CLOSED — a request that reaches a write route with no scopes set at
 * all is refused, so a missed success path shows up as a loud 403 rather
 * than a silent bypass.
 */
import type { Request, Response, NextFunction } from 'express'

export type ApiKeyScope = '*' | 'read' | 'write'

export const API_KEY_SCOPES: readonly ApiKeyScope[] = ['*', 'read', 'write']

/** What a caller gets when no narrower scope applies. */
export const ALL_SCOPES: readonly ApiKeyScope[] = ['*']

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by the /api auth middleware; absent means "not authenticated here". */
      apiKeyScopes?: readonly string[]
    }
  }
}

/** True when the scope list allows a write: '*' or 'write' is present. */
export function hasWriteScope(scopes: readonly string[] | null | undefined): boolean {
  if (!Array.isArray(scopes)) return false
  return scopes.includes('*') || scopes.includes('write')
}

/**
 * The scopes a stored api_key row grants. An empty or missing array (a row
 * written before the column existed, or a migration that has not run yet)
 * means the key keeps the power it always had.
 */
export function scopesFromRow(row: { scopes?: unknown } | null | undefined): readonly string[] {
  const s = row?.scopes
  if (Array.isArray(s) && s.length > 0 && s.every(v => typeof v === 'string')) return s as string[]
  return ALL_SCOPES
}

/**
 * Validate the `scopes` a caller asks for on key creation. Returns the
 * cleaned list or throws with a message fit for a 400. Absent → ['*'], so
 * existing callers that never heard of scopes are unchanged.
 */
export function normalizeScopes(input: unknown): ApiKeyScope[] {
  if (input === undefined || input === null) return [...ALL_SCOPES]
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error(`scopes must be a non-empty array of ${API_KEY_SCOPES.map(s => `'${s}'`).join(', ')}`)
  }
  const out: ApiKeyScope[] = []
  for (const v of input) {
    if (typeof v !== 'string' || !(API_KEY_SCOPES as readonly string[]).includes(v)) {
      throw new Error(`unknown scope ${JSON.stringify(v)}; allowed: ${API_KEY_SCOPES.map(s => `'${s}'`).join(', ')}`)
    }
    if (!out.includes(v as ApiKeyScope)) out.push(v as ApiKeyScope)
  }
  return out
}

/**
 * Express gate for routes that change something in QuickBooks or Stripe.
 * Mount it per route, after the ownership check has no reason to run first:
 * a read-only key gets a 403 whether or not it owns the entity, and the
 * message names what is missing.
 */
// Generic over the route's params on purpose. Typed as a plain `Request`,
// the middleware's default ParamsDictionary (string | string[]) would be
// unified into every route it sits in front of, and `req.params.entity_id`
// in the handler after it would stop being a string.
export function requireWrite<P = unknown, ResBody = unknown, ReqBody = unknown, ReqQuery = unknown>(
  req: Request<P, ResBody, ReqBody, ReqQuery>, res: Response<ResBody>, next: NextFunction,
) {
  if (hasWriteScope(req.apiKeyScopes)) return next()
  res.status(403).json({ error: 'write scope required' } as ResBody)
}
