#!/usr/bin/env node
// Phase 33 Task 3 — the camera-lab VANTAGE BATTERY. Boots a real dev server (window.__smashy
// only exists in the DEV-gated chunk, same constraint bench-chaos.mjs documents at length — this
// mirrors that script's boot/probe/bridge-wait/error-collection pattern deliberately, so both
// tools behave the same way in this repo's devcontainer/CI), then judges the Phase 33 camera
// candidates (config/camera.ts's CAMERA_PRESETS 'A'..'E', applied live through
// window.__smashy.setCameraPreset) two ways:
//
//   STILLS  — teleport the player to each named vantage (window.__smashy.cameraVantages() — real
//             street points, never hardcoded) under every preset, settle, and read the Phase-33
//             clip counters (core/debugBridge.ts's cameraClipStats(): eye-inside-a-building /
//             near-plane-clip / occluder-on-boresight / clamp-fired frame rates) PLUS the Phase-76
//             readability block + a screenshot + a perf snapshot.
//   DRIVES  — one scripted downtown cruise per preset via window.__smashy.startCameraLabDrive
//             (ai/cameraLabDrive.ts), screenshotting periodically, with an optional same-seed
//             repeat run to prove the drive — and the camera's clip-rate response to it — is
//             reproducible (waypoint sequence IDENTICAL, per-frame rates within ±10% relative;
//             see this file's diffDriveReports()).
//   CHASE   — Phase 76: one ★3 pursuit drive per preset on dev/feelDrives.ts's EXISTING `chase3`
//             route (via window.__smashy.startFeelDrive — reused, never re-implemented: that route
//             already grants heat to ★3 and polls for a live roster before its window opens), so
//             the readability block's pursuer metrics are read with cops actually on the map. The
//             clip counters are reset the moment the tier is observed at ★3, so the measured
//             window is the CHASE, not the arming ramp that precedes it.
//
// --- the Phase 76 readability block ----------------------------------------------------------
// cameraClipStats().readability (world/toronto/cameraReadability.ts) answers "what does the frame
// SHOW", which every counter above is blind to: onScreenPursuerCount, pursuerWarningDistanceM,
// cityInFrameFraction, groundBandWu — each `number | null`, where null means THE DENOMINATOR WAS
// ZERO (no sighting, no player frame, no measurable band). This script renders null as `n/a` and
// never as 0; a 0 and an n/a are different findings and collapsing them would be the exact class
// of lie the measurement-discipline rules below exist to prevent. If the block is missing from the
// bridge entirely (a stale bundle / this task landing before the instrumentation), every
// readability cell degrades to `n/a` behind ONE loud warning and the run still exits 0 on its own
// merits — same fallback shape as the `hasDrive` capability check.
//
// --- why "settle" before every measurement -------------------------------------------------
// A teleport (window.__smashy.reset) does NOT reset the follow-camera rig: the rig lerps its way
// across the map toward the new position over multiple seconds, and mid-sweep the clip stats and
// perf numbers are garbage (measured live: ~179 draw calls / 840k tris mid-sweep vs. ~70/100k
// once settled — an order of magnitude off). Every measurement window in this file follows the
// same shape: teleport -> settle (--settle) -> resetCameraClipStats() -> wait (--stats-window)
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
//   node scripts/camera-lab.mjs [--presets all|A,B,C] [--vantages all|id,id,...] [--drive 60]
//     [--drive-waypoints 12] [--repeat 1] [--drive-preset all|A,B,...] [--shot-every 2]
//     [--seed 416] [--chase 0] [--slice=i/n] [--stats-window 4000] [--settle 3500]
//     [--out .planning/screenshots/phase-33-lab]
//
// Every flag accepts BOTH `--key value` and `--key=value` (the second form is what
// flicker-sweep.mjs / feel-lab.mjs use, and `--slice=i/n` is quoted that way everywhere in the
// planning docs — supporting both keeps this script's own historical invocations working).
//
// --- --slice=i/n (P42's process rule) ---------------------------------------------------------
// Long batteries die mid-run and take their evidence with them (P36/P38/P42/P43/P45 all did), so
// the STILLS work list is sliceable. The list is the flat, PRESET-MAJOR sequence of
// (preset × vantage) cells — `E@spawn, E@financial-canyon, …, F@spawn, …` — in the order the
// `--presets` and `--vantages` arguments give, and `--slice=i/n` takes the contiguous block
// `[floor((i-1)·L/n), floor(i·L/n))` of it. Parsing and block arithmetic are copied VERBATIM from
// flicker-sweep.mjs (:465-473, :1191-1196) via feel-lab.mjs, so this repo has ONE slicing
// convention, not three. Slices 1/n…n/n therefore cover exactly the unsliced set with no cell
// dropped or duplicated (unit-checkable from the recorded ids: every file carries both
// `stillCellIds` — the full list it was carved from — and `sliceStillCellIds` — what THIS
// invocation actually ran).
// Each slice writes its OWN result files — `summary.slice-<i>-of-<n>.json` at the tree root and
// `<preset>/stills.slice-<i>-of-<n>.json` — so a dead slice loses only itself and never truncates
// a sibling's evidence. Unsliced runs keep the historical `summary.json` / `<preset>/stills.json`
// names byte-for-byte. camera-lab-sheet.mjs reads every `summary*.json` in the tree and merges
// them, so a sliced battery still produces ONE contact sheet.
// `--slice` slices STILLS ONLY. DRIVES and CHASE are per-preset units already governed by
// `--drive` / `--drive-preset` / `--chase`; running them in every still slice would multiply them
// n times, so pass `--drive 0 --chase 0` on the still slices and run the drive/chase passes in
// their own invocations (the script says exactly this, loudly, whenever both are requested).
//
// `--seed N` (default 416, the project's standing "known-tricky" seed) fixes the waypoint stream
// for BOTH the scripted lab drive and the `chase3` route, and is recorded in every report.
//
// `--chase S` (default 0 = skip) runs the ★3 CHASE phase for S seconds per preset. It shares
// `--drive-preset` as its preset filter (both phases are "one scripted run per preset"), so
// `--drive 0 --chase 45 --drive-preset E,H` chases on E and H only and drives on neither.
//
// `--stats-window MS` (default 4000, raised from Phase 33's 1500) and `--settle MS` (default 3500)
// are the two waits every measurement window is built from — see the settle note above and
// DEFAULT_STATS_WINDOW_MS. They are flags rather than constants because the right value is a
// property of the machine: this devcontainer's SwiftShader needs the defaults, a real GPU can
// shorten them, and a slower host MUST lengthen them or every cell is sampled mid-sweep. Both are
// recorded in each summary's `args`, so a rate is never silently compared against one measured over
// a different window.
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
import { metricSpec, metricValues } from './lib/cameraLabMetrics.mjs';

const DEV_URL = 'http://localhost:5173';
const SETTINGS_STORAGE_KEY = 'smashy6ix:settings';
const BENCH_TIER = 'high'; // pin a consistent quality tier for comparable perf/tri numbers across presets

/**
 * `--presets all` (the DEFAULT) discovers the live preset ids instead of naming them.
 *
 * WHY, and it is not a convenience: the previous default was the literal list ['A'..'E'], so the
 * day config/camera.ts gained candidate rigs the battery would have kept measuring the old five and
 * SAID NOTHING — a silent omission is indistinguishable from a preset that measured clean. The
 * bridge exposes `setCameraPreset`/`getCameraPreset` but no LIST, and `setCameraPreset(id)` returns
 * false and does nothing for an unknown id, so probing A..Z is the only way to ask the running game
 * what rigs it actually has. An explicit `--presets F,H` still works and still throws on a typo.
 */
const PRESET_PROBE_IDS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
/** Default waypoint/route seed. The project's standing "known-tricky" seed (see CLAUDE.md phase
 * notes); overridable per invocation with `--seed` since Phase 76, and recorded in every report so
 * a number can never be compared against a differently-seeded one by accident. */
const DEFAULT_DRIVE_SEED = 416;
/** Phase 76 CHASE phase: dev/feelDrives.ts's existing ★3 route. Named here, resolved (and its
 * `requireTier` read) off the bridge's `feelRoutes()` at run time — never a hardcoded tier. */
const CHASE_ROUTE_ID = 'chase3';

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

const CHASE_TIER_POLL_MS = 200;
/** How long to wait for the chase route to actually reach its required tier before opening the
 * measured window. dev/feelDrives.ts's own TIER_ARM_TIMEOUT_MS is 8 s and it arms AFTER a teleport
 * + settle + steady-frame warm-up, so this is that budget with generous headroom for a slow
 * SwiftShader boot. On expiry the window is opened anyway and `tierObserved:false` is recorded —
 * an unarmed chase is a finding, not something to silently drop. */
const CHASE_TIER_ARM_TIMEOUT_MS = 30_000;

const DEFAULT_SETTLE_MS = 3_500; // rig-sweep settle after any teleport (measured; see file header)
/**
 * Clip-stat accumulation window after resetCameraClipStats().
 *
 * PHASE 76 RAISED THIS 1,500 → 4,000 ms, and the reason is a measurement-validity one, not a
 * taste: under SwiftShader the 1.5 s window yielded only 7-36 frames per still cell (rig E's
 * `financial-canyon` sampled NINE), and this phase's headline evidence is a set of 0 % readings.
 * A 0 % over 7 frames is not evidence of anything — one unlucky frame is 14 pp. Every still row
 * and the summary table therefore also REPORT their frame count, so a reader can weigh each cell's
 * rate against its own sample size instead of trusting a percentage with no denominator.
 */
const DEFAULT_STATS_WINDOW_MS = 4_000;

/**
 * THE MEASUREMENT-VALIDITY FACTS this battery cannot express as a number.
 *
 * Written into every summary (and merged + rendered by camera-lab-sheet.mjs) so they travel WITH
 * the evidence instead of living in a plan file the person reading the contact sheet does not have
 * open. Both of the standing two change how the very first table must be read, which is why they
 * are data here rather than a paragraph somewhere.
 */
const MEASUREMENT_NOTES = [
  "LOOK-AHEAD DOES NOTHING AT REST. fx/cameraRig.ts's computeLookTarget collapses the lead below " +
    'SPEED_EPSILON, so a candidate that differs from the control ONLY in lookAhead (Phase 76\'s "K") ' +
    'produces STILLS identical to the control BY CONSTRUCTION. That is the expected result, not a ' +
    'null finding — judge look-ahead on the DRIVE and CHASE rows only.',
  'CROSS-PHASE DRIVE NUMBERS ARE NOT COMPARABLE. Phase 75 re-derived LANE_OFFSET_WU, so the drive ' +
    "route's waypoint POSITIONS moved (spine ~3.85 wu laterally) even though the graph topology did " +
    'not. Only within-run, candidate-to-candidate comparison is honest; Phase 33\'s drive rates are ' +
    'not a baseline for these.',
  'VANTAGE POSES ARE SELF-DESCRIBING, AND NOT ALIKE. Each still row carries the pose ' +
    'world/toronto/cameraVantages.ts derived for it (junction vs mid-block, road class, signed lane ' +
    'offset, on-median). All seven Phase 33 anchors are street-CENTRELINE junctions — after Phase 75 ' +
    'that is ~22 x 17.6 wu of open asphalt, most of the frame; the three Phase 76 anchors are ' +
    'camera-side LANE points mid-block. "fold-corridor" sits on the Phase 75 planted median: ' +
    'visual-only, so the pose is legal, but the grass strip is in every one of its frames.',
  'A RATE IS ONLY AS STRONG AS ITS DENOMINATOR. Every still cell prints the frame count it was ' +
    'measured over. Under SwiftShader a short window yields very few frames, and a 0% over 7 frames ' +
    'is not evidence — one unlucky frame is 14 pp.',
];

function parseArgs(argv) {
  const out = {
    presets: 'all',
    vantages: 'all',
    drive: 60,
    driveWaypoints: 12,
    repeat: 1,
    drivePreset: 'all',
    out: '.planning/screenshots/phase-33-lab',
    shotEvery: 2,
    seed: DEFAULT_DRIVE_SEED,
    chase: 0,
    slice: null,
    // Both waits are FLAGS, not constants, because the right value is a property of the machine the
    // battery runs on: the defaults are sized for this devcontainer's SwiftShader, and a faster GPU
    // can shorten them (more cells per hour) while a slower one MUST lengthen them or every cell is
    // measured mid-sweep. Recorded in `args` on every summary so a number can never be compared
    // against one taken over a different window by accident.
    statsWindowMs: DEFAULT_STATS_WINDOW_MS,
    settleMs: DEFAULT_SETTLE_MS,
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    // Both spellings are accepted: `--key value` (this script's historical form) and `--key=value`
    // (flicker-sweep.mjs / feel-lab.mjs's form, and how `--slice=i/n` is written everywhere in the
    // planning docs). An inline value wins; otherwise the next argv entry is consumed.
    const eq = raw.indexOf('=');
    const a = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? null : raw.slice(eq + 1);
    const next = () => (inline === null ? argv[++i] : inline);
    switch (a) {
      // pnpm >= 9 forwards the argument separator VERBATIM, so a bare `--` must be ignored rather
      // than treated as an unknown flag (same accommodation flicker-sweep.mjs makes).
      case '--':
        break;
      case '--presets': {
        // 'all' (the default) is resolved against the LIVE preset table once the bridge is up; an
        // explicit list is taken verbatim and still fails loudly on an unknown id (applyPreset).
        const v = next().trim();
        out.presets = v === 'all' ? 'all' : v.split(',').map((t) => t.trim()).filter(Boolean);
        break;
      }
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
      case '--seed':
        out.seed = Number(next());
        break;
      case '--chase':
        out.chase = Number(next());
        break;
      case '--slice': {
        // Verbatim from flicker-sweep.mjs:465-473 (via feel-lab.mjs:189-198) — one slicing
        // convention in this repo, not three.
        const m = /^(\d+)\/(\d+)$/.exec(String(next()).trim());
        const i2 = m ? Number.parseInt(m[1], 10) : NaN;
        const n2 = m ? Number.parseInt(m[2], 10) : NaN;
        if (!m || i2 < 1 || n2 < 1 || i2 > n2) {
          console.error('[camera-lab] --slice must be i/n with 1 <= i <= n');
          process.exit(1);
        }
        out.slice = { i: i2, n: n2 };
        break;
      }
      case '--stats-window':
        out.statsWindowMs = Number(next());
        break;
      case '--settle':
        out.settleMs = Number(next());
        break;
      default:
        console.error(`[camera-lab] unknown arg: ${raw}`);
        process.exit(1);
    }
  }
  if (!Number.isFinite(out.seed)) {
    console.error(`[camera-lab] --seed must be a finite number, got "${out.seed}"`);
    process.exit(1);
  }
  if (!Number.isFinite(out.chase) || out.chase < 0) {
    console.error(`[camera-lab] --chase must be a non-negative number of seconds (0 = skip), got "${out.chase}"`);
    process.exit(1);
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
  if (!Number.isFinite(out.statsWindowMs) || out.statsWindowMs <= 0) {
    console.error(`[camera-lab] --stats-window must be > 0 ms, got "${out.statsWindowMs}"`);
    process.exit(1);
  }
  if (!Number.isFinite(out.settleMs) || out.settleMs <= 0) {
    console.error(`[camera-lab] --settle must be > 0 ms, got "${out.settleMs}"`);
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

/**
 * Ask the RUNNING GAME which camera presets exist, by probing `setCameraPreset` over A..Z.
 *
 * The bridge has no preset-list entry point, and hardcoding one here is the failure mode this
 * replaces (see PRESET_PROBE_IDS): a candidate rig added to config/camera.ts would never be
 * measured and nothing would say so. `setCameraPreset(unknown)` returns false and changes nothing,
 * so the probe's only side effect is the preset it leaves applied — restored before returning.
 * Throws if NOTHING is accepted: an empty preset table means the battery has nothing to compare and
 * a run of zero rows is worse than an error.
 */
async function discoverPresets(page) {
  const original = await page.evaluate(() => window.__smashy.getCameraPreset());
  const found = [];
  for (const id of PRESET_PROBE_IDS) {
    if (await page.evaluate((pid) => window.__smashy.setCameraPreset(pid), id)) found.push(id);
  }
  if (original) await page.evaluate((pid) => window.__smashy.setCameraPreset(pid), original);
  if (found.length === 0) {
    throw new Error(
      'camera-lab: setCameraPreset() accepted no id in A..Z — config/camera.ts\'s CAMERA_PRESETS is ' +
        'empty or has been re-keyed. Refusing to run a battery with no candidates.',
    );
  }
  return found;
}

/**
 * Phase 76 — the readability block, normalised for reporting.
 *
 * Returns `null` when the bridge has no `readability` at all (stale bundle / instrumentation not
 * landed) so callers can tell "not instrumented" from "instrumented and empty". Within the block,
 * the four derived fields are passed through EXACTLY as the bridge computes them: `number | null`,
 * where null means the denominator was 0. They are never coerced to 0 anywhere in this file —
 * `fmtRate`/`fmtVal` render null as `n/a`, because "no pursuer ever entered the frame" and "a
 * pursuer entered the frame at 0 m" are different findings.
 *
 * The raw counters ride along as the sanity denominators: `frames` (readability frames — ≤ the
 * clip `frames`, since the pass needs a player vehicle), `sightings` (the warning-distance
 * denominator), `cityBoxesTested` (0 ⇒ the clip index was empty, so a 0 % coverage read is an
 * unmounted world, not a clean one) and `onScreenPursuerMax`.
 */
function readabilityOf(stats) {
  const r = stats?.readability;
  if (!r || typeof r !== 'object') return null;
  return {
    frames: r.frames ?? 0,
    onScreenPursuerCount: r.onScreenPursuerCount ?? null,
    onScreenPursuerMax: r.onScreenPursuerMax ?? 0,
    pursuerWarningDistanceM: r.pursuerWarningDistanceM ?? null,
    sightings: r.sightings ?? 0,
    cityInFrameFraction: r.cityInFrameFraction ?? null,
    cityBoxesTested: r.cityBoxesTested ?? 0,
    // Mean indexed volumes INSIDE the frustum per frame. Not a headline — the interpretation key
    // for the one above it: `cityInFrameFraction` is an upper bound (the union of each box's NDC
    // bounding RECT, per cameraReadability.ts's own accumulateBoxCoverage doc), so a saturated
    // 100% off a handful of boxes means the bound is loose at that pose, not that the frame is
    // full of city. Reported so nobody has to re-derive that from the source to read a cell.
    cityBoxesInFrame: (r.frames ?? 0) > 0 ? (r.cityBoxesInFrameSum ?? 0) / r.frames : null,
    groundBandWu: r.groundBandWu ?? null,
  };
}

/**
 * The STILLS work list: the flat, PRESET-MAJOR (preset × vantage) cell sequence, in exactly the
 * order `--presets` and `--vantages` gave. Stable and pure — the same arguments always produce the
 * same list, which is what makes a sliced run's coverage checkable after the fact.
 */
function buildStillCells(presetIds, vantageIds) {
  const cells = [];
  for (const preset of presetIds) {
    for (const vantage of vantageIds) cells.push({ id: `${preset}@${vantage}`, preset, vantage });
  }
  return cells;
}

/** Contiguous block arithmetic, verbatim from flicker-sweep.mjs:1191-1196. */
function sliceOf(list, slice) {
  const { i, n } = slice;
  const start = Math.floor(((i - 1) * list.length) / n);
  const end = Math.floor((i * list.length) / n);
  return { items: list.slice(start, end), block: { i, n, start, end } };
}

/** `summary.json` unsliced; `summary.slice-2-of-4.json` when sliced — a dead slice can then only
 * lose its own file, and camera-lab-sheet.mjs merges whatever is on disk. */
function sliceSuffix(slice) {
  return slice ? `.slice-${slice.i}-of-${slice.n}` : '';
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

// ─── THE GENERIC READOUT (Phase 76) ───────────────────────────────────────────────────────────
//
// `driveRates` and `readabilityOf` above NAME their fields, which means a counter added to
// world/toronto/cameraClipStats.ts stays invisible here until somebody edits this file — and a
// silently-dropped counter is indistinguishable from one that read zero. scripts/lib/
// cameraLabMetrics.mjs is the name-AGNOSTIC half: it walks whatever object cameraClipStats()
// returns and derives a reported metric from EVERY numeric leaf by suffix (frames → raw,
// `*Frames` → a rate, `*Sum[Unit]` → a mean over its own denominator, everything else → raw), so
// a counter that follows the convention needs ZERO edits here or in camera-lab-sheet.mjs.
//
// It lives in scripts/lib rather than inline BECAUSE it is the decoupling contract, and a contract
// that is only exercised by a 20-minute browser battery is a contract nobody checks:
// src/game/world/toronto/cameraLabMetrics.test.ts drives it against the real, live
// `CameraClipStats` type. The full convention (and why null is never 0) is documented there.
//
// The named helpers stay: the console tables, the reproducibility bar and the on-disk field names
// of every prior evidence tree are written in them. This adds `metrics` alongside.


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
 * step physics can actually pin — see phase-33-plan.md's reproducibility-bar decision).
 *
 * PHASE 76: the readability block is deliberately NOT part of this bar. It is a property of what
 * live traffic and live pursuit happened to be doing in frame — the same wedge-lottery band the
 * plan's discipline list flags for `boresightRate` — so folding it in would manufacture REPRO FAIL
 * verdicts out of the world's own variance. It is reported per run instead, and compared as a
 * band across ≥3 runs, exactly as the plan prescribes. */
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
  // Every OTHER metric the generic readout produced, reported side by side WITHOUT a verdict.
  // Two reasons, and neither is laziness: a `raw` metric is a discrete extreme or an unnormalised
  // count that ±10 % says nothing about, and the readability means are a property of what live
  // traffic and pursuit happened to be doing in frame (the same wedge-lottery band the plan flags
  // for `boresightRate`) — holding either to the bar would manufacture REPRO FAILs out of the
  // world's own variance. Reporting them anyway is what stops "not in the verdict" becoming "not
  // on the page".
  const v1 = metricValues(r1.stats ?? {});
  const v2 = metricValues(r2.stats ?? {});
  const informationalMetrics = {};
  for (const { key, kind } of metricSpec(r1.stats ?? {})) {
    if (key in rateChecks) continue;
    informationalMetrics[key] = { kind, primary: v1[key] ?? null, repeat: v2[key] ?? null };
  }
  return {
    ok: waypointsMatch && ratesOk,
    waypointsMatch,
    waypointCountPrimary: r1.waypoints?.length ?? null,
    waypointCountRepeat: r2.waypoints?.length ?? null,
    rateChecks,
    informationalMetrics,
  };
}

async function measureVantage(page, presetId, vantage, presetDir, args) {
  await applyPreset(page, presetId);
  await teleport(page, vantage.x, vantage.z);
  await page.waitForTimeout(args.settleMs);
  await page.evaluate(() => window.__smashy.resetCameraClipStats());
  await page.waitForTimeout(args.statsWindowMs);
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
    // Pose metadata cameraVantages() derives from the street table (street/class/junction-or-
    // midblock/lane offset/on-median). Carried through so a cell's numbers can be read against the
    // kind of place they were measured at — a junction and a mid-block pose answer different
    // questions about "is there any city in frame". Absent on an older bridge ⇒ null, not invented.
    streetId: vantage.streetId ?? null,
    // Every ribbon under the point, not just the widest: two of DIFFERENT axes is a junction, two of
    // the SAME axis is a Phase 75 swallowed carriageway (Bay over York), and both are worth seeing
    // next to a framing that looks emptier than it should.
    streetIds: vantage.streetIds ?? null,
    cls: vantage.cls ?? null,
    kind: vantage.kind ?? null,
    // Signed lateral offset from that street's centreline, POSITIVE toward the camera side — the
    // corridorLaw `worstLane` reference. 0 is a centreline pose (all seven Phase 33 anchors).
    laneOffsetWu: vantage.laneOffsetWu ?? null,
    onMedian: vantage.onMedian ?? null,
    // The sample size behind every rate on this row (see DEFAULT_STATS_WINDOW_MS's note). Never
    // omit it:
    // a 0 % is only as strong as its denominator.
    frames: f,
    readability: readabilityOf(sample.stats),
    // The name-agnostic readout of the SAME sample (see THE GENERIC READOUT above): every numeric
    // field the bridge returned, as a rate/mean/raw by suffix. The named fields below stay for the
    // console tables and for continuity with prior evidence trees; this is what carries a counter
    // nobody here has heard of.
    metrics: metricValues(sample.stats),
    // The raw counter snapshot this row was derived from. Kept so a later analysis can re-derive a
    // metric the convention did not anticipate without re-running the battery.
    stats: sample.stats,
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
  await page.waitForTimeout(args.settleMs);
  await page.evaluate(() => window.__smashy.resetCameraClipStats());

  const driveDir = path.join(presetDir, 'drive');
  mkdirSync(driveDir, { recursive: true });

  const seconds = args.drive;
  const stopAfterWaypoints = args.driveWaypoints;
  const seed = args.seed;
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
    // A wanted tier ADDS FOLLOW DISTANCE (CAMERA.tierZoom / tierPitchDeg), so a plain lab drive
    // that ended above ★0 was shot from a different rig than the one under test — the plan's
    // discipline list calls that an invalid preset comparison. Recorded and warned about rather
    // than failed: the numbers are still an honest measurement of what happened, and whether to
    // re-run is a reader's call. NOTE THE ASYMMETRY WITH `summarizeChaseRun`, which deliberately
    // has no such flag: a non-zero tier is the entire point of the chase mode, and flagging it
    // there would be flagging that mode for working.
    tierContaminated: (report.tierAtEnd ?? 0) > 0,
    waypointCount: Array.isArray(report.waypoints) ? report.waypoints.length : null,
    rates,
    readability: readabilityOf(report.stats),
    metrics: metricValues(report.stats ?? {}),
    driveDir: report.driveDir,
    shots: report.shots,
    stats: report.stats ?? null,
  };
}

/**
 * PHASE 76 CHASE — one ★3 pursuit run per preset, for the readability block's PURSUER metrics
 * (`onScreenPursuerCount` / `pursuerWarningDistanceM` are structurally n/a on every still and on
 * the plain lab drive: there are no cops in either).
 *
 * The chase itself is dev/feelDrives.ts's EXISTING `chase3` route, driven through
 * window.__smashy.startFeelDrive exactly as scripts/feel-lab.mjs drives it. Nothing about the
 * pursuit is re-implemented here: that route already teleports to the downtown anchor, grants heat,
 * polls until the required tier AND a live roster exist, and reports `tierArmed` / `tierAtStart` /
 * `maxPursuitUnits` so an unarmed run can never read as a chase.
 *
 * Discipline this function preserves:
 *  - `freshRunCycle` first (heat is monotonic per run — an earlier chase's stars would carry) and
 *    `waitForClipIndexReady` inside it, because that cycle REMOUNTS the world.
 *  - the preset is applied AFTER the remount, like runOneDrive, so the FOV push lands on the live
 *    camera the new mount created.
 *  - the clip counters are reset the moment the tier is OBSERVED at the route's required level, so
 *    the measured window is the chase and not the arming ramp (which would dilute every pursuer
 *    mean with seconds of empty street). Whether that observation actually happened is recorded as
 *    `tierObserved`, never assumed.
 */
async function runOneChase(page, presetId, args, presetDir, requiredTier) {
  await freshRunCycle(page);
  await applyPreset(page, presetId);

  const chaseDir = path.join(presetDir, 'chase');
  mkdirSync(chaseDir, { recursive: true });

  const seconds = args.chase;
  const promise = page.evaluate(
    ({ route, s, sd }) => window.__smashy.startFeelDrive({ route, seconds: s, seed: sd }),
    { route: CHASE_ROUTE_ID, s: seconds, sd: args.seed },
  );
  let resolved = false;
  promise.then(
    () => {
      resolved = true;
    },
    () => {
      resolved = true;
    },
  );

  // Open the measured window at ★<requiredTier>. Polling the store (readHud) rather than trusting
  // a fixed delay: the arm takes as long as the spawn director takes.
  const armStart = Date.now();
  let tierObserved = false;
  let tierAtWindowOpen = null;
  while (!resolved && Date.now() - armStart < CHASE_TIER_ARM_TIMEOUT_MS) {
    const hud = await page.evaluate(() => window.__smashy.readHud());
    if (hud.tier >= requiredTier) {
      tierObserved = true;
      tierAtWindowOpen = hud.tier;
      break;
    }
    await page.waitForTimeout(CHASE_TIER_POLL_MS);
  }
  if (!tierObserved && !resolved) {
    console.warn(
      `[camera-lab] WARNING: chase (${presetId}) never reached ★${requiredTier} within ` +
        `${CHASE_TIER_ARM_TIMEOUT_MS}ms — opening the window anyway and recording tierObserved=false. ` +
        'Its pursuer numbers describe an UNARMED run; read the report\'s tierArmed before using them.',
    );
  }
  const armWaitMs = Date.now() - armStart;
  await page.evaluate(() => window.__smashy.resetCameraClipStats());

  const shots = [];
  const shotEveryMs = args.shotEvery * 1000;
  const maxShots = Math.floor(seconds / args.shotEvery);
  for (let i = 1; i <= maxShots && !resolved; i++) {
    await sleep(shotEveryMs);
    if (resolved) break;
    const fileName = `chase-t${i * args.shotEvery}.png`;
    try {
      await page.screenshot({ path: path.join(chaseDir, fileName) });
      shots.push(fileName);
    } catch (err) {
      console.warn(`[camera-lab] chase screenshot t=${i * args.shotEvery}s (${presetId}) failed: ${err.message}`);
    }
  }

  const report = await withTimeout(
    promise,
    Math.max(seconds * 1000 * 4, 30_000) + 60_000,
    `startFeelDrive(${CHASE_ROUTE_ID}/${presetId})`,
  );
  // Read the counters IMMEDIATELY after the drive resolves — the world keeps running, and every
  // frame after this point is post-window.
  const stats = await page.evaluate(() => window.__smashy.cameraClipStats());
  try {
    await page.screenshot({ path: path.join(chaseDir, 'chase-final.png') });
    shots.push('chase-final.png');
  } catch (err) {
    console.warn(`[camera-lab] chase final screenshot (${presetId}) failed: ${err.message}`);
  }

  return {
    preset: presetId,
    route: CHASE_ROUTE_ID,
    requiredTier,
    tierObserved,
    tierAtWindowOpen,
    armWaitMs,
    chaseDir: `${presetId}/chase`,
    shots,
    stats,
    report,
  };
}

function summarizeChaseRun(run) {
  const f = run.stats?.frames ?? 0;
  return {
    route: run.route,
    seconds: run.report?.seconds ?? null,
    elapsedSec: run.report?.elapsedSec ?? null,
    seed: run.report?.seed ?? null,
    requiredTier: run.requiredTier,
    tierObserved: run.tierObserved,
    tierArmed: run.report?.tierArmed ?? null,
    tierAtStart: run.report?.tierAtStart ?? null,
    tierAtEnd: run.report?.tierAtEnd ?? null,
    pursuitUnitsAtStart: run.report?.pursuitUnitsAtStart ?? null,
    maxPursuitUnits: run.report?.maxPursuitUnits ?? null,
    armWaitMs: run.armWaitMs,
    frames: f,
    rates: driveRates(run.stats ?? {}),
    readability: readabilityOf(run.stats),
    metrics: metricValues(run.stats ?? {}),
    chaseDir: run.chaseDir,
    shots: run.shots,
    stats: run.stats ?? null,
  };
}

function fmtRate(r) {
  return r === null || r === undefined ? '   n/a' : `${(r * 100).toFixed(1)}%`.padStart(6);
}

/** A plain number, or `n/a` for null/undefined — NEVER 0. (A null readability field means its
 * denominator was empty; printing 0 would invent a measurement.) */
function fmtVal(n, digits = 1) {
  return n === null || n === undefined || !Number.isFinite(n) ? 'n/a' : n.toFixed(digits);
}

/** A value with a unit, or a bare `n/a` — the unit is dropped with the number so a null never
 * renders as the nonsense "n/am". */
function fmtUnit(n, unit, digits = 1) {
  return n === null || n === undefined || !Number.isFinite(n) ? 'n/a' : `${n.toFixed(digits)}${unit}`;
}

/** One-line readability digest, for the drive/chase blocks. */
function fmtReadability(r) {
  if (!r) return 'readability: NOT INSTRUMENTED';
  return (
    `pursuers=${fmtVal(r.onScreenPursuerCount, 2)} (max ${r.onScreenPursuerMax}) ` +
    `warnDist=${fmtUnit(r.pursuerWarningDistanceM, 'm')} (${r.sightings} sightings) ` +
    `city=${fmtRate(r.cityInFrameFraction).trim()} ` +
    `(${fmtVal(r.cityBoxesInFrame, 1)} of ${r.cityBoxesTested} boxes in frustum) ` +
    `band=${fmtUnit(r.groundBandWu, 'wu')}  rFrames=${r.frames}`
  );
}

/** Renders one preset × vantage grid; `cellFn(row)` formats a still row (or gets `null`). */
function printCellTable(title, summary, presetIds, vantageIds, cellFn, width = 12) {
  console.log(`\n[camera-lab] ${title}`);
  console.log(['vantage'.padEnd(18), ...presetIds.map((p) => p.padStart(width))].join(' | '));
  for (const vid of vantageIds) {
    const cells = presetIds.map((pid) => {
      const row = (summary.presets[pid]?.stills ?? []).find((r) => r.vantage === vid);
      return String(row ? cellFn(row) : '—').padStart(width);
    });
    console.log([vid.padEnd(18), ...cells].join(' | '));
  }
}

function printSummaryTable(summary) {
  const presetIds = Object.keys(summary.presets);
  const vantageIds = summary.vantageIds;

  if (summary.slice) {
    console.log(
      `\n[camera-lab] SLICE ${summary.slice.i}/${summary.slice.n} — ran ${summary.sliceStillCellIds.length}` +
        `/${summary.stillCellIds.length} still cell(s): ${summary.sliceStillCellIds.join(', ')}`,
    );
  }

  // Rate + its own denominator in the same cell: a 0.0% over 9 frames and a 0.0% over 60 are not
  // the same evidence, and this phase's headline is a set of 0.0%s (see DEFAULT_STATS_WINDOW_MS).
  printCellTable(
    'STILLS — eyeInsideRate (frames sampled) by preset x vantage:',
    summary,
    presetIds,
    vantageIds,
    (row) => `${fmtRate(row.eyeInsideRate).trim()} (${row.frames})`,
  );

  if (summary.hasReadabilityCapability === false) {
    console.log('\n[camera-lab] READABILITY — not instrumented on this bridge; every cell is n/a.');
  } else {
    printCellTable(
      'STILLS — cityInFrameFraction (fraction of frame covered by indexed BUILDING volume;\n' +
        '              trees, traffic lights, medians and parked cars are NOT counted):',
      summary,
      presetIds,
      vantageIds,
      (row) => (row.readability ? fmtRate(row.readability.cityInFrameFraction).trim() : 'n/a'),
      10,
    );
    printCellTable(
      'STILLS — groundBandWu (visible ground band depth, wu):',
      summary,
      presetIds,
      vantageIds,
      (row) => (row.readability ? fmtVal(row.readability.groundBandWu) : 'n/a'),
      10,
    );
    console.log(
      '\n[camera-lab] STILLS — readability digest per preset (pursuer fields are structurally n/a\n' +
        '              on stills: nothing is chasing a parked car — see the CHASE phase for those):',
    );
    for (const pid of presetIds) {
      for (const row of summary.presets[pid]?.stills ?? []) {
        console.log(`  ${pid.padEnd(3)} ${row.vantage.padEnd(18)} ${fmtReadability(row.readability)}`);
      }
    }
  }

  // THE GENERIC READOUT, on the console. The named tables above are the curated view; this is the
  // complete one — every key the live counter shape produced, meaned over the still cells this
  // invocation measured. It is deliberately dense and deliberately unfiltered: a counter that a
  // future task adds shows up here on its first run with no edit to this file, which is the whole
  // point (a metric nobody printed is a metric nobody checked). `metricSpec` fixes the column
  // order, so two runs list their metrics identically.
  if (summary.metricSpec && summary.metricSpec.length > 0) {
    console.log(
      `\n[camera-lab] STILLS — ALL ${summary.metricSpec.length} metric(s), meaned over this ` +
        "invocation's cells (kind in brackets; null-valued cells are excluded from the mean, so a " +
        'metric that was n/a everywhere prints n/a):',
    );
    for (const pid of presetIds) {
      const stills = summary.presets[pid]?.stills ?? [];
      if (stills.length === 0) continue;
      const parts = summary.metricSpec.map(({ key, kind }) => {
        const vals = stills.map((r) => r.metrics?.[key]).filter((v) => typeof v === 'number');
        const mean = vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0) / vals.length;
        return `${key}[${kind[0]}]=${fmtVal(mean, kind === 'raw' ? 1 : 4)}`;
      });
      console.log(`  ${pid.padEnd(3)} ${parts.join('  ')}`);
    }
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
        `  ${pid.padEnd(3)} eyeInside=${fmtRate(d.rates.eyeInsideRate)} tierAtEnd=${d.tierAtEnd ?? 'n/a'}` +
          `${d.tierContaminated ? ' [TIER-CONTAMINATED]' : ''} ` +
          `waypoints=${d.waypointCount ?? 'n/a'} frames=${d.framesObserved ?? 'n/a'} ${verdictStr}`,
      );
      console.log(`      ${fmtReadability(d.readability)}`);
    }
  }

  if (summary.chaseSkippedReason) {
    console.log(`\n[camera-lab] CHASE skipped: ${summary.chaseSkippedReason}`);
  } else {
    console.log(`\n[camera-lab] CHASE (${CHASE_ROUTE_ID}) — pursuer visibility per preset:`);
    for (const pid of presetIds) {
      const c = summary.presets[pid].chase;
      if (!c) continue;
      const armStr = c.tierArmed === false || c.tierObserved === false ? ' *** NOT ARMED ***' : '';
      console.log(
        `  ${pid.padEnd(3)} ★${c.tierAtStart ?? '?'}→★${c.tierAtEnd ?? '?'} (required ★${c.requiredTier})` +
          ` units ${c.pursuitUnitsAtStart ?? '?'}→max ${c.maxPursuitUnits ?? '?'}` +
          ` frames=${c.frames} eyeInside=${fmtRate(c.rates.eyeInsideRate)}${armStr}`,
      );
      console.log(`      ${fmtReadability(c.readability)}`);
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

    // Phase 76 capability probes — each degrades LOUDLY but gracefully, exactly like hasDrive.
    const probeStats = await page.evaluate(() => window.__smashy.cameraClipStats());
    const hasReadability = !!probeStats?.readability && typeof probeStats.readability === 'object';
    if (!hasReadability) {
      console.warn(
        '[camera-lab] WARNING: cameraClipStats() has no `readability` block (world/toronto/' +
          'cameraReadability.ts not landed yet, or a stale bundle) — every Phase 76 readability ' +
          'field will be reported as n/a (NEVER as 0). The clip counters and the rest of the run ' +
          'are unaffected and still exit 0 on their own merits.',
      );
    }
    const feelRoutesMeta = await page.evaluate(() =>
      typeof window.__smashy?.startFeelDrive === 'function' && typeof window.__smashy?.feelRoutes === 'function'
        ? window.__smashy.feelRoutes()
        : null,
    );
    const chaseRoute = feelRoutesMeta?.[CHASE_ROUTE_ID] ?? null;
    const hasChase = !!chaseRoute;
    if (args.chase > 0 && !hasChase) {
      console.warn(
        `[camera-lab] WARNING: window.__smashy.startFeelDrive / feelRoutes()['${CHASE_ROUTE_ID}'] is not ` +
          'available on the bridge (dev/feelDrives.ts not loaded, or a stale bundle) — skipping the ' +
          'CHASE phase. STILLS/DRIVES still run.',
      );
    }

    // Resolve `--presets all` against the LIVE preset table (see PRESET_PROBE_IDS: the default used
    // to be a hardcoded A..E, which would have silently ignored every candidate rig added since).
    const presetIds = args.presets === 'all' ? await discoverPresets(page) : args.presets;
    console.log(
      `[camera-lab] presets: ${presetIds.join(', ')}` +
        (args.presets === 'all' ? ' (discovered from the live CAMERA_PRESETS table)' : ''),
    );

    // The STILLS work list + its slice. Preset-major, argument order, contiguous block.
    const stillCells = buildStillCells(presetIds, vantageIds);
    const { items: sliceCells, block: sliceBlock } = args.slice
      ? sliceOf(stillCells, args.slice)
      : { items: stillCells, block: null };
    if (sliceBlock) {
      console.log(
        `[camera-lab] slice ${sliceBlock.i}/${sliceBlock.n}: still cells ` +
          `[${sliceBlock.start}, ${sliceBlock.end}) of ${stillCells.length} — ` +
          `${sliceCells.map((c) => c.id).join(', ') || '(empty block)'}`,
      );
      if (args.drive !== 0 || args.chase > 0) {
        console.warn(
          '[camera-lab] NOTE: --slice slices STILLS ONLY. DRIVES/CHASE are per-preset units and will ' +
            'run IN FULL for this invocation — if you are running n still slices, pass ' +
            '`--drive 0 --chase 0` on them and run the drive/chase passes in their own invocation, ' +
            'or you will measure each drive n times.',
        );
      }
    }

    const summary = {
      generatedAt: new Date().toISOString(),
      args,
      seed: args.seed,
      // The RESOLVED preset list (args.presets may be the literal 'all'), so a summary always says
      // which rigs it actually measured rather than which it was asked to.
      presetIds,
      vantageIds,
      // Full work list vs. what THIS file ran — the pair that makes a sliced battery's coverage
      // checkable after the fact (feel-lab.mjs's allUnitIds/sliceUnitIds convention).
      stillCellIds: stillCells.map((c) => c.id),
      sliceStillCellIds: sliceCells.map((c) => c.id),
      slice: sliceBlock,
      hasDriveCapability: hasDrive,
      hasReadabilityCapability: hasReadability,
      hasChaseCapability: hasChase,
      notes: MEASUREMENT_NOTES,
      // The LIVE counter shape, recorded once from the first sample this invocation takes: every
      // key the generic readout produced, what kind it is (rate/mean/raw) and which field and
      // denominator it came from. It is what lets camera-lab-sheet.mjs render columns for counters
      // this script has never heard of, and what makes a metric that VANISHED between two runs
      // visible (a key present in one summary and absent in another) instead of silently omitted.
      metricSpec: null,
      drivesSkippedReason: null,
      chaseSkippedReason: null,
      presets: {},
    };
    const recordMetricSpec = (stats) => {
      if (!summary.metricSpec && stats && typeof stats === 'object') summary.metricSpec = metricSpec(stats);
    };

    // Group the sliced cells back by preset (order preserved) so each preset's screenshots and
    // stills file are written once, and a preset absent from this slice is simply not touched.
    const cellsByPreset = new Map();
    for (const cell of sliceCells) {
      if (!cellsByPreset.has(cell.preset)) cellsByPreset.set(cell.preset, []);
      cellsByPreset.get(cell.preset).push(cell.vantage);
    }
    console.log(
      `[camera-lab] STILLS: ${sliceCells.length} cell(s) across ${cellsByPreset.size} preset(s) ` +
        `(${args.settleMs} ms settle + ${args.statsWindowMs} ms window)…`,
    );
    for (const [presetId, cellVantageIds] of cellsByPreset) {
      const presetDir = path.join(outDir, presetId);
      mkdirSync(presetDir, { recursive: true });
      const stillsRows = [];
      for (const vid of cellVantageIds) {
        const vantage = vantages.find((v) => v.id === vid);
        console.log(`[camera-lab]   ${presetId} @ ${vid}…`);
        const row = await measureVantage(page, presetId, vantage, presetDir, args);
        recordMetricSpec(row.stats);
        stillsRows.push(row);
      }
      writeFileSync(
        path.join(presetDir, `stills${sliceSuffix(sliceBlock)}.json`),
        JSON.stringify({ preset: presetId, slice: sliceBlock, vantages: stillsRows }, null, 2),
      );
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
          ? presetIds
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
        recordMetricSpec(report1.stats);
        summary.presets[presetId].drive = summarizeDriveReport(report1);
        if (summary.presets[presetId].drive.tierContaminated) {
          console.warn(
            `[camera-lab] WARNING: drive ${presetId} ended at ★${summary.presets[presetId].drive.tierAtEnd}. ` +
              'A wanted tier adds follow distance (CAMERA.tierZoom/tierPitchDeg), so this run was shot ' +
              'from a DIFFERENT rig than the one under test — re-run it before using it in a ' +
              'preset-to-preset comparison. (Expected, and deliberately NOT flagged, in CHASE mode.)',
          );
        }

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

    if (args.chase === 0) {
      summary.chaseSkippedReason = '--chase 0';
      console.log('[camera-lab] CHASE skipped (--chase 0).');
    } else if (!hasChase) {
      summary.chaseSkippedReason = `window.__smashy.startFeelDrive / feelRoutes()['${CHASE_ROUTE_ID}'] not present on the bridge`;
    } else {
      const chasePresetIds =
        args.drivePreset === 'all'
          ? presetIds
          : args.drivePreset
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
      const requiredTier = chaseRoute.requireTier;
      console.log(
        `[camera-lab] CHASE: ${chasePresetIds.length} preset(s) on '${CHASE_ROUTE_ID}' ` +
          `(★${requiredTier} required), ${args.chase}s each, seed ${args.seed}…`,
      );
      for (const presetId of chasePresetIds) {
        const presetDir = path.join(outDir, presetId);
        mkdirSync(presetDir, { recursive: true });
        console.log(`[camera-lab]   chase ${presetId}…`);
        const run = await runOneChase(page, presetId, args, presetDir, requiredTier);
        writeFileSync(path.join(presetDir, 'chase.json'), JSON.stringify(run, null, 2));
        summary.presets[presetId] = summary.presets[presetId] ?? {};
        recordMetricSpec(run.stats);
        summary.presets[presetId].chase = summarizeChaseRun(run);
        if (run.report?.tierArmed === false) {
          console.warn(
            `[camera-lab] WARNING: chase ${presetId} reports tierArmed=false — dev/feelDrives.ts ` +
              'opened its window below the required tier. Its pursuer numbers are NOT a chase.',
          );
        }
      }
    }

    summary.consoleErrorCount = consoleErrors.length + pageErrors.length;
    summary.consoleErrors = consoleErrors;
    summary.pageErrors = pageErrors;

    writeFileSync(path.join(outDir, `summary${sliceSuffix(sliceBlock)}.json`), JSON.stringify(summary, null, 2));
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
