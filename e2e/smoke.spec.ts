import { test, expect, type Page } from '@playwright/test';

// Phase 1 smoke coverage: the app shell renders distinct, correct content on every
// route (including 404), the header/skip-link are consistent everywhere, and nothing
// throws. This is the permanent, committed version of the equivalent check hand-run
// once from a throwaway script in the previous task.

const GITHUB_HREF = 'https://github.com/Derran05W';
const LINKEDIN_PLACEHOLDER_HREF = '#linkedin-placeholder';

const ROUTES: Array<{ path: string; heading: string }> = [
  { path: '/', heading: 'Smashy the 6ix' },
  { path: '/portfolio', heading: 'Portfolio' },
  { path: '/resume', heading: 'Résumé' },
  { path: '/does-not-exist', heading: '404' },
];

/** Asserts the header (wordmark + all 4 link items) is present with correct hrefs. */
async function expectHeaderPresent(page: Page) {
  await expect(page.getByText('Derran', { exact: true })).toBeVisible();

  const resume = page.getByRole('link', { name: 'Resume' });
  const portfolio = page.getByRole('link', { name: 'Portfolio' });
  const linkedin = page.getByRole('link', {
    name: 'LinkedIn soon — placeholder link, not connected yet',
  });
  const github = page.getByRole('link', { name: 'GitHub (opens in a new tab)' });

  await expect(resume).toHaveAttribute('href', '/resume');
  await expect(portfolio).toHaveAttribute('href', '/portfolio');
  await expect(linkedin).toHaveAttribute('href', LINKEDIN_PLACEHOLDER_HREF);
  await expect(github).toHaveAttribute('href', GITHUB_HREF);
}

test.describe('routes render distinct content', () => {
  for (const { path, heading } of ROUTES) {
    test(`${path} renders its own heading`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
    });
  }
});

test.describe('header is consistent across every route, including 404', () => {
  for (const { path } of ROUTES) {
    test(`header present with correct links on ${path}`, async ({ page }) => {
      await page.goto(path);
      await expectHeaderPresent(page);
    });
  }
});

test('skip link is the first focusable element and moves focus to #main-content', async ({
  page,
}) => {
  await page.goto('/');

  // Nothing has been interacted with yet, so the very first Tab must land on the skip
  // link — it must be the first focusable element in DOM order.
  await page.keyboard.press('Tab');
  const skipLink = page.locator('a.skip-link');
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toHaveText('Skip to content');
  await expect(skipLink).toHaveAttribute('href', '#main-content');

  // Activating it must move focus to the #main-content landmark it targets.
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
});

test('home route renders the labeled game-canvas container', async ({ page }) => {
  await page.goto('/');

  // Only the shell's always-present, labeled container (GameCanvas.tsx) is asserted
  // here — actual game rendering (a mounted <canvas>, chunk-load timing) is covered by
  // e2e/game.spec.ts, which needs the WebGL software-rendering launch flag and much
  // more generous timeouts than this shell-level smoke test does.
  const canvas = page.getByRole('img', { name: '3D driving game canvas' });
  await expect(canvas).toBeVisible();
});

test('no console or page errors while navigating all routes', async ({ page }) => {
  const errors: string[] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(`console.error: ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => {
    errors.push(`pageerror: ${err.message}`);
  });

  for (const { path } of ROUTES) {
    await page.goto(path);
    // Let the route settle (lazy chunks, fonts, etc.) before moving on.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  }

  expect(errors).toEqual([]);
});
