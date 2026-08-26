/**
 * Environment bootstrap — MUST be the first import in server.ts.
 *
 * Why this is its own module:
 *
 * Route modules capture process.env at module scope:
 *     const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || <anon literal>
 *
 * This package is ESM ("type": "module", "module": "NodeNext"), so every
 * `import` in server.ts is HOISTED and fully evaluated before any statement
 * in server.ts's body runs. When the env loading lived inline in that body —
 * interleaved between the import statements, which reads as sequential — the
 * route modules had already evaluated and captured their fallbacks by the
 * time dotenv and SSM ran. Every route silently ran on the anon key, and
 * because RLS is enforced, real queries returned nothing at all.
 *
 * ESM evaluates imports depth-first in source order, so making this the
 * FIRST import is what actually guarantees env is populated before any route
 * module reads it. Nothing here may import a module that reads env at load.
 *
 * Precedence (first-loaded wins — dotenv default):
 *   1. .env.production (deploy-specific non-secrets: PORT, region, URLs)
 *   2. AWS SSM Parameter Store /tax-api/* (secrets: SUPABASE_SERVICE_ROLE_KEY,
 *      QBO, Gemini…)
 *   3. .env (local dev baseline; skipped in prod if SSM won)
 */
import { config as loadEnv } from 'dotenv'
import { loadSsmParametersSync } from './lib/ssm.js'

if (process.env.NODE_ENV === 'production') {
  loadEnv({ path: '.env.production' })
}

const __ssm = loadSsmParametersSync()
if (__ssm.error) console.warn(`[ssm] load skipped: ${__ssm.error}`)
else console.log(`[ssm] loaded ${__ssm.loaded.length} params (${__ssm.skipped.length} already set)`)

loadEnv({ path: '.env' })
if (process.env.DOTENV_CONFIG_PATH) loadEnv({ path: process.env.DOTENV_CONFIG_PATH })

// Fail loudly rather than silently degrading to the anon key. Without the
// service role key every RLS-protected query returns empty and the API looks
// healthy while serving nothing — the exact failure this module exists to
// prevent.
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    '[bootstrap] SUPABASE_SERVICE_ROLE_KEY is not set after loading .env.production, SSM and .env. ' +
    'Routes will fall back to the anon key and RLS will return no rows for every query.',
  )
}

export const envReady = true
