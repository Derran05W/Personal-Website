// Out-of-bounds backstop — pure trigger detection (Phase 37, `.planning/part-9-camera-world-edge.md`).
// No react, no three: this module only decides WHEN the player has left the playable world for
// long enough that the run must end. The consequence (state/events.ts's `leftWorld` → combat/
// runLoop.ts's WRECKED path) and the emission call site (world/toronto/TorontoScene.tsx's
// physics-step stepper) both live elsewhere — same split as tunnel.ts's fold trigger.
//
// This is the BACKSTOP, not the primary edge treatment. The primary is diegetic: a barrier ring
// standing inside every land edge of the polygon (world/toronto/worldEdge.ts), which a car bounces
// off. This module exists for what the ring cannot catch — an arc clean over it, or a physics
// failure that drops the chassis through the ground slab — and it replaces the pre-Phase-37
// "teleport the car back to spawn and say nothing" net (BOUNDARY.fellOutResetY), because dying
// honestly beats teleporting silently.
//
// --- what counts as out of bounds ----------------------------------------------------------
// A sample is OOB when EITHER:
//   (a) its map position is outside PLAYABLE_POLYGON (polygon.ts; map x = world x, map y = world
//       z — the identity axis swap projection.ts documents), or
//   (b) its world y is below BOUNDARY.oobMinY (the "fell through the world" case).
//
// IMPORTANT — the polygon INCLUDES the south water band (polygon.ts: the downtown block runs
// down to ZONE_BOUNDARIES[4], and the band below ZONE_BOUNDARIES[3] is lake). So a car in the
// lake is NOT out of bounds by this test, and water deaths stay `enteredWater`-first: the WATER
// sensor in TorontoScene owns them, fires immediately on contact, and reads as drowning rather
// than as leaving the map. This module only ever backstops the two cases above — see this file's
// tests, which pin the "parked in the water band at y=0 never fires" case explicitly.
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import { BOUNDARY } from '../../config/world';

export interface OobConfig {
  /** Samples per second (the trigger accumulates dt and evaluates on each elapsed period). */
  readonly sampleHz: number;
  /** Consecutive out-of-bounds seconds required before firing. */
  readonly sustainSec: number;
  /** World Y below which a sample is out of bounds regardless of its XZ. */
  readonly minY: number;
}

/** Live defaults — config/world.ts's BOUNDARY block (the single source; never re-literalized). */
export const OOB_DEFAULTS: OobConfig = {
  sampleHz: BOUNDARY.oobSampleHz,
  sustainSec: BOUNDARY.oobSustainSec,
  minY: BOUNDARY.oobMinY,
};

/**
 * Pure per-sample test — "is the player out of the world RIGHT NOW", with no notion of sustain
 * or of having already fired (that's createOobTrigger's job below). Takes WORLD coordinates and
 * does the map projection itself (world [x, z] → map {x, y}) so no caller has to remember the
 * axis swap.
 */
export function isOutOfBounds(
  worldX: number,
  worldY: number,
  worldZ: number,
  minY: number = OOB_DEFAULTS.minY,
): boolean {
  if (worldY < minY) return true; // fell through the world — no XZ test needed.
  return !pointInPolygon({ x: worldX, y: worldZ }, PLAYABLE_POLYGON);
}

export interface OobTrigger {
  /**
   * Feed one player-position sample plus the elapsed time since the previous call. Returns
   * `true` on the single step the sustain window completes, and `false` on every step before
   * AND after that (the trigger latches — see createOobTrigger's doc comment).
   */
  step(worldX: number, worldY: number, worldZ: number, dtSec: number): boolean;
  /** Full re-arm: clears the latch, the sustain window, and the sampling accumulator. */
  reset(): void;
}

// A single step's dt is clamped to this many SAMPLING PERIODS before it is accumulated (so the
// clamp scales with whatever sampleHz the caller configured, instead of a second hidden constant
// that a slow-sampling config would silently trip over). In production the caller is a fixed
// 1/60 s physics step, so this never binds; it exists so that a tab refocus or a long
// main-thread stall can't hand the loop below a multi-second dt — which would credit a wild
// number of "consecutive" samples to ONE stale position (and spin the catch-up loop). Same
// spirit as the occlusion pass's own delta clamp in TorontoScene.
const MAX_CATCHUP_SAMPLES = 3;

// Guards the accumulator comparison against float drift: at a 1/60 s step, six steps sum to
// 0.09999999999999999, which must still count as a full 0.1 s sampling period.
const EPS = 1e-9;

/**
 * Stateful stepper: accumulates dt, evaluates `isOutOfBounds` once per sampling period, and
 * fires once the OOB samples have been CONSECUTIVE for `sustainSec`. Any in-bounds sample resets
 * the run of consecutive samples to zero (the continuity rule combat/runLoop.ts's BustedTracker
 * uses — a transient excursion must not accumulate toward a kill across a recovery).
 *
 * LATCHED for the trigger's lifetime: after firing it returns `false` forever, so one excursion
 * can only ever end the run once even though the car keeps sitting outside while the death lock
 * plays out. The Toronto scene remounts per run (game/index.tsx keys the world on `seed-runId`),
 * so a fresh run always gets a fresh trigger — the same lifecycle idiom as tunnel.ts's
 * createFoldTrigger. `reset()` exists anyway, for tests and for any future caller that wants to
 * re-arm without a remount.
 *
 * The sustain window is counted in SAMPLES (`ceil(sustainSec × sampleHz)`), not by summing
 * floats, so the fire step is exact and independent of how the caller's dt happens to divide.
 */
export function createOobTrigger(cfg: OobConfig = OOB_DEFAULTS): OobTrigger {
  const samplePeriodSec = 1 / cfg.sampleHz;
  const samplesToFire = Math.max(1, Math.ceil(cfg.sustainSec * cfg.sampleHz - EPS));
  const maxDtSec = samplePeriodSec * MAX_CATCHUP_SAMPLES;

  let accumSec = 0; // time not yet consumed by a sample
  let oobSamples = 0; // CONSECUTIVE out-of-bounds samples so far
  let fired = false;

  return {
    step(worldX: number, worldY: number, worldZ: number, dtSec: number): boolean {
      if (fired) return false;
      if (!Number.isFinite(dtSec) || dtSec <= 0) return false;

      accumSec += Math.min(dtSec, maxDtSec);
      while (accumSec + EPS >= samplePeriodSec) {
        accumSec -= samplePeriodSec;
        if (!isOutOfBounds(worldX, worldY, worldZ, cfg.minY)) {
          oobSamples = 0;
          continue;
        }
        oobSamples += 1;
        if (oobSamples >= samplesToFire) {
          fired = true;
          accumSec = 0;
          return true;
        }
      }
      return false;
    },
    reset(): void {
      accumSec = 0;
      oobSamples = 0;
      fired = false;
    },
  };
}
