import { test, expect } from '@playwright/test';

// Phase 20 Task 4 (QA/a11y) × Task 2 (error boundary): a failure to fetch or boot the
// lazy game chunk must NEVER white-page the site (TDD §9/§15). src/app/GameErrorBoundary
// wraps the lazy <Game> mount (outside its Suspense, so it also catches a rejected
// import()) and renders src/app/GameBootFallback — a self-contained static skyline hero —
// while the header/routes stay fully usable.
//
// Runs against the default prod-preview build (baseURL 4173 in playwright.config.ts): the
// gate resolves 'auto-start' for the default desktop context, so GameCanvas mounts and the
// dynamic import() fires — which is exactly the request this test blocks.

test('a failed game-chunk fetch shows the boot fallback, never a white page', async ({ page }) => {
  // Abort the code-split game chunk so React.lazy's import() rejects. The hash varies per
  // build; the `game-` asset prefix is stable (Vite manualChunks). Aborting this alone is
  // enough to reject the dynamic import — the separate rapier-*.js chunk never gets a
  // chance to load once the game module that imports it fails.
  await page.route(/\/assets\/game-.*\.js(\?.*)?$/, (route) => route.abort());

  await page.goto('/');

  // Shell chrome paints and stays present regardless of the game failing.
  await expect(page.getByRole('link', { name: 'Portfolio' })).toBeVisible();

  // GameErrorBoundary caught the rejected import() and rendered the static-hero fallback
  // (data-testid on GameBootFallback) — proof the tree did not unmount to a blank #root.
  await expect(page.getByTestId('game-boot-fallback')).toBeVisible({ timeout: 15_000 });

  // #root is not empty — a belt-and-suspenders guard against a silent white-page.
  await expect(page.locator('#root')).not.toBeEmpty();

  // The header remains navigable after the crash — the fallback is not a dead end.
  // The heading locator is name-scoped: toHaveURL resolves on pushState, which can land
  // BEFORE React commits the outlet swap — and in the boot-fallback state Home carries
  // TWO h1s (hero + fallback hero), so a bare level-1 query sampled mid-transition dies
  // on a terminal strict-mode violation instead of retrying. Scoping by name keeps the
  // assertion unique and lets it poll until the swap commits.
  await page.getByRole('link', { name: 'Portfolio' }).click();
  await expect(page).toHaveURL(/\/portfolio$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Portfolio' })).toBeVisible();

  // Note: this spec intentionally does NOT assert zero console errors — the aborted chunk
  // surfaces a network error, and GameErrorBoundary.componentDidCatch logs one deliberate
  // breadcrumb (`[GameErrorBoundary] the game failed to boot`). Both are expected. The
  // contract under test is "no white page, chrome still works", proven by the assertions
  // above, not console silence.
});
