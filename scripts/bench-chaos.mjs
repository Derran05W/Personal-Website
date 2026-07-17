#!/usr/bin/env node
// Chaos-bench CI wrapper (Phase 12 Task 4). Boots a real dev server (window.__smashy — the
// bench's bridge entry — only exists in the DEV-gated chunk; `pnpm preview`'s prod build
// strips it, same as devPanel.tsx/PerfOverlay.tsx, so this can't reuse playwright.config.ts's
// `pnpm preview` webServer), drives ai/chaosBench.ts's ~60 s ★5 auto-drive circuit through
// window.__smashy.runChaosBench(), prints the budget report, and exits nonzero if the
// container-verifiable gates (draw calls / triangles vs config/quality.ts's 'high' tier — the
// same numbers CLAUDE.md's perf table documents) are exceeded. FPS is sampled and printed for
// visibility but is NEVER a CI gate here: this container's Chromium renders through
// SwiftShader (software WebGL — see playwright.config.ts's `--enable-unsafe-swiftshader`
// launch flag), so fps reflects the CI host's software-rendering ceiling, not the game's real
// GPU performance. Real fps validation rides on user hardware, as established since Phase 3's
// fun-gate verification.
//
// Devcontainer note (see .devcontainer/gen-chromium-shims.mjs / the project memory entry on
// browser shims): this no-sudo, firewalled devcontainer needs
//   LD_LIBRARY_PATH=$HOME/.cache/chromium-shim-libs pnpm bench:chaos
// until the container is rebuilt with the real apt deps baked in — same prefix `pnpm smoke`
// already needs. This script does nothing special for that; it's inherited from the invoking
// shell's environment, exactly like any other Playwright-driven command.
//
// Phase 18 Task 4: BENCH_TIER knob. `ai/chaosBench.ts`'s own in-page `report.gate` is
// hard-pinned to the 'high' tier (see that module's file header — it's the default a fresh
// page load boots with), so it can't tell us whether a device running on 'med'/'low' stays
// inside ITS OWN budget row. `BENCH_TIER=low pnpm bench:chaos` (default: high) seeds the
// persisted quality setting via an init script BEFORE any app code runs — state/store.ts's
// `loadSettings()` reads `localStorage[SETTINGS_STORAGE_KEY]` synchronously at module init,
// and `core/quality.ts`'s `applyDetectedQuality()` never overrides an already-persisted
// choice (see both files) — so this reliably pins the tier the whole run boots and stays on,
// the same way a real user's saved Pause->Quality selector choice would. This script then
// gates `report.maxDrawCalls`/`report.maxTriangles` (the same raw numbers `report.gate`
// itself is built from) against the SELECTED tier's budget row instead of always 'high'.
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const DEV_URL = 'http://localhost:5173';
const SETTINGS_STORAGE_KEY = 'smashy6ix:settings';

const RAW_BENCH_TIER = (process.env.BENCH_TIER ?? 'high').trim().toLowerCase();
// Mirrors src/game/config/quality.ts's QUALITY_TIERS budget rows (maxDrawCalls/
// maxTriangles only — the two numbers this script's gate needs). This is a plain .mjs CLI
// script with no TS/Vite pipeline of its own, so it can't import that module directly;
// keep these two columns in lockstep by hand with config/quality.ts, same discipline
// chaosBench.ts's own file-header comment documents for its 'high'-only in-page gate —
// config/config.test.ts is the source of truth if these ever drift.
const TIER_BUDGETS = {
  high: { maxDrawCalls: 150, maxTriangles: 300_000 },
  med: { maxDrawCalls: 120, maxTriangles: 200_000 },
  low: { maxDrawCalls: 90, maxTriangles: 120_000 },
};
if (!Object.hasOwn(TIER_BUDGETS, RAW_BENCH_TIER)) {
  console.error(
    `[bench-chaos] invalid BENCH_TIER "${RAW_BENCH_TIER}" — expected one of: ${Object.keys(TIER_BUDGETS).join(', ')}`,
  );
  process.exit(1);
}
const BENCH_TIER = RAW_BENCH_TIER;
const tierBudget = TIER_BUDGETS[BENCH_TIER];
// Node's fetch (undici) and a browser's own resolver can disagree on how bare "localhost"
// resolves in this devcontainer — observed here (arm64 Debian) resolving ONLY to ::1 via
// /etc/hosts (no IPv4 loopback entry) while the container's kernel has dual-stack disabled
// (127.0.0.1 refuses even though the IPv6 wildcard is listening). Playwright/Chromium's own
// resolver reaches `localhost` fine regardless (verified live), so DEV_URL above stays plain
// "localhost" for the actual browser navigation — but the plain Node-side readiness probe
// below tries every loopback form explicitly rather than betting on Node's fetch matching
// whatever a spawned (or pre-existing, reused) dev server happens to be bound to.
const PROBE_URLS = ['http://127.0.0.1:5173', 'http://[::1]:5173', 'http://localhost:5173'];
const SERVER_READY_TIMEOUT_MS = 30_000;
const SERVER_POLL_MS = 500;
const CANVAS_TIMEOUT_MS = 20_000;
const SMASHY_BRIDGE_TIMEOUT_MS = 15_000;
const BRIDGE_POLL_MS = 200;
// The bench itself runs ~60 s (ai/chaosBench.ts's BENCH_DURATION_MS) plus roster-fill/
// ensure-playing polling — generous headroom for a cold SwiftShader warm-up.
const BENCH_EVAL_TIMEOUT_MS = 120_000;

async function isServerUp() {
  const results = await Promise.all(
    PROBE_URLS.map(async (url) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        return res.ok || res.status < 500;
      } catch {
        return false;
      }
    }),
  );
  return results.some(Boolean);
}

async function waitForServer(deadlineMs) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await isServerUp()) return;
    await new Promise((r) => setTimeout(r, SERVER_POLL_MS));
  }
  throw new Error(`dev server never came up at ${DEV_URL} within ${deadlineMs}ms`);
}

/** Races `promise` against a timeout, rejecting with a clear message instead of hanging the
 * whole script forever if a page-side await never settles (e.g. a bench bug). */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function main() {
  let devServer = null;
  const alreadyRunning = await isServerUp();

  if (!alreadyRunning) {
    console.log(`[bench-chaos] no dev server at ${DEV_URL} — starting one (pnpm exec vite)…`);
    devServer = spawn('pnpm', ['exec', 'vite', '--port', '5173', '--strictPort'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    devServer.stdout.on('data', () => {}); // swallow — vite's own banner isn't useful here
    devServer.stderr.on('data', (chunk) => process.stderr.write(chunk));
    await waitForServer(SERVER_READY_TIMEOUT_MS);
    console.log('[bench-chaos] dev server is up.');
  } else {
    console.log(`[bench-chaos] reusing existing dev server at ${DEV_URL}.`);
  }

  let exitCode;
  const browser = await chromium.launch({
    // Matches playwright.config.ts: headless CI runners have no GPU, and Chrome 139+ gates
    // software WebGL behind this flag — without it r3f/three's canvas context never resolves
    // and the game chunk never mounts a <canvas>.
    args: ['--enable-unsafe-swiftshader'],
  });

  try {
    const page = await browser.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    // Pin the persisted quality tier BEFORE any app script runs (init scripts fire ahead of
    // every navigation's own scripts, including the very first) — see the BENCH_TIER doc
    // comment near the top of this file for why this is the reliable way to force a tier
    // regardless of the auto-detect heuristic or a future FPS-probe downgrade.
    console.log(`[bench-chaos] pinning persisted quality tier to "${BENCH_TIER}"…`);
    await page.addInitScript(
      ([key, tier]) => {
        try {
          window.localStorage.setItem(key, JSON.stringify({ quality: tier, muted: false, reducedShake: false }));
        } catch {
          // Private/incognito or storage disabled: fall through — the app's own
          // loadSettings() degrades to auto-detect the same way, and the bench's gate
          // still reports honestly against whatever tier actually applied.
        }
      },
      [SETTINGS_STORAGE_KEY, BENCH_TIER],
    );

    console.log('[bench-chaos] loading the game…');
    await page.goto(DEV_URL, { waitUntil: 'load' });
    // .first(): the dev-only r3f-perf overlay (core/PerfOverlay.tsx) mounts a second, nested
    // <canvas> for its own FPS-graph scene — both match this selector, so a plain locator()
    // trips Playwright's strict-mode multi-match guard. The game canvas is always first in
    // DOM order (it's part of the main <Canvas> tree; PerfOverlay's nested canvas mounts
    // inside it, later).
    await page.locator('.game-canvas-container canvas').first().waitFor({
      state: 'visible',
      timeout: CANVAS_TIMEOUT_MS,
    });

    console.log('[bench-chaos] waiting for the dev debug bridge (window.__smashy)…');
    const bridgeStart = Date.now();
    let bridgeReady = false;
    while (Date.now() - bridgeStart < SMASHY_BRIDGE_TIMEOUT_MS) {
      bridgeReady = await page.evaluate(() => typeof window.__smashy?.runChaosBench === 'function');
      if (bridgeReady) break;
      await page.waitForTimeout(BRIDGE_POLL_MS);
    }
    if (!bridgeReady) {
      throw new Error(
        'window.__smashy.runChaosBench never appeared — is this a prod build? ' +
          "The bridge only loads under import.meta.env.DEV (this script targets the dev server, not `pnpm preview`).",
      );
    }

    console.log('[bench-chaos] running the ★5 chaos bench (~60s)…');
    const report = await withTimeout(
      page.evaluate(() => window.__smashy.runChaosBench()),
      BENCH_EVAL_TIMEOUT_MS,
      'runChaosBench()',
    );

    // ai/chaosBench.ts already console.info's a formatted table INSIDE the page — but page
    // console output only reaches this process via the 'console' listener above (and only if
    // it were type 'error', which console.info never is), so print the structured report
    // here too from the Node side, straight from the returned object.
    console.log('\n[bench-chaos] report (raw):');
    console.log(JSON.stringify(report, null, 2));

    // Gate against the SELECTED tier's own budget row, not report.gate (which ai/
    // chaosBench.ts hard-pins to 'high' — see this file's BENCH_TIER doc comment above).
    // report.maxDrawCalls/maxTriangles are the raw peak numbers report.gate itself is
    // built from, so this is an equivalent check when BENCH_TIER=high (the default) and a
    // strictly tighter one for med/low.
    const budgetOk = report.maxDrawCalls < tierBudget.maxDrawCalls && report.maxTriangles < tierBudget.maxTriangles;
    if (!budgetOk) {
      console.error(
        `[bench-chaos] FAIL: over budget (tier=${BENCH_TIER}) — drawCalls ${report.maxDrawCalls}/${tierBudget.maxDrawCalls}, ` +
          `triangles ${report.maxTriangles}/${tierBudget.maxTriangles}`,
      );
    } else {
      console.log(
        `[bench-chaos] OK (tier=${BENCH_TIER}): drawCalls ${report.maxDrawCalls}/${tierBudget.maxDrawCalls}, ` +
          `triangles ${report.maxTriangles}/${tierBudget.maxTriangles} (fps min ${report.minFps ?? 'n/a'} ` +
          'avg ' +
          `${report.avgFps ?? 'n/a'} — informational, not gated; see file header).`,
      );
    }

    if (consoleErrors.length > 0) {
      console.error(`[bench-chaos] FAIL: ${consoleErrors.length} console error(s) during the run:`);
      for (const msg of consoleErrors) console.error(`  - ${msg}`);
    }
    if (pageErrors.length > 0) {
      console.error(`[bench-chaos] FAIL: ${pageErrors.length} uncaught page error(s) during the run:`);
      for (const msg of pageErrors) console.error(`  - ${msg}`);
    }

    exitCode = budgetOk && consoleErrors.length === 0 && pageErrors.length === 0 ? 0 : 1;
  } catch (err) {
    console.error('[bench-chaos] FAIL:', err instanceof Error ? err.stack : err);
    exitCode = 1;
  } finally {
    await browser.close();
    if (devServer) {
      devServer.kill();
    }
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error('[bench-chaos] unexpected failure:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
