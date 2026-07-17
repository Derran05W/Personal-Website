#!/usr/bin/env node
// Postbuild static-prerender step (Phase 20 Task 1). Runs after `vite build` (see
// package.json's "build" script) against the already-built dist/ directory:
//   1. Builds src/entry-server.tsx to a throwaway Node-runnable SSR bundle via Vite's
//      own `build({ build: { ssr: ... } })` API — NOT a third-party prerender plugin.
//      See src/entry-server.tsx's file header for why (rolldown-compatibility risk +
//      dependency weight of a plugin vs. a first-class, already-relied-on Vite build
//      mode).
//   2. Renders '/', '/portfolio', '/resume', '/credits' to HTML strings, skipping any
//      that meta.ts declares but router.tsx doesn't actually have live yet (defensive —
//      see src/app/meta.ts's file header; logged, not fatal).
//   3. Splices each render into the ALREADY-BUILT dist/index.html template (title +
//      description/OG/Twitter meta + canonical link + the rendered markup into
//      `#root`), and writes it to dist/index.html ('/') or dist/<route>/index.html
//      (everything else). Only string surgery on Vite's own output — no HTML parser
//      dependency, and immune to whatever Vite's asset-tag injection looks like from
//      one build to the next since those tags are never touched.
//   4. Emits dist/sitemap.xml and dist/robots.txt from the same live-route list.
//
// scripts/check-prerender.mjs verifies the result (dist/<route>/index.html exists,
// contains real content + the no-game-chunk-bytes invariant on the non-Home routes).
import { build } from 'vite';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const distDir = path.join(root, 'dist');
const ssrOutDir = path.join(root, 'dist-ssr');
const ssrEntryFile = path.join(ssrOutDir, 'entry-server.js');

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function outputPathFor(routePath) {
  if (routePath === '/') return path.join(distDir, 'index.html');
  return path.join(distDir, routePath.replace(/^\//, ''), 'index.html');
}

/** Splices route-specific SEO tags + the rendered markup into the built index.html
 * template. Only ever replaces tags matched by attribute (name="description",
 * property="og:title", property="og:description", <title>) — everything else Vite
 * generated (hashed script/link tags, favicon, manifest, font preload) passes through
 * untouched, so this survives Vite changing exactly what it injects there. */
function renderDocument(template, { meta, canonical, ogImage, routePath, innerHtml }) {
  let html = template;

  html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(meta.title)}</title>`);
  html = html.replace(
    /<meta[^>]*\bname="description"[^>]*\/?>/,
    `<meta name="description" content="${escapeHtml(meta.description)}" />`,
  );
  html = html.replace(
    /<meta[^>]*\bproperty="og:title"[^>]*\/?>/,
    `<meta property="og:title" content="${escapeHtml(meta.title)}" />`,
  );
  html = html.replace(
    /<meta[^>]*\bproperty="og:description"[^>]*\/?>/,
    `<meta property="og:description" content="${escapeHtml(meta.description)}" />`,
  );

  const extraHeadTags = [
    `<link rel="canonical" href="${escapeHtml(canonical)}" />`,
    `<meta property="og:url" content="${escapeHtml(canonical)}" />`,
    `<meta property="og:image" content="${escapeHtml(ogImage)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeHtml(meta.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(meta.description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(ogImage)}" />`,
  ].join('\n    ');
  html = html.replace('</head>', `    ${extraHeadTags}\n  </head>`);

  html = html.replace(
    '<div id="root"></div>',
    `<div id="root" data-prerendered-route="${escapeHtml(routePath)}">${innerHtml}</div>`,
  );

  return html;
}

async function main() {
  if (!existsSync(path.join(distDir, 'index.html'))) {
    console.error('FAIL: dist/index.html not found — run `vite build` before scripts/prerender.mjs.');
    process.exitCode = 1;
    return;
  }

  await rm(ssrOutDir, { recursive: true, force: true });
  await build({
    root,
    logLevel: 'warn',
    build: {
      ssr: 'src/entry-server.tsx',
      outDir: 'dist-ssr',
      emptyOutDir: true,
      minify: false,
      copyPublicDir: false,
    },
  });

  /** @type {import('../src/entry-server.ts')} */
  const ssr = await import(pathToFileUrl(ssrEntryFile));

  const liveRoutePaths = new Set(ssr.getLiveRoutePaths());
  const liveRoutes = ssr.ROUTE_META.filter((route) => liveRoutePaths.has(route.path));
  const skipped = ssr.ROUTE_META.filter((route) => !liveRoutePaths.has(route.path));

  if (skipped.length > 0) {
    for (const route of skipped) {
      console.warn(
        `NOTE: meta.ts declares ${route.path} but it isn't wired into router.tsx yet — ` +
          'skipping prerender + sitemap entry for it this build. Nothing to fix here: ' +
          'once the route lands, this script picks it up automatically.',
      );
    }
  }

  const template = await readFile(path.join(distDir, 'index.html'), 'utf-8');

  for (const route of liveRoutes) {
    const innerHtml = ssr.renderRoute(route.path);
    const canonical = ssr.canonicalUrl(route.path);
    const ogImage = ssr.ogImageUrl();
    const document = renderDocument(template, {
      meta: route,
      canonical,
      ogImage,
      routePath: route.path,
      innerHtml,
    });

    const outPath = outputPathFor(route.path);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, document, 'utf-8');
    console.log(`OK: prerendered ${route.path} -> ${path.relative(root, outPath)} (${document.length} bytes)`);
  }

  const sitemapXml = ssr.buildSitemapXml(liveRoutes, ssr.SITE_URL);
  await writeFile(path.join(distDir, 'sitemap.xml'), sitemapXml, 'utf-8');
  console.log(`OK: wrote dist/sitemap.xml (${liveRoutes.length} routes)`);

  const robotsTxt = `User-agent: *\nAllow: /\n\nSitemap: ${ssr.SITE_URL}/sitemap.xml\n`;
  await writeFile(path.join(distDir, 'robots.txt'), robotsTxt, 'utf-8');
  console.log('OK: wrote dist/robots.txt (with Sitemap: directive)');

  await rm(ssrOutDir, { recursive: true, force: true });
}

function pathToFileUrl(filePath) {
  return new URL(`file://${filePath}`).href;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
