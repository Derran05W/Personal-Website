import { expect, type Page } from '@playwright/test';

// Shared helpers for the Phase 18 Task 4 specs (e2e/mobile.spec.ts,
// e2e/webgl-fallback.spec.ts) that need window.__smashy (game/core/debugBridge.ts). Not a
// *.spec.ts file — Playwright's default testMatch only picks up *.test.ts/*.spec.ts, so
// this is a plain importable module, never collected as its own test file.
//
// window.__smashy is DEV-gated (import.meta.env.DEV folds to `false` in the `pnpm
// preview` prod build, dead-code-eliminating the whole module — see debugBridge.ts's file
// header and scripts/bench-chaos.mjs's, which hits the identical constraint). Any spec
// using these helpers must target the second webServer entry (playwright.config.ts,
// http://localhost:5173 — a real `vite` dev server) via `test.use({ baseURL: DEV_URL })`.
export const DEV_URL = 'http://localhost:5173';

// The dev server serves an unminified bundle and compiles Rapier's WASM on first
// request — generous timeouts, matching (or exceeding) e2e/game.spec.ts's own 20s
// canvas-visibility budget and bench-chaos.mjs's bridge-wait budget.
export const CANVAS_TIMEOUT_MS = 30_000;
export const GARAGE_TIMEOUT_MS = 30_000;
const MACHINE_POLL_TIMEOUT_MS = 20_000;
const MACHINE_POLL_INTERVAL_MS = 200;

export interface PageErrors {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
}

/** Attaches console/page error listeners up front (must be called before `page.goto` to
 * catch boot-time errors) — same pattern as e2e/smoke.spec.ts's own error test. */
export function collectErrors(page: Page): PageErrors {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });
  return { consoleErrors, pageErrors };
}

/** Polls window.__smashy.getMachine() until it reads `target` or times out. Throws
 * (failing the test) on timeout — every caller has already established the bridge exists
 * by this point (the game chunk is up), so a timeout here is a real bug, not a
 * missing-hook situation. */
export async function waitForMachine(page: Page, target: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__smashy?.getMachine() ?? null), {
      timeout: MACHINE_POLL_TIMEOUT_MS,
      intervals: [MACHINE_POLL_INTERVAL_MS],
    })
    .toBe(target);
}

/** Reads the player vehicle's current state through the dev bridge — the same seam
 * bench-chaos.mjs and the rest of the debug tooling use. Null if no run is live. */
export function readVehicleState(page: Page) {
  return page.evaluate(() => window.__smashy?.readState() ?? null);
}
