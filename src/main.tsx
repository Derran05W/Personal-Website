import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import './index.css';
import { router } from './app/router.tsx';

const rootEl = document.getElementById('root')!;
const app = (
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);

// scripts/prerender.mjs bakes static markup for '/', '/portfolio', '/resume', '/credits'
// into their own dist/<route>/index.html, each with a `data-prerendered-route="<path>"`
// marker on #root (see that script's renderDocument()). Hydrate ONLY when that marker
// exactly matches the URL actually being loaded:
//   - Any other path (typos, unprerendered routes, the SPA-fallback rewrite in
//     vercel.json serving dist/index.html for a path that isn't '/') would have a
//     marker that doesn't match location.pathname — falls through to a plain client
//     render, which is exactly correct there (hydrating mismatched markup is worse than
//     not hydrating at all).
//   - '/' is deliberately EXCLUDED even though it IS prerendered: Home's WebGL2/
//     device-capability gate (src/app/gameGate.ts) can only be resolved with real
//     browser APIs, so its prerendered markup deliberately assumes the no-WebGL2
//     fallback branch (see src/entry-server.tsx / scripts/prerender.mjs) purely for
//     SEO/social-share value — a capable browser's real first render is a different
//     branch (auto-starts the game), which would mismatch on hydration. Every other
//     prerendered route is static content with no environment-dependent branching, so
//     it hydrates safely.
//   - Plain `pnpm dev` never has this marker at all (the source index.html's #root is
//     always empty), so this always falls through to the plain client render there,
//     matching pre-Phase-20 behavior exactly.
const prerenderedRoute = rootEl.dataset.prerenderedRoute;
const canHydrate = prerenderedRoute !== undefined && prerenderedRoute === location.pathname && location.pathname !== '/';

if (canHydrate) {
  hydrateRoot(rootEl, app);
} else {
  createRoot(rootEl).render(app);
}
