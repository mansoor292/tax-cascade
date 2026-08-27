import { defineConfig, devices } from '@playwright/test'

/**
 * E2E harness.
 *
 * Runs against a deployed URL, not a local dev server: the bugs worth
 * catching here (auth triggers, RLS, env loading) only exist against the real
 * Supabase project and the real API. Override with BASE_URL to point at a
 * preview deploy or localhost.
 *
 *   npx playwright test                                  # prod
 *   BASE_URL=http://localhost:5173 npx playwright test   # local vite
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
    baseURL: process.env.BASE_URL || 'https://fin.catipult.ai',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
})
