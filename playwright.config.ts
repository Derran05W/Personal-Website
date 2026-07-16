import { defineConfig, devices } from '@playwright/test';

// Config only for Phase 1 — the actual smoke spec(s) land in e2e/ in the next task.
// https://playwright.dev/docs/test-configuration
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Headless CI runners have no GPU. Chrome 139+ gates software WebGL (needed to
        // even get a context at all in that environment) behind this flag — without it,
        // r3f/three's canvas.getContext('webgl2') resolves to null and the game chunk
        // never mounts a <canvas>. Desktop dev machines with a real GPU are unaffected.
        launchOptions: { args: ['--enable-unsafe-swiftshader'] },
      },
    },
  ],
  webServer: {
    command: 'pnpm preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
  },
});
