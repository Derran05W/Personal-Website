// Quality-tier detection + the live FPS probe (TDD §10).
//
// Two layers, in order of authority (lowest wins ties by never overriding a higher one):
//   1. detectQualityTier()      — the cheap, synchronous first-load HEURISTIC (UA + cores).
//      applyDetectedQuality() writes it ONCE, as provenance 'auto', only when nothing is
//      persisted yet.
//   2. startQualityProbe()      — the Phase 18 runtime PROBE. After LOADING resolves and the
//      GARAGE scene is live and warm (~1 s in), it samples ~2 s of rAF deltas and, if the
//      device can't sustain the heuristic tier, DEMOTES (never promotes), persisting as 'auto'.
//      A persisted *user* choice (settings.qualitySource === 'user' — a pause-menu pick) is
//      sacred: the probe reads it and never overrides.
//
// What each tier budget actually drives is wired by the consumers themselves (they read
// QUALITY_TIERS[quality] at mount/remount, or reactively for the cheap render-side rows):
//   DPR cap            game/index.tsx  <Canvas dpr>                          (reactive)
//   shadowMapSize      world/BlueHourRig.tsx (DuskKey remounts on quality)   (reactive)
//   particleCap        fx/ParticlesMount.tsx  setParticleBudget             (reactive)
//   pursuitCapModifier ai/spawnDirector.ts    capForTier(..., modifier)     (live, per maintain)
//   maxDynamicBodies   world/propDynamics.ts  dynamicPropPoolCap(...)        (next run, at mount)
//   trafficDensity     ai/traffic.ts          trafficActiveTarget(...)      (next run, at mount)
//   parkedCarKeep      world/cityInstances.ts thinning at build             (next run, at remount)

import { SETTINGS_STORAGE_KEY, getGameState, useGameStore, type Settings } from '../state/store';
import type { GameState } from '../state/machine';
import { QUALITY_TIER_ORDER, type QualityTier } from '../config';

// Coarse mobile heuristic — matches phones and small tablets so they start on the 'low'
// tier (DPR 1.5, shadows off). Kept deliberately broad; the FPS probe below is the real
// arbiter and can demote from here.
const MOBILE_UA =
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet|Silk|Kindle/i;

/**
 * First-load quality guess from cheap, synchronous signals:
 *   1. mobile user-agent            → 'low'
 *   2. hardwareConcurrency ≤ 4      → 'med'
 *   3. otherwise                    → 'high'
 *
 * Written to survive a `navigator` that is missing (SSR-less but jsdom/test) or that
 * lacks `userAgent` / `hardwareConcurrency` — any missing signal falls through to 'high'.
 */
export function detectQualityTier(): QualityTier {
  const nav: Navigator | undefined = typeof navigator !== 'undefined' ? navigator : undefined;

  const ua = nav?.userAgent ?? '';
  if (MOBILE_UA.test(ua)) return 'low';

  const cores = nav?.hardwareConcurrency;
  if (typeof cores === 'number' && cores <= 4) return 'med';

  return 'high';
}

function hasPersistedSettings(): boolean {
  try {
    return localStorage.getItem(SETTINGS_STORAGE_KEY) !== null;
  } catch {
    // Private mode / disabled storage: treat as "no persisted choice" and detect.
    return false;
  }
}

/**
 * Applied once at game mount. A user's *persisted* settings choice always wins, so this only
 * auto-detects when the settings key is absent from localStorage. `setQuality(_, 'auto')`
 * persists the detected tier with auto provenance (so the FPS probe may still re-measure it),
 * which is what makes this run at most once per browser (idempotent + safe under React
 * StrictMode's double-invoked mount effects).
 */
export function applyDetectedQuality(): void {
  if (hasPersistedSettings()) return;
  getGameState().setQuality(detectQualityTier(), 'auto');
}

// ===========================================================================================
// FPS probe — pure decision core (unit-tested; no timers, rAF, or store) --------------------
// ===========================================================================================

// Sustained-fps thresholds. Below SOFT the tier is one notch too high for the device → drop
// one; below HARD it is badly over budget → go straight to 'low'. Both compare against the
// tier's own target implicitly (the probe runs AT the heuristic tier, so "can't hold 45 while
// already at, say, med" is the signal to fall to low). TDD §10 targets are 60 (high/med) / 30
// (low); 45 sits between them as the "not comfortably holding" line, 22 as "clearly can't".
export const PROBE_SOFT_FPS = 45;
export const PROBE_HARD_FPS = 22;

// Timing: wait past chunk-download / JIT warmup before sampling, then sample a stable window.
export const PROBE_DELAY_MS = 1000;
export const PROBE_DURATION_MS = 2000;

/**
 * A device's SUSTAINED frame rate from a window of per-frame deltas (ms), via the MEDIAN delta
 * — robust to the odd GC hitch or scheduler stall that a mean would let drag the estimate down
 * and cause a spurious demotion. Non-positive / non-finite deltas are dropped; an empty window
 * yields 0 (no signal). Pure.
 */
export function sustainedFps(deltasMs: readonly number[]): number {
  const valid = deltasMs.filter((d) => d > 0 && Number.isFinite(d));
  if (valid.length === 0) return 0;
  const sorted = [...valid].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const medianMs = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return medianMs > 0 ? 1000 / medianMs : 0;
}

/** The tier one notch below `tier` (clamped at the 'low' floor). Walks QUALITY_TIER_ORDER. */
function dropOneTier(tier: QualityTier): QualityTier {
  const i = QUALITY_TIER_ORDER.indexOf(tier);
  return QUALITY_TIER_ORDER[Math.max(0, i - 1)];
}

/**
 * Probe classification: given a sustained fps and the tier it was measured AT, decide the tier
 * to run. Only ever DEMOTES — never promotes:
 *   fps <= 0            → keep `current` (no usable signal)
 *   fps <  HARD (22)    → 'low' (clearly can't cope)
 *   fps <  SOFT (45)    → one tier down
 *   otherwise           → keep `current`
 * Pure.
 */
export function classifyProbeTier(fps: number, current: QualityTier): QualityTier {
  if (fps <= 0) return current;
  if (fps < PROBE_HARD_FPS) return 'low';
  if (fps < PROBE_SOFT_FPS) return dropOneTier(current);
  return current;
}

export interface ProbeInput {
  readonly deltasMs: readonly number[];
  readonly current: QualityTier;
  readonly source: Settings['qualitySource'];
}

export interface ProbeDecision {
  readonly tier: QualityTier;
  /** True iff the probe should persist `tier` (it differs from `current` AND the user hasn't
   * locked the choice). When false, `tier === current` and nothing should be written. */
  readonly apply: boolean;
}

/**
 * The whole probe decision in one pure function: honour a persisted USER choice (never
 * override — the sacred rule), else classify the sampled fps and report whether the result is
 * an actual change worth persisting. Unit-tested against fps windows + provenance.
 */
export function resolveProbe({ deltasMs, current, source }: ProbeInput): ProbeDecision {
  if (source === 'user') return { tier: current, apply: false };
  const tier = classifyProbeTier(sustainedFps(deltasMs), current);
  return { tier, apply: tier !== current };
}

// ===========================================================================================
// FPS probe — runtime driver (thin; wraps resolveProbe with rAF sampling + GARAGE gating) ----
// ===========================================================================================
// Not mounted here: the integrator wires `useEffect(() => startQualityProbe(), [])` into
// game/index.tsx exactly like initProgressPersistence()/initEventMap(). Framework-free and
// fully dependency-injected (real browser globals by default) so it is unit-testable with fakes.

export interface ProbeRuntimeDeps {
  now: () => number;
  raf: (cb: () => void) => number;
  caf: (id: number) => void;
  setTimeout: (cb: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  /** Subscribe to store changes; returns an unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  getMachine: () => GameState;
  getSettings: () => Settings;
  setQuality: (tier: QualityTier, source: Settings['qualitySource']) => void;
}

function defaultProbeDeps(): ProbeRuntimeDeps {
  const g = globalThis as typeof globalThis & Window;
  return {
    now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    raf: (cb) => g.requestAnimationFrame(() => cb()),
    caf: (id) => g.cancelAnimationFrame(id),
    setTimeout: (cb, ms) => g.setTimeout(cb, ms) as unknown as number,
    clearTimeout: (id) => g.clearTimeout(id),
    subscribe: (listener) => useGameStore.subscribe(listener),
    getMachine: () => getGameState().machine,
    getSettings: () => getGameState().settings,
    setQuality: (tier, source) => getGameState().setQuality(tier, source),
  };
}

/**
 * Start the one-shot FPS probe. Idempotent per call: it fires its sampling AT MOST once — the
 * first time the machine reaches GARAGE (or immediately if it is already there). ~1 s after
 * that it samples ~2 s of rAF deltas on the live GARAGE scene, then persists a demotion (as
 * 'auto') iff `resolveProbe` says so. Returns a teardown that cancels any pending timer/rAF and
 * unsubscribes — safe to call from a React effect cleanup / StrictMode double-mount.
 */
export function startQualityProbe(deps: ProbeRuntimeDeps = defaultProbeDeps()): () => void {
  let started = false;
  let cancelled = false;
  let unsub: (() => void) | null = null;
  let rafId: number | null = null;
  let timerId: number | null = null;

  const finish = (deltasMs: number[]): void => {
    if (cancelled) return;
    const s = deps.getSettings();
    const { tier, apply } = resolveProbe({ deltasMs, current: s.quality, source: s.qualitySource });
    if (apply) deps.setQuality(tier, 'auto');
  };

  const sample = (): void => {
    const deltas: number[] = [];
    const start = deps.now();
    let last = start;
    const tick = (): void => {
      if (cancelled) return;
      const t = deps.now();
      deltas.push(t - last);
      last = t;
      if (t - start < PROBE_DURATION_MS) rafId = deps.raf(tick);
      else finish(deltas);
    };
    rafId = deps.raf(tick);
  };

  const begin = (): void => {
    if (started || cancelled) return;
    started = true;
    // Stop listening once we've committed — the probe runs once.
    unsub?.();
    unsub = null;
    timerId = deps.setTimeout(() => {
      timerId = null;
      if (!cancelled) sample();
    }, PROBE_DELAY_MS);
  };

  if (deps.getMachine() === 'GARAGE') {
    begin();
  } else {
    unsub = deps.subscribe(() => {
      if (deps.getMachine() === 'GARAGE') begin();
    });
  }

  return () => {
    cancelled = true;
    unsub?.();
    unsub = null;
    if (rafId !== null) deps.caf(rafId);
    if (timerId !== null) deps.clearTimeout(timerId);
  };
}
