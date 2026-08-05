#!/usr/bin/env node
// Phase 74 Task 5 — the FEEL LAB BATTERY. Boots a real dev server (window.__smashy only exists
// in the DEV-gated chunk — the same constraint camera-lab.mjs and bench-chaos.mjs document at
// length), then drives dev/feelProbes.ts's five controlled-manoeuvre probes and dev/feelDrives.ts's
// four named route drives headlessly, writing a schema-tagged results.json plus per-unit JSON and
// screenshots to disk. This is the STANDING battery for the whole feel-overhaul arc (Part 17-20,
// Phases 74-94 all re-run it against a moving baseline), so — unlike a throwaway per-phase probe —
// it lives in scripts/ with a package.json entry, per this repo's `scripts/` vs `.planning/tools/`
// convention.
//
// --- two measurement modes (phase-74-plan.md Decision 3) --------------------------------------
//   PROBES — dev/feelProbes.ts's five scripted manoeuvres (launch, brake, stepSteer, turnRadius,
//            slalom) on a cleared straight (civ traffic / transit / pack-parked cars OFF, player
//            invincible) via window.__smashy.startFeelProbes(). Measures what the CAR can do.
//   ROUTES — dev/feelDrives.ts's four named drives (downtownDense, spineCruise, minorWeave,
//            chase3) on the LIVE city, everything ON, via window.__smashy.startFeelDrive().
//            Measures what the CITY does to the car.
// One results schema, `kind: 'route' | 'probes'` per unit. Never average a probe number against a
// route number — they answer different questions by construction (see feelProbes.ts's header).
//
// --- run units + slicing (addendum to phase-74-plan.md, corrections after the harness survey) --
// `--tier` is single-valued per invocation (the persisted quality tier is pinned via
// `page.addInitScript` BEFORE navigation — it can't be changed mid-session without a reload, so
// "×3 tiers" means three separate foreground invocations, exactly like bench-chaos.mjs's
// BENCH_TIER convention). Within ONE invocation, the flat list of "run units" is:
//   - one unit per selected route id (`--routes=`, default all four)
//   - ONE unit for the whole selected probe SUITE (`--probes=` narrows which of the five run
//     INSIDE that one bridge call — it does not multiply units; a suite is one scripted session)
// filtered first by `--mode=probes|routes|both`, THEN sliced by `--slice=i/n` (contiguous block on
// the already-filtered list — copied verbatim from flicker-sweep.mjs's `--slice` parsing (:456-466)
// and slice-block computation (:1182-1188)). Each slice writes its OWN results.json into
// `<out>/<run>/` — there is no merge script; the verdict is assembled by reading the per-slice
// files, so every file records both `sliceUnitIds` (what THIS file ran) and `allUnitIds` (the full
// filtered list this slice was carved from), and every run/skip/error is recorded explicitly
// (never a silent omission — see the file's "honesty" section below).
//
// --- timing / recommended slicing --------------------------------------------------------------
// A route unit is a `seconds`-long scripted drive (default 60s) plus ~1-10s of settle/arm
// overhead: roughly 60-75s wall-clock. A probe-suite unit runs five manoeuvres back to back;
// measured worst-case bound on the manoeuvres' own timeouts is ~150s, and it is realistically
// faster (each probe stops as soon as its trace is done, not at its ceiling) — budget ~60-150s.
// So one `--mode=both --tier=<T>` invocation (4 route units + 1 probe-suite unit) runs
// ~5-7.5 minutes: under the 8-minute-per-invocation ceiling (project rule since the P42/P43 stall-
// recovery lesson — see the project memory on phase-runner stalls), but close enough to it that
// the RECOMMENDED shape for a full baseline (4 routes x 3 tiers + the probe suite x 3 tiers) is
// SIX invocations, not one huge one: for each tier in {high, med, low}, run
//   node scripts/feel-lab.mjs --mode=routes --tier=<T> --run=<T>-routes
//   node scripts/feel-lab.mjs --mode=probes --tier=<T> --run=<T>-probes
// (routes alone: ~4-5 min; probes alone: ~1-2.5 min — both comfortably clear of the ceiling with
// margin for a slow SwiftShader day). `--slice=i/n` is still fully supported and generic (any
// mode, any unit count) if a single mode/tier invocation ever needs splitting further — e.g. a
// slow container could do `--mode=routes --tier=high --slice=1/2 --run=high-routes-a` then
// `--slice=2/2 --run=high-routes-b`.
//
// --- honesty rules this file enforces -----------------------------------------------------------
//   1. Every unit in the (mode+routes+probes)-filtered, then sliced, list gets an entry in
//      `results.units` — `status: 'ok' | 'error'`, with `reason` set on anything but 'ok'. A unit
//      that throws never disappears; it is recorded and the run still exits nonzero. This is the
//      exact failure mode CLAUDE.md flags from an earlier phase: "a battery aborted at 14/22 and
//      the notes claimed all-green" — this harness keeps going through a unit failure (so the
//      record is complete) and still fails the exit code (so a partial run can never read clean).
//   2. Every probe/route result carries its OWN isolation/toggle block verbatim (dev/feelProbes.ts's
//      `ProbeResultBase.isolation`, dev/feelDrives.ts's `FeelDriveReport.toggles` applied+observed)
//      — nobody reading results.json can mistake a probe number for live play, or a route's
//      "everything on" claim without the actual toggle states to check it against.
//   3. Console errors and uncaught page errors are collected for the WHOLE session (registered
//      before navigation) and gate the exit code unconditionally, on top of any per-unit failure.
//
// --- fresh-run cycle before EVERY unit -----------------------------------------------------------
// Heat is monotonic per run (locked decision, CLAUDE.md) and neither probe nor route isolation
// touches pursuit spawning (dev/feelProbes.ts's `ProbeIsolation` only covers civTraffic/transit/
// packParked/invincible — see applyIsolation() — and a route only grants heat itself for chase3).
// Left alone, an earlier chase3 unit's heat would carry into the next probe's "cleared straight"
// as live police, silently contaminating a controlled measurement. So exactly like
// camera-lab.mjs's `freshRunCycle`, this script drives a GAMEOVER->PLAYING cycle (heat/score/hp
// zeroed, a fresh world-relevant machine state) before every single unit, probe suite included.
//
// Usage:
//   node scripts/feel-lab.mjs --mode=probes|routes|both --tier=high|med|low
//     [--routes=downtownDense,spineCruise,...] [--probes=launch,brake,...]
//     [--seconds=60] [--seed=1] --run=<id> [--out=.planning/screenshots/phase-74] [--slice=i/n]
//
// Devcontainer note (see .devcontainer/gen-chromium-shims.mjs / the project memory on browser
// shims): this no-sudo, firewalled devcontainer needs
//   LD_LIBRARY_PATH=$HOME/.cache/chromium-shim-libs node scripts/feel-lab.mjs ...
// until the container ships the real apt deps baked in — same prefix camera-lab.mjs/bench-chaos.mjs
// already need.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const DEV_URL = 'http://localhost:5173';
const SETTINGS_STORAGE_KEY = 'smashy6ix:settings';

// Mirrors dev/feelProbes.ts's `ProbeKind` union. Not queryable off the bridge (feelRoutes() has a
// static-metadata analogue; probes have no equivalent accessor), so kept here by hand — same
// discipline camera-lab.mjs's DEFAULT_PRESETS and bench-chaos.mjs's TIER_BUDGETS document for
// their own hand-mirrored constants.
const ALL_PROBE_KINDS = ['launch', 'brake', 'stepSteer', 'turnRadius', 'slalom'];
const ALL_TIERS = ['high', 'med', 'low'];
const ALL_MODES = ['probes', 'routes', 'both'];

const PROBE_URLS = ['http://127.0.0.1:5173', 'http://[::1]:5173', 'http://localhost:5173'];
const SERVER_READY_TIMEOUT_MS = 30_000;
const SERVER_POLL_MS = 500;
const CANVAS_TIMEOUT_MS = 20_000;
const BRIDGE_TIMEOUT_MS = 15_000;
const BRIDGE_POLL_MS = 200;
const ENSURE_PLAYING_TIMEOUT_MS = 30_000; // generous: a fresh-run cycle fully remounts the world
const ENSURE_PLAYING_POLL_MS = 150;

const SHOT_EVERY_MS = 8_000;
// Assumed duration purely for sizing the probe-suite's periodic-screenshot loop (runProbesUnit) —
// the REAL safety net is the withTimeout() wrap below, sized independently and generously.
const PROBE_ASSUMED_SECONDS = 120;
const PROBE_TIMEOUT_MS = 300_000; // 5 min — see the file header's worst-case bound (~150s) x2

const DEFAULT_ROUTE_SECONDS = 60; // mirrors dev/feelDrives.ts's DEFAULT_SECONDS
const DEFAULT_ROUTE_SEED = 1; // mirrors dev/feelDrives.ts's DEFAULT_SEED

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Races `promise` against a timeout, rejecting with a clear message instead of hanging the whole
 * script forever if a page-side await never settles. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    mode: 'both',
    tier: 'high',
    routes: null, // null = all, resolved once feelRoutes() is known
    probes: null, // null = all ALL_PROBE_KINDS
    seconds: DEFAULT_ROUTE_SECONDS,
    seed: DEFAULT_ROUTE_SEED,
    run: null,
    out: '.planning/screenshots/phase-74',
    slice: null,
  };
  for (const arg of argv) {
    // pnpm >= 9 forwards the argument separator VERBATIM (`pnpm feel:lab -- --mode=x` reaches
    // this script as ['--', '--mode=x']) — ignore a bare `--` rather than treating it as unknown
    // (flicker-sweep.mjs's same rule, :439-440).
    if (arg === '--') continue;
    const [key, ...rest] = arg.split('=');
    const value = rest.join('=');
    switch (key) {
      case '--mode':
        out.mode = value.trim();
        break;
      case '--tier':
        out.tier = value.trim();
        break;
      case '--routes':
        out.routes = value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--probes':
        out.probes = value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--seconds':
        out.seconds = Number(value);
        break;
      case '--seed':
        out.seed = Number(value);
        break;
      case '--run':
        out.run = value.trim();
        break;
      case '--out':
        out.out = value;
        break;
      case '--slice': {
        const m = /^(\d+)\/(\d+)$/.exec(value.trim());
        const i = m ? Number.parseInt(m[1], 10) : NaN;
        const n = m ? Number.parseInt(m[2], 10) : NaN;
        if (!m || i < 1 || n < 1 || i > n) {
          console.error('[feel-lab] --slice must be i/n with 1 <= i <= n');
          process.exit(1);
        }
        out.slice = { i, n };
        break;
      }
      default:
        console.error(`[feel-lab] unknown arg: ${arg}`);
        process.exit(1);
    }
  }

  if (!ALL_MODES.includes(out.mode)) {
    console.error(`[feel-lab] --mode must be one of ${ALL_MODES.join('|')}, got "${out.mode}"`);
    process.exit(1);
  }
  if (!ALL_TIERS.includes(out.tier)) {
    console.error(`[feel-lab] --tier must be one of ${ALL_TIERS.join('|')}, got "${out.tier}"`);
    process.exit(1);
  }
  if (!Number.isFinite(out.seconds) || out.seconds <= 0) {
    console.error(`[feel-lab] --seconds must be a positive number, got "${out.seconds}"`);
    process.exit(1);
  }
  if (!Number.isFinite(out.seed)) {
    console.error(`[feel-lab] --seed must be a number, got "${out.seed}"`);
    process.exit(1);
  }
  if (!out.run || !/^[\w.-]+$/.test(out.run)) {
    console.error(
      '[feel-lab] --run=<id> is REQUIRED and must be a simple name ([A-Za-z0-9_.-]) — it names the ' +
        'output subdirectory so slices/tiers never overwrite each other.',
    );
    process.exit(1);
  }
  if (out.probes) {
    const unknown = out.probes.filter((p) => !ALL_PROBE_KINDS.includes(p));
    if (unknown.length > 0) {
      console.error(
        `[feel-lab] unknown --probes id(s): ${unknown.join(', ')} — known: ${ALL_PROBE_KINDS.join(', ')}`,
      );
      process.exit(1);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// SERVER (boot-or-reuse — camera-lab.mjs / bench-chaos.mjs)
// ---------------------------------------------------------------------------------------------

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
    await sleep(SERVER_POLL_MS);
  }
  throw new Error(`dev server never came up at ${DEV_URL} within ${deadlineMs}ms`);
}

async function waitForBridgeFn(page, fnName) {
  const start = Date.now();
  while (Date.now() - start < BRIDGE_TIMEOUT_MS) {
    const ready = await page.evaluate((name) => typeof window.__smashy?.[name] === 'function', fnName);
    if (ready) return;
    await page.waitForTimeout(BRIDGE_POLL_MS);
  }
  throw new Error(
    `window.__smashy.${fnName} never appeared — is this a prod build? The bridge only loads under ` +
      'import.meta.env.DEV (this script targets the dev server, not `pnpm preview`).',
  );
}

/** Polls until `machine` reaches PLAYING, driving any single valid transition edge it can (mirrors
 * ai/chaosBench.ts's ensurePlaying / camera-lab.mjs's own copy). */
async function ensurePlaying(page) {
  const start = Date.now();
  while (Date.now() - start < ENSURE_PLAYING_TIMEOUT_MS) {
    const m = await page.evaluate(() => window.__smashy.getMachine());
    if (m === 'PLAYING') return;
    await page.evaluate(() => window.__smashy.transition('PLAYING'));
    await page.waitForTimeout(ENSURE_PLAYING_POLL_MS);
  }
  throw new Error(`feel-lab: could not reach PLAYING within ${ENSURE_PLAYING_TIMEOUT_MS}ms`);
}

/** Polls until playerVehicle.readState() is non-null — needed even after ensurePlaying() resolves
 * because a fresh-run cycle remounts the player component (see camera-lab.mjs's own copy for the
 * full race explanation). */
async function waitForPlayerReady(page) {
  const start = Date.now();
  while (Date.now() - start < ENSURE_PLAYING_TIMEOUT_MS) {
    const ok = await page.evaluate(() => window.__smashy.readState() !== null);
    if (ok) return;
    await page.waitForTimeout(ENSURE_PLAYING_POLL_MS);
  }
  throw new Error('feel-lab: player never became ready (readState() stayed null)');
}

/** Heat-0, world-relevant fresh start before EVERY unit — see the file header's "fresh-run cycle"
 * section for why probes need this too, not just routes. Safe from any machine state PLAYING/
 * PAUSED can reach GAMEOVER from, or from GAMEOVER itself (transition() is a guarded no-op on an
 * invalid edge, never throws). */
async function freshRunCycle(page) {
  await page.evaluate(() => window.__smashy.transition('GAMEOVER'));
  await page.waitForTimeout(300);
  await ensurePlaying(page);
  await waitForPlayerReady(page);
}

// ---------------------------------------------------------------------------------------------
// Run units
// ---------------------------------------------------------------------------------------------

function safeId(id) {
  return id.replace(/[^\w.-]+/g, '-');
}

/** Builds the flat, filtered (mode + routes + probes) list of run units — BEFORE slicing. One
 * unit per selected route id, plus (at most) ONE unit for the whole selected probe suite. */
function buildUnits(args, knownRouteIds) {
  const units = [];
  if (args.mode === 'routes' || args.mode === 'both') {
    const routeIds = args.routes ?? knownRouteIds;
    const unknown = routeIds.filter((id) => !knownRouteIds.includes(id));
    if (unknown.length > 0) {
      throw new Error(`unknown --routes id(s): ${unknown.join(', ')} — known: ${knownRouteIds.join(', ')}`);
    }
    for (const routeId of routeIds) {
      units.push({ id: `route:${routeId}`, kind: 'route', routeId });
    }
  }
  if (args.mode === 'probes' || args.mode === 'both') {
    const probeKinds = args.probes ?? ALL_PROBE_KINDS;
    units.push({ id: 'probes:suite', kind: 'probes', probeKinds });
  }
  return units;
}

/**
 * Runs a route unit via `startFeelDrive`, taking periodic screenshots into `unitDir` while it is
 * in flight (mirrors camera-lab.mjs's runOneDrive loop: the screenshot loop is bounded by an
 * ITERATION COUNT derived from `args.seconds`, not wall-clock parity with the timeout below — a
 * slow run simply stops taking mid-run shots and still gets its final one; the real safety net is
 * the separate `withTimeout` wrap on the awaited promise), then one final screenshot after
 * resolution.
 */
async function runRouteUnit(page, unit, args, unitDir) {
  const opts = { route: unit.routeId, seconds: args.seconds, seed: args.seed };
  const timeoutMs = Math.max(args.seconds * 1000 * 4, 30_000) + 30_000;
  const promise = page.evaluate((o) => window.__smashy.startFeelDrive(o), opts);
  let resolved = false;
  promise.then(
    () => {
      resolved = true;
    },
    () => {
      resolved = true;
    },
  );
  const shots = [];
  const maxShots = Math.max(1, Math.floor(args.seconds / (SHOT_EVERY_MS / 1000)));
  for (let i = 1; i <= maxShots && !resolved; i++) {
    await sleep(SHOT_EVERY_MS);
    if (resolved) break;
    const fileName = `shot-t${i}.png`;
    try {
      await page.screenshot({ path: path.join(unitDir, fileName) });
      shots.push(fileName);
    } catch (err) {
      console.warn(`[feel-lab] screenshot ${fileName} (${unit.id}) failed: ${err.message}`);
    }
  }

  const report = await withTimeout(promise, timeoutMs, `startFeelDrive(${unit.routeId})`);
  try {
    await page.screenshot({ path: path.join(unitDir, 'shot-final.png') });
    shots.push('shot-final.png');
  } catch (err) {
    console.warn(`[feel-lab] final screenshot (${unit.id}) failed: ${err.message}`);
  }

  const formattedText = await page.evaluate((r) => window.__smashy.formatFeelDriveReport(r), report);
  const perf = await page.evaluate(() => window.__smashy.readPerf());
  return { report, shots, formattedText, perf };
}

async function runProbesUnit(page, unit, args, unitDir) {
  const opts = { probes: unit.probeKinds, includeSamples: false };
  const promise = page.evaluate((o) => window.__smashy.startFeelProbes(o), opts);
  let resolved = false;
  promise.then(
    () => {
      resolved = true;
    },
    () => {
      resolved = true;
    },
  );
  const shots = [];
  const maxShots = Math.max(1, Math.floor(PROBE_ASSUMED_SECONDS / (SHOT_EVERY_MS / 1000)));
  for (let i = 1; i <= maxShots && !resolved; i++) {
    await sleep(SHOT_EVERY_MS);
    if (resolved) break;
    const fileName = `shot-t${i}.png`;
    try {
      await page.screenshot({ path: path.join(unitDir, fileName) });
      shots.push(fileName);
    } catch (err) {
      console.warn(`[feel-lab] screenshot ${fileName} (${unit.id}) failed: ${err.message}`);
    }
  }

  const suite = await withTimeout(promise, PROBE_TIMEOUT_MS, `startFeelProbes(${unit.id})`);
  try {
    await page.screenshot({ path: path.join(unitDir, 'shot-final.png') });
    shots.push('shot-final.png');
  } catch (err) {
    console.warn(`[feel-lab] final screenshot (${unit.id}) failed: ${err.message}`);
  }

  const formattedText = await page.evaluate((s) => window.__smashy.formatFeelProbeReport(s), suite);
  const perf = await page.evaluate(() => window.__smashy.readPerf());
  return { suite, shots, formattedText, perf };
}

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

/** Soft findings worth surfacing but that do NOT by themselves fail the exit code (only a thrown
 * unit or a console/page error does that — see the file header's honesty rules). */
function collectWarnings(unit, record) {
  const warnings = [];
  if (record.status !== 'ok') return warnings;
  if (unit.kind === 'route') {
    const r = record.report;
    if (r.requiredTier > 0 && !r.tierArmed) {
      warnings.push(`${unit.id}: tierArmed=false (required tier ${r.requiredTier} never reached)`);
    }
    if (r.driver.revives > 0) {
      warnings.push(`${unit.id}: ${r.driver.revives} revive(s) (water/out-of-bounds mid-window)`);
    }
  } else {
    for (const p of record.suite.results) {
      if (p.status !== 'ok') {
        warnings.push(`${unit.id}: probe '${p.kind}' status=${p.status}`);
      }
    }
  }
  return warnings;
}

function buildVerdict(units, consoleErrors, pageErrors) {
  const unitsOk = units.filter((u) => u.status === 'ok').length;
  const unitsError = units.filter((u) => u.status === 'error').length;
  const warnings = units.flatMap((u) => u.warnings ?? []);
  const reasons = [];
  if (unitsError > 0) reasons.push(`${unitsError} unit(s) errored`);
  if (consoleErrors.length > 0) reasons.push(`${consoleErrors.length} console error(s)`);
  if (pageErrors.length > 0) reasons.push(`${pageErrors.length} page error(s)`);
  return {
    ok: reasons.length === 0,
    unitsPlanned: units.length,
    unitsOk,
    unitsError,
    consoleErrorCount: consoleErrors.length,
    pageErrorCount: pageErrors.length,
    reasons,
    warnings,
  };
}

function fmt(n, digits = 1) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : 'n/a';
}

function printSummaryTable(results) {
  console.log(
    `\n[feel-lab] run="${results.args.run}" tier=${results.tier} mode=${results.args.mode}` +
      (results.slice ? ` slice=${results.slice.i}/${results.slice.n}` : ''),
  );
  console.log('[feel-lab] units:');
  for (const u of results.units) {
    let headline;
    if (u.status === 'ok' && u.kind === 'route') {
      const r = u.report;
      headline =
        `elapsed=${fmt(r.elapsedSec)}s contacts/min=${fmt(r.telemetry.contact.eventsPerMin)} ` +
        `stuck=${r.telemetry.stuck.count}(${r.telemetry.stuck.unrecoverableCount} unrec.) ` +
        `flips=${r.telemetry.stability.flipCount} tierArmed=${r.tierArmed}`;
    } else if (u.status === 'ok' && u.kind === 'probes') {
      headline = u.suite.results.map((p) => `${p.kind}:${p.status}`).join(' ');
    } else {
      headline = u.reason ?? '';
    }
    console.log(`  ${u.id.padEnd(16)} ${u.status.padEnd(6)} ${(u.durationMs / 1000).toFixed(1)}s  ${headline}`);
  }
  if (results.verdict.warnings.length > 0) {
    console.log('[feel-lab] warnings (non-gating):');
    for (const w of results.verdict.warnings) console.log(`  - ${w}`);
  }
  console.log(
    `\n[feel-lab] console/page errors: ${results.consoleErrorCount} — ${
      results.consoleErrorCount === 0 ? 'OK' : 'FAIL'
    }`,
  );
  console.log(`[feel-lab] verdict: ${results.verdict.ok ? 'OK' : 'FAIL'}${
    results.verdict.reasons.length > 0 ? ` (${results.verdict.reasons.join('; ')})` : ''
  }`);
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.out, args.run);
  mkdirSync(outDir, { recursive: true });

  let devServer = null;
  const alreadyRunning = await isServerUp();
  if (!alreadyRunning) {
    console.log(`[feel-lab] no dev server at ${DEV_URL} — starting one (pnpm exec vite)…`);
    devServer = spawn('pnpm', ['exec', 'vite', '--port', '5173', '--strictPort'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    devServer.stdout.on('data', () => {});
    devServer.stderr.on('data', (chunk) => process.stderr.write(chunk));
    await waitForServer(SERVER_READY_TIMEOUT_MS);
    console.log('[feel-lab] dev server is up.');
  } else {
    console.log(`[feel-lab] reusing existing dev server at ${DEV_URL}.`);
  }

  let exitCode;
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    console.log(`[feel-lab] pinning persisted quality tier to "${args.tier}"…`);
    await page.addInitScript(
      ([key, tier]) => {
        try {
          window.localStorage.setItem(key, JSON.stringify({ quality: tier, muted: false, reducedShake: false }));
        } catch {
          // Private/incognito or storage disabled — the app degrades to auto-detect the same way.
        }
      },
      [SETTINGS_STORAGE_KEY, args.tier],
    );

    console.log('[feel-lab] loading the game…');
    await page.goto(DEV_URL, { waitUntil: 'load' });
    await page.locator('.game-canvas-container canvas').first().waitFor({
      state: 'visible',
      timeout: CANVAS_TIMEOUT_MS,
    });

    console.log('[feel-lab] waiting for the dev debug bridge (window.__smashy)…');
    for (const fn of ['startFeelProbes', 'startFeelDrive', 'feelRoutes', 'formatFeelProbeReport', 'formatFeelDriveReport']) {
      await waitForBridgeFn(page, fn);
    }

    console.log('[feel-lab] reaching PLAYING…');
    await ensurePlaying(page);
    await waitForPlayerReady(page);

    const feelRoutesMeta = await page.evaluate(() => window.__smashy.feelRoutes());
    const knownRouteIds = Object.keys(feelRoutesMeta);

    // Not wrapped in its own try/catch: a bad --routes id is a configuration error, not a unit
    // failure, and should be handled by the outer catch below so the browser/dev-server cleanup
    // in `finally` still runs (an early `process.exit()` here would skip it).
    const allUnits = buildUnits(args, knownRouteIds);
    const allUnitIds = allUnits.map((u) => u.id);

    let sliceUnits = allUnits;
    let sliceBlock = null;
    if (args.slice) {
      const { i, n } = args.slice;
      const start = Math.floor(((i - 1) * allUnits.length) / n);
      const end = Math.floor((i * allUnits.length) / n);
      sliceUnits = allUnits.slice(start, end);
      sliceBlock = { i, n, start, end };
    }

    console.log(
      `[feel-lab] ${sliceUnits.length}/${allUnits.length} unit(s) this invocation` +
        (sliceBlock ? ` (slice ${sliceBlock.i}/${sliceBlock.n})` : '') +
        `: ${sliceUnits.map((u) => u.id).join(', ')}`,
    );

    const unitRecords = [];
    for (const unit of sliceUnits) {
      const safe = safeId(unit.id);
      const unitDir = path.join(outDir, safe);
      mkdirSync(unitDir, { recursive: true });

      const startedAtIso = new Date().toISOString();
      const t0 = Date.now();
      const record = {
        id: unit.id,
        kind: unit.kind,
        tier: args.tier,
        routeId: unit.routeId ?? null,
        probeKinds: unit.probeKinds ?? null,
        status: 'error',
        reason: null,
        startedAtIso,
        finishedAtIso: null,
        durationMs: null,
        perf: null,
        screenshotDir: safe,
        screenshots: [],
        formattedText: null,
        report: null,
        suite: null,
        warnings: [],
      };

      try {
        console.log(`[feel-lab]   ${unit.id}…`);
        await freshRunCycle(page);
        if (unit.kind === 'route') {
          const { report, shots, formattedText, perf } = await runRouteUnit(page, unit, args, unitDir);
          record.report = report;
          record.screenshots = shots;
          record.formattedText = formattedText;
          record.perf = perf;
        } else {
          const { suite, shots, formattedText, perf } = await runProbesUnit(page, unit, args, unitDir);
          record.suite = suite;
          record.screenshots = shots;
          record.formattedText = formattedText;
          record.perf = perf;
        }
        record.status = 'ok';
      } catch (err) {
        record.status = 'error';
        record.reason = err instanceof Error ? err.message : String(err);
        console.error(`[feel-lab] FAIL unit ${unit.id}: ${record.reason}`);
      }

      record.finishedAtIso = new Date().toISOString();
      record.durationMs = Date.now() - t0;
      record.warnings = collectWarnings(unit, record);
      unitRecords.push(record);
      console.log(
        `[feel-lab]   ${unit.id}: ${record.status}` +
          (record.reason ? ` — ${record.reason}` : '') +
          ` (${(record.durationMs / 1000).toFixed(1)}s)`,
      );

      writeFileSync(path.join(outDir, `${safe}.json`), JSON.stringify(record, null, 2));
    }

    const verdict = buildVerdict(unitRecords, consoleErrors, pageErrors);

    const results = {
      schema: 'feel-lab/1',
      generatedAt: new Date().toISOString(),
      args,
      tier: args.tier,
      slice: sliceBlock,
      allUnitIds,
      sliceUnitIds: sliceUnits.map((u) => u.id),
      units: unitRecords,
      consoleErrorCount: consoleErrors.length + pageErrors.length,
      consoleErrors,
      pageErrors,
      verdict,
    };

    writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
    printSummaryTable(results);

    if (consoleErrors.length > 0) {
      console.error(`[feel-lab] FAIL: ${consoleErrors.length} console error(s) during the run:`);
      for (const msg of consoleErrors) console.error(`  - ${msg}`);
    }
    if (pageErrors.length > 0) {
      console.error(`[feel-lab] FAIL: ${pageErrors.length} uncaught page error(s) during the run:`);
      for (const msg of pageErrors) console.error(`  - ${msg}`);
    }

    exitCode = verdict.ok ? 0 : 1;
    console.log(`\n[feel-lab] evidence tree: ${outDir}`);
    console.log(exitCode === 0 ? '[feel-lab] OK' : '[feel-lab] FAIL');
  } catch (err) {
    console.error('[feel-lab] FAIL:', err instanceof Error ? err.stack : err);
    exitCode = 1;
  } finally {
    await browser.close();
    if (devServer) devServer.kill();
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error('[feel-lab] unexpected failure:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
