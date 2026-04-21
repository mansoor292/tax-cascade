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
module.exports = {
  apps: [{
    name: 'tax-api',
    script: '/opt/tax-api/node_modules/.bin/tsx',  // hoisted in the workspace
    args: 'src/server.ts',
    cwd: '/opt/tax-api/packages/api',
    instances: 'max',        // one worker per CPU core
    exec_mode: 'cluster',
    merge_logs: true,
    autorestart: true,
    max_memory_restart: '768M',
    node_args: ['--unhandled-rejections=warn'],
    env: {
      NODE_ENV: 'production',
    },
  }],
}
