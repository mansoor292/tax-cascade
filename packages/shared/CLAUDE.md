# packages/shared — working notes for AI agents

Canonical tax-domain constants and types both packages import: the
metric ↔ sectioned-field_values maps (`metrics.ts`), the section display
vocabulary (`sections.ts`), and the API response types (`types.ts`).

## How the wiring works (do not "simplify" it)

`package.json` exports are split by condition ON PURPOSE:

- `"default"` → `./src/*.ts` — tsx (which runs the API from source in
  PRODUCTION, no build step) and Vite both execute the raw TypeScript.
  Prod never depends on a compiled artifact of this package.
- `"types"` → `./dist/*.d.ts` — the api and web `tsc` runs resolve
  declarations from `dist/` (built by each package's `prebuild`, and by the
  root postinstall). This keeps shared source OUT of their emitting
  programs — pulling `../shared/src` into api's `tsc` breaks its
  rootDir/declaration build.

`dist/` is gitignored and contains declarations only (`emitDeclarationOnly`).
If types look stale in an editor, run `npm run build -w packages/shared`.

## Source rules

- ESM with `.js`-suffixed relative imports (NodeNext).
- No enums, no namespaces — files must stay single-file transpilable
  (esbuild/tsx never see the whole program).
- No runtime dependencies, no Node/browser-only APIs — this code runs in
  both environments.
