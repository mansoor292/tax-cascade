import { defineConfig } from 'vitest/config'

// Restrict to source tests: `npm run build` emits compiled *.test.js into
// dist/, and vitest's default include would run those too — every suite
// counted twice, and stale dist tests could mask a red src test.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
