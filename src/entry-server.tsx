// Build-time SSR entry (Phase 20 Task 1). NOT part of the client bundle — Vite builds
// this separately via `vite build --ssr src/entry-server.tsx` (see scripts/prerender.mjs),
// producing a Node-runnable module the prerender script imports and calls.
//
// Mechanism choice, recorded here since it's a "decisions for this session" item
// (CLAUDE.md Phase 20 plan): a hand-rolled postbuild script using Vite's own SSR build
// (`vite build --ssr`) + `react-dom/server`'s `renderToString`, rather than a
// third-party prerender plugin. Reasoning:
//   - This Vite install (8.1.4) defaults to the oxc/rolldown toolchain — a maintained
//     prerender plugin's compatibility with that isn't a given, and this repo's own
//     constraint is "verify before committing." `vite build --ssr <entry>` is a
//     first-class Vite CLI flag (documented, stable since Vite's original SSR guide),
//     not a plugin, so it isn't exposed to that risk at all — same guarantee `vite
//     build` (the client build this whole site already relies on) already has.
//   - Zero new dependencies: `react-dom/server` ships with `react-dom` (already a
//     dependency), and `<StaticRouter>` ships with `react-router` (ditto).
//   - This app's route table has no loaders/actions, so the *classic* SSR pair
//     (`<StaticRouter>` + `useRoutes(routes)`) produces byte-identical output to the
//     heavier *data-router* SSR flow (`createStaticHandler`/`createStaticRouter`/
//     `StaticRouterProvider`, which exists to resolve loaders before rendering) — the
//     classic pair is synchronous (no `handler.query(request)` round trip) and a few
//     lines shorter for the same result.
/* eslint-disable react-refresh/only-export-components -- this file is a build-time SSR
   entry (`vite build --ssr src/entry-server.tsx`), never served to a browser and never
   part of the Vite dev server's HMR graph, so "fast refresh" doesn't apply to it. It
   deliberately re-exports meta.ts/sitemap.ts's plain data/functions alongside the one
   render helper component below — scripts/prerender.mjs needs all of it from a single
   pre-built module (see that script's file header). */
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter, useRoutes, type RouteObject } from 'react-router';
import { routes } from './app/routeTable';

export { SITE_URL, ROUTE_META, OG_IMAGE_PATH, canonicalUrl, ogImageUrl, getRouteMeta } from './app/meta';
export { buildSitemapXml } from './app/sitemap';

function RoutedTree() {
  return useRoutes(routes);
}

/**
 * Renders the app's route tree at `path` to an HTML string — the inner markup for
 * `#root`, not a full document (scripts/prerender.mjs splices this into the already
 * Vite-built dist/index.html template, which owns <head>/asset tags).
 *
 * Uses `renderToString` (not `renderToStaticMarkup`): the output is meant to be
 * hydrated on non-Home routes (see main.tsx's `hydrateRoot` branch) — React's own docs
 * call out `renderToStaticMarkup` as unsafe to hydrate against.
 */
export function renderRoute(path: string): string {
  return renderToString(
    <StrictMode>
      <StaticRouter location={path}>
        <RoutedTree />
      </StaticRouter>
    </StrictMode>,
  );
}

function topLevelChildPaths(route: RouteObject): string[] {
  const children = route.children ?? [];
  const paths: string[] = [];
  for (const child of children) {
    if (child.index) paths.push('/');
    else if (typeof child.path === 'string' && child.path !== '*') paths.push(`/${child.path}`);
  }
  return paths;
}

/**
 * Top-level route paths actually registered in router.tsx right now, normalized to
 * leading-slash absolute form ('/' for the index route). scripts/prerender.mjs
 * cross-checks meta.ts's ROUTE_META against this before prerendering/sitemap-listing a
 * path, so an entry meta.ts declares ahead of the router actually having it wired
 * (e.g. '/credits' landing from a concurrent task) is skipped safely rather than
 * emitting a broken prerendered page or a 404 sitemap entry — see meta.ts's file header.
 */
export function getLiveRoutePaths(): string[] {
  return routes.flatMap(topLevelChildPaths);
}
