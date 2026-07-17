// Pure guard logic for whether Vercel Analytics should be mounted at all — kept
// dependency-free and framework-free so it's directly vitest-testable (analytics.test.ts)
// without touching the @vercel/analytics package or the DOM.
//
// Two independent reasons to stay a no-op, either one sufficient on its own:
//   - dev: never send real analytics from a local dev session.
//   - webdriver: Playwright (and any other automation) sets `navigator.webdriver = true`
//     — this must stay a no-op even against a PRODUCTION build (e.g. `pnpm preview`,
//     which e2e/*.spec.ts's default baseURL targets), or every smoke/chaos-bench run
//     would fire real page-view/event traffic and skew Vercel Analytics' numbers.
export interface AnalyticsEnv {
  dev: boolean;
  webdriver: boolean;
}

export function shouldEnableAnalytics({ dev, webdriver }: AnalyticsEnv): boolean {
  return !dev && !webdriver;
}

/** Reads the two real environment signals `shouldEnableAnalytics` needs. Split out from
 * the guard function itself so the guard stays a pure function of its inputs (testable
 * with plain booleans) while this one thin wrapper owns the `import.meta.env`/`navigator`
 * reads. */
export function readAnalyticsEnv(): AnalyticsEnv {
  return {
    dev: import.meta.env.DEV,
    webdriver: typeof navigator !== 'undefined' && navigator.webdriver === true,
  };
}
