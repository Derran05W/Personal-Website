import { describe, expect, it } from 'vitest';
import { shouldEnableAnalytics } from './analytics';

describe('shouldEnableAnalytics', () => {
  it('is enabled when neither dev nor webdriver', () => {
    expect(shouldEnableAnalytics({ dev: false, webdriver: false })).toBe(true);
  });

  it('is disabled in dev, even without webdriver', () => {
    expect(shouldEnableAnalytics({ dev: true, webdriver: false })).toBe(false);
  });

  it('is disabled under webdriver, even in a production build (pnpm preview + Playwright)', () => {
    expect(shouldEnableAnalytics({ dev: false, webdriver: true })).toBe(false);
  });

  it('is disabled when both dev and webdriver', () => {
    expect(shouldEnableAnalytics({ dev: true, webdriver: true })).toBe(false);
  });
});
