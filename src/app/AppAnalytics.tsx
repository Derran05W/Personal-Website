import { Analytics } from '@vercel/analytics/react';
import { readAnalyticsEnv, shouldEnableAnalytics } from './analytics';

/**
 * Mounts Vercel Analytics (page views, `@vercel/analytics/react`'s automatic pageview
 * tracking on every client-side route change, plus whatever custom `track()` calls the
 * game chunk fires — see src/game/analytics.ts) exactly once, in the shell.
 *
 * Guarded by analytics.ts's pure `shouldEnableAnalytics`: a no-op in dev, and a no-op
 * under any webdriver-controlled browser (Playwright smoke/chaos-bench runs) even
 * against a production build — see analytics.ts's file header for why both guards are
 * independently necessary.
 *
 * Lives in src/app/ (the shell), not src/game/: `<Analytics/>` must be mounted once,
 * for the app's whole lifetime, regardless of whether the game chunk ever loads (e.g. a
 * WebGL2-unsupported visitor still generates a real page view). The game chunk only
 * ever calls `track()` for its own custom events — it never mounts this component.
 */
export default function AppAnalytics() {
  if (!shouldEnableAnalytics(readAnalyticsEnv())) return null;
  return <Analytics />;
}
