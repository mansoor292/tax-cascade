import type { Response } from 'express'

/**
 * Answer a thrown error with the right status.
 *
 * Bad caller input is a 400, not a 500. The distinction matters twice over:
 * a 500 tells the caller (and Claude, driving the MCP tools) that OUR server
 * broke, so retrying the same bad payload looks reasonable; and the raw
 * message we were returning leaked database internals — column names,
 * constraint names, PostgREST syntax — to anyone with an account.
 */
export function sendError(res: Response, e: any, fallback = 'Internal error') {
  if (e?.name === 'TaxInputError') {
    return res.status(400).json({ error: e.message, field: e.field })
  }

  const msg = String(e?.message || fallback)

  // Postgres speaking directly to the client is always our bug, never
  // something the caller can act on. Translate the ones a user can actually
  // hit and keep the detail server-side.
  if (/invalid input syntax for type uuid/i.test(msg)) {
    return res.status(400).json({ error: 'Malformed id — expected a UUID.' })
  }
  if (/violates not-null constraint/i.test(msg)) {
    const col = msg.match(/column "([^"]+)"/)?.[1]
    return res.status(400).json({
      error: col ? `${col} is required.` : 'A required field is missing.',
      field: col,
    })
  }
  if (/violates foreign key constraint/i.test(msg)) {
    return res.status(400).json({ error: 'Referenced record does not exist.' })
  }
  // A value the database refuses is a bad argument, not a broken server. The
  // raw text named the constraint and nothing a caller could act on.
  if (/violates check constraint/i.test(msg)) {
    const con = msg.match(/constraint "([^"]+)"/)?.[1] || ''
    const field = con.replace(/^tax_entity_|^tax_return_|^document_|_check$/g, '') || undefined
    return res.status(400).json({
      error: field ? `Unsupported value for ${field}.` : 'That value is not one of the supported options.',
      field,
    })
  }
  if (/duplicate key value/i.test(msg)) {
    return res.status(409).json({ error: 'That record already exists.' })
  }

  // A missing integration is the caller's state, not our failure. Returning
  // 500 here told Claude the server was broken and invited a pointless retry.
  if (/no active (qbo|quickbooks|stripe) connection/i.test(msg)) {
    return res.status(409).json({ error: msg })
  }

  // Anything else keeps its message — most are genuinely useful (a QBO API
  // rejection, a PDF template mismatch) and hiding them helps nobody. Only
  // the database-internal shapes above are rewritten.
  console.error('[error]', e)
  return res.status(500).json({ error: msg || fallback })
}

/** Same mapping for a Supabase `error` object rather than a thrown one. */
export function sendDbError(res: Response, error: { message?: string }, fallback = 'Internal error') {
  return sendError(res, { message: error?.message }, fallback)
}
