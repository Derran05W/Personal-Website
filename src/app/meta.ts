// Per-route SEO metadata — single source of truth consumed by:
//   - RouteMetaSync.tsx: keeps document.title + meta/OG/canonical tags in sync on every
//     client-side (SPA) navigation.
//   - src/entry-server.tsx / scripts/prerender.mjs: bakes the same values into each
//     route's static <head> at build time, plus the sitemap (sitemap.ts).
//
// TDD §9: "portfolio/resume routes prerendered with meta/OG; the game is enhancement."
// CLAUDE.md's open-items list: header branding/domain are still placeholders pending
// user input — SITE_URL below is the Vercel-inferred default, override via
// VITE_SITE_URL once a custom domain is confirmed.

/** Absolute origin this site is served from — the ONE place every absolute URL in meta
 * tags / sitemap / OG image plumbing derives from. Defaults to the Vercel-inferred
 * `<project-name>.vercel.app` production alias (this repo's package.json `name` is
 * "smashy-the-6ix", and Vercel's `vercel.json` here doesn't override the project name,
 * so that's the production alias Vercel assigns). Override with `VITE_SITE_URL` (a
 * build-time env var) once a custom domain is confirmed — see CLAUDE.md's "Open (user
 * input needed)" list.
 *
 * Reads straight off `import.meta.env`, which Vite statically replaces at build time in
 * every context that goes through Vite's transform pipeline (the client build, `vite
 * build --ssr`, and vitest) — see scripts/prerender.mjs's file header for why the plain
 * Node prerender script itself never imports this file directly and instead goes
 * through the pre-built SSR bundle. */
export const SITE_URL =
  (import.meta.env.VITE_SITE_URL as string | undefined)?.trim().replace(/\/+$/, '') ||
  'https://smashy-the-6ix.vercel.app';

/** Social-card image (Phase 20 plan: captured live from the game — see repo root for
 * the capture). 1200×630, the standard OG/Twitter "summary_large_image" size. */
export const OG_IMAGE_PATH = '/og-card.png';

export interface RouteMeta {
  /** Path exactly as registered in src/app/router.tsx's route table. */
  path: string;
  title: string;
  description: string;
}

const GAME_TITLE = 'Smashy the 6ix';

// The four content routes named in the Phase 20 plan. '/credits' is listed here even
// though (as of this session) it may not yet be wired into router.tsx — Task 2 lands it
// concurrently; this table is the forward-declared content authority regardless of
// router wiring status. scripts/prerender.mjs / sitemap.ts cross-check against the
// LIVE router route table (src/entry-server.tsx's getLiveRoutePaths()) before treating
// an entry here as renderable, so an not-yet-wired '/credits' is skipped safely rather
// than emitting a broken prerendered page or a 404 sitemap entry.
export const ROUTE_META: readonly RouteMeta[] = [
  {
    path: '/',
    title: GAME_TITLE,
    description:
      "Smashy the 6ix — a low-poly 3D driving game homepage paired with Derran's portfolio and résumé.",
  },
  {
    path: '/portfolio',
    title: `Portfolio — ${GAME_TITLE}`,
    description: 'Project write-ups and case studies from the developer behind Smashy the 6ix.',
  },
  {
    path: '/resume',
    title: `Résumé — ${GAME_TITLE}`,
    description: "Download or preview Derran's résumé (PDF).",
  },
  {
    path: '/credits',
    title: `Credits — ${GAME_TITLE}`,
    description:
      'Assets, tools, and licenses behind Smashy the 6ix — every model and sound is procedural or synthesized in-house.',
  },
];

const metaByPath = new Map(ROUTE_META.map((m) => [m.path, m] as const));

/** Looks up a route's meta by exact path. Returns undefined for anything not in
 * ROUTE_META (e.g. the 404 catch-all) — callers decide their own not-found fallback
 * (RouteMetaSync.tsx sets a dedicated noindex title/description for that case). */
export function getRouteMeta(path: string): RouteMeta | undefined {
  return metaByPath.get(path);
}

/** Absolute, canonical URL for a route path. `siteUrl` defaults to SITE_URL but is
 * accepted as a parameter so sitemap.ts's pure builder — and its tests — never depend
 * on the ambient env. */
export function canonicalUrl(path: string, siteUrl: string = SITE_URL): string {
  if (path === '/') return `${siteUrl}/`;
  return `${siteUrl}${path}`;
}

/** Absolute URL for the shared OG/Twitter social-card image. */
export function ogImageUrl(siteUrl: string = SITE_URL): string {
  return `${siteUrl}${OG_IMAGE_PATH}`;
}
