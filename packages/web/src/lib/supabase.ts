import { createClient } from '@supabase/supabase-js'

// Env only — the anon key is injected at build time (netlify.toml names the
// variable; the value lives in the Netlify dashboard) or via .env for local
// dev. The hardcoded fallback literal this file used to carry is the reason
// the key had to be rotated; never re-add one.
const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY
if (!url || !key) {
  throw new Error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set — see packages/web/CLAUDE.md')
}

export const supabase = createClient(url, key)
