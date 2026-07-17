import { createBrowserRouter } from 'react-router';
import { routes } from './routeTable';

// Data router (react-router v8, "Data mode"): current idiomatic top-level API for a
// plain Vite SPA — see main.tsx for the paired <RouterProvider> (imported from
// "react-router/dom", not "react-router", as of v8).
//
// All routes nest under <App>, the persistent shell layout (skip link + Header + the
// #main-content landmark that <Outlet/> renders into) — so the header and skip link
// stay present, tabbable, and consistent on every route, including 404.
//
// The route table itself lives in routeTable.ts (Phase 20 Task 1) — see that file's
// header for why: `createBrowserRouter(...)` below has a real side effect at
// module-eval time (it reaches for `document`/`window` to build browser History
// immediately), so this module can only ever be evaluated in a real browser. Only
// main.tsx (the real client entry) imports this file; src/entry-server.tsx imports
// routeTable.ts directly instead, so prerendering never touches this side effect.
export const router = createBrowserRouter(routes);
