// Phase 33 camera lab — live preset application + preset D's canyon-aware spring arm.
//
// DEV-ONLY BY WIRING: this module is imported exclusively from core/debugBridge.ts and
// core/devPanel.tsx, both of which game/index.tsx reaches only through an
// `import.meta.env.DEV ? … : null` branch (a compile-time constant in prod, so the whole subtree
// is dead-code-eliminated). Nothing in the shipped render tree may import it — the rig hook it
// registers (fx/cameraRig.ts's setCameraRigModifier) is null in production precisely so this file
// can exist without touching a shipped frame.
//
// HOW A PRESET APPLIES: the rig re-reads CAMERA.yawDeg/pitchDeg/baseDist every frame already, so
// switching rigs is just a write into that runtime-mutable block — the same live-tuning write path
// core/devPanel.tsx's `writeConfigLeaf` uses (config blocks are `as const` at the TYPE level but
// plain mutable objects at runtime). FOV is the exception: it is a property of the camera object,
// not something the rig recomputes, so it must be written onto the live PerspectiveCamera and the
// projection matrix rebuilt — AND fx/cameraRig's lazily-latched FOV-kick base must be dropped
// (resetBaseFov), or the next frame stomps the new lens back to the old one.

import type { PerspectiveCamera } from 'three';
import {
  CAMERA,
  CAMERA_PRESETS,
  CAMERA_SHARED_LEAF_DEFAULTS,
  CAMERA_SHARED_LEAF_KEYS,
  MAX_WANTED_TIER,
  type CameraPreset,
  type CameraPresetId,
  type CameraSharedLeaf,
  type CameraSharedOverrides,
  type CameraSpringArmConfig,
} from '../config/camera';
import { buildingsAboveCapWu, streetwallCapForEyeWu } from '../config/cityPackScale';
import { eyeInsideAny, segmentHitCount } from '../world/toronto/cameraClipIndex';
import {
  cameraDistance,
  resetBaseFov,
  setCameraRigModifier,
  sphericalOffset,
  type CameraRigModifier,
  type CameraRigModifierResult,
  type Vec3,
} from './cameraRig';

/** One entry of the CAMERA_PRESETS tuple — narrower than `CameraPreset` (its `id` is the literal
 * union), which is what keeps the active-preset bookkeeping below typed without a cast. */
export type CameraPresetEntry = (typeof CAMERA_PRESETS)[number];

// core/devPanel.tsx owns the canonical `writeConfigLeaf`, but importing it here would drag leva
// into this module's graph for a two-line cast. Same idiom, restated locally on purpose — see
// that function's doc comment for the rationale (strip `readonly`, no `any`, lint-clean).
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The four leaves that DEFINE a rig — what a preset always carries. */
type CameraGeometryLeaf = 'yawDeg' | 'pitchDeg' | 'baseDist' | 'fov';

function writeCameraLeaf(key: CameraGeometryLeaf | CameraSharedLeaf, value: number): void {
  // Via `object` for the same reason devPanel's helper takes an `object` parameter: CAMERA also
  // carries nested blocks (shake, cinematic), so a direct cast to a number-valued record is not a
  // sufficient overlap. Every key this accepts is a number leaf.
  (CAMERA as object as Mutable<Record<string, number>>)[key] = value;
}

// --- spring arm (preset D) ---------------------------------------------------------------------
// PURE CORE, module state, one modifier closure. The arm answers a single question per frame — is
// the NEAR FIELD in front of the lens blocked? — and eases two offsets toward their caps while it
// is, releasing only after the near field has read clear continuously for `clearHoldSec`. That
// asymmetry is the whole design: engaging instantly keeps the lens out of walls, releasing lazily
// keeps a grazed corner from pumping the framing (a strobe here would BE the flashing complaint).

export interface SpringArmState {
  /** Current pitch lift (deg, 0…maxPitchLiftDeg). */
  lift: number;
  /** Current pull-in (m, 0…maxPullInM; applied to the rig as a NEGATIVE distance offset). */
  pull: number;
  /** Seconds the near field has read clear continuously (0 while blocked). */
  clearSec: number;
}

export function createSpringArmState(): SpringArmState {
  return { lift: 0, pull: 0, clearSec: 0 };
}

/** Move `current` toward `target` by at most `maxStep`. */
function approach(current: number, target: number, maxStep: number): number {
  if (current < target) return Math.min(target, current + maxStep);
  if (current > target) return Math.max(target, current - maxStep);
  return current;
}

/**
 * Advance the arm one frame. `blocked` is the near-field probe result (see probeNearField).
 * Mutates and returns `state` (hot path — no allocation), which also makes the whole rise/hold/
 * release behaviour unit-testable without a camera, a scene or an index.
 *
 * Both axes rate-limit at cap/easeSec per second, so a full 0 → cap traversal always takes
 * `easeSec` no matter how the frame time is chopped up.
 */
export function stepSpringArm(
  state: SpringArmState,
  blocked: boolean,
  dt: number,
  cfg: CameraSpringArmConfig,
): SpringArmState {
  state.clearSec = blocked ? 0 : state.clearSec + dt;
  // Released only once the clear streak outlasts the hold — until then the arm holds its target
  // at the caps even though this frame read clear (the hysteresis).
  const engaged = state.clearSec < cfg.clearHoldSec;
  const liftTarget = engaged ? cfg.maxPitchLiftDeg : 0;
  const pullTarget = engaged ? cfg.maxPullInM : 0;
  const ease = cfg.easeSec > 0 ? dt / cfg.easeSec : 1;
  state.lift = approach(state.lift, liftTarget, cfg.maxPitchLiftDeg * ease);
  state.pull = approach(state.pull, pullTarget, cfg.maxPullInM * ease);
  return state;
}

/**
 * Is the near field in front of the lens blocked? True when the eye is already inside building
 * volume, or when any indexed building sits on the first `probeAheadM` metres of the eye→car
 * boresight. Deliberately NOT the full eye→car segment: in a solid streetwall something is
 * between lens and car most of the time, and an arm that reacts to that is permanently lifted
 * rather than canyon-aware.
 */
export function probeNearField(
  camPos: Readonly<Vec3>,
  playerPos: Readonly<Vec3>,
  cfg: CameraSpringArmConfig,
): boolean {
  if (eyeInsideAny(camPos.x, camPos.y, camPos.z)) return true;
  const dx = playerPos.x - camPos.x;
  const dy = playerPos.y - camPos.y;
  const dz = playerPos.z - camPos.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-3) return false;
  const reach = Math.min(cfg.probeAheadM, dist) / dist;
  const hits = segmentHitCount(
    camPos.x,
    camPos.y,
    camPos.z,
    camPos.x + dx * reach,
    camPos.y + dy * reach,
    camPos.z + dz * reach,
  );
  return hits > 0;
}

const armState = createSpringArmState();
// Reused modifier result + probe scratch (hot path — the rig calls this every frame).
const armResult: Mutable<CameraRigModifierResult> = { pitchOffsetDeg: 0, distOffset: 0 };
const baseEyeScratch: Mutable<Vec3> = { x: 0, y: 0, z: 0 };

/** Clear the arm's easing state (preset switch / test isolation). */
export function resetSpringArm(): void {
  armState.lift = 0;
  armState.pull = 0;
  armState.clearSec = 0;
}

/** Test/debug: the live arm state. */
export function getSpringArmState(): Readonly<SpringArmState> {
  return armState;
}

/**
 * Where the BASE rig (no arm, no beat) would ideally put the eye for this player state — the
 * probe position the arm's blocked test uses. Probing the arm's OWN current lens position is a
 * feedback loop: a fully-engaged arm clears its view, reads "clear", releases after clearHoldSec,
 * is instantly blocked again, and pumps the framing on a ~1 s cycle forever (measured live at the
 * fold-corridor rest spot: a steady 0.286 blocked-frame duty cycle). Probing the base geometry
 * instead makes engagement a pure function of the PLAYER's position — the arm stays engaged as
 * long as the canyon would block the stock rig, and releases exactly once the player leaves it.
 */
export function springArmProbePos(out: Vec3, playerPos: Readonly<Vec3>, speed: number, tier: number): Vec3 {
  sphericalOffset(out, cameraDistance(speed, tier, 0));
  out.x += playerPos.x;
  out.y += playerPos.y;
  out.z += playerPos.z;
  return out;
}

function makeSpringArmModifier(cfg: CameraSpringArmConfig): CameraRigModifier {
  return (ctx) => {
    springArmProbePos(baseEyeScratch, ctx.playerPos, ctx.speed, ctx.tier);
    stepSpringArm(armState, probeNearField(baseEyeScratch, ctx.playerPos, cfg), ctx.dt, cfg);
    armResult.pitchOffsetDeg = armState.lift;
    armResult.distOffset = -armState.pull; // pull IN = less follow distance
    return armResult;
  };
}

// --- preset application -------------------------------------------------------------------------

/** The preset the lab last applied. 'E' by default because Phase 34 adopted E as the shipped
 * CAMERA block (test-locked identity), so a fresh session honestly reports the rig it is actually
 * running — a stale 'A' here would make the lab lie about the default boot. */
let activePresetId: CameraPresetId = 'E';

export function getCameraPreset(): CameraPresetId {
  return activePresetId;
}

export function findCameraPreset(id: string): CameraPresetEntry | null {
  return CAMERA_PRESETS.find((p) => p.id === id) ?? null;
}

/** `springArm` is optional on the interface but literally ABSENT from the four presets that don't
 * declare one, so the tuple's union members don't share the key — read it through this guard
 * rather than widening every entry to `CameraPreset` (which would throw away the id literals the
 * active-preset bookkeeping is typed on). */
export function springArmOf(preset: CameraPresetEntry): CameraSpringArmConfig | undefined {
  return 'springArm' in preset ? preset.springArm : undefined;
}

/** Same optional-key guard as springArmOf, for Phase 76's per-preset shared-leaf overrides. */
export function sharedOverridesOf(preset: CameraPreset): CameraSharedOverrides | undefined {
  return 'shared' in preset ? preset.shared : undefined;
}

/**
 * The value a preset resolves for one shared leaf: its own override if it declares one, otherwise
 * the module-init shipped default. NEVER "whatever the last applied preset left in CAMERA" — that
 * read is the contamination this whole seam exists to make impossible.
 */
export function resolveSharedLeaf(preset: CameraPreset, key: CameraSharedLeaf): number {
  return sharedOverridesOf(preset)?.[key] ?? CAMERA_SHARED_LEAF_DEFAULTS[key];
}

/**
 * Apply a candidate rig LIVE. Writes the preset's four geometry leaves into the runtime-mutable
 * CAMERA block (the rig picks yaw/pitch/distance up on the very next frame), writes a FULLY
 * RESOLVED set of the shared ramp/lead/damping leaves, pushes the FOV onto the live camera +
 * relatches the rig's FOV base, and registers or clears the spring-arm modifier so exactly the
 * presets that declare one run one.
 *
 * THE SHARED-LEAF WRITE IS TOTAL, AND THAT IS THE DESIGN (Phase 76). Once a preset may override a
 * leaf that used to be shared, switching J → E has to put E's ramp back or every later cell in a
 * battery is measured through the previous candidate's ramp — a silent, plausible-looking
 * contamination that would invalidate the phase's entire evidence set. The obvious fix is a
 * snapshot plus a restore list; the better one is to have no list to forget: every apply writes
 * EVERY shared leaf as `override ?? CAMERA_SHARED_LEAF_DEFAULTS[key]`, iterating the same
 * CAMERA_SHARED_LEAF_KEYS tuple that defines what "overridable" means. The write is then
 * idempotent, order-independent and history-free — applying E after J is identical to applying E
 * on a cold module — and a future leaf cannot become overridable without also becoming restorable,
 * because both come from the one tuple.
 *
 * `camera` may be null (the bridge can be called before the scene has published its handle): the
 * config side still applies and the call still succeeds — only the lens change needs the instance.
 * Returns false ONLY for an unknown preset id.
 */
export function applyCameraPreset(id: string, camera: PerspectiveCamera | null): boolean {
  const preset = findCameraPreset(id);
  if (!preset) return false;
  writeCameraLeaf('yawDeg', preset.yawDeg);
  writeCameraLeaf('pitchDeg', preset.pitchDeg);
  writeCameraLeaf('baseDist', preset.baseDist);
  writeCameraLeaf('fov', preset.fov);
  for (const key of CAMERA_SHARED_LEAF_KEYS) writeCameraLeaf(key, resolveSharedLeaf(preset, key));
  const arm = springArmOf(preset);
  resetSpringArm();
  setCameraRigModifier(arm ? makeSpringArmModifier(arm) : null);
  if (camera) {
    camera.fov = preset.fov;
    camera.updateProjectionMatrix();
  }
  // Always relatch, camera or not: the base must never outlive the FOV it was captured from.
  resetBaseFov();
  activePresetId = preset.id;
  return true;
}

/** Derived rest-state geometry for a preset: eye height and horizontal radius at `baseDist` (no
 * speed/tier zoom, no death beat). These are THE comparison numbers for the gate — and Phase 34's
 * law tests seed from the winner's pair. */
export function presetRestGeometry(preset: CameraPreset): { eyeHeight: number; horizontalRadius: number } {
  const pitch = (preset.pitchDeg * Math.PI) / 180;
  return {
    eyeHeight: preset.baseDist * Math.sin(pitch),
    horizontalRadius: preset.baseDist * Math.cos(pitch),
  };
}

/**
 * Absolute pitch (deg) at the TOP of a candidate's framing ramp — top speed at ★5, the pose
 * config/camera.ts's CAMERA_PITCH_MAX_DEG names for the shipped rig. Resolved through the
 * preset's own shared leaves, so a candidate that re-grades the ramp is evaluated on ITS ramp.
 *
 * This is the quantity the ~70° vertigo ceiling bounds, and the reason CameraPreset.shared exists:
 * a base pitch of 66-68 on the shipped +11.5° ramp saturates at 77.5-79.5°, i.e. the candidate is
 * undriveable and its drive evidence would be worthless. cameraLab.test.ts asserts the whole table
 * stays under the ceiling, which turns "declare a ramp override" from a note into a requirement.
 */
export function presetPitchMaxDeg(preset: CameraPreset): number {
  return (
    preset.pitchDeg +
    resolveSharedLeaf(preset, 'speedPitchDeg') +
    MAX_WANTED_TIER * resolveSharedLeaf(preset, 'tierPitchDeg')
  );
}

/** Saturated-pose geometry for a candidate: follow distance, absolute pitch, eye height and
 * horizontal radius at top speed / ★5 — both halves of ITS ramp fully in. The rest/saturated pair
 * is the honest read of a rig: E is the only candidate that ends up NARROWER than it rests (its
 * pitch ramp is large relative to its distance ramp), and the high-table candidates end up wider. */
export function presetSaturatedGeometry(preset: CameraPreset): {
  dist: number;
  pitchDeg: number;
  eyeHeight: number;
  horizontalRadius: number;
} {
  const dist =
    preset.baseDist + resolveSharedLeaf(preset, 'speedZoom') + MAX_WANTED_TIER * resolveSharedLeaf(preset, 'tierZoom');
  const pitchDeg = presetPitchMaxDeg(preset);
  const pitch = (pitchDeg * Math.PI) / 180;
  return { dist, pitchDeg, eyeHeight: dist * Math.sin(pitch), horizontalRadius: dist * Math.cos(pitch) };
}

/** What a candidate's resting eye implies for city massing (Phase 76 plan §3c). */
export interface PresetStreetwallCap {
  /** Resting eye height (wu) — the same number presetRestGeometry reports. */
  readonly eyeWu: number;
  /** The STREETWALL_MAX_HEIGHT_WU this rig would produce, via the SHIPPED derivation. */
  readonly capWu: number;
  /** Pack building models the cap would still bind on (manifest order); empty = inert. */
  readonly bindsOn: readonly string[];
  /** Convenience: does this cap re-mass anything at all? */
  readonly binds: boolean;
}

/**
 * The cascade nobody had listed before Phase 76: `STREETWALL_MAX_HEIGHT_WU` is DERIVED from the
 * resting camera eye, so a candidate that raises the eye raises the cap — and once the cap clears a
 * model's natural frontage-target height it stops binding, and the streetwall grows across most of
 * the city. Today the cap binds on `brown-building` alone (24.19 wu natural → 21.05 shipped) in 12
 * of 15 districts, so un-binding it is a ~3.1 wu, city-wide, visible change.
 *
 * A HEADLINE INPUT TO THE GATE, not a footnote: it may well be the *fix* for "there is no city in
 * the frame" rather than a side effect to manage — and if it isn't wanted, it is a cost. Either
 * way the user has to be shown it before picking, and T4 has to photograph a finalist with the
 * un-capped streetwall so the evidence is the real city rather than today's approximation of it.
 */
export function presetStreetwallCap(preset: CameraPreset): PresetStreetwallCap {
  const eyeWu = presetRestGeometry(preset).eyeHeight;
  const capWu = streetwallCapForEyeWu(eyeWu);
  const bindsOn = buildingsAboveCapWu(capWu);
  return { eyeWu, capWu, bindsOn, binds: bindsOn.length > 0 };
}
