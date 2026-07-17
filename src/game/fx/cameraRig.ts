// Fixed-yaw follow camera + impact shake (TDD §5.3). The math core here is deliberately
// framework-free (plain {x,y,z} numbers, no three/R3F) so it unit-tests cleanly; only
// updateCameraRig() touches a live camera instance, and even that takes the camera as a
// parameter and imports three types-only. core/frameOrder.tsx's CameraFxSystem drives this
// once per frame from a priority-1 useFrame and then owns the render.
//
// Camera model: the camera sits at a FIXED spherical offset from the player — yaw and
// pitch never track the car (no rotation control = the readable Smashy 3/4 look). Only the
// follow DISTANCE reacts (to speed and wanted tier). The position is damped toward its
// ideal with a frame-rate-independent lerp; the look target leads ahead along velocity.
//
// Hot-path discipline: no per-frame allocation. All working vectors and the returned
// result live at module scope and are mutated in place — computeCameraFrame() returns a
// reused object (copy anything you retain), matching IVehicleModel.readState()'s contract.

import type { PerspectiveCamera } from 'three';
import { CAMERA } from '../config/camera';
import { STARTER_TOP_SPEED } from '../config/vehicles';
import { getGameState, getReducedShake } from '../state/store';
import { gameEvents } from '../state/events';
import { playerVehicle } from '../vehicles/playerRef';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface CameraFrameInput {
  /** Player render position — MUST be the interpolated pose, not rawPose (TDD §7 gotcha). */
  readonly playerPos: Readonly<Vec3>;
  /** Player linear velocity, m/s. */
  readonly velocity: Readonly<Vec3>;
  /** |velocity|, m/s. */
  readonly speed: number;
  /** Current wanted tier (0..5). */
  readonly tier: number;
  /** Seconds since last frame. */
  readonly dt: number;
  /** The camera's current (smoothed) position — the lerp starts here. */
  readonly currentCamPos: Readonly<Vec3>;
  /** Extra follow-distance (m), on top of base/speed/tier zoom — Phase 9's WRECKED/BUSTED
   * death pull-back (setDeathPullback below). Defaults to 0 when omitted, so every
   * pre-Phase-9 call site (and test) is unaffected. */
  readonly pullback?: number;
  /** Death-beat cinematic yaw drift (deg) — Phase 16. Default 0 (normal fixed-yaw frames). */
  readonly yawOffsetDeg?: number;
  /** Death-beat cinematic pitch offset (deg) — Phase 16. Default 0. */
  readonly pitchOffsetDeg?: number;
}

export interface CameraFrameResult {
  /** Position the camera should hold THIS frame (already damped toward the ideal). */
  readonly desiredCamPos: Vec3;
  /** Point the camera should look at (player + velocity lead). */
  readonly lookTarget: Vec3;
}

// --- math/impl constants (not gameplay tunables; those live in config/camera.ts) --------
const DEG2RAD = Math.PI / 180;
const TWO_PI = Math.PI * 2;
// Below this speed (m/s) the velocity direction is mostly integration noise, so the look
// target collapses onto the player (no lead) to avoid twitch at a standstill.
const SPEED_EPSILON = 1e-3;
// Shake noise shaping: two sines per axis at incommensurate rates decorrelate into a
// non-repeating jitter. Weights sum to 1 so |offset| ≤ trauma ≤ maxAmplitude (cap holds).
const SHAKE_W1 = 0.5;
const SHAKE_W2 = 0.5;
const SHAKE_FREQ_RATIO = 1.7;
// Per-axis phase seeds so x/y/z don't jitter in lockstep.
const SHAKE_PHASE_X = 0;
const SHAKE_PHASE_Y = 2.1;
const SHAKE_PHASE_Z = 4.2;
const SHAKE_PHASE_2 = 1.0;

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Smoothstep ease (t²(3−2t)) on an already-clamped [0,1] input — zero slope at both ends,
 * so the death-beat orbit/pitch ease in and settle without a lurch. */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Speed → 0..1 ease used for BOTH the speed-zoom distance and the look-ahead scale-in.
 * Smoothstep (t²(3−2t)) is chosen deliberately over a literal ease-out: its zero slope at
 * t=0 means the follow distance doesn't lurch the instant you tap the gas AND the velocity
 * lead scales in from ~0 at a standstill (the required twitch guard), while its zero slope
 * at t=1 avoids a pop as speed saturates the zoom. Feel value — revisit at the fun gate.
 */
export function easeSpeedZoom(speed: number): number {
  const t = clamp01(speed / STARTER_TOP_SPEED);
  return t * t * (3 - 2 * t);
}

/** Follow distance (m): base + eased speed-zoom + per-tier zoom + an optional death
 * pull-back (m, default 0 — see CameraFrameInput.pullback / setDeathPullback below). */
export function cameraDistance(speed: number, tier: number, pullback = 0): number {
  return CAMERA.baseDist + CAMERA.speedZoom * easeSpeedZoom(speed) + CAMERA.tierZoom * tier + pullback;
}

/** Fixed yaw/pitch spherical offset (player → camera) at `distance`, written into `out`.
 * `yawOffsetDeg`/`pitchOffsetDeg` (default 0) nudge the fixed yaw/pitch — used ONLY by the
 * Phase 16 death-beat cinematic (a gentle orbit + lower/higher framing); every normal frame
 * passes 0 and gets the unchanged fixed-yaw Smashy offset. */
export function sphericalOffset(out: Vec3, distance: number, yawOffsetDeg = 0, pitchOffsetDeg = 0): Vec3 {
  const yaw = (CAMERA.yawDeg + yawOffsetDeg) * DEG2RAD;
  const pitch = (CAMERA.pitchDeg + pitchOffsetDeg) * DEG2RAD;
  const cosPitch = Math.cos(pitch);
  out.x = distance * cosPitch * Math.sin(yaw);
  out.y = distance * Math.sin(pitch);
  out.z = distance * cosPitch * Math.cos(yaw);
  return out;
}

/** Ideal (un-damped) camera position for the given player state, written into `out`.
 * `yawOffsetDeg`/`pitchOffsetDeg` (default 0) are the death-beat cinematic offsets — see
 * sphericalOffset. */
export function computeIdealCamPos(
  out: Vec3,
  playerPos: Readonly<Vec3>,
  speed: number,
  tier: number,
  pullback = 0,
  yawOffsetDeg = 0,
  pitchOffsetDeg = 0,
): Vec3 {
  sphericalOffset(out, cameraDistance(speed, tier, pullback), yawOffsetDeg, pitchOffsetDeg);
  out.x += playerPos.x;
  out.y += playerPos.y;
  out.z += playerPos.z;
  return out;
}

/**
 * Frame-rate-independent damping alpha for a per-frame lerp tuned at 60fps. `CAMERA.lerp`
 * is the alpha at dt=1/60; here it's rescaled so N small steps and one big step of the
 * same elapsed time converge to the same place: alpha = 1 − (1 − lerp)^(dt·60).
 */
export function dampingAlpha(lerpAt60: number, dt: number): number {
  return clamp01(1 - Math.pow(1 - lerpAt60, dt * 60));
}

/** Look target = player + velocity lead (normalized dir × lookAhead × speed ease), into `out`. */
export function computeLookTarget(
  out: Vec3,
  playerPos: Readonly<Vec3>,
  velocity: Readonly<Vec3>,
  speed: number,
): Vec3 {
  out.x = playerPos.x;
  out.y = playerPos.y;
  out.z = playerPos.z;
  if (speed > SPEED_EPSILON) {
    // velocity/speed = unit dir; × (lookAhead × leadScale) = lead offset.
    const scale = (easeSpeedZoom(speed) * CAMERA.lookAhead) / speed;
    out.x += velocity.x * scale;
    out.y += velocity.y * scale;
    out.z += velocity.z * scale;
  }
  return out;
}

// Reused scratch + result (hot path: no allocation).
const idealScratch: Vec3 = { x: 0, y: 0, z: 0 };
const frameResult: CameraFrameResult = {
  desiredCamPos: { x: 0, y: 0, z: 0 },
  lookTarget: { x: 0, y: 0, z: 0 },
};

/**
 * Pure per-frame camera solve: ideal position → damped toward `currentCamPos`, plus the
 * velocity-led look target. Returns a REUSED object mutated in place — copy anything you
 * keep past the call. Shake is applied separately (see stepShake / updateCameraRig).
 */
export function computeCameraFrame(input: CameraFrameInput): CameraFrameResult {
  computeIdealCamPos(
    idealScratch,
    input.playerPos,
    input.speed,
    input.tier,
    input.pullback ?? 0,
    input.yawOffsetDeg ?? 0,
    input.pitchOffsetDeg ?? 0,
  );
  const alpha = dampingAlpha(CAMERA.lerp, input.dt);
  const desired = frameResult.desiredCamPos;
  desired.x = lerp(input.currentCamPos.x, idealScratch.x, alpha);
  desired.y = lerp(input.currentCamPos.y, idealScratch.y, alpha);
  desired.z = lerp(input.currentCamPos.z, idealScratch.z, alpha);
  computeLookTarget(frameResult.lookTarget, input.playerPos, input.velocity, input.speed);
  return frameResult;
}

// --- shake -------------------------------------------------------------------------------
// Per-source trauma model (Phase 16, TDD §5.3/§8). addShake(strength, source) accumulates
// into a per-source bucket capped by CAMERA.shake.sourceCaps[source]; every bucket decays
// linearly at decayPerSec. The APPLIED amplitude each frame is min(maxAmplitude, Σ buckets)
// — the overall cap still holds, but the split keeps a high-frequency source (a wall-grind
// of impacts) from monopolising the budget and starving a rarer big hit of headroom to
// punch through on top. Rationale in config/camera.ts.

export type ShakeSource = 'impact' | 'explosion' | 'ram' | 'generic';

// Per-source trauma buckets (m). Iterated for decay, summed for the applied amplitude.
const sourceTrauma: Record<ShakeSource, number> = { impact: 0, explosion: 0, ram: 0, generic: 0 };
const SHAKE_SOURCES: readonly ShakeSource[] = ['impact', 'explosion', 'ram', 'generic'];

let shakeTime = 0;
const shakeOffset: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Add camera-shake trauma from a hit of the given `source` (default `'impact'` — the common
 * uncategorised case in a driving/destruction game, and the source that also arms the FOV
 * kick, so existing call sites passing only a strength keep working AND correctly register
 * as impacts). Trauma is capped PER SOURCE (CAMERA.shake.sourceCaps); the overall cap is
 * enforced when the buckets are summed in stepShake. Non-positive strength is a no-op.
 *
 * An `'impact'` at/above CAMERA.shake.fovKick.minStrength also arms the hard-impact FOV
 * micro-kick — this is where "trigger the FOV kick from the same addShake('impact') signal"
 * lives, so combat/damage.ts's unchanged impact call drives the lens kick without the
 * resolver needing to know the FOV kick exists.
 */
export function addShake(strength: number, source: ShakeSource = 'impact'): void {
  if (strength <= 0) return;
  const cap = CAMERA.shake.sourceCaps[source];
  sourceTrauma[source] = Math.min(cap, sourceTrauma[source] + strength);
  if (source === 'impact' && strength >= CAMERA.shake.fovKick.minStrength) armFovKick(strength);
}

/** Applied trauma this frame (m): min(maxAmplitude, Σ per-source buckets). Debug/tests. */
export function getShakeTrauma(): number {
  let sum = 0;
  for (const s of SHAKE_SOURCES) sum += sourceTrauma[s];
  return Math.min(CAMERA.shake.maxAmplitude, sum);
}

/** A single source's live trauma (m) — test/debug introspection of one bucket. */
export function getSourceTrauma(source: ShakeSource): number {
  return sourceTrauma[source];
}

/** Clear all shake + FOV-kick state (run restart / test isolation). */
export function resetShake(): void {
  for (const s of SHAKE_SOURCES) sourceTrauma[s] = 0;
  shakeTime = 0;
  shakeOffset.x = shakeOffset.y = shakeOffset.z = 0;
  fovKickTrauma = 0;
}

/**
 * Advance the shake one frame: decay every per-source bucket, then return the (reused)
 * positional offset for this frame. |offset| on each axis ≤ applied trauma ≤ maxAmplitude.
 * Deterministic given dt history. Does NOT itself honour reducedShake / the death beat — the
 * caller (updateCameraRig) decides whether to APPLY the returned offset, so trauma keeps
 * decaying even while suppressed (the a11y contract: accumulate/decay, just don't apply).
 */
export function stepShake(dt: number): Readonly<Vec3> {
  const decay = CAMERA.shake.decayPerSec * dt;
  let applied = 0;
  for (const s of SHAKE_SOURCES) {
    const next = Math.max(0, sourceTrauma[s] - decay);
    sourceTrauma[s] = next;
    applied += next;
  }
  applied = Math.min(CAMERA.shake.maxAmplitude, applied);
  if (applied <= 0) {
    // Rest state: keep the phase clock small so sin() stays precise across long sessions.
    shakeTime = 0;
    shakeOffset.x = shakeOffset.y = shakeOffset.z = 0;
    return shakeOffset;
  }
  shakeTime += dt;
  const a = applied;
  const w = TWO_PI * CAMERA.shake.frequencyHz;
  const wt = w * shakeTime;
  const wt2 = SHAKE_FREQ_RATIO * wt;
  shakeOffset.x = a * (SHAKE_W1 * Math.sin(wt + SHAKE_PHASE_X) + SHAKE_W2 * Math.sin(wt2 + SHAKE_PHASE_X + SHAKE_PHASE_2));
  shakeOffset.y = a * (SHAKE_W1 * Math.sin(wt + SHAKE_PHASE_Y) + SHAKE_W2 * Math.sin(wt2 + SHAKE_PHASE_Y + SHAKE_PHASE_2));
  shakeOffset.z = a * (SHAKE_W1 * Math.sin(wt + SHAKE_PHASE_Z) + SHAKE_W2 * Math.sin(wt2 + SHAKE_PHASE_Z + SHAKE_PHASE_2));
  return shakeOffset;
}

// --- FOV micro-kick (Phase 16, TDD §8) ---------------------------------------------------
// A hard impact briefly widens the lens a few degrees, snapping back over ~150 ms — a cheap,
// readable "punch" the positional jitter can't give. Trauma model mirrors the shake above
// (accumulate capped, decay linearly) but in DEGREES of FOV, with its own faster decay.
// armFovKick is called from addShake('impact', …); the degrees are applied to the live
// camera in updateCameraRig (the only owner of the camera), which gates it under
// reducedShake and during the death beat.
let fovKickTrauma = 0;

/** Arm the FOV kick from an impact of the given strength (deg = strength × strengthToDeg,
 * capped at maxDeg). Called by addShake('impact', …); exported for tests. */
export function armFovKick(strength: number): void {
  if (strength <= 0) return;
  const add = strength * CAMERA.shake.fovKick.strengthToDeg;
  fovKickTrauma = Math.min(CAMERA.shake.fovKick.maxDeg, fovKickTrauma + add);
}

/** Current FOV-kick magnitude (deg). Test/debug introspection. */
export function getFovKick(): number {
  return fovKickTrauma;
}

/** Advance the FOV kick one frame: decay and return the current magnitude (deg). Like
 * stepShake, always decays regardless of reducedShake — the caller decides whether to APPLY
 * the returned degrees. */
export function stepFovKick(dt: number): number {
  fovKickTrauma = Math.max(0, fovKickTrauma - CAMERA.shake.fovKick.decayPerSec * dt);
  return fovKickTrauma;
}

// --- death beat (Phase 9 pull-back, tuned into a cinematic in Phase 16, TDD §5.10/§8) -----
// A WRECKED/BUSTED lock window (combat/runLoop.ts) plays a deliberate camera beat before the
// GAMEOVER screen. combat/runLoop.ts flips setDeathPullback(true) at lock start and
// setDeathPullback(false) at the next run's start (beginRun) — a single boolean, no reason
// attached. The WRECKED-vs-BUSTED distinction (a pull-BACK survey vs a tighter, lower
// converge on the arrest) is learned instead from the `playerWrecked` / `busted` events the
// same lock emits, captured below — the same module-load subscription idiom hud/
// gameOverRunEnd.ts uses for the GAMEOVER cause (gameEvents is dependency-free, so this
// keeps the rig unit-testable). The pure computeCameraFrame/computeIdealCamPos core stays
// pure: it takes pullback/yaw/pitch as explicit params (default 0); only updateCameraRig's
// impure per-frame read of these flags decides what to pass in.
type DeathCause = 'wrecked' | 'busted';
let deathPullbackActive = false;
let deathCause: DeathCause | null = null;
// Seconds elapsed in the current beat — drives the orbit/pitch ease-in (0 while inactive).
let deathBeatElapsed = 0;

/** Toggle the death beat on/off. combat/runLoop.ts calls this true when a WRECKED/BUSTED
 * lock window starts and false again at the next run's start (beginRun). Turning it OFF
 * also clears the captured cause + beat clock so a later run can't inherit stale framing. */
export function setDeathPullback(active: boolean): void {
  deathPullbackActive = active;
  if (!active) {
    deathCause = null;
    deathBeatElapsed = 0;
  }
}

/** Test/debug: current death-beat flag. */
export function getDeathPullback(): boolean {
  return deathPullbackActive;
}

/** Test/debug: the captured death cause driving the beat framing (null when not in a beat,
 * or before the wrecked/busted event has been seen). */
export function getDeathCause(): DeathCause | null {
  return deathCause;
}

/** Set the death cause directly. Normally set by the module-load event subscription below;
 * exported so tests can drive the beat framing without emitting through gameEvents. */
export function setDeathCause(cause: DeathCause | null): void {
  deathCause = cause;
}

// Capture the run-loop's own WRECKED/BUSTED signals to pick the beat framing. Registered at
// module-evaluation time (before any run can end), same timing guarantee as hud/
// gameOverRunEnd.ts. `busted` wins if both somehow fire — a surrounded car that also hits 0
// hp is dramatically an arrest, not a crash.
gameEvents.on('playerWrecked', () => {
  if (deathCause === null) deathCause = 'wrecked';
});
gameEvents.on('busted', () => {
  deathCause = 'busted';
});

// --- live rig ----------------------------------------------------------------------------
// Smoothed follow position persisted across frames (the lerp state, shake-free). Separate
// from camera.position so the shake offset never feeds back into the next frame's lerp.
const smoothedCamPos: Vec3 = { x: 0, y: 0, z: 0 };
let rigInitialized = false;

// Reused input for computeCameraFrame — mutated each frame so updateCameraRig allocates
// nothing in the hot path. Structurally assignable to the readonly CameraFrameInput.
const rigInput: {
  playerPos: Readonly<Vec3>;
  velocity: Readonly<Vec3>;
  speed: number;
  tier: number;
  dt: number;
  currentCamPos: Readonly<Vec3>;
  pullback: number;
  yawOffsetDeg: number;
  pitchOffsetDeg: number;
} = {
  playerPos: smoothedCamPos,
  velocity: smoothedCamPos,
  speed: 0,
  tier: 0,
  dt: 0,
  currentCamPos: smoothedCamPos,
  pullback: 0,
  yawOffsetDeg: 0,
  pitchOffsetDeg: 0,
};

// Base (un-kicked) FOV, captured lazily the first frame the rig owns a rest-state camera —
// the FOV kick is always applied as base + kick, so the kick can never permanently drift the
// lens even across many hits. Null until captured.
let baseFov: number | null = null;

/** Reset the follow state so the next frame snaps (run restart / vehicle respawn). */
export function resetCameraRig(): void {
  rigInitialized = false;
  setDeathPullback(false); // clears deathPullbackActive + cause + beat clock in one place
  resetShake();
}

/**
 * Death-beat framing for the current frame: extra pull-back/converge distance plus eased
 * orbit-yaw and pitch offsets. Pure given (active, cause, elapsed) — split out so the beat
 * math is unit-testable without a live camera. When inactive, everything is 0 (normal
 * fixed-yaw follow). WRECKED pulls back + lifts; BUSTED converges in + drops lower.
 */
export function deathBeatFraming(
  active: boolean,
  cause: DeathCause | null,
  elapsedSec: number,
): { pullback: number; yawOffsetDeg: number; pitchOffsetDeg: number } {
  if (!active) return { pullback: 0, yawOffsetDeg: 0, pitchOffsetDeg: 0 };
  const c = CAMERA.cinematic;
  const ease = smoothstep(clamp01(elapsedSec / c.easeInSec));
  const busted = cause === 'busted';
  const pullback = busted ? c.bustedPullback : CAMERA.deathPullback;
  const pitchTarget = busted ? c.bustedPitchOffsetDeg : c.wreckedPitchOffsetDeg;
  return {
    pullback,
    yawOffsetDeg: c.orbitYawDeg * ease,
    pitchOffsetDeg: pitchTarget * ease,
  };
}

/**
 * Per-frame camera update called by CameraFxSystem. Reads the live player vehicle through
 * playerRef; if there's no vehicle (GARAGE / menus) it leaves the camera untouched and
 * disarms so the next spawn snaps into place instead of swooping in from a stale position.
 */
export function updateCameraRig(camera: PerspectiveCamera, dt: number): void {
  const model = playerVehicle.current;
  if (!model) {
    rigInitialized = false;
    return;
  }

  const state = model.readState();
  const pos = state.pose.position; // interpolated pose — never rawPose (TDD §7)
  const speed = state.speed;
  const tier = getGameState().tier;

  // Death-beat framing: advance the beat clock while active, then resolve the eased
  // pull-back/converge + orbit/pitch for this frame (all 0 during normal play).
  if (deathPullbackActive) deathBeatElapsed = Math.min(deathBeatElapsed + dt, CAMERA.cinematic.easeInSec);
  else deathBeatElapsed = 0;
  const beat = deathBeatFraming(deathPullbackActive, deathCause, deathBeatElapsed);

  if (!rigInitialized) {
    // First frame of a run: snap to the ideal so we don't lerp in from the origin.
    computeIdealCamPos(smoothedCamPos, pos, speed, tier, beat.pullback, beat.yawOffsetDeg, beat.pitchOffsetDeg);
    rigInitialized = true;
  }

  rigInput.playerPos = pos;
  rigInput.velocity = state.velocity;
  rigInput.speed = speed;
  rigInput.tier = tier;
  rigInput.dt = dt;
  rigInput.pullback = beat.pullback;
  rigInput.yawOffsetDeg = beat.yawOffsetDeg;
  rigInput.pitchOffsetDeg = beat.pitchOffsetDeg;
  // currentCamPos already aliases smoothedCamPos (stable module ref).
  const frame = computeCameraFrame(rigInput);
  smoothedCamPos.x = frame.desiredCamPos.x;
  smoothedCamPos.y = frame.desiredCamPos.y;
  smoothedCamPos.z = frame.desiredCamPos.z;

  // Shake + FOV kick ALWAYS step (trauma keeps decaying), but their offsets are suppressed
  // when the player has asked for reduced shake OR while the death beat is playing — the
  // beat must read as a clean, deliberate camera move, never as residual crash jitter.
  const shake = stepShake(dt);
  const fovKick = stepFovKick(dt);
  const suppress = getReducedShake() || deathPullbackActive;
  const ox = suppress ? 0 : shake.x;
  const oy = suppress ? 0 : shake.y;
  const oz = suppress ? 0 : shake.z;
  camera.position.set(smoothedCamPos.x + ox, smoothedCamPos.y + oy, smoothedCamPos.z + oz);
  camera.lookAt(frame.lookTarget.x, frame.lookTarget.y, frame.lookTarget.z);

  // FOV kick: capture the rest-state base once (only when nothing is applied, so we never
  // latch a kicked value as the base), then hold camera.fov at base + kick, touching
  // updateProjectionMatrix ONLY on the frames the value actually changes (i.e. while active).
  const appliedKick = suppress ? 0 : fovKick;
  if (appliedKick === 0 && baseFov === null) baseFov = camera.fov;
  const targetFov = (baseFov ?? camera.fov) + appliedKick;
  if (camera.fov !== targetFov) {
    camera.fov = targetFov;
    camera.updateProjectionMatrix();
  }
}
