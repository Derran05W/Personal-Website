// District blackout emitter system — the signature feature's core (Phase 13, TDD §5.8).
//
// A destroyed transformer takes its whole district's lights out. The mechanism this module
// owns is the FLICKER → PERMANENT BLACKOUT sequence: over POWER_GRID.flickerSec the district's
// emissive archetypes stutter through a handful of seeded on/off pulses, then cut to black for
// the rest of the run. Everything visual reduces to ONE primitive — setDistrictEmissive
// (world/instancing.ts), which flips exactly one district's contiguous [start,count] slice of
// an archetype's aEmissiveOn buffer (the sacred district-grouped ordering, proven in Phase 5).
// So a full-district write is four range-writes (EMISSIVE_ARCHETYPES), effectively free.
//
// SEAM: Task 2's powergrid/grid.ts subscribes `transformerDestroyed` and calls
// blackoutDistrict(districtId) — that is the only production entry point. The flicker sequencer
// is a plain fixed-step state machine (tickFlickers) driven by the PowerGridSystem mount
// (powergrid/PowerGridMount.tsx) from useAfterPhysicsStep; pausing physics pauses the flicker
// for free (same contract as world/propDynamics.ts). relightDistrict / setDistrictDark are
// DEV/debug-only.
//
// DETERMINISM: the pulse schedule is seeded from (run world seed, districtId) via the world's
// forkable Rng (world/rng.ts), so a given seed blacks a given district out identically on every
// machine — same guarantee the seeded city generation carries (TDD §5.4).

import { POWER_GRID, RENDERING } from '../config';
import { EMISSIVE_ARCHETYPES, type ArchetypeName } from '../world/archetypes';
import {
  DISTRICT_COUNT,
  getArchetypeHandles,
  setDistrictEmissive,
  setDistrictEmissiveValue,
} from '../world/instancing';
import { createRng, type Rng } from '../world/rng';
import { getGameState } from '../state/store';

// --- Flicker tuning (analog feel) ---------------------------------------------------------
// Per-archetype stagger: each emissive archetype lags a hair behind the others on every edge,
// so the whole district doesn't snap in lockstep — reads as failing wiring, not a light switch.
// TDD §5.8 gives the 0.6 s envelope (POWER_GRID.flickerSec); these two bounds are the analog
// texture on top of it, feel-tunable placeholders.
const STAGGER_MIN_SEC = 0.04;
const STAGGER_MAX_SEC = 0.08;
// Interior toggles are evenly slotted across the flicker window then jittered within their slot
// (±this fraction of a slot) so the blinks feel erratic rather than metronomic. The final
// (permanent-OFF) edge is never jittered — it is pinned to flickerSec.
const INTERIOR_JITTER_FRAC = 0.6;

// --- Schedule (pure data; deterministic) --------------------------------------------------

/** One scheduled aEmissiveOn write during a flicker: at `timeSec` after blackout start, flip
 * EMISSIVE_ARCHETYPES[archetypeIndex]'s district slice to `on` (1 lit / 0 dark). */
export interface FlickerWrite {
  readonly timeSec: number;
  readonly archetypeIndex: number;
  readonly on: 0 | 1;
}

/** A fully-resolved flicker plan for one district. `writes` is ascending by `timeSec`; the last
 * write for every archetype is guaranteed OFF (the district ends permanently dark). */
export interface FlickerSchedule {
  readonly districtId: number;
  /** Number of dark blinks (2–3). Toggle count is 2·pulseCount+1 — odd, so the sequence starts
   * lit and ends dark irrespective of which value was rolled. */
  readonly pulseCount: number;
  /** Per-archetype stagger offset (s), index === EMISSIVE_ARCHETYPES index; each in
   * [STAGGER_MIN_SEC, STAGGER_MAX_SEC]. */
  readonly staggerSec: readonly number[];
  readonly writes: readonly FlickerWrite[];
  /** Elapsed time (s) after which the flicker is complete and the district is permanently OFF. */
  readonly durationSec: number;
}

/**
 * Build the deterministic flicker plan for `districtId` from `rng`. Draws, in a fixed order so
 * the sequence is reproducible: pulseCount (2–3), then the interior toggle jitters, then the
 * per-archetype stagger offsets. The district starts lit; toggle k flips it to
 * `k % 2 === 0 ? off : on`, so the odd final toggle (pinned to flickerSec) lands on OFF.
 */
export function buildFlickerSchedule(districtId: number, rng: Rng): FlickerSchedule {
  const flickerSec = POWER_GRID.flickerSec;
  const archCount = EMISSIVE_ARCHETYPES.length;

  // 2–3 dark blinks ⇒ an ODD toggle count ⇒ starts lit, ends dark by construction.
  const pulseCount = rng.int(2, 3);
  const toggleCount = pulseCount * 2 + 1;

  // Base toggle times, END-ANCHORED: the last edge is pinned to flickerSec (the "0.6 s then
  // out" contract); interior edges are evenly slotted then jittered within their slot.
  const slot = flickerSec / toggleCount;
  const baseTimes: number[] = [];
  for (let k = 0; k < toggleCount; k++) {
    if (k === toggleCount - 1) {
      baseTimes.push(flickerSec);
      continue;
    }
    const center = (k + 1) * slot;
    const jitter = (rng.next() - 0.5) * slot * INTERIOR_JITTER_FRAC;
    baseTimes.push(center + jitter);
  }
  // Keep strictly ascending (jitter stays well inside a slot, but never trust it).
  for (let k = 1; k < baseTimes.length; k++) {
    if (baseTimes[k] <= baseTimes[k - 1]) baseTimes[k] = baseTimes[k - 1] + 1e-3;
  }

  // Per-archetype stagger — drawn AFTER the toggle jitters so schedules stay reproducible.
  const staggerSec: number[] = [];
  for (let i = 0; i < archCount; i++) {
    staggerSec.push(STAGGER_MIN_SEC + rng.next() * (STAGGER_MAX_SEC - STAGGER_MIN_SEC));
  }

  const writes: FlickerWrite[] = [];
  for (let k = 0; k < toggleCount; k++) {
    const on: 0 | 1 = k % 2 === 0 ? 0 : 1; // even edge → OFF, odd edge → ON
    for (let i = 0; i < archCount; i++) {
      writes.push({ timeSec: baseTimes[k] + staggerSec[i], archetypeIndex: i, on });
    }
  }
  writes.sort((a, b) => a.timeSec - b.timeSec);

  const durationSec = flickerSec + Math.max(...staggerSec);
  return { districtId, pulseCount, staggerSec, writes, durationSec };
}

// --- Emissive write plumbing --------------------------------------------------------------

/** Flip one emissive archetype's district slice. The production write is setDistrictEmissive;
 * tests inject a recording stand-in so the sequencer is verifiable without a built city. */
export type EmissiveWriteFn = (
  archetype: ArchetypeName,
  districtId: number,
  on: 0 | 1,
) => void;

const realWrite: EmissiveWriteFn = (name, districtId, on) =>
  setDistrictEmissive(name, districtId, on);

// --- Extra emissive archetypes (Phase 19 seam for Task 2's market string lights) -----------
// EMISSIVE_ARCHETYPES (world/archetypes.ts) is the compile-time set of blackout participants.
// Phase 19's Kensington market props (awning / produce-stand string lights, Task 2) are built
// as their OWN archetypes but must ALSO go dark when their district blacks out — the "money
// clip". Rather than edit archetypes.ts, a market mount registers its emissive archetype name
// here at build time; the permanent-OFF paths (finalize / setDistrictDark / relight), the
// Kensington boost, and the range-bookkeeping guard all iterate EMISSIVE_ARCHETYPES ∪ extras.
// The FLICKER schedule stays on the core set only (deterministic + golden-safe — see
// buildFlickerSchedule), so extras don't stutter through the flicker; they cut with the
// district at finalize (~flickerSec later), which reads as "the market's circuit dies last".
const extraEmissiveArchetypes = new Set<ArchetypeName>();

/**
 * Register an archetype (beyond EMISSIVE_ARCHETYPES) as a district-blackout participant.
 * THE Phase 19 hookup: Task 2's market string-light mount calls this ONCE at build so a
 * Kensington blackout snuffs the market glow. Idempotent; the archetype must also be BUILT
 * (world/instancing.ts buildInstancedArchetype) for the writes to actually land — an unbuilt
 * name is a harmless no-op until its mesh exists.
 */
export function registerEmissiveArchetype(name: ArchetypeName): void {
  extraEmissiveArchetypes.add(name);
}

/** The full blackout-participant set: core EMISSIVE_ARCHETYPES first, then any registered
 * extras (dedup'd against the core), in registration order. Returns the shared core array
 * unchanged when nothing extra is registered (the common case — zero allocation). */
export function emissiveArchetypeNames(): readonly ArchetypeName[] {
  if (extraEmissiveArchetypes.size === 0) return EMISSIVE_ARCHETYPES;
  const extras = [...extraEmissiveArchetypes].filter((n) => !EMISSIVE_ARCHETYPES.includes(n));
  return extras.length === 0 ? EMISSIVE_ARCHETYPES : [...EMISSIVE_ARCHETYPES, ...extras];
}

/** Test-only: drop registered extras so one test's registration can't leak into the next. */
export function __resetEmissiveArchetypesForTest(): void {
  extraEmissiveArchetypes.clear();
}

// One-shot DEV timing of the "full-district write set" (all EMISSIVE_ARCHETYPES flipped in a
// single pass). TDD/plan acceptance: < 1 ms. Logged once; the boolean guards the whole thing.
let timingLogged = false;

/**
 * Flip EVERY emissive archetype's slice for one district in a single pass — the "full-district
 * write set". DEV-times the first invocation and console.info's it once (acceptance < 1 ms).
 * The flicker's staggered per-archetype writes bypass this (they intentionally never fire as one
 * batch); the timed batch is the finalize / instant-dark / relight path.
 */
function timedFullWrite(districtId: number, on: 0 | 1, write: EmissiveWriteFn): void {
  const names = emissiveArchetypeNames();
  if (import.meta.env.DEV && !timingLogged) {
    timingLogged = true;
    const t0 = performance.now();
    for (const name of names) write(name, districtId, on);
    const ms = performance.now() - t0;
    console.info(
      `[powergrid] full-district emissive write set (${names.length} archetypes, district ${districtId}): ${ms.toFixed(3)} ms`,
    );
    return;
  }
  for (const name of names) write(name, districtId, on);
}

// --- DEV bookkeeping guard ----------------------------------------------------------------
// A blackout writes one contiguous [start,count] slice per archetype mesh; if those slices do
// NOT tile the whole instance buffer (Σ range counts !== mesh.count) a district flip would leave
// stray instances stuck lit/dark. This proves the invariant once, the first time a blackout runs
// against a real city.

/** One archetype-mesh whose district ranges fail to tile its instance buffer. */
export interface RangeBookkeepingViolation {
  readonly archetype: ArchetypeName;
  readonly variantKey: string;
  readonly rangeSum: number;
  readonly meshCount: number;
}

/** For every emissive archetype's every variant mesh, check Σ(range counts) === mesh.count.
 * Read-only; returns the violations (empty ⇒ healthy). Exported for the bookkeeping test. */
export function findRangeBookkeepingViolations(): RangeBookkeepingViolation[] {
  const out: RangeBookkeepingViolation[] = [];
  for (const name of emissiveArchetypeNames()) {
    for (const h of getArchetypeHandles(name)) {
      let rangeSum = 0;
      for (const r of h.ranges) rangeSum += r.count;
      if (rangeSum !== h.mesh.count) {
        out.push({ archetype: name, variantKey: h.variantKey, rangeSum, meshCount: h.mesh.count });
      }
    }
  }
  return out;
}

let bookkeepingChecked = false;

/** Run the bookkeeping guard once, the first time a blackout touches a BUILT city (skips while
 * the registry is empty so it doesn't "pass" before there's anything to check). DEV-only. */
function maybeAssertRangeBookkeeping(): void {
  if (!import.meta.env.DEV || bookkeepingChecked) return;
  const names = emissiveArchetypeNames();
  const anyHandles = names.some((n) => getArchetypeHandles(n).length > 0);
  if (!anyHandles) return; // city not built yet — retry on the next blackout
  bookkeepingChecked = true;
  const violations = findRangeBookkeepingViolations();
  if (violations.length > 0) {
    console.error(
      '[powergrid] district range bookkeeping mismatch — a blackout would leave instances stuck:',
      violations,
    );
  } else {
    console.info(
      `[powergrid] range bookkeeping OK — ${names.length} emissive archetypes tile their instance buffers.`,
    );
  }
}

// --- Flicker sequencer (fixed-step state machine) -----------------------------------------

interface ActiveFlicker {
  readonly schedule: FlickerSchedule;
  elapsed: number;
  cursor: number; // index of the next unfired write
}

/**
 * Drives district flickers forward one fixed step at a time. Pure w.r.t. rendering: it only
 * calls its injected `write` (setDistrictEmissive in production, a recorder in tests), so the
 * whole sequencer is unit-testable without a GPU/city. A district is at most in one of three
 * states: flickering (in `active`), permanently dark (in `darkened`), or lit (in neither) —
 * blackouts are permanent for the run (TDD §5.8), so a district already flickering or dark
 * ignores a re-trigger.
 */
export class FlickerRunner {
  private readonly active = new Map<number, ActiveFlicker>();
  private readonly darkened = new Set<number>();
  private readonly write: EmissiveWriteFn;

  constructor(write: EmissiveWriteFn = realWrite) {
    this.write = write;
  }

  /** Begin a district's flicker. No-op (returns false) if it is already flickering or already
   * permanently dark this run. */
  start(schedule: FlickerSchedule): boolean {
    const d = schedule.districtId;
    if (this.active.has(d) || this.darkened.has(d)) return false;
    this.active.set(d, { schedule, elapsed: 0, cursor: 0 });
    return true;
  }

  /** Advance every active flicker by `dtSec`, firing all writes now due (in ascending time
   * order) and finalizing any flicker whose writes are exhausted. */
  tick(dtSec: number): void {
    if (this.active.size === 0) return;
    for (const [d, f] of this.active) {
      f.elapsed += dtSec;
      const { writes } = f.schedule;
      while (f.cursor < writes.length && writes[f.cursor].timeSec <= f.elapsed) {
        const w = writes[f.cursor];
        this.write(EMISSIVE_ARCHETYPES[w.archetypeIndex], d, w.on);
        f.cursor++;
      }
      if (f.cursor >= writes.length) this.finalize(d);
    }
  }

  /** Authoritative permanent-OFF: a single batched full-district write (guarantees terminal
   * dark regardless of the pulse parity that got us here) plus the one-shot DEV timing sample.
   * Deleting the current key mid-iteration is safe for a Map. */
  private finalize(d: number): void {
    timedFullWrite(d, 0, this.write);
    this.active.delete(d);
    this.darkened.add(d);
  }

  /** Stop a district's flicker and forget its dark/lit bookkeeping (debug relight). Does NOT
   * itself write emissive — the caller does. */
  cancel(d: number): void {
    this.active.delete(d);
    this.darkened.delete(d);
  }

  /** Mark a district permanently dark without a flicker (instant blackout-all debug). */
  markDark(d: number): void {
    this.active.delete(d);
    this.darkened.add(d);
  }

  isFlickering(d: number): boolean {
    return this.active.has(d);
  }
  isDark(d: number): boolean {
    return this.darkened.has(d);
  }
  activeCount(): number {
    return this.active.size;
  }

  /** Drop all flicker/dark state (city remount / teardown). */
  clear(): void {
    this.active.clear();
    this.darkened.clear();
  }
}

// --- Module singleton + public API --------------------------------------------------------
// One live runner drives the real city (mirrors world/propDynamics.ts's single active
// controller). The PowerGridSystem mount ticks it; Task 2's grid.ts triggers it.

const flickerRunner = new FlickerRunner();

function assertDistrict(districtId: number): void {
  if (!Number.isInteger(districtId) || districtId < 0 || districtId >= DISTRICT_COUNT) {
    throw new RangeError(
      `powergrid: districtId ${districtId} out of range [0, ${DISTRICT_COUNT - 1}]`,
    );
  }
}

/** Deterministic per-(run, district) flicker seed: fork the world seed by district so two
 * districts blackout differently and the same district is identical across machines/reloads. */
function flickerRng(districtId: number): Rng {
  return createRng(getGameState().seed).fork(`blackout-${districtId}`);
}

/**
 * THE production entry point (Task 2's grid.ts calls this on `transformerDestroyed`): start the
 * flicker → permanent blackout for `districtId`. Idempotent per run — a second call for a
 * district already flickering or dark is a no-op. Seeded from the run's world seed + districtId.
 */
export function blackoutDistrict(districtId: number): void {
  assertDistrict(districtId);
  maybeAssertRangeBookkeeping();
  flickerRunner.start(buildFlickerSchedule(districtId, flickerRng(districtId)));
}

/** Fixed-step tick — the PowerGridSystem mount calls this from useAfterPhysicsStep with
 * PHYSICS_STEP_SEC. Pure passthrough to the singleton runner (kept as a free function so the
 * mount needn't reach into the instance). */
export function tickFlickers(dtSec: number): void {
  flickerRunner.tick(dtSec);
}

/** DEBUG (blackout-all / instant): force a district fully dark immediately, no flicker. Cancels
 * any in-progress flicker for it and marks it permanently dark. */
export function setDistrictDark(districtId: number): void {
  assertDistrict(districtId);
  maybeAssertRangeBookkeeping();
  flickerRunner.cancel(districtId);
  timedFullWrite(districtId, 0, realWrite);
  flickerRunner.markDark(districtId);
}

/** DEBUG ONLY: re-light a district — cancel any flicker and switch every emissive archetype's
 * slice back ON. Not a gameplay path (blackouts are permanent); exists for the debug panel. */
export function relightDistrict(districtId: number): void {
  assertDistrict(districtId);
  flickerRunner.cancel(districtId);
  timedFullWrite(districtId, 1, realWrite);
}

// --- Kensington emissive boost (Phase 19, TDD §13) ----------------------------------------

/**
 * Scale one district's per-instance emissive VALUE across every blackout-participant archetype
 * (core EMISSIVE_ARCHETYPES + registered extras). scale>1 brightens (the Kensington market
 * "money clip"); a subsequent blackout write (0) overrides it wholesale, so the boost never
 * outlives the district going dark. No-op for archetypes not built this run. Idempotent —
 * safe to re-call after a late market mount registers + builds its string-light archetype.
 */
export function applyDistrictEmissiveScale(districtId: number, scale: number): void {
  assertDistrict(districtId);
  for (const name of emissiveArchetypeNames()) setDistrictEmissiveValue(name, districtId, scale);
}

/**
 * Apply the configured Kensington market boost (RENDERING.kensingtonEmissiveScale) to
 * `districtId`. THE second half of the Phase 19 hookup: the integrator calls this once, after
 * the city (and any market mounts) have built, with world.landmarks.kensingtonDistrictId.
 * world/CityScape.tsx already calls it defensively for the buildings/streetlights that always
 * exist; a market mount that lands later re-invokes it (idempotent) to cover its own lights.
 */
export function applyKensingtonBoost(districtId: number): void {
  applyDistrictEmissiveScale(districtId, RENDERING.kensingtonEmissiveScale);
}

/** True while `districtId` is mid-flicker (before it settles permanently dark). */
export function isDistrictFlickering(districtId: number): boolean {
  return flickerRunner.isFlickering(districtId);
}

/** True once `districtId` has settled permanently dark this run. */
export function isDistrictDark(districtId: number): boolean {
  return flickerRunner.isDark(districtId);
}

/** Count of districts currently mid-flicker. */
export function activeFlickerCount(): number {
  return flickerRunner.activeCount();
}

/** Drop all flicker/dark state — the PowerGridSystem mount calls this on teardown so a city
 * remount (seed/retry) starts with a clean grid. */
export function clearFlickers(): void {
  flickerRunner.clear();
}
