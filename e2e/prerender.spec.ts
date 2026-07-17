import { test, expect } from '@playwright/test';
import { collectErrors } from './support/bridge';

// Phase 20 Task 1: SEO/prerender verification. scripts/check-prerender.mjs already
// proves the STATIC dist/<route>/index.html files are correct in isolation; this spec
// proves the same invariant end to end, in a real browser, against the served/hydrated
// page — the plan's own gotcha, verbatim: "Prerendered routes must not pull the game
// chunk — check the network tab on /portfolio cold load: zero game bytes."
//
// Runs against the default baseURL (http://localhost:4173, the prod `pnpm preview`
// build — see playwright.config.ts), same as e2e/smoke.spec.ts: `pnpm build` already
// chains vite build -> scripts/prerender.mjs, so dist/ has the real prerendered output
// this spec exercises.

const CONTENT_ROUTES: Array<{ path: string; heading: string | RegExp }> = [
  { path: '/portfolio', heading: 'Portfolio' },
  { path: '/resume', heading: 'Résumé' },
  { path: '/credits', heading: 'Credits' },
];

test.describe('content routes are prerendered and game-free', () => {
  for (const { path, heading } of CONTENT_ROUTES) {
    test(`${path}: cold load pulls zero game-chunk bytes, hydrates with no console/page errors`, async ({
      page,
    }) => {
      const errors = collectErrors(page);
      const requestedUrls: string[] = [];
      page.on('request', (req) => requestedUrls.push(req.url()));

      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);

      // Give any errant client-side game import a chance to fire before asserting its
      // absence — matches e2e/webgl-fallback.spec.ts's "wait then assert absence"
      // shape for a negative network/DOM assertion.
      await page.waitForTimeout(1000);

      const gameChunkRequests = requestedUrls.filter((url) => /\/assets\/game[^/]*\.js(\?|$)/.test(url));
      expect(gameChunkRequests).toEqual([]);

      // No game-canvas-container either — GameCanvas.tsx never mounts outside Home's
      // component tree, but this pins the DOM-level guarantee alongside the network one.
      await expect(page.locator('.game-canvas-container')).toHaveCount(0);

      expect(errors.consoleErrors).toEqual([]);
      expect(errors.pageErrors).toEqual([]);
    });

    test(`${path}: has a canonical link and OG/Twitter meta tags pointing at an absolute URL`, async ({
      page,
    }) => {
      await page.goto(path);

      const canonicalHref = await page.locator('link[rel="canonical"]').getAttribute('href');
      expect(canonicalHref).toMatch(/^https:\/\//);

      const ogImage = await page.locator('meta[property="og:image"]').getAttribute('content');
      expect(ogImage).toMatch(/^https:\/\/.+\/og-card\.png$/);

      const ogUrl = await page.locator('meta[property="og:url"]').getAttribute('content');
      expect(ogUrl).toBe(canonicalHref);

      const twitterCard = await page.locator('meta[name="twitter:card"]').getAttribute('content');
      expect(twitterCard).toBe('summary_large_image');

      await expect(page).toHaveTitle(/Smashy the 6ix/);
    });
  }

  test('client-side navigation between content routes updates title/canonical (RouteMetaSync)', async ({
    page,
  }) => {
    await page.goto('/portfolio');
    await expect(page).toHaveTitle(/Portfolio/);
    const portfolioCanonical = await page.locator('link[rel="canonical"]').getAttribute('href');
    expect(portfolioCanonical).toMatch(/\/portfolio$/);

    await page.getByRole('link', { name: 'Resume' }).click();
    await expect(page).toHaveURL(/\/resume$/);
    await expect(page).toHaveTitle(/Résumé/);
    const resumeCanonical = await page.locator('link[rel="canonical"]').getAttribute('href');
    expect(resumeCanonical).toMatch(/\/resume$/);
    expect(resumeCanonical).not.toBe(portfolioCanonical);
  });
});

test.describe('sitemap + robots', () => {
  test('sitemap.xml lists the content routes', async ({ page }) => {
    const response = await page.goto('/sitemap.xml');
    expect(response?.ok()).toBe(true);
    const body = await response!.text();
    expect(body).toContain('<urlset');
    expect(body).toContain('/portfolio</loc>');
    expect(body).toContain('/resume</loc>');
    expect(body).toContain('/credits</loc>');
  });

  test('robots.txt references the sitemap', async ({ page }) => {
    const response = await page.goto('/robots.txt');
    expect(response?.ok()).toBe(true);
    const body = await response!.text();
    expect(body).toMatch(/^Sitemap: https:\/\/.+\/sitemap\.xml$/m);
  });
});
