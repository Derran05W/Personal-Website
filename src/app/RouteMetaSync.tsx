import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { getRouteMeta, canonicalUrl, ogImageUrl } from './meta';

function setMetaTag(attr: 'name' | 'property', key: string, content: string): void {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function setLinkTag(rel: string, href: string): void {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement('link');
    el.setAttribute('rel', rel);
    document.head.appendChild(el);
  }
  el.setAttribute('href', href);
}

const NOT_FOUND_META = {
  title: 'Page not found — Smashy the 6ix',
  description: "This page doesn't exist.",
};

/**
 * Keeps `document.title` plus the description/OG/Twitter/canonical meta tags in sync
 * with the current route on every client-side navigation.
 *
 * scripts/prerender.mjs bakes the SAME per-route values from meta.ts into each route's
 * static `<head>` at build time (so crawlers and social scrapers — which never execute
 * JS — see correct tags on first load); this component covers the case a static file
 * can't: a `<Link>` click is a client-side navigation that never reloads the document,
 * so without this the tags baked into the very first page load would go stale the
 * moment someone navigates to another route.
 *
 * Uses `useLocation()` rather than `useMatches()` (react-router's other route-metadata
 * hook) deliberately: `useMatches()` only works inside the *data*-router context that
 * `<RouterProvider>` provides, but src/entry-server.tsx renders this same component
 * tree under the classic `<StaticRouter>` for prerendering (see that file's header for
 * why) — `useLocation()` is the one route-read hook that works identically under both,
 * so the exact same component runs, unmodified, in both places. This app's route table
 * is also flat (no nested/dynamic segments), so a path-keyed lookup table needs nothing
 * useMatches() would otherwise buy.
 *
 * Mounted once in App.tsx (the persistent shell layout) so it observes every route,
 * including 404.
 */
export default function RouteMetaSync(): null {
  const location = useLocation();

  useEffect(() => {
    const meta = getRouteMeta(location.pathname);
    const { title, description } = meta ?? NOT_FOUND_META;

    document.title = title;
    setMetaTag('name', 'description', description);
    setMetaTag('name', 'robots', meta ? 'index, follow' : 'noindex');

    setMetaTag('property', 'og:type', 'website');
    setMetaTag('property', 'og:title', title);
    setMetaTag('property', 'og:description', description);
    setMetaTag('property', 'og:image', ogImageUrl());

    setMetaTag('name', 'twitter:card', 'summary_large_image');
    setMetaTag('name', 'twitter:title', title);
    setMetaTag('name', 'twitter:description', description);
    setMetaTag('name', 'twitter:image', ogImageUrl());

    // No canonical/og:url for the 404 catch-all — there's no canonical URL for "not a
    // real page," and a stale one pointing at whatever bad path the visitor hit would
    // be actively wrong.
    if (meta) {
      const canonical = canonicalUrl(location.pathname);
      setLinkTag('canonical', canonical);
      setMetaTag('property', 'og:url', canonical);
    }
  }, [location.pathname]);

  return null;
}
