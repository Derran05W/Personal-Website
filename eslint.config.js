import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import { globalIgnores } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config([
  globalIgnores(['dist', 'coverage', 'playwright-report', 'test-results']),
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat['recommended-latest'],
      reactRefresh.configs.vite,
      eslintConfigPrettier,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // Hard requirement (CLAUDE.md / TDD): no explicit `any`, anywhere, ever.
      '@typescript-eslint/no-explicit-any': 'error',
      // TypeScript's own compiler (`pnpm typecheck`) already catches undefined
      // identifiers; no-undef doesn't understand TS ambient/global types and
      // produces false positives on files like this one (`process`, etc.).
      'no-undef': 'off',
    },
  },
]);
