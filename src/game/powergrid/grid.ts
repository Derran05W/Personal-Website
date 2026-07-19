// District lit/dark state + DARK CITY (Phase 13 Task 2; TDD §5.8). Owns the CANONICAL
// per-district power state — module-scope (not React state), because the consumers that
// need to read it (hud/Minimap.tsx's district overlay, powergrid/lightPool.ts's
// dark-district exclusion — both built in other Phase 13 tasks) are not necessarily
// React components rendered under the same tree, the same reasoning world/worldRef.ts's
// header gives for its own `{ current }` module-scope handle. `gridRef` below mirrors
// that exact pattern.
//
// --- integration with powergrid/emitters.ts (Task 1) ---------------------------------------
// This module owns district lit/dark STATE (the "is district N dark" boolean, DARK CITY
// detection, and the persisted badge). The actual VISUAL blackout — flicker → permanent
// darkening of the per-instance `emissiveOn` buffer ranges across EMISSIVE_ARCHETYPES — is
// Task 1's `powergrid/emitters.ts`, whose own header declares the seam explicitly: "Task
// 2's powergrid/grid.ts subscribes transformerDestroyed and calls
// blackoutDistrict(districtId) — that is the only production entry point." This module
// was authored before emitters.ts existed (the two were built in parallel per
// phase-13-plan.md), so the call is still wrapped defensively (try/catch — see
// `triggerBlackout` below): a throwing/incomplete blackoutDistrict can never break grid
// state, darkCity detection, or the persisted badge, same "one bad listener can't take
// down its neighbors" contract state/events.ts's `emit()` already guarantees for the
// typed event catalog. Note the two modules' notions of "dark" are deliberately
// independent: THIS module's `gridRef.current.lit[d]` flips the instant
// `transformerDestroyed` fires (immediate — the power IS out); emitters.ts's own
// `isDistrictDark(d)` only flips true once that district's ~0.6s flicker sequence has
// finished (delayed — the VISUAL is still catching up). DARK CITY / the badge / the HUD
// banner all key off this module's immediate state, not the visual's.
//
// --- exactly-once / repeat-districtId defense --------------------------------------------
// In the real game, a transformer's hp can only reach 0 once — combat/damage.ts's
// `applyEntityDamage` no-ops immediately once `entry.hp <= 0` (see that file's header),
// so `transformerDestroyed{districtId}` can structurally fire at most once per district
// per run. This module defends anyway (`handleTransformerDestroyed` below ignores a
// districtId that's already dark) — belt-and-suspenders against a hypothetical future
// regression upstream, and the thing that keeps darkCity's "exactly once per run"
// contract honest even if it didn't. See state/heat.test.ts's regression describe block
// for the paired proof that state/heat.ts's own `transformerDestroyed` handler has NO
// such guard (by design — it relies on the same upstream hp-clamp), so a synthetic
// double-emit would double-count HEAT even though this module stays idempotent.
//
// --- reset-on-init (module-scope state + a keyed mount) ------------------------------------
// `gridRef`/the darkCity latch are plain module-scope variables, not React state, so they
// persist across mounts by default. The integration mount is expected to be KEYED per run
// (the same seed/runId-keyed remount pattern as ai/SpawnDirectorMount.tsx / world/
// CityScape.tsx — a fresh <PowerGridSystem key={`${seed}-${runId}`} /> on every run/retry),
// so `initPowerGrid()` unconditionally resets ALL module state on every call, not just the
// first. Without this, a retried run would inherit the previous run's dark districts and
// (worse) its already-tripped darkCity latch, silently suppressing the banner on a run
// that legitimately earns it. If the orchestrator instead chooses a persistent (never-
// remounting) mount for this system, they must call `initPowerGrid()` again on
// `runStarted` themselves — this module can't observe which mounting strategy is in use.

import { gameEvents } from '../state/events';
import { WORLD } from '../config/world';
import { setDarkCityUnlocked } from '../state/persistence';
import { blackoutDistrict } from './emitters';

/** 4x4 district grid = 16 (TDD §5.8). Derived from WORLD.districts (the grid's side
 * length) rather than hardcoded, so this can never silently drift from world/types.ts's
 * `districtIdAt` if WORLD.districts is ever retuned. */
export const DISTRICT_COUNT = WORLD.districts * WORLD.districts;

export interface PowerGridState {
  /** Length DISTRICT_COUNT, indexed by districtId. true = lit, false = dark. Never
   * mutated in place — every state change reassigns `gridRef.current` wholesale (mirrors
   * world/worldRef.ts's "reassigned wholesale, never mutated in place" convention), so a
   * consumer that snapshots the array reference once can safely diff it against a later
   * read instead of needing to deep-compare on every poll. */
  readonly lit: readonly boolean[];
  /** True once every district has gone dark this run (the DARK CITY condition). Districts
   * only ever go lit -> dark within a run (transformers don't come back), so this can only
   * ever flip false -> true, never back. */
  readonly allDark: boolean;
}

function initialGridState(districtCount: number): PowerGridState {
  return { lit: Array<boolean>(districtCount).fill(true), allDark: false };
}

/** Module-scope handle to the current grid state (TDD §5.8's Minimap/light-pool read
 * contract) — mirrors world/worldRef.ts's `{ current }` shape exactly. `current === `
 * `initialGridState()`'s shape until `initPowerGrid()` has run at least once. */
export const gridRef: { current: PowerGridState } = { current: initialGridState(DISTRICT_COUNT) };

let darkCityEmittedThisRun = false;

// Phase 29 (Toronto parity): the grid tracks whatever `districtCount` the LIVE world was
// initialized with (initPowerGrid's optional param below) — never the frozen legacy
// DISTRICT_COUNT export, which grid.test.ts pins at exactly 16 (4x4 grid, TDD §5.8) and must
// stay that literal constant for the legacy world. Toronto has 15 districts
// (world/toronto/districts.ts's TORONTO_DISTRICT_COUNT); sizing gridRef's `lit` array to the
// legacy 16 there would leave one never-addressed slot permanently lit, and DARK CITY (which
// requires EVERY tracked district dark) could never fire.
let activeDistrictCount = DISTRICT_COUNT;

/** Defensive wrapper over emitters.ts's `blackoutDistrict` — see this file's header. A
 * throwing call (e.g. a not-yet-built city, or any future regression in the flicker
 * sequencer) must never break grid state, darkCity detection, or the persisted badge. */
function triggerBlackout(districtId: number): void {
  try {
    blackoutDistrict(districtId);
  } catch (error) {
    console.error(`[powergrid] blackoutDistrict threw for district ${districtId}:`, error);
  }
}

function handleTransformerDestroyed(districtId: number): void {
  if (!Number.isInteger(districtId) || districtId < 0 || districtId >= activeDistrictCount) {
    if (import.meta.env.DEV) {
      console.warn(
        `[powergrid] transformerDestroyed for out-of-range districtId ${districtId} (expected 0..${activeDistrictCount - 1}) — ignored.`,
      );
    }
    return;
  }

  const { lit } = gridRef.current;
  if (!lit[districtId]) return; // Already dark — defensive no-op against a repeat/duplicate
  // event for the same district (see this file's header). Deliberately silent (not a DEV
  // warning): in the real flow this path is expected to never actually trigger (the
  // upstream hp-clamp already prevents it), so warning here would just be noise the one
  // time a test exercises this defense on purpose.

  const nextLit = lit.slice();
  nextLit[districtId] = false;
  const allDark = nextLit.every((isLit) => !isLit);
  gridRef.current = { lit: nextLit, allDark };

  triggerBlackout(districtId);

  if (allDark && !darkCityEmittedThisRun) {
    darkCityEmittedThisRun = true;
    gameEvents.emit('darkCity', {});
    setDarkCityUnlocked();
  }
}

/**
 * Subscribes district blackout state to `transformerDestroyed` (state/events.ts).
 * Unconditionally resets every module-scope field (gridRef back to all-lit, the darkCity
 * latch) on EVERY call — see this file's "reset-on-init" header section for why. Returns
 * a teardown (unsubscribe); call once at mount, call the returned function on unmount —
 * same contract as every other `init*System` in this codebase (state/heat.ts's
 * `initHeatSystem`, state/persistence.ts's `initProgressPersistence`, etc).
 *
 * `districtCount` (Phase 29): overrides the legacy DISTRICT_COUNT (16, 4x4 grid) for the live
 * `lit` array's size and the transformerDestroyed range check — game/index.tsx passes
 * world/toronto/districts.ts's TORONTO_DISTRICT_COUNT (15) when the Toronto map is active.
 * Omitted (the original, pre-29 call site — the legacy world) defaults to DISTRICT_COUNT, so
 * that call site's behavior — and every test that calls initPowerGrid() with no args — is
 * byte-identical to before.
 */
export function initPowerGrid(districtCount: number = DISTRICT_COUNT): () => void {
  activeDistrictCount = districtCount;
  gridRef.current = initialGridState(districtCount);
  darkCityEmittedThisRun = false;

  const off = gameEvents.on('transformerDestroyed', ({ districtId }) => {
    handleTransformerDestroyed(districtId);
  });

  return () => {
    off();
  };
}

/** Test-only: forces module state back to defaults without also churning a fresh
 * gameEvents subscription (mirrors state/heat.ts's `__resetPassiveAccumulatorForTest` /
 * combat/contacts.ts's `__resetContactsForTest`). Does not touch emitters.ts's own flicker/
 * dark bookkeeping — tests that drive a real blackout are responsible for calling that
 * module's `clearFlickers()` themselves so state doesn't leak into an unrelated test. */
export function __resetGridForTest(): void {
  activeDistrictCount = DISTRICT_COUNT;
  gridRef.current = initialGridState(DISTRICT_COUNT);
  darkCityEmittedThisRun = false;
}
