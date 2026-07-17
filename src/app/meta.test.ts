import { describe, expect, it } from 'vitest';
import { ROUTE_META, SITE_URL, canonicalUrl, getRouteMeta, ogImageUrl } from './meta';

const EXPECTED_PATHS = ['/', '/portfolio', '/resume', '/credits'];

describe('ROUTE_META', () => {
  it('has an entry for every one of the four Phase 20 content routes, exactly once each', () => {
    expect(ROUTE_META.map((m) => m.path).sort()).toEqual([...EXPECTED_PATHS].sort());
  });

  it('gives every route a non-empty title and description', () => {
    for (const meta of ROUTE_META) {
      expect(meta.title.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
    }
  });

  it('every title is unique (so a crawler/tab-switcher can tell routes apart)', () => {
    const titles = ROUTE_META.map((m) => m.title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe('getRouteMeta', () => {
  it('looks up each known path', () => {
    for (const path of EXPECTED_PATHS) {
      expect(getRouteMeta(path)?.path).toBe(path);
    }
  });

  it('returns undefined for an unknown path (e.g. the 404 catch-all)', () => {
    expect(getRouteMeta('/does-not-exist')).toBeUndefined();
  });
});

describe('SITE_URL', () => {
  it('is an absolute https URL with no trailing slash', () => {
    expect(SITE_URL).toMatch(/^https:\/\/.+[^/]$/);
  });
});

describe('canonicalUrl', () => {
  const site = 'https://example.test';

  it('the root path canonicalizes to the bare origin with a trailing slash', () => {
    expect(canonicalUrl('/', site)).toBe('https://example.test/');
  });

  it('other paths append directly onto the origin, no trailing slash', () => {
    expect(canonicalUrl('/portfolio', site)).toBe('https://example.test/portfolio');
    expect(canonicalUrl('/resume', site)).toBe('https://example.test/resume');
    expect(canonicalUrl('/credits', site)).toBe('https://example.test/credits');
  });

  it('defaults to the real SITE_URL when no siteUrl argument is given', () => {
    expect(canonicalUrl('/portfolio')).toBe(`${SITE_URL}/portfolio`);
  });
});

describe('ogImageUrl', () => {
  it('is an absolute URL pointing at /og-card.png', () => {
    expect(ogImageUrl('https://example.test')).toBe('https://example.test/og-card.png');
  });

  it('defaults to the real SITE_URL', () => {
    expect(ogImageUrl()).toBe(`${SITE_URL}/og-card.png`);
  });
});
