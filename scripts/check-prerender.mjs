#!/usr/bin/env node
// Verifies scripts/prerender.mjs's output in dist/ (run after `pnpm build`, which chains
// vite build -> prerender.mjs -> this check — see package.json). Two invariants per
// content route (TDD §9 / Phase 20 plan gotcha: "Prerendered routes must not pull the
// game chunk — check the network tab on /portfolio cold load: zero game bytes"):
//   1. The static HTML file exists and contains real, route-specific content markup.
//   2. It references NO game-chunk script tag — a cold load of that document alone can
//      never trigger a game-chunk fetch (the game only ever loads via GameCanvas.tsx's
//      client-side dynamic import(), which only Home's component tree can reach).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const distDir = join(process.cwd(), 'dist');

// path -> marker text that must appear in that route's rendered #root content, proving
// this is the REAL page and not e.g. an empty shell or a 404 fallback.
const ROUTE_MARKERS = [
  { path: '/', file: 'index.html', marker: 'Smashy the 6ix' },
  { path: '/portfolio', file: 'portfolio/index.html', marker: 'Portfolio' },
  { path: '/resume', file: 'resume/index.html', marker: 'Résumé' },
  { path: '/credits', file: 'credits/index.html', marker: 'Credits' },
];

// A prerendered document's own <script> tags must never reference an emitted game-chunk
// asset (the hashed filenames Vite gives the code-split game bundle — see
// scripts/check-shell-size.mjs's sibling "index-*.js" pattern for the entry chunk).
const GAME_CHUNK_SCRIPT_RE = /<script[^>]*src="[^"]*\/assets\/game[^"]*\.js"/;

let failed = false;
let checkedCount = 0;

for (const { path, file, marker } of ROUTE_MARKERS) {
  const fullPath = join(distDir, file);
  if (!existsSync(fullPath)) {
    console.warn(
      `SKIP: dist/${file} not found — ${path} wasn't prerendered this build (see prerender.mjs's ` +
        'log for whether it was defensively skipped, e.g. the route not being live in router.tsx yet).',
    );
    continue;
  }

  const html = readFileSync(fullPath, 'utf-8');
  checkedCount += 1;

  if (!html.includes(`data-prerendered-route="${path}"`)) {
    console.error(`FAIL: dist/${file} is missing the data-prerendered-route="${path}" marker.`);
    failed = true;
  }

  if (!html.includes(marker)) {
    console.error(`FAIL: dist/${file} doesn't contain expected content marker "${marker}".`);
    failed = true;
  }

  if (GAME_CHUNK_SCRIPT_RE.test(html)) {
    console.error(`FAIL: dist/${file} references a game-chunk script tag — cold load would pull game bytes.`);
    failed = true;
  }

  if (!html.includes('<title>') || !/<meta\s+name="description"/.test(html)) {
    console.error(`FAIL: dist/${file} is missing <title> or a description meta tag.`);
    failed = true;
  }

  if (!/<link\s+rel="canonical"/.test(html)) {
    console.error(`FAIL: dist/${file} is missing a canonical <link> tag.`);
    failed = true;
  }

  if (!failed) console.log(`OK: dist/${file} — content present, no game-chunk script tag, meta/canonical present.`);
}

const sitemapPath = join(distDir, 'sitemap.xml');
if (!existsSync(sitemapPath)) {
  console.error('FAIL: dist/sitemap.xml not found.');
  failed = true;
} else {
  const sitemap = readFileSync(sitemapPath, 'utf-8');
  if (!sitemap.includes('<urlset')) {
    console.error('FAIL: dist/sitemap.xml does not look like a sitemap (no <urlset>).');
    failed = true;
  } else {
    console.log('OK: dist/sitemap.xml present and well-formed.');
  }
}

const robotsPath = join(distDir, 'robots.txt');
if (!existsSync(robotsPath)) {
  console.error('FAIL: dist/robots.txt not found.');
  failed = true;
} else {
  const robots = readFileSync(robotsPath, 'utf-8');
  if (!/^Sitemap:/m.test(robots)) {
    console.error('FAIL: dist/robots.txt has no Sitemap: directive.');
    failed = true;
  } else {
    console.log('OK: dist/robots.txt present with a Sitemap: directive.');
  }
}

if (checkedCount === 0) {
  console.error('FAIL: none of the four content routes were prerendered — nothing to verify.');
  failed = true;
}

if (failed) process.exit(1);
console.log(`OK: prerender check passed (${checkedCount}/${ROUTE_MARKERS.length} routes verified).`);
