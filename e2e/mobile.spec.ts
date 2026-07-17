import { test, expect } from '@playwright/test';
import {
  DEV_URL,
  CANVAS_TIMEOUT_MS,
  GARAGE_TIMEOUT_MS,
  collectErrors,
  waitForMachine,
  readVehicleState,
} from './support/bridge';

// Phase 18 Task 4: mobile-viewport smoke + degradation coverage. TDD §§5.2/9/10/15;
// CLAUDE.md's Phase 18 plan (`.planning/phases/phase-18-plan.md`).
//
// This whole file targets the SECOND webServer entry (playwright.config.ts,
// http://localhost:5173, a real `vite` dev server) instead of the default 4173 prod
// preview: `window.__smashy` (game/core/debugBridge.ts) is DEV-gated and does not exist
// in the `pnpm preview` build (see that module's file header, and
// scripts/bench-chaos.mjs's — same constraint). Every test below needs the bridge to
// read vehicle state or the state machine, so the whole file overrides baseURL rather
// than only the tests that strictly need it — the gating logic under test
// (src/app/gameGate.ts, deviceCapabilities.ts, webgl.ts) is dev/prod-build-invariant
// (same source, same behavior); the only thing the prod build changes is asset
// optimization, which isn't what this file verifies.
//
// A phone-shaped context (390×844, isMobile, hasTouch, coarse pointer) is applied via
// `test.use()` on top of the shared `chromium` project rather than a dedicated
// Playwright project — a second project would double every OTHER spec's run too, which
// works against this task's "keep `pnpm smoke` fast" instruction. The project's
// `--enable-unsafe-swiftshader` launch flag (needed for software WebGL under a headless
// GPU-less runner) is a browser launch option, unaffected by per-test context overrides.
//
// Phase 18 Tasks 1 (touch controls, src/game/hud/touch/) and 2 (quality manager) are
// landing concurrently with this task and were NOT YET present in the tree as of
// writing. Every assertion that depends on a hook from those tasks feature-detects it
// first and calls `test.fixme(true, reason)` (Playwright's dynamic/in-body form) if it's
// missing, rather than failing red — see this file's individual tests for exactly what
// each one is waiting on. Once the sibling task lands its testid unchanged, these tests
// start asserting for real with no edits needed here.

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';

test.use({
  baseURL: DEV_URL,
  viewport: MOBILE_VIEWPORT,
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  userAgent: MOBILE_USER_AGENT,
});

test('mobile shell paints a Play card and does not auto-mount the game', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Smashy the 6ix');

  // src/app/gameGate.ts: coarse pointer -> 'play-card' gate -> Home.tsx withholds
  // <GameCanvas/> entirely until tapped (never lazy-imports the ~2-3MB game chunk).
  const playCard = page.getByTestId('home-play-card');
  await expect(playCard).toBeVisible();
  await expect(playCard).toHaveText(/play/i);

  // No game-canvas-container at all yet (not just "no <canvas>") — Home.tsx renders
  // `{started ? <GameCanvas /> : null}`, so the container itself is absent pre-tap.
  await expect(page.locator('.game-canvas-container')).toHaveCount(0);

  expect(errors.consoleErrors).toEqual([]);
  expect(errors.pageErrors).toEqual([]);
});

test('tapping Play boots the game chunk and reaches GARAGE', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('home-play-card').click();

  await expect(page.locator('.game-canvas-container canvas').first()).toBeVisible({
    timeout: CANVAS_TIMEOUT_MS,
  });
  await expect(page.getByTestId('garage-root')).toBeVisible({ timeout: GARAGE_TIMEOUT_MS });
  await waitForMachine(page, 'GARAGE');
});

test('starting a run shows touch controls and responds to simultaneous steer+brake input', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await page.getByTestId('home-play-card').click();
  await expect(page.getByTestId('garage-root')).toBeVisible({ timeout: GARAGE_TIMEOUT_MS });

  await page.getByTestId('garage-start').click();
  await waitForMachine(page, 'PLAYING');

  // Phase 18 Task 1 (hud/touch/) hook: substring-matched rather than an exact guessed
  // name, since that task was still unbuilt as of writing — this file's naming
  // assumption is documented in the header comment above. Reasonable per this
  // codebase's existing testid convention (kebab-case, descriptive: "garage-start",
  // "home-play-card", "context-loss-overlay", ...).
  const steerControls = page.locator('[data-testid*="steer" i]');
  const brakeControls = page.locator('[data-testid*="brake" i]');
  if ((await steerControls.count()) === 0 || (await brakeControls.count()) === 0) {
    test.fixme(
      true,
      'Phase 18 Task 1 touch controls (src/game/hud/touch/) have not landed a ' +
        '[data-testid*="steer"/"brake"] hook yet as of this run.',
    );
    return;
  }

  await expect(steerControls.first()).toBeVisible();
  await expect(brakeControls.first()).toBeVisible();

  const before = await readVehicleState(page);
  expect(before).not.toBeNull();

  // Simultaneous multi-touch: two independent pointerIds held concurrently, mirroring
  // what two fingers on a real touchscreen dispatch (the touch control task's own
  // brief calls for "pointer events with multi-touch (steer+brake concurrently)").
  await steerControls.first().dispatchEvent('pointerdown', {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
  });
  await brakeControls.first().dispatchEvent('pointerdown', {
    pointerId: 2,
    pointerType: 'touch',
    isPrimary: false,
    button: 0,
  });

  // Hold both down for a real stretch of wall-clock time — the dev server's physics
  // loop runs on its own regardless of render fps, so this doesn't need to wait on
  // frames, just enough sim time for a change to be observable under SwiftShader.
  await page.waitForTimeout(800);
  const during = await readVehicleState(page);

  await steerControls.first().dispatchEvent('pointerup', {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
  });
  await brakeControls.first().dispatchEvent('pointerup', {
    pointerId: 2,
    pointerType: 'touch',
    isPrimary: false,
    button: 0,
  });

  expect(during).not.toBeNull();
  // Loose on purpose (SwiftShader's frame pacing is unpredictable — see file header):
  // ANY of steer angle, position, or speed moving off the pre-touch baseline proves the
  // simultaneous input reached the vehicle. before/during are non-null per the asserts
  // above.
  const steerAngleChanged = during!.wheels.some((w) => Math.abs(w.steerAngle) > 0.01);
  const posMoved =
    Math.hypot(
      during!.pose.position.x - before!.pose.position.x,
      during!.pose.position.z - before!.pose.position.z,
    ) > 0.01;
  const speedChanged = Math.abs(during!.speed - before!.speed) > 0.05;
  expect(steerAngleChanged || posMoved || speedChanged).toBe(true);

  expect(errors.consoleErrors).toEqual([]);
  expect(errors.pageErrors).toEqual([]);
});

test('localStorage progress survives a reload on the mobile profile', async ({ page }) => {
  await page.goto('/');

  const beforeRun = await page.evaluate(() => localStorage.getItem('smashy6ix:progress'));
  expect(beforeRun).toBeNull();

  await page.getByTestId('home-play-card').click();
  await expect(page.getByTestId('garage-root')).toBeVisible({ timeout: GARAGE_TIMEOUT_MS });
  await page.getByTestId('garage-start').click();
  await waitForMachine(page, 'PLAYING');

  // Debug-bridge shortcut (Phase 9 Task 4) straight to a real GAMEOVER + runEnded emit
  // — the same public seam state/persistence.ts's runEnded subscriber (recordRunEnd)
  // listens on, so this is a legitimate proof of the real persistence path, not a
  // stand-in for it. Avoids waiting out the WRECKED lock-window timer for a HP-drain.
  await page.evaluate(() => window.__smashy?.forceBustedGameOver());
  await waitForMachine(page, 'GAMEOVER');

  const afterRun = await page.evaluate(() => localStorage.getItem('smashy6ix:progress'));
  expect(afterRun).not.toBeNull();
  const parsedAfterRun = JSON.parse(afterRun as string) as { v: number; lifetimeScore: number };
  expect(parsedAfterRun.v).toBe(1);
  expect(parsedAfterRun.lifetimeScore).toBeGreaterThanOrEqual(0);

  await page.reload();

  const afterReload = await page.evaluate(() => localStorage.getItem('smashy6ix:progress'));
  expect(afterReload).toBe(afterRun);
});
