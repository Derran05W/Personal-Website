import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/  ·  https://vitest.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/vitest-setup.ts'],
    // Vitest's default `include` (**/*.{test,spec}.*) is repo-wide and would otherwise
    // also pick up the Playwright specs under e2e/ (which call test.describe() from
    // '@playwright/test', not vitest) and fail with "did not expect test.describe() to
    // be called here". Excluding e2e/ keeps the two runners scoped to their own files:
    // vitest owns src/**/*.test.{ts,tsx}, Playwright owns e2e/**/*.spec.ts (testDir in
    // playwright.config.ts).
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
