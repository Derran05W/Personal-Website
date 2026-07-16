import { test, expect } from '@playwright/test';

// Phase 2 smoke coverage for the lazy-loaded game chunk (src/game/): it actually loads
// and mounts a <canvas> into the labeled container (GameCanvas.tsx), the shell's
// chunk-loading fallback clears once it does, nothing throws while it loads, and —
// critically — the fixed full-viewport canvas never steals pointer events from the
// header (TDD §4.2: canvas z-index 0, header z-index 50; "header usable while the game
// loads" is a hard requirement, not a workaround). Rapier WASM init + chunk fetch can be
// slow on a cold CI cache, so canvas-visibility waits are deliberately generous.

test('game chunk loads a canvas, and the shell loading fallback clears once it has', async ({
  page,
}) => {
  await page.goto('/');

  const canvas = page.locator('.game-canvas-container canvas');
  await expect(canvas).toBeVisible({ timeout: 20_000 });

  // The shell-side fallback (GameCanvas.tsx's <Suspense data-testid=
  // "game-chunk-loading">) can resolve before we ever get a chance to observe it — a
  // warm dynamic-import cache can settle within a single microtask — so don't assert
  // it *appeared* first. Only assert it's gone once the canvas is up: if it were
  // still in the DOM at that point, the Suspense boundary/fallback teardown would be
  // broken.
  await expect(page.getByTestId('game-chunk-loading')).toHaveCount(0);
});

test('no console or page errors while the game chunk loads', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', (msg) => {
    // WebGL-context/extension warnings under swiftshader (see playwright.config.ts)
    // surface as type 'warning', not 'error' — only 'error' is treated as a failure.
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  await page.goto('/');
  await expect(page.locator('.game-canvas-container canvas')).toBeVisible({
    timeout: 20_000,
  });

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('header stays clickable once the game canvas has loaded', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.game-canvas-container canvas')).toBeVisible({
    timeout: 20_000,
  });

  // The canvas is a fixed, full-viewport, z-index:0 layer sitting directly under the
  // header's nav links — this is the actual regression this test guards: a canvas (or
  // an overlay it grows) that ends up on top would swallow the click and the
  // navigation below would never happen.
  await page.getByRole('link', { name: 'Portfolio' }).click();
  await expect(page).toHaveURL(/\/portfolio$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Portfolio');
});
