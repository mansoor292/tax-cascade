import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'scripts/archive', 'data', 'output'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.node },
    },
    rules: {
      // The route layer leans on `any` heavily (Supabase rows, engine
      // payloads); tightening this is meaningful refactor work, not lint
      // config. Keep it visible without failing the build.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // `catch {}` after best-effort work (cache reads, cleanup) is an
      // established pattern here — the surrounding comments carry the why.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
)
