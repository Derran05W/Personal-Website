import { describe, expect, it } from 'vitest';
import { ROUTE_META } from './meta';
import { buildSitemapXml } from './sitemap';

const SITE = 'https://example.test';

describe('buildSitemapXml', () => {
  it('is well-formed XML with the sitemaps.org namespace', () => {
    const xml = buildSitemapXml(ROUTE_META, SITE);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('</urlset>');
  });

  it('lists a <loc> for every route passed in, using the given site origin', () => {
    const xml = buildSitemapXml(ROUTE_META, SITE);
    expect(xml).toContain(`<loc>${SITE}/</loc>`);
    expect(xml).toContain(`<loc>${SITE}/portfolio</loc>`);
    expect(xml).toContain(`<loc>${SITE}/resume</loc>`);
    expect(xml).toContain(`<loc>${SITE}/credits</loc>`);
  });

  it('contains exactly one <url> entry per route (no dupes)', () => {
    const xml = buildSitemapXml(ROUTE_META, SITE);
    const matches = xml.match(/<url>/g) ?? [];
    expect(matches).toHaveLength(ROUTE_META.length);
  });

  it('only lists whatever subset of routes it is given (the caller filters for "live")', () => {
    const subset = ROUTE_META.filter((r) => r.path !== '/credits');
    const xml = buildSitemapXml(subset, SITE);
    expect(xml).not.toContain('/credits');
    expect(xml.match(/<url>/g) ?? []).toHaveLength(subset.length);
  });

  it('escapes XML-significant characters in the URL', () => {
    const xml = buildSitemapXml([{ path: '/a&b', title: 't', description: 'd' }], SITE);
    expect(xml).toContain(`<loc>${SITE}/a&amp;b</loc>`);
  });
});
