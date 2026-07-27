// Phase 36 — the camera anti-clip guard: the last-resort promise that the lens never RESTS inside
// building volume.
//
// WHERE IT SITS IN THE DEFENCE STACK. Three mechanisms keep the camera out of walls, in order of
// how much of the work they do:
//   1. the EYE-LINE LAW (config/camera.ts's CAMERA_EYE_MIN_WU + config/cityPackScale.ts's
//      STREETWALL_MAX_HEIGHT_WU): ordinary streetwall is simply shorter than the resting eye, so
//      in normal play there is nothing at eye height to be inside of;
//   2. the CORRIDOR-AIRSPACE margin the shipped rig was picked on (config/camera.ts's header):
//      the eye's horizontal radius keeps it inside the street's own airspace;
//   3. this module, for everything those two deliberately do not cover — the death beat's MEASURED
//      excursions (BUSTED pitches down below EYE_MIN by design, and at ★2+ its horizontal radius
//      leaves the corridor: config/camera.ts's `cinematic` block names Phase 36 as its cover), a
//      respawn or teleport beside a tower, and any future geometry that slips past (1).
// It is a GUARD, not a framing system: if it is firing often, something in (1) or (2) regressed.
//
// THE SOLVE. Pull the eye along the boresight toward the car — the one direction that is
// guaranteed to (a) keep the car centred, since the car stays exactly on the view axis, (b) end
// somewhere legal, since the car itself is on drivable ground inside the playable polygon, and
// (c) compose safely with the polygon clamp that runs immediately before it (fx/cameraRig.ts's
// hook block explains that ordering).
//
// WHY IT IS A PROJECTION, NOT A DELTA — the design constraint that shapes everything below. The
// rig applies this to its own lerp STATE and feeds the result back in next frame (Phase 34's
// convergence property), and calls it twice on the cold-start frame. A "pull the eye in by N
// metres" delta applied to its own output therefore compounds without bound. So the solver
// answers an absolute question instead: "what is the FIRST point along eye→car that is clear?",
// and moves the eye exactly there. Re-running it on that point finds it already clear and moves
// nothing — idempotent by construction, exactly as the hook's contract demands.
//
// AND WHY IT NEVER PUSHES OUT. The release is the rig's own damping lerp: once the wall is gone
// the guard stops pulling and the eye eases back to the ideal at CAMERA.lerp, which is already the
// smooth motion the whole camera is built on. Implementing a release here would be a second
// spring fighting the first (Phase 33's preset D died of exactly that). The rate cap below is
// therefore one-directional by design: it limits how fast the pull may GROW.

import { CAMERA } from '../../config/camera';
import { pointInsideAny } from './cameraClipIndex';
import { playerVehicle } from '../../vehicles/playerRef';
import { isWorldFrozen, simNowMs } from '../../core/simClock';
import type { CameraPosConstraint, Vec3 } from '../../fx/cameraRig';

/** Below this boresight length (m) there is no meaningful direction to pull along — the eye is
 * effectively on the car — so the solver is a no-op rather than dividing by ~0. Implementation
 * constant (a numerical guard, not a tunable), same carve-out as fx/cameraRig.ts's SPEED_EPSILON. */
const MIN_BORESIGHT_M = 1e-3;

/** A point-in-building test, injected so the solver is unit-testable without the live clip index
 * (and so a future Phase-40 arbiter can be swapped in at one call site). */
export type InsideTest = (x: number, y: number, z: number) => boolean;

export interface AntiClipConfig {
  /** Clearance (m) the eye must have from every volume before it counts as clear. */
  readonly marginWu: number;
  /** Hard cap (m) on the pull. */
  readonly maxPullM: number;
  /** Rate cap (m/s) on pull GROWTH (the release is the rig's lerp — see the header). */
  readonly slewMPerSec: number;
  /** Sample spacing (m) along the boresight when searching for the first clear point. */
  readonly probeStepM: number;
}

/**
 * How far (m) along the boresight the eye must move toward the car to be clear — the raw,
 * un-rate-limited answer. Pure: everything it needs is a parameter.
 *
 * Returns 0 when the eye is already clear (the overwhelmingly common case, and a SINGLE point
 * query — the sampling loop below is only ever paid on frames the guard actually has work to do).
 * Never returns more than the boresight length itself, so the eye can never be pulled past the car.
 *
 * ALSO returns 0 when NO sampled point within the cap is clear, which is the subtle case. The
 * tempting alternative — "pull the whole cap anyway, get as close to the car as allowed" — breaks
 * the idempotence the rig hook demands: it would leave the eye still inside, so the next call
 * would pull another capful, and the cold-start frame's double call alone would move it twice.
 * Every value this function CAN return therefore lands the eye somewhere the test reports clear,
 * which is precisely what makes re-running it a no-op. The un-helped case (≥ maxPullM of solid
 * geometry straight ahead — the eye is deep inside a tower base) is the occlusion FADE path's
 * problem, and it is already fading that tower.
 */
export function solveAntiClipPull(
  eye: Readonly<Vec3>,
  car: Readonly<Vec3>,
  inside: InsideTest,
  cfg: AntiClipConfig,
): number {
  const dx = car.x - eye.x;
  const dy = car.y - eye.y;
  const dz = car.z - eye.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(len > MIN_BORESIGHT_M)) return 0; // NaN-safe: a NaN length falls through this too
  if (!inside(eye.x, eye.y, eye.z)) return 0;
  const ux = dx / len;
  const uy = dy / len;
  const uz = dz / len;
  const cap = Math.min(cfg.maxPullM, len);
  const step = cfg.probeStepM > 0 ? cfg.probeStepM : cap;
  for (let d = step; d < cap; d += step) {
    if (!inside(eye.x + ux * d, eye.y + uy * d, eye.z + uz * d)) return d;
  }
  // The cap point itself is the last candidate (the loop stops short of it whenever cap isn't an
  // exact multiple of the step).
  return inside(eye.x + ux * cap, eye.y + uy * cap, eye.z + uz * cap) ? 0 : cap;
}

/**
 * Rate-limit a raw pull against the previous frame's applied pull: growth is capped at
 * `slewMPerSec`, shrink is NOT capped (the guard simply stops pulling; the rig's damping owns the
 * visible release). Split out from the solver so the timing rule is testable at exact dt steps.
 */
export function rateLimitPull(rawPullM: number, prevPullM: number, dtSec: number, cfg: AntiClipConfig): number {
  if (rawPullM <= 0) return 0;
  const allowance = cfg.slewMPerSec * Math.max(0, dtSec);
  return Math.min(rawPullM, prevPullM + allowance, cfg.maxPullM);
}

/**
 * Mutable per-rig state: how much pull is currently applied, and the clock the rate cap ramps
 * against. Kept explicit (rather than module-level `let`s) so tests drive it deterministically and
 * so a second instance — a lab harness, a future split-screen — is possible without surgery.
 */
export interface AntiClipState {
  /** Pull (m) applied on the last call — the rate cap's ramp base. */
  pullM: number;
  /** Timestamp (ms) of the last call, for the dt the rate cap needs. */
  lastMs: number;
}

export function createAntiClipState(): AntiClipState {
  return { pullM: 0, lastMs: 0 };
}

/**
 * One guard step: solve, rate-limit, and MOVE `eye` in place. Returns the pull actually applied.
 *
 * IDEMPOTENCE, concretely (the property fx/cameraRig's hook contract demands, and the one the
 * cold-start frame's double call exercises): the second call sees an eye that the first call
 * already placed at a clear point, so `solveAntiClipPull` returns 0 and nothing moves. `pullM` is
 * likewise left alone by the zero-pull branch, so the ramp base doesn't collapse on the double
 * call and re-ramp from 0 on the next frame.
 *
 * `nowMs` is injected (the live path passes core/simClock.ts's simNowMs() — wall clock minus any
 * frozen spans, Phase 42) so the tests step the rate cap at exact frame boundaries instead of
 * racing a real clock.
 */
export function applyAntiClip(
  eye: Vec3,
  car: Readonly<Vec3>,
  inside: InsideTest,
  state: AntiClipState,
  nowMs: number,
  cfg: AntiClipConfig,
): number {
  const raw = solveAntiClipPull(eye, car, inside, cfg);
  if (raw <= 0) {
    // Clear: do NOT push the eye back out (the rig's lerp does that) and do not reset the ramp
    // base — a wall the eye is skimming would otherwise re-ramp from 0 on every alternate frame.
    state.lastMs = nowMs;
    return 0;
  }
  // COLD START (lastMs 0 = first call after a reset/mount): apply the full solve immediately
  // instead of ramping. There is no previous frame to be smooth relative to — a respawn or a
  // preset apply can drop the eye straight into a wall — and ramping there would paint several
  // frames of the exact failure this guard exists to prevent. It is also what keeps the rig's
  // cold-start DOUBLE call idempotent: a snapped pull lands the eye somewhere clear, so the second
  // call solves 0. Every subsequent frame ramps.
  const dtSec = state.lastMs === 0 ? Infinity : Math.max(0, (nowMs - state.lastMs) / 1000);
  const pull = rateLimitPull(raw, state.pullM, dtSec, cfg);
  state.pullM = pull;
  state.lastMs = nowMs;
  if (pull <= 0) return 0;
  const dx = car.x - eye.x;
  const dy = car.y - eye.y;
  const dz = car.z - eye.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(len > MIN_BORESIGHT_M)) return 0;
  const s = pull / len;
  eye.x += dx * s;
  eye.y += dy * s;
  eye.z += dz * s;
  return pull;
}

// --- the live guard ----------------------------------------------------------------------------

const liveState = createAntiClipState();
let livePullM = 0;

/** Pull (m) the guard applied on the most recent frame — 0 when the eye is clear, which is what a
 * healthy session reads. Surfaced through core/debugBridge.ts's occlusionV2Stats(). */
export function getAntiClipPullM(): number {
  return livePullM;
}

/** Reset the live guard's state (world unmount / run restart / test isolation). */
export function resetAntiClip(): void {
  liveState.pullM = 0;
  liveState.lastMs = 0;
  livePullM = 0;
}

/** The live inside-test: the Phase 33 AABB index, promoted to a production build by Phase 36's
 * scene wiring. An EMPTY index (world not mounted yet) reports everything clear, so the guard is
 * inert rather than wrong before the city exists. */
function insideLive(x: number, y: number, z: number): boolean {
  return pointInsideAny(x, y, z, CAMERA.antiClip.marginWu);
}

/**
 * The shipped guard, shaped for fx/cameraRig's `setCameraAntiClip` seam: reads the live player's
 * render pose for the boresight target (no vehicle = no boresight = no-op, which is exactly the
 * GARAGE/menu case the rig itself also skips) and mutates the rig's smoothed position in place.
 *
 * Module scope, not a factory call per mount: the identity must be stable so TorontoScene's mount
 * effect registers/clears exactly one function and a StrictMode double-mount is a no-op
 * re-register of the same fn — the same discipline as that file's clampCameraPos.
 */
export const antiClipCameraPos: CameraPosConstraint = (pos: Vec3): void => {
  // Phase 42 (core/simClock.ts): HOLD while the world is frozen — the pull the guard had applied is
  // already folded into the rig's lerp state (which a 0 delta leaves untouched), so doing nothing
  // is what keeps the eye exactly where the freeze caught it. Running would be actively wrong: the
  // solve is unchanged frame to frame at a standstill, so the ramp would keep GROWING the pull and
  // walk the camera down the boresight through a capture pair — a whole-frame change, not flicker.
  if (isWorldFrozen()) return;
  const model = playerVehicle.current;
  if (!model) {
    livePullM = 0;
    return;
  }
  const car = model.readState().pose.position; // interpolated pose — same source the rig follows
  // simNowMs (not performance.now): frozen spans are subtracted out, so the first frame after a
  // release sees ONE frame's dt in the rate cap instead of the whole freeze, and the ramp resumes
  // from where it was rather than being handed a free unlimited step.
  livePullM = applyAntiClip(pos, car, insideLive, liveState, simNowMs(), CAMERA.antiClip);
};
