/**
 * OAuth discovery metadata — the netlify.toml redirect block, ported as
 * explicit routes. The ordering rules that caused two production incidents
 * on Netlify (SPA fallback swallowing discovery URLs; HTML parsed as
 * metadata → "Couldn't reach server") become plain code here: the known
 * documents are served in every RFC spelling, and EVERY other well-known
 * path 404s with JSON — never falls through to the SPA.
 *
 * Spellings served (RFC 9728 / RFC 8414 with a path-bearing resource /mcp):
 *   /.well-known/oauth-protected-resource[/...]
 *   /mcp/.well-known/oauth-protected-resource
 *   /.well-known/oauth-authorization-server[/...]
 *   /mcp/.well-known/oauth-authorization-server
 * The documents themselves stay in packages/web/public/.well-known/ — the
 * one copy, read at boot.
 */
import { Router } from 'express'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const WELL_KNOWN_DIR = path.resolve(here, '../../../web/public/.well-known')

function loadDoc(name: string): unknown {
  return JSON.parse(readFileSync(path.join(WELL_KNOWN_DIR, name), 'utf8'))
}

const PROTECTED_RESOURCE = loadDoc('oauth-protected-resource.json')
const AUTH_SERVER        = loadDoc('oauth-authorization-server.json')

const router = Router()

for (const p of [
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/*',
  '/mcp/.well-known/oauth-protected-resource',
]) router.get(p, (_req, res) => res.json(PROTECTED_RESOURCE))

for (const p of [
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-authorization-server/*',
  '/mcp/.well-known/oauth-authorization-server',
]) router.get(p, (_req, res) => res.json(AUTH_SERVER))

// Any OTHER discovery document must 404 with JSON, not reach the SPA
// fallback: MCP clients try several candidates and move past a 404, but an
// HTML page served 200 parses as broken metadata.
for (const p of ['/.well-known/*', '/mcp/.well-known/*']) {
  router.all(p, (_req, res) => res.status(404).json({ error: 'not_found' }))
}

export default router
