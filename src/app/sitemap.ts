// Pure sitemap.xml builder — no file I/O, no DOM, so it's exercisable straight from
// vitest (sitemap.test.ts) and reused as-is by the Node prerender script (via the
// pre-built SSR bundle — see scripts/prerender.mjs's file header).
import { canonicalUrl, type RouteMeta } from './meta';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Builds a standard sitemap.xml body listing one <url> per route. `routes` should
 * already be filtered to whatever's actually live (see scripts/prerender.mjs / the
 * getLiveRoutePaths() cross-check) — this function doesn't itself judge liveness. */
export function buildSitemapXml(routes: readonly RouteMeta[], siteUrl: string): string {
  const urlEntries = routes
    .map((route) => `  <url>\n    <loc>${escapeXml(canonicalUrl(route.path, siteUrl))}</loc>\n  </url>`)
    .join('\n');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `${urlEntries}\n` +
    `</urlset>\n`
  );
}
