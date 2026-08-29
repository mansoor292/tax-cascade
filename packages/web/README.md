# @taxengine/web

Catipult Tax's frontend: Vite + React 19 SPA deployed on Netlify at
fin.catipult.ai, plus the OAuth 2.1 Netlify Functions used by the MCP
connector flow.

```bash
npm run dev        # :5173, proxies /api and /auth to the API on :3737
npm run build      # tsc -b && vite build
npm run lint
npm run test:e2e   # Playwright vs localhost (test:e2e:prod for the live site)
```

See `CLAUDE.md` in this directory for the layout, conventions, and the
rules that keep the Netlify redirect chain and OAuth discovery working.
