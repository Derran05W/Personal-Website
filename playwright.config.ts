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
  // Two servers: the default prod-preview build every existing spec targets (baseURL
  // above), plus a real Vite dev server for the handful of Phase 18 Task 4 specs that
  // need `window.__smashy` (game/core/debugBridge.ts). That bridge is DEV-gated
  // (`import.meta.env.DEV` folds to `false` in the `pnpm preview` build, dead-code-
  // eliminating the whole module — see debugBridge.ts's own file header and
  // scripts/bench-chaos.mjs's, which hits the exact same constraint), so it can never
  // exist on the 4173 server. Those specs override `baseURL` to point at 5173 instead
  // (see e2e/mobile.spec.ts / e2e/webgl-fallback.spec.ts's context-loss block).
  // `reuseExistingServer: true` (not `!process.env.CI`, unlike the entry above) is
  // deliberate: per this task's brief, a dev server may already be running on :5173 from
  // an earlier manual session — reuse it, never kill it. Playwright only ever tears down
  // a webServer entry it spawned itself, so this is safe even when nothing is running yet.
  webServer: [
    {
      command: 'pnpm preview',
      url: 'http://localhost:4173',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'pnpm exec vite --port 5173 --strictPort',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
    },
  ],
});
