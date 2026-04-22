/**
 * POST /.netlify/functions/oauth-issue-code
 *
 * Called same-origin by the React consent screen (OAuthAuthorize.tsx) after
 * the user has signed in with Supabase and clicked "Approve". We validate
 * the Supabase session JWT server-side, find-or-create the user's MCP
 * API key, and sign a short-lived auth code. The caller (the React page)
 * then handles the top-level redirect back to Claude.ai.
 */
import type { Context } from '@netlify/functions'
import {
  supabaseAnon, signAuthCode, findOrCreateApiKey, json, error,
} from './_shared/oauth.js'

interface IssueCodeBody {
  code_challenge:        string
  code_challenge_method: string
  redirect_uri:          string
  state?:                string
  client_id?:            string
  scope?:                string
  supabase_jwt:          string
}

export default async (req: Request, _ctx: Context): Promise<Response> => {
  if (req.method !== 'POST') return error('method_not_allowed', 'POST required', 405)

  let body: IssueCodeBody
  try {
    body = await req.json()
  } catch {
    return error('invalid_request', 'JSON body required')
  }

  const {
    code_challenge,
    code_challenge_method,
    redirect_uri,
    state,
    client_id,
    supabase_jwt,
  } = body || ({} as IssueCodeBody)

  if (!code_challenge || !redirect_uri || !supabase_jwt) {
    return error('invalid_request', 'code_challenge, redirect_uri, supabase_jwt are required')
  }
  if (code_challenge_method !== 'S256') {
    // Tighten per OAuth 2.1: only S256 is accepted.
    return error('invalid_request', 'Only S256 code_challenge_method is supported')
  }

  // Verify the Supabase session server-side.
  const supabase = supabaseAnon()
  const { data: userResp, error: userErr } = await supabase.auth.getUser(supabase_jwt)
  if (userErr || !userResp?.user) {
    return error('invalid_grant', 'Invalid or expired Supabase session', 401)
  }

  const userId = userResp.user.id
  const api_key = await findOrCreateApiKey(userId)

  const code = await signAuthCode({
    api_key,
    code_challenge,
    redirect_uri,
    client_id: client_id || '',
    user_id:   userId,
  })

  return json({
    code,
    redirect_uri,
    state: state || '',
  })
}
