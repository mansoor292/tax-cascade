// pm2 process config for tax-api.
//
// Cluster mode: spawn one worker per CPU core. Node is single-threaded, and
// heavy paths (argon2 verify on auth, AES-GCM on large JSON, pdf-lib form
// fill) block the event loop. Clustering is the cheapest way to keep the
// service responsive under concurrent MCP load without rewriting the hot
// path into worker_threads.
//
// Per-process state: DEK LRU cache in crypto.ts is NOT shared across workers.
// Each worker KMS-decrypts a user's DEK on first hit and caches it for
// TAX_API_DEK_TTL_MS (default 10 min). Fine at our scale — a ~N-worker fan-
// out on first request adds one KMS round-trip per worker per user per TTL.
//
// Env: dotenv loads .env.production from cwd (/opt/tax-api/packages/api)
// before this file is consulted. Keep secrets out of here.
//
// Usage on prod:
//   pm2 delete tax-api 2>/dev/null || true
//   pm2 start /opt/tax-api/ecosystem.config.cjs
//   pm2 save   # persist so pm2 resurrect picks it up after reboot
// Why `--import tsx` and NOT the tsx bin shim:
//
// The shim (node_modules/.bin/tsx) SPAWNS A CHILD to run the script. Under
// cluster mode that child is not a cluster worker, so it calls a plain
// listen() instead of inheriting the master's shared socket. With two
// workers the second child hit EADDRINUSE, exited 1, and pm2 respawned it —
// 4.2 million times over 135 days, burning a core and leaving exactly ONE
// worker actually serving. Silent, because pm2 restarts forever without
// complaint and the surviving worker kept answering.
//
// `node --import tsx src/server.ts` loads TypeScript in-process, so the
// pm2-forked worker IS the server and cluster socket sharing works.
// Verified: under the shim the script runs in a child pid; under --import
// it runs in the forked pid itself.
// Deploys reload this cluster via scripts/deploy-reload.sh, double-forked out
// of the webhook so pm2's treekill cannot cut it short partway through.
module.exports = {
  apps: [{
    name: 'tax-api',
    script: 'src/server.ts',
    interpreter: 'node',
    // tsx resolves from the hoisted workspace root.
    interpreter_args: '--import tsx --unhandled-rejections=warn',
    cwd: '/opt/tax-api/packages/api',
    instances: 'max',        // one worker per CPU core
    exec_mode: 'cluster',
    merge_logs: true,
    autorestart: true,
    max_memory_restart: '768M',
    // Guardrails so a future crash loop is LOUD instead of invisible: a
    // worker that cannot stay up for 30s more than 10 times in a row is
    // marked errored and left down, rather than respawned indefinitely.
    min_uptime: '30s',
    max_restarts: 10,
    env: {
      NODE_ENV: 'production',
    },
  }],
}
