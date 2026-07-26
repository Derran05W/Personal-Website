#!/usr/bin/env node
// Phase 33 Task 3 — the camera-lab VANTAGE BATTERY. Boots a real dev server (window.__smashy
// only exists in the DEV-gated chunk, same constraint bench-chaos.mjs documents at length — this
// mirrors that script's boot/probe/bridge-wait/error-collection pattern deliberately, so both
// tools behave the same way in this repo's devcontainer/CI), then judges the Phase 33 camera
// candidates (config/camera.ts's CAMERA_PRESETS 'A'..'E', applied live through
// window.__smashy.setCameraPreset) two ways:
//
//   STILLS  — teleport the player to each of the 7 named vantages (window.__smashy.
//             cameraVantages() — real street crossings, never hardcoded) under every preset,
//             settle, and read the Phase-33 clip counters (core/debugBridge.ts's
//             cameraClipStats(): eye-inside-a-building / near-plane-clip / occluder-on-boresight
//             / clamp-fired frame rates) + a screenshot + a perf snapshot.
//   DRIVES  — one scripted downtown cruise per preset via window.__smashy.startCameraLabDrive
//             (ai/cameraLabDrive.ts), screenshotting periodically, with an optional same-seed
//             repeat run to prove the drive — and the camera's clip-rate response to it — is
//             reproducible (waypoint sequence IDENTICAL, per-frame rates within ±10% relative;
//             see this file's diffDriveReports()).
//
// --- why "settle" before every measurement -------------------------------------------------
// A teleport (window.__smashy.reset) does NOT reset the follow-camera rig: the rig lerps its way
// across the map toward the new position over multiple seconds, and mid-sweep the clip stats and
// perf numbers are garbage (measured live: ~179 draw calls / 840k tris mid-sweep vs. ~70/100k
// once settled — an order of magnitude off). Every measurement window in this file follows the
// same shape: teleport -> settle (SETTLE_MS) -> resetCameraClipStats() -> wait (STATS_WINDOW_MS)
// -> read. Never sample unsettled; the two waits are not interchangeable with a single longer one
// because the counters must start from zero AFTER the sweep, not before it.
//
// --- why a "fresh-run cycle" gates every drive ----------------------------------------------
// Heat is monotonic per run (locked decision, CLAUDE.md) and the game's own GAMEOVER->PLAYING
// retry edge (combat/runLoop.ts's runReset()) is the only way to get back to heat 0 without a
// full page reload — and it also bumps state/store.ts's `runId`, which game/index.tsx uses to key
// (`${seed}-${runId}`) a FULL remount of the physical Toronto world, including the clip index
// (world/toronto/TorontoScene.tsx rebuilds it every mount). So every drive preset gets a fresh
// GAMEOVER -> PLAYING cycle first (freshRunCycle below), and the clip-index-populated assertion
// is re-checked after each one, not just once at boot — an empty index reads exactly like a
// perfectly clean camera, which would silently corrupt the evidence.
//
// Usage:
//   node scripts/camera-lab.mjs [--presets A,B,C,D,E] [--vantages all|id,id,...] [--drive 60]
//     [--drive-waypoints 12] [--repeat 1] [--drive-preset all|A,B,...] [--shot-every 2]
//     [--out .planning/screenshots/phase-33-lab]
//
// `--drive-waypoints N` (default 12; 0 = pure time mode) boxes each drive by ROUTE COVERAGE via
// startCameraLabDrive's stopAfterWaypoints — `--drive` seconds become the safety ceiling. Two
// same-seed waypoint-boxed runs cover identical route legs, which is what makes the ±10% rate
// tolerance an honest reproducibility bar (a time-boxed pair can differ by a whole route leg —
// measured 33% vs 43% boresightRate — through frame-pacing alone).
// `--drive 0` skips the DRIVES phase entirely. If window.__smashy.startCameraLabDrive isn't on
// the bridge yet (ai/cameraLabDrive.ts / Task 2 not landed), DRIVES is skipped with a loud
// warning — STILLS still runs and still exits 0 on its own merits.
//
// Devcontainer note (see .devcontainer/gen-chromium-shims.mjs): this no-sudo, firewalled
// devcontainer needs `LD_LIBRARY_PATH=$HOME/.cache/chromium-shim-libs pnpm exec node
// scripts/camera-lab.mjs ...` until the container ships the real apt deps — same prefix
// bench-chaos.mjs and pnpm smoke already need.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const DEV_URL = 'http://localhost:5173';
const SETTINGS_STORAGE_KEY = 'smashy6ix:settings';
const BENCH_TIER = 'high'; // pin a consistent quality tier for comparable perf/tri numbers across presets

const DEFAULT_PRESETS = ['A', 'B', 'C', 'D', 'E'];
const DRIVE_SEED = 416; // the project's standing "known-tricky" seed (see CLAUDE.md phase notes)

const PROBE_URLS = ['http://127.0.0.1:5173', 'http://[::1]:5173', 'http://localhost:5173'];
const SERVER_READY_TIMEOUT_MS = 30_000;
const SERVER_POLL_MS = 500;
const CANVAS_TIMEOUT_MS = 20_000;
const BRIDGE_TIMEOUT_MS = 15_000;
const BRIDGE_POLL_MS = 200;
const ENSURE_PLAYING_TIMEOUT_MS = 30_000; // generous: a fresh-run cycle fully remounts the world
const ENSURE_PLAYING_POLL_MS = 150;
const CLIP_INDEX_TIMEOUT_MS = 10_000;
const CLIP_INDEX_POLL_MS = 200;

const SETTLE_MS = 3_500; // rig-sweep settle after any teleport (measured; see file header)
const STATS_WINDOW_MS = 1_500; // clip-stat accumulation window after resetCameraClipStats()

function parseArgs(argv) {
  const out = {
    presets: DEFAULT_PRESETS,
    vantages: 'all',
    drive: 60,
    driveWaypoints: 12,
    repeat: 1,
    drivePreset: 'all',
    out: '.planning/screenshots/phase-33-lab',
    shotEvery: 2,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--presets':
        out.presets = next()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--vantages':
        out.vantages = next().trim();
        break;
      case '--drive':
        out.drive = Number(next());
        break;
      case '--drive-waypoints':
        out.driveWaypoints = Number(next());
        break;
      case '--repeat':
        out.repeat = Number(next());
        break;
      case '--drive-preset':
        out.drivePreset = next().trim();
        break;
      case '--out':
        out.out = next();
        break;
      case '--shot-every':
        out.shotEvery = Number(next());
        break;
      default:
        console.error(`[camera-lab] unknown arg: ${a}`);
        process.exit(1);
    }
  }
  if (!Number.isFinite(out.driveWaypoints) || out.driveWaypoints < 0) {
    console.error(`[camera-lab] --drive-waypoints must be a non-negative number, got "${out.driveWaypoints}"`);
    process.exit(1);
  }
  if (!Number.isFinite(out.drive) || out.drive < 0) {
    console.error(`[camera-lab] --drive must be a non-negative number, got "${out.drive}"`);
    process.exit(1);
  }
  if (!Number.isFinite(out.repeat) || out.repeat < 1) {
    console.error(`[camera-lab] --repeat must be >= 1, got "${out.repeat}"`);
    process.exit(1);
  }
  if (!Number.isFinite(out.shotEvery) || out.shotEvery <= 0) {
    console.error(`[camera-lab] --shot-every must be > 0, got "${out.shotEvery}"`);
    process.exit(1);
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Races `promise` against a timeout, rejecting with a clear message instead of hanging the
 * whole script forever if a page-side await never settles. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

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
 * ai/chaosBench.ts's ensurePlaying — BOOT->LOADING->GARAGE happen on their own; only GARAGE/
 * GAMEOVER->PLAYING needs a push). Throws rather than silently proceeding on a stuck machine. */
async function ensurePlaying(page) {
  const start = Date.now();
  while (Date.now() - start < ENSURE_PLAYING_TIMEOUT_MS) {
    const m = await page.evaluate(() => window.__smashy.getMachine());
    if (m === 'PLAYING') return;
    await page.evaluate(() => window.__smashy.transition('PLAYING'));
    await page.waitForTimeout(ENSURE_PLAYING_POLL_MS);
  }
  throw new Error(`camera-lab: could not reach PLAYING within ${ENSURE_PLAYING_TIMEOUT_MS}ms`);
}

/** Polls until playerVehicle.readState() is non-null. Needed even after ensurePlaying() resolves:
 * a fresh-run cycle remounts the player component (`key={player-${worldKey}-...}`), so the ref can
 * lag the machine transition by a beat — see ai/chaosBench.ts's waitForPlayerReady for the same
 * race documented against the ORIGINAL boot sequence. */
async function waitForPlayerReady(page) {
  const start = Date.now();
  while (Date.now() - start < ENSURE_PLAYING_TIMEOUT_MS) {
    const ok = await page.evaluate(() => window.__smashy.readState() !== null);
    if (ok) return;
    await page.waitForTimeout(ENSURE_PLAYING_POLL_MS);
  }
  throw new Error('camera-lab: player never became ready (readState() stayed null)');
}

/** MUST be called right after any point the world could have (re)mounted — initial boot AND every
 * fresh-run cycle. An empty index reads exactly like a perfectly clean camera; this refuses that
 * silent corruption instead of trusting a run of zeroes. */
async function waitForClipIndexReady(page) {
  const start = Date.now();
  while (Date.now() - start < CLIP_INDEX_TIMEOUT_MS) {
    const size = await page.evaluate(() => window.__smashy.cameraClipIndexSize());
    if (size > 0) return size;
    await page.waitForTimeout(CLIP_INDEX_POLL_MS);
  }
  throw new Error(
    `camera-lab: cameraClipIndexSize() stayed 0 for ${CLIP_INDEX_TIMEOUT_MS}ms — world not mounted, or the ` +
      'clip index is broken. Refusing to trust a battery run against an empty index.',
  );
}

/** Heat-0, world-remounted fresh start: the retry edge (GAMEOVER->PLAYING) zeroes heat/score/hp
 * and bumps runId for a full world remount — see this file's header for why every drive needs
 * this. Safe to call from any machine state PLAYING/PAUSED can reach GAMEOVER from, or from
 * GAMEOVER itself (transition() is a guarded no-op on an invalid edge, never throws). */
async function freshRunCycle(page) {
  await page.evaluate(() => window.__smashy.transition('GAMEOVER'));
  await page.waitForTimeout(300);
  await ensurePlaying(page);
  await waitForPlayerReady(page);
  await waitForClipIndexReady(page);
}

async function teleport(page, x, z) {
  await page.evaluate(
    ([tx, tz]) => {
      window.__smashy.reset({ position: { x: tx, y: 0.85, z: tz }, rotation: { x: 0, y: 0, z: 0, w: 1 } });
    },
    [x, z],
  );
}

async function applyPreset(page, presetId) {
  const applied = await page.evaluate((pid) => window.__smashy.setCameraPreset(pid), presetId);
  if (!applied) {
    throw new Error(`camera-lab: setCameraPreset("${presetId}") returned false — unknown preset id?`);
  }
}

function rate(n, frames) {
  return frames > 0 ? n / frames : null;
}

function driveRates(stats) {
  const f = stats.frames ?? 0;
  return {
    eyeInsideRate: rate(stats.eyeInsideFrames, f),
    nearPlaneRate: rate(stats.nearPlaneFrames, f),
    occludedRate: rate(stats.occludedFrames, f),
    // Full-index eye→car cover (catches "car hidden behind the streetwall" frames the ~18-mesh
    // occluded counter can't see) — the first tuning round's discriminating metric.
    boresightRate: rate(stats.boresightBlockedFrames, f),
    clampedRate: rate(stats.clampedFrames, f),
  };
}

function relDiffOk(a, b, tolerance = 0.1) {
  if (a === null || b === null) return a === b;
  if (a === 0 && b === 0) return true;
  const denom = Math.max(Math.abs(a), Math.abs(b));
  if (denom === 0) return true;
  return Math.abs(a - b) / denom <= tolerance;
}

function waypointsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/** The reproducibility verdict: identical waypoint sequence (the drive path itself, deterministic
 * given (seed, start)) AND every clip rate within ±10% relative (wall-clock frame counts are NOT
 * compared — headless fps varies run to run; rates are the invariant a deterministic path + fixed-
 * step physics can actually pin — see phase-33-plan.md's reproducibility-bar decision). */
function diffDriveReports(r1, r2) {
  const waypointsMatch = waypointsEqual(r1.waypoints, r2.waypoints);
  const rates1 = driveRates(r1.stats);
  const rates2 = driveRates(r2.stats);
  const rateChecks = {};
  let ratesOk = true;
  for (const key of Object.keys(rates1)) {
    const ok = relDiffOk(rates1[key], rates2[key]);
    rateChecks[key] = { primary: rates1[key], repeat: rates2[key], ok };
    if (!ok) ratesOk = false;
  }
  return {
    ok: waypointsMatch && ratesOk,
    waypointsMatch,
    waypointCountPrimary: r1.waypoints?.length ?? null,
    waypointCountRepeat: r2.waypoints?.length ?? null,
    rateChecks,
  };
}

async function measureVantage(page, presetId, vantage, presetDir) {
  await applyPreset(page, presetId);
  await teleport(page, vantage.x, vantage.z);
  await page.waitForTimeout(SETTLE_MS);
  await page.evaluate(() => window.__smashy.resetCameraClipStats());
  await page.waitForTimeout(STATS_WINDOW_MS);
  const sample = await page.evaluate(() => ({
    stats: window.__smashy.cameraClipStats(),
    perf: window.__smashy.readPerf(),
  }));
  const screenshotRel = `${presetId}/vantage-${vantage.id}.png`;
  await page.screenshot({ path: path.join(presetDir, `vantage-${vantage.id}.png`) });
  const f = sample.stats.frames ?? 0;
  return {
    vantage: vantage.id,
    x: vantage.x,
    z: vantage.z,
    frames: f,
    eyeInsideRate: rate(sample.stats.eyeInsideFrames, f),
    nearPlaneRate: rate(sample.stats.nearPlaneFrames, f),
    occludedRate: rate(sample.stats.occludedFrames, f),
    boresightRate: rate(sample.stats.boresightBlockedFrames, f),
    occlusionHitSum: sample.stats.occlusionHitSum,
    occlusionHitMax: sample.stats.occlusionHitMax,
    clampedRate: rate(sample.stats.clampedFrames, f),
    perf: sample.perf,
    screenshot: screenshotRel,
  };
}

/** Runs one scripted drive (fresh-run cycle -> preset -> spawn -> startCameraLabDrive), taking a
 * screenshot roughly every `shotEvery` wall-clock seconds while it runs. Returns the merged
 * bridge report + this file's own metadata (label, driveDir, shot filenames). */
async function runOneDrive(page, presetId, vantages, args, presetDir, label) {
  await freshRunCycle(page);
  await applyPreset(page, presetId);
  const spawnVantage = vantages.find((v) => v.id === 'spawn') ?? vantages[0];
  await teleport(page, spawnVantage.x, spawnVantage.z);
  await page.waitForTimeout(SETTLE_MS);
  await page.evaluate(() => window.__smashy.resetCameraClipStats());

  const driveDir = path.join(presetDir, 'drive');
  mkdirSync(driveDir, { recursive: true });

  const seconds = args.drive;
  const stopAfterWaypoints = args.driveWaypoints;
  const seed = DRIVE_SEED;
  const drivePromise = page.evaluate(
    ({ s, sd, saw }) => window.__smashy.startCameraLabDrive({ seconds: s, seed: sd, stopAfterWaypoints: saw }),
    { s: seconds, sd: seed, saw: stopAfterWaypoints },
  );
  let resolved = false;
  drivePromise.then(
    () => {
      resolved = true;
    },
    () => {
      resolved = true;
    },
  );

  const shots = [];
  const shotEveryMs = args.shotEvery * 1000;
  const maxShots = Math.floor(seconds / args.shotEvery);
  for (let i = 1; i <= maxShots && !resolved; i++) {
    await sleep(shotEveryMs);
    if (resolved) break;
    const fileName = `${label}-t${i * args.shotEvery}.png`;
    try {
      await page.screenshot({ path: path.join(driveDir, fileName) });
      shots.push(fileName);
    } catch (err) {
      console.warn(`[camera-lab] screenshot t=${i * args.shotEvery}s (${presetId}/${label}) failed: ${err.message}`);
    }
  }

  // Safety timeout well beyond real-time in case SwiftShader runs the sim slower than the wall
  // clock (headless fps is unstable — see this file's header and bench-chaos.mjs's own note).
  const report = await withTimeout(
    drivePromise,
    Math.max(seconds * 1000 * 4, 30_000) + 30_000,
    `startCameraLabDrive(${presetId}/${label})`,
  );

  return {
    preset: presetId,
    label,
    driveDir: `${presetId}/drive`,
    shots,
    ...report,
  };
}

function summarizeDriveReport(report) {
  const rates = driveRates(report.stats ?? {});
  return {
    seconds: report.seconds,
    seed: report.seed,
    framesObserved: report.framesObserved ?? report.stats?.frames ?? null,
    heatAtEnd: report.heatAtEnd ?? null,
    tierAtEnd: report.tierAtEnd ?? null,
    waypointCount: Array.isArray(report.waypoints) ? report.waypoints.length : null,
    rates,
    driveDir: report.driveDir,
    shots: report.shots,
    stats: report.stats ?? null,
  };
}

function fmtRate(r) {
  return r === null || r === undefined ? '   n/a' : `${(r * 100).toFixed(1)}%`.padStart(6);
}

function printSummaryTable(summary) {
  console.log('\n[camera-lab] STILLS — eyeInsideRate by preset x vantage:');
  const presetIds = Object.keys(summary.presets);
  const vantageIds = summary.vantageIds;
  const header = ['vantage'.padEnd(18), ...presetIds.map((p) => p.padStart(8))].join(' | ');
  console.log(header);
  for (const vid of vantageIds) {
    const cells = presetIds.map((pid) => {
      const row = (summary.presets[pid].stills ?? []).find((r) => r.vantage === vid);
      return (row ? fmtRate(row.eyeInsideRate) : '    —').padStart(8);
    });
    console.log([vid.padEnd(18), ...cells].join(' | '));
  }

  if (summary.drivesSkippedReason) {
    console.log(`\n[camera-lab] DRIVES skipped: ${summary.drivesSkippedReason}`);
  } else {
    console.log('\n[camera-lab] DRIVES — eyeInsideRate / tierAtEnd / repeat verdict:');
    for (const pid of presetIds) {
      const d = summary.presets[pid].drive;
      if (!d) continue;
      const verdict = summary.presets[pid].repeatVerdict;
      const verdictStr = verdict ? (verdict.ok ? 'REPRO OK' : 'REPRO FAIL') : '(no repeat)';
      console.log(
        `  ${pid.padEnd(3)} eyeInside=${fmtRate(d.rates.eyeInsideRate)} tierAtEnd=${d.tierAtEnd ?? 'n/a'} ` +
          `waypoints=${d.waypointCount ?? 'n/a'} ${verdictStr}`,
      );
    }
  }

  console.log(
    `\n[camera-lab] console/page errors: ${summary.consoleErrorCount} — ${
      summary.consoleErrorCount === 0 ? 'OK' : 'FAIL'
    }`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.out);
  mkdirSync(outDir, { recursive: true });

  let devServer = null;
  const alreadyRunning = await isServerUp();
  if (!alreadyRunning) {
    console.log(`[camera-lab] no dev server at ${DEV_URL} — starting one (pnpm exec vite)…`);
    devServer = spawn('pnpm', ['exec', 'vite', '--port', '5173', '--strictPort'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    devServer.stdout.on('data', () => {});
    devServer.stderr.on('data', (chunk) => process.stderr.write(chunk));
    await waitForServer(SERVER_READY_TIMEOUT_MS);
    console.log('[camera-lab] dev server is up.');
  } else {
    console.log(`[camera-lab] reusing existing dev server at ${DEV_URL}.`);
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

    console.log(`[camera-lab] pinning persisted quality tier to "${BENCH_TIER}"…`);
    await page.addInitScript(
      ([key, tier]) => {
        try {
          window.localStorage.setItem(key, JSON.stringify({ quality: tier, muted: false, reducedShake: false }));
        } catch {
          // Private/incognito or storage disabled — the app degrades to auto-detect the same way.
        }
      },
      [SETTINGS_STORAGE_KEY, BENCH_TIER],
    );

    console.log('[camera-lab] loading the game…');
    await page.goto(DEV_URL, { waitUntil: 'load' });
    await page.locator('.game-canvas-container canvas').first().waitFor({
      state: 'visible',
      timeout: CANVAS_TIMEOUT_MS,
    });

    console.log('[camera-lab] waiting for the dev debug bridge (window.__smashy)…');
    await waitForBridgeFn(page, 'setCameraPreset');

    console.log('[camera-lab] reaching PLAYING…');
    await ensurePlaying(page);
    await waitForPlayerReady(page);
    await waitForClipIndexReady(page);

    const vantages = await page.evaluate(() => window.__smashy.cameraVantages());
    const vantageIds =
      args.vantages === 'all'
        ? vantages.map((v) => v.id)
        : args.vantages
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
    for (const vid of vantageIds) {
      if (!vantages.some((v) => v.id === vid)) {
        throw new Error(
          `camera-lab: unknown vantage id "${vid}" — known ids: ${vantages.map((v) => v.id).join(', ')}`,
        );
      }
    }

    const hasDrive = await page.evaluate(() => typeof window.__smashy?.startCameraLabDrive === 'function');
    if (!hasDrive) {
      console.warn(
        '[camera-lab] WARNING: window.__smashy.startCameraLabDrive is not present on the bridge ' +
          '(ai/cameraLabDrive.ts / Task 2 not landed yet, or a stale bundle) — skipping the DRIVES ' +
          'phase. STILLS still runs.',
      );
    }

    const summary = {
      generatedAt: new Date().toISOString(),
      args,
      vantageIds,
      hasDriveCapability: hasDrive,
      drivesSkippedReason: null,
      presets: {},
    };

    console.log(`[camera-lab] STILLS: ${args.presets.length} preset(s) x ${vantageIds.length} vantage(s)…`);
    for (const presetId of args.presets) {
      const presetDir = path.join(outDir, presetId);
      mkdirSync(presetDir, { recursive: true });
      const stillsRows = [];
      for (const vid of vantageIds) {
        const vantage = vantages.find((v) => v.id === vid);
        console.log(`[camera-lab]   ${presetId} @ ${vid}…`);
        const row = await measureVantage(page, presetId, vantage, presetDir);
        stillsRows.push(row);
      }
      writeFileSync(path.join(presetDir, 'stills.json'), JSON.stringify({ preset: presetId, vantages: stillsRows }, null, 2));
      summary.presets[presetId] = { stills: stillsRows };
    }

    let anyRepeatFailed = false;
    if (args.drive === 0) {
      summary.drivesSkippedReason = '--drive 0';
      console.log('[camera-lab] DRIVES skipped (--drive 0).');
    } else if (!hasDrive) {
      summary.drivesSkippedReason = 'window.__smashy.startCameraLabDrive not present on the bridge';
    } else {
      const drivePresetIds =
        args.drivePreset === 'all'
          ? args.presets
          : args.drivePreset
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
      console.log(`[camera-lab] DRIVES: ${drivePresetIds.length} preset(s), ${args.drive}s each, repeat=${args.repeat}…`);
      for (const presetId of drivePresetIds) {
        const presetDir = path.join(outDir, presetId);
        mkdirSync(presetDir, { recursive: true });
        console.log(`[camera-lab]   drive ${presetId} (primary)…`);
        const report1 = await runOneDrive(page, presetId, vantages, args, presetDir, 'primary');
        writeFileSync(path.join(presetDir, 'drive.json'), JSON.stringify(report1, null, 2));
        summary.presets[presetId] = summary.presets[presetId] ?? {};
        summary.presets[presetId].drive = summarizeDriveReport(report1);

        if (args.repeat >= 2) {
          console.log(`[camera-lab]   drive ${presetId} (repeat)…`);
          const report2 = await runOneDrive(page, presetId, vantages, args, presetDir, 'repeat');
          writeFileSync(path.join(presetDir, 'drive-repeat.json'), JSON.stringify(report2, null, 2));
          const verdict = diffDriveReports(report1, report2);
          summary.presets[presetId].repeatVerdict = verdict;
          if (!verdict.ok) {
            anyRepeatFailed = true;
            console.error(`[camera-lab] FAIL: reproducibility violated for preset ${presetId}:`, JSON.stringify(verdict, null, 2));
          }
        }
      }
    }

    summary.consoleErrorCount = consoleErrors.length + pageErrors.length;
    summary.consoleErrors = consoleErrors;
    summary.pageErrors = pageErrors;

    writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
    printSummaryTable(summary);

    if (consoleErrors.length > 0) {
      console.error(`[camera-lab] FAIL: ${consoleErrors.length} console error(s) during the run:`);
      for (const msg of consoleErrors) console.error(`  - ${msg}`);
    }
    if (pageErrors.length > 0) {
      console.error(`[camera-lab] FAIL: ${pageErrors.length} uncaught page error(s) during the run:`);
      for (const msg of pageErrors) console.error(`  - ${msg}`);
    }

    exitCode = consoleErrors.length === 0 && pageErrors.length === 0 && !anyRepeatFailed ? 0 : 1;
    console.log(`\n[camera-lab] evidence tree: ${outDir}`);
    console.log(exitCode === 0 ? '[camera-lab] OK' : '[camera-lab] FAIL');
  } catch (err) {
    console.error('[camera-lab] FAIL:', err instanceof Error ? err.stack : err);
    exitCode = 1;
  } finally {
    await browser.close();
    if (devServer) devServer.kill();
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error('[camera-lab] unexpected failure:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
