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
import { getGameState } from '../state/store';
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

/** Follow distance (m): base + eased speed-zoom + per-tier zoom. */
export function cameraDistance(speed: number, tier: number): number {
  return CAMERA.baseDist + CAMERA.speedZoom * easeSpeedZoom(speed) + CAMERA.tierZoom * tier;
}

/** Fixed yaw/pitch spherical offset (player → camera) at `distance`, written into `out`. */
export function sphericalOffset(out: Vec3, distance: number): Vec3 {
  const yaw = CAMERA.yawDeg * DEG2RAD;
  const pitch = CAMERA.pitchDeg * DEG2RAD;
  const cosPitch = Math.cos(pitch);
  out.x = distance * cosPitch * Math.sin(yaw);
  out.y = distance * Math.sin(pitch);
  out.z = distance * cosPitch * Math.cos(yaw);
  return out;
}

/** Ideal (un-damped) camera position for the given player state, written into `out`. */
export function computeIdealCamPos(
  out: Vec3,
  playerPos: Readonly<Vec3>,
  speed: number,
  tier: number,
): Vec3 {
  sphericalOffset(out, cameraDistance(speed, tier));
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
  computeIdealCamPos(idealScratch, input.playerPos, input.speed, input.tier);
  const alpha = dampingAlpha(CAMERA.lerp, input.dt);
  const desired = frameResult.desiredCamPos;
  desired.x = lerp(input.currentCamPos.x, idealScratch.x, alpha);
  desired.y = lerp(input.currentCamPos.y, idealScratch.y, alpha);
  desired.z = lerp(input.currentCamPos.z, idealScratch.z, alpha);
  computeLookTarget(frameResult.lookTarget, input.playerPos, input.velocity, input.speed);
  return frameResult;
}

// --- shake -------------------------------------------------------------------------------
// Trauma model: addShake() accumulates trauma (capped at CAMERA.shake.maxAmplitude), which
// decays linearly at CAMERA.shake.decayPerSec and drives a decaying positional jitter.
let shakeTrauma = 0;
let shakeTime = 0;
const shakeOffset: Vec3 = { x: 0, y: 0, z: 0 };

/** Add impact trauma (m of peak jitter). Later phases call this on collisions/explosions. */
export function addShake(strength: number): void {
  if (strength <= 0) return;
  shakeTrauma = Math.min(CAMERA.shake.maxAmplitude, shakeTrauma + strength);
}

/** Current trauma (m). Exposed for the debug panel / tests. */
export function getShakeTrauma(): number {
  return shakeTrauma;
}

/** Clear all shake state (run restart / test isolation). */
export function resetShake(): void {
  shakeTrauma = 0;
  shakeTime = 0;
  shakeOffset.x = shakeOffset.y = shakeOffset.z = 0;
}

/**
 * Advance the shake one frame: decay trauma, then return the (reused) positional offset for
 * this frame. |offset| on each axis ≤ trauma ≤ maxAmplitude. Deterministic given dt history.
 */
export function stepShake(dt: number): Readonly<Vec3> {
  shakeTrauma = Math.max(0, shakeTrauma - CAMERA.shake.decayPerSec * dt);
  if (shakeTrauma <= 0) {
    // Rest state: keep the phase clock small so sin() stays precise across long sessions.
    shakeTime = 0;
    shakeOffset.x = shakeOffset.y = shakeOffset.z = 0;
    return shakeOffset;
  }
  shakeTime += dt;
  const a = shakeTrauma;
  const w = TWO_PI * CAMERA.shake.frequencyHz;
  const wt = w * shakeTime;
  const wt2 = SHAKE_FREQ_RATIO * wt;
  shakeOffset.x = a * (SHAKE_W1 * Math.sin(wt + SHAKE_PHASE_X) + SHAKE_W2 * Math.sin(wt2 + SHAKE_PHASE_X + SHAKE_PHASE_2));
  shakeOffset.y = a * (SHAKE_W1 * Math.sin(wt + SHAKE_PHASE_Y) + SHAKE_W2 * Math.sin(wt2 + SHAKE_PHASE_Y + SHAKE_PHASE_2));
  shakeOffset.z = a * (SHAKE_W1 * Math.sin(wt + SHAKE_PHASE_Z) + SHAKE_W2 * Math.sin(wt2 + SHAKE_PHASE_Z + SHAKE_PHASE_2));
  return shakeOffset;
}

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
} = { playerPos: smoothedCamPos, velocity: smoothedCamPos, speed: 0, tier: 0, dt: 0, currentCamPos: smoothedCamPos };

/** Reset the follow state so the next frame snaps (run restart / vehicle respawn). */
export function resetCameraRig(): void {
  rigInitialized = false;
  resetShake();
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

  if (!rigInitialized) {
    // First frame of a run: snap to the ideal so we don't lerp in from the origin.
    computeIdealCamPos(smoothedCamPos, pos, speed, tier);
    rigInitialized = true;
  }

  rigInput.playerPos = pos;
  rigInput.velocity = state.velocity;
  rigInput.speed = speed;
  rigInput.tier = tier;
  rigInput.dt = dt;
  // currentCamPos already aliases smoothedCamPos (stable module ref).
  const frame = computeCameraFrame(rigInput);
  smoothedCamPos.x = frame.desiredCamPos.x;
  smoothedCamPos.y = frame.desiredCamPos.y;
  smoothedCamPos.z = frame.desiredCamPos.z;

  const shake = stepShake(dt);
  camera.position.set(
    smoothedCamPos.x + shake.x,
    smoothedCamPos.y + shake.y,
    smoothedCamPos.z + shake.z,
  );
  camera.lookAt(frame.lookTarget.x, frame.lookTarget.y, frame.lookTarget.z);
}
