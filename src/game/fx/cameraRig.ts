// Fixed-yaw follow camera + impact shake (TDD §5.3). The math core here is deliberately
// framework-free (plain {x,y,z} numbers, no three/R3F) so it unit-tests cleanly; only
// updateCameraRig() touches a live camera instance, and even that takes the camera as a
// parameter and imports three types-only. core/frameOrder.tsx's CameraFxSystem drives this
// once per frame from a priority-1 useFrame and then owns the render.
//
// Camera model: the camera sits at a FIXED spherical offset from the player — the BEARING
// never tracks the car (no rotation control = the readable Smashy 3/4 look). What reacts is
// the follow DISTANCE and, since Phase 34, the PITCH: both ease out with speed and wanted
// tier, because distance alone widens the camera's horizontal radius past the corridor-
// airspace bound the shipped rig is built around (config/camera.ts has the derivation).
// The position is damped toward its ideal with a frame-rate-independent lerp; the look
// target leads ahead along velocity. The damped position may then be re-shaped by an optional
// PROD-ACTIVE position constraint (setCameraPosConstraint — the world's polygon camera clamp),
// applied to the lerp state itself so the clamp is something the rig converges to rather than a
// correction fought every frame, and then by the PROD-ACTIVE anti-clip guard (Phase 36's
// setCameraAntiClip — the world's "never rest inside a building" last-resort pull), in that order.
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
import { cameraJitter } from './cameraJitterRef';

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

/**
 * Extra pitch (deg, + = higher/more top-down) the framing ramp adds to CAMERA.pitchDeg for the
 * given player state — the pitch half of the speed/tier zoom, rising on the SAME smoothstep as
 * cameraDistance's speed term and linearly per tier like its tier term.
 *
 * Why the ramp has a pitch half at all: a purely-distance zoom grows the eye's horizontal radius
 * (dist·cos pitch), and past ~14.8 wu that radius parks the eye inside the streetwall on a dieted
 * street. Trading part of the distance for pitch buys the same "more of the world on screen" while
 * SHRINKING the radius. Rationale + the measured envelope live in config/camera.ts.
 */
export function cameraPitchOffsetDeg(speed: number, tier: number): number {
  return CAMERA.speedPitchDeg * easeSpeedZoom(speed) + CAMERA.tierPitchDeg * tier;
}

/** Fixed-yaw spherical offset (player → camera) at `distance`, written into `out`. Deliberately a
 * dumb spherical solve: the caller resolves what the pitch/yaw for this frame ARE (the ramp above,
 * the death beat, a lab modifier) and passes the total as `yawOffsetDeg`/`pitchOffsetDeg` (default
 * 0 = the bare fixed-bearing Smashy offset). */
export function sphericalOffset(out: Vec3, distance: number, yawOffsetDeg = 0, pitchOffsetDeg = 0): Vec3 {
  const yaw = (CAMERA.yawDeg + yawOffsetDeg) * DEG2RAD;
  const pitch = (CAMERA.pitchDeg + pitchOffsetDeg) * DEG2RAD;
  const cosPitch = Math.cos(pitch);
  out.x = distance * cosPitch * Math.sin(yaw);
  out.y = distance * Math.sin(pitch);
  out.z = distance * cosPitch * Math.cos(yaw);
  return out;
}

/** Ideal (un-damped) camera position for the given player state, written into `out`. The speed/
 * tier ramp (cameraDistance + cameraPitchOffsetDeg) is the framing itself, so it is applied here;
 * `yawOffsetDeg`/`pitchOffsetDeg` (default 0) are EXTERNAL offsets — the death-beat cinematic, a
 * lab modifier — and stay additive ON TOP of the ramped pitch, so a beat during a ★4 chase reads
 * as a beat against the framing the player was actually looking at. */
export function computeIdealCamPos(
  out: Vec3,
  playerPos: Readonly<Vec3>,
  speed: number,
  tier: number,
  pullback = 0,
  yawOffsetDeg = 0,
  pitchOffsetDeg = 0,
): Vec3 {
  sphericalOffset(
    out,
    cameraDistance(speed, tier, pullback),
    yawOffsetDeg,
    cameraPitchOffsetDeg(speed, tier) + pitchOffsetDeg,
  );
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

// --- rig modifier hook (Phase 33 camera lab) ----------------------------------------------
// A single optional per-frame hook that may nudge the follow framing: it returns extra pitch
// (deg) and extra follow distance (m), which updateCameraRig COMPOSES additively with the
// death-beat's own offsets. It exists so a candidate rig with dynamic behaviour (preset D's
// canyon-aware spring arm, fx/cameraLab.ts) can be prototyped WITHOUT this module learning
// anything about buildings, the AABB index, or the lab.
//
// PROD-INERT BY CONSTRUCTION: the modifier is null unless something registers one, and the only
// registrar is the dev-gated lab (core/debugBridge.ts / core/devPanel.tsx). With null registered
// the composition below reduces to `beat.pullback` / `beat.pitchOffsetDeg` verbatim — today's
// math, bit-for-bit.

export interface CameraRigModifierContext {
  /** Player render position this frame (the interpolated pose the rig itself reads). */
  readonly playerPos: Readonly<Vec3>;
  /** The rig's CURRENT smoothed camera position — i.e. where the lens is right now, before
   * this frame's damping step. The shake offset is NOT included (it never feeds back); the
   * position constraint (below) IS, since Phase 34 folds it into this same smoothed state. */
  readonly camPos: Readonly<Vec3>;
  readonly speed: number;
  readonly tier: number;
  readonly dt: number;
}

export interface CameraRigModifierResult {
  /** Added to the death beat's pitch offset (deg; + = higher / more top-down). */
  readonly pitchOffsetDeg: number;
  /** Added to the death beat's pull-back (m; − = closer to the car). */
  readonly distOffset: number;
}

export type CameraRigModifier = (ctx: CameraRigModifierContext) => CameraRigModifierResult;

let rigModifier: CameraRigModifier | null = null;

// Reused ctx (hot path: no per-frame allocation, same discipline as rigInput below). Declared
// with mutable fields; structurally assignable to the readonly CameraRigModifierContext.
const modifierCtx: {
  playerPos: Readonly<Vec3>;
  camPos: Readonly<Vec3>;
  speed: number;
  tier: number;
  dt: number;
} = { playerPos: { x: 0, y: 0, z: 0 }, camPos: { x: 0, y: 0, z: 0 }, speed: 0, tier: 0, dt: 0 };

/** Register (or clear, with null) the per-frame framing modifier. Only ever called by the
 * dev-gated camera lab — production never registers one, so the rig math is unchanged. */
export function setCameraRigModifier(fn: CameraRigModifier | null): void {
  rigModifier = fn;
}

/** Test/debug: the currently registered modifier (null = today's stock rig). */
export function getCameraRigModifier(): CameraRigModifier | null {
  return rigModifier;
}

// --- position constraint hook (Phase 34 clamp rework) --------------------------------------
// A single optional per-frame hook that may MOVE the smoothed follow position — the seam the
// world's polygon camera clamp (world/toronto/polygon.ts's clampToPolygon, registered by
// world/toronto/TorontoScene.tsx) plugs into so the rig can be kept inside the playable map
// without this module learning that a map polygon exists.
//
// PROD-ACTIVE — the deliberate opposite of the rig-modifier hook above. That one is null in
// production by construction (its only registrar is the dev-gated lab); THIS one is registered by
// the shipped world component on mount and shapes every frame the player sees. Treat a change to
// its contract as a change to shipped camera behaviour.
//
// WHY A HOOK AT ALL — the architecture it replaces: until Phase 34 the clamp lived in a SECOND,
// later useFrame (priority 2) in TorontoScene that wrote `camera.position` after CameraFxSystem's
// priority-1 update+render had already painted, and therefore had to issue a whole extra
// `gl.render()` of its own to make its correction visible. Worse, it never fed back: `smoothedCamPos`
// (the lerp state) is module-private, so the very next frame the rig lerped from its OWN unclamped
// position again and the two passes fought for as long as the player hugged the edge. Applying the
// constraint HERE — after the damping lerp, with the result written back into the lerp state — makes
// the clamp part of the rig's state rather than a correction applied on top of it: the next frame's
// lerp starts from the CLAMPED position, so the rig converges toward the constraint instead of
// re-fighting it, and one render per frame is enough again.
//
// CONTRACT for an implementer:
//   • MUTATE `pos` IN PLACE (no return value, no allocation) — it is handed the rig's live
//     smoothedCamPos, matching this module's scratch discipline.
//   • Be IDEMPOTENT: f(f(p)) === f(p). It is applied every frame to its own previous output, so a
//     constraint that keeps nudging would drift the camera without bound. (clampToPolygon is
//     idempotent by construction — its own doc explains how.)
//   • Be CHEAP: it runs once per rendered frame, on the hot path.
// Shake is applied AFTER this (see updateCameraRig): shake is a purely visual offset that must
// never feed back into the lerp, so it is deliberately outside the constrained state — a hard
// impact can jitter the lens a few cm past the constraint for a frame, which is the intent.
export type CameraPosConstraint = (pos: Vec3) => void;

let posConstraint: CameraPosConstraint | null = null;

/** Register (or clear, with null) the per-frame position constraint. Unlike the rig modifier
 * above, production DOES register one — world/toronto/TorontoScene.tsx installs the polygon camera
 * clamp on mount and clears it on unmount. Idempotent by design (last writer wins), so a
 * StrictMode double-mount's register → cleanup → register sequence lands registered. */
export function setCameraPosConstraint(fn: CameraPosConstraint | null): void {
  posConstraint = fn;
}

/** Test/debug: the currently registered position constraint (null = unconstrained rig). */
export function getCameraPosConstraint(): CameraPosConstraint | null {
  return posConstraint;
}

// --- anti-clip hook (Phase 36) --------------------------------------------------------------
// A SECOND prod-active position seam, applied to the same smoothed follow position immediately
// AFTER `posConstraint`. Same type, same mutate-in-place contract; a separate slot rather than a
// second registration on the first one because the two must compose in a FIXED order and each
// world component owns exactly one of them.
//
// WHY THIS ORDER (constraint → anti-clip), and why it is safe:
//   • the polygon clamp answers "is the eye off the edge of the map?" and moves the eye
//     HORIZONTALLY toward the map interior;
//   • the anti-clip answers "is the eye inside a building?" and moves it ALONG THE BORESIGHT,
//     toward the car — and the car is by definition inside the polygon, so the anti-clip can
//     never undo the clamp (it interpolates toward a point the clamp already accepts). The
//     reverse order would not hold: clamping after a pull could shove the eye back into the wall
//     the pull just escaped. Hence: clamp first, guard last.
//
// The same three contract rules as posConstraint apply (mutate in place, be idempotent, be
// cheap) — see that block. Idempotence is the load-bearing one here and the reason the shipped
// resolver is a PROJECTION ("move the eye to the first clear point along the boresight") rather
// than a DELTA ("pull the eye in by N metres"): a delta applied to its own output every frame
// compounds without bound, and this hook, like the constraint, is fed its own previous result
// through the rig's lerp state and is called twice on the cold-start frame.
//
// Shake stays outside this too (it is applied after both hooks, to camera.position, never to the
// lerp state) — a hard impact may jitter the lens a few cm into a wall for one frame, which is
// the same deliberate exemption the clamp gets.

let antiClip: CameraPosConstraint | null = null;

/** Register (or clear, with null) the per-frame anti-clip guard. Production DOES register one —
 * world/toronto/TorontoScene.tsx installs the Toronto resolver (world/toronto/cameraAntiClip.ts)
 * on mount and clears it on unmount. Last writer wins, so a StrictMode double-mount's
 * register → cleanup → register sequence lands registered. */
export function setCameraAntiClip(fn: CameraPosConstraint | null): void {
  antiClip = fn;
}

/** Test/debug: the currently registered anti-clip guard (null = unguarded rig). */
export function getCameraAntiClip(): CameraPosConstraint | null {
  return antiClip;
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
 * Drop the latched FOV base so the next rest frame re-captures `camera.fov`. The kick is always
 * applied as base + kick, and the base is latched ONCE (lazily, on the first un-kicked frame) —
 * which means any EXTERNAL change to the lens (a camera-preset apply, fx/cameraLab.ts) would
 * otherwise be stomped straight back to the stale base on the very next frame. Every path that
 * writes `camera.fov` from outside this module must call this. Never called in production (the
 * shipped FOV is set once, at Canvas creation, from CAMERA.fov).
 */
export function resetBaseFov(): void {
  baseFov = null;
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
    // First frame of a run: snap to the ideal so we don't lerp in from the origin. The snap goes
    // through the constraint too, so a respawn/teleport beside the map edge never hands an
    // unconstrained position to the lab modifier below or to this frame's damping step. (That
    // makes the init frame the one frame the constraint runs twice — free, given the idempotence
    // the hook's contract already demands.)
    computeIdealCamPos(smoothedCamPos, pos, speed, tier, beat.pullback, beat.yawOffsetDeg, beat.pitchOffsetDeg);
    posConstraint?.(smoothedCamPos);
    antiClip?.(smoothedCamPos);
    rigInitialized = true;
  }

  // Phase 33: an optional lab modifier composes ADDITIVELY on top of the beat's framing (never
  // replaces it — a death beat during a canyon must still read as the beat). Called exactly once
  // per frame, after the cold-start snap so `camPos` is always a real lens position. Null in
  // production, in which case these are `beat.*` verbatim.
  let pullback = beat.pullback;
  let pitchOffsetDeg = beat.pitchOffsetDeg;
  if (rigModifier !== null) {
    modifierCtx.playerPos = pos;
    modifierCtx.camPos = smoothedCamPos;
    modifierCtx.speed = speed;
    modifierCtx.tier = tier;
    modifierCtx.dt = dt;
    const mod = rigModifier(modifierCtx);
    pullback += mod.distOffset;
    pitchOffsetDeg += mod.pitchOffsetDeg;
  }

  rigInput.playerPos = pos;
  rigInput.velocity = state.velocity;
  rigInput.speed = speed;
  rigInput.tier = tier;
  rigInput.dt = dt;
  rigInput.pullback = pullback;
  rigInput.yawOffsetDeg = beat.yawOffsetDeg;
  rigInput.pitchOffsetDeg = pitchOffsetDeg;
  // currentCamPos already aliases smoothedCamPos (stable module ref).
  const frame = computeCameraFrame(rigInput);
  smoothedCamPos.x = frame.desiredCamPos.x;
  smoothedCamPos.y = frame.desiredCamPos.y;
  smoothedCamPos.z = frame.desiredCamPos.z;
  // Positional constraint (the polygon camera clamp in production) applied to the LERP STATE, not
  // to camera.position — so next frame's damping starts from the constrained point and the rig
  // converges toward it instead of fighting it. Null → these three lines above are the final
  // smoothed position, exactly as before Phase 34.
  posConstraint?.(smoothedCamPos);
  // Anti-clip guard (Phase 36), always AFTER the constraint — see that hook's block above for why
  // this order is the safe one. Folded into the lerp state for the same convergence reason: the
  // guard pins the eye at the first clear point and the next frame damps outward FROM there,
  // which is exactly the smooth release the guard deliberately does not implement itself.
  antiClip?.(smoothedCamPos);

  // Shake + FOV kick ALWAYS step (trauma keeps decaying), but their offsets are suppressed
  // when the CAMERA.shake.enabled kill-switch is off, OR the player has asked for reduced
  // shake, OR while the death beat is playing — the beat must read as a clean, deliberate
  // camera move, never as residual crash jitter.
  const shake = stepShake(dt);
  const fovKick = stepFovKick(dt);
  const suppress = !CAMERA.shake.enabled || getReducedShake() || deathPullbackActive;
  const ox = suppress ? 0 : shake.x;
  const oy = suppress ? 0 : shake.y;
  const oz = suppress ? 0 : shake.z;
  // Phase 42 flicker-detector jitter (fx/cameraJitterRef.ts): a sub-wu ground-plane offset added
  // to the eye AND the look target, i.e. a PURE TRANSLATION — the view direction is bit-identical
  // between a jittered and an un-jittered frame, so the only thing that changes is where the
  // rasterization grid falls, which is precisely the toggle the detector measures. Applied here,
  // OUTSIDE the lerp state (exactly like shake above), so it can never feed back into next frame's
  // damping or into the clamp/anti-clip solves. DEV-only read: `import.meta.env.DEV` folds to
  // `false` in production and the pair collapses to the literal 0s this line already added.
  let jx = 0;
  let jz = 0;
  if (import.meta.env.DEV) {
    jx = cameraJitter.x;
    jz = cameraJitter.z;
  }
  camera.position.set(smoothedCamPos.x + ox + jx, smoothedCamPos.y + oy, smoothedCamPos.z + oz + jz);
  camera.lookAt(frame.lookTarget.x + jx, frame.lookTarget.y, frame.lookTarget.z + jz);

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
