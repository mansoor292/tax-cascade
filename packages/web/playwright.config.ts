import { defineConfig, devices } from '@playwright/test'

/**
 * E2E harness.
 *
 * The bugs worth catching here (auth triggers, RLS, env loading) only exist
 * against the real Supabase project and the real API — but these tests also
 * create real accounts, so pointing at production must be a deliberate act:
 * `npm run test:e2e:prod`. The default is the local vite dev server (whose
 * /api and /auth proxies still hit the real backend on :3737).
 *
 *   npm run dev & npx playwright test                    # local vite
 *   npm run test:e2e:prod                                # deployed site
 *   BASE_URL=https://... npx playwright test             # preview deploy
 */
export default defineConfig({
  testDir: './e2e',
  // Signup writes real rows; keep it serial so cleanup is predictable.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
  },
  // Two projects, split by what they drive. The api project is pure
  // request-context (no browser page) — `--project api` is the fast pass.
  // Both stay on one worker: every spec talks to the real prod backend, and
  // parallel signups against live Supabase trade a few minutes for flake.
  //
  // Money note: specs tagged @spend call Textract/Gemini (~$0.10/run).
  // `--grep-invert @spend` skips them.
  projects: [
    {
      name: 'api',
      testMatch: [
        '**/api-robustness.spec.ts', '**/cross-tenant.spec.ts',
        '**/auth-matrix.spec.ts', '**/compute-golden.spec.ts',
        '**/calendar-and-misc.spec.ts', '**/returns-lifecycle.spec.ts',
        '**/scenarios-lifecycle.spec.ts', '**/document-pipeline.spec.ts',
        '**/mcp-client-discovery.spec.ts',
      ],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'ui',
      testIgnore: [
        '**/api-robustness.spec.ts', '**/cross-tenant.spec.ts',
        '**/auth-matrix.spec.ts', '**/compute-golden.spec.ts',
        '**/calendar-and-misc.spec.ts', '**/returns-lifecycle.spec.ts',
        '**/scenarios-lifecycle.spec.ts', '**/document-pipeline.spec.ts',
        '**/mcp-client-discovery.spec.ts',
      ],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
