// Phase 33 camera lab — clip statistics. The OBJECTIVE half of the camera decision: five plain
// counters that turn "the camera phases through buildings" from a complaint into a number that
// can be compared across candidate rigs on an identical scripted drive.
//
// Every counter is a FRAME count (or a per-frame sum), never a wall-clock figure: headless fps is
// unstable, so the battery compares RATES (counter / frames) between presets and between repeat
// runs of the same seeded drive. Reset before a measured stretch, read after.
//
// Written exclusively from `import.meta.env.DEV` branches in world/toronto/TorontoScene.tsx and
// read through core/debugBridge.ts / core/devPanel.tsx. Pure module state — no three, no React —
// so the accumulation rules are unit-tested exactly as they run. Phase 36 promotes the
// eye-inside-building test into a permanent anti-clip guard; these counters are its evidence base.

export interface CameraClipStats {
  /** Frames sampled since the last reset (the denominator for every rate below). */
  readonly frames: number;
  /** Frames whose camera eye was INSIDE a building volume — the headline failure. */
  readonly eyeInsideFrames: number;
  /** Frames where any near-plane corner was inside a building (the lens is clipping through a
   * wall even though the eye point itself is still outside it). */
  readonly nearPlaneFrames: number;
  /** Frames where at least one occluder sat on the camera→car ray. */
  readonly occludedFrames: number;
  /** Sum of per-frame occluder hit counts (÷ frames = mean occluders on the boresight). */
  readonly occlusionHitSum: number;
  /** Worst single-frame occluder count seen. */
  readonly occlusionHitMax: number;
  /** Frames on which the polygon camera clamp actually acted (it also costs a second
   * gl.render() — Phase 34 reworks the clamp and wants this baseline per rig). */
  readonly clampedFrames: number;
  /** Frames where ≥1 INDEXED building sat on the eye→car segment. The occluded* counters above
   * only see the ~18 registered named/hero meshes; this is the full-coverage version against the
   * AABB index — it is what catches "the car vanished behind the streetwall" (a frame can read
   * eye-outside yet show nothing but wall; the first tuning round proved exactly that at the
   * fold corridor under presets C/E). Counted only on frames a player vehicle exists. */
  readonly boresightBlockedFrames: number;
  /** Sum of per-frame indexed boresight hits (÷ boresightBlockedFrames = mean depth of cover). */
  readonly boresightHitSum: number;
}

let frames = 0;
let eyeInsideFrames = 0;
let nearPlaneFrames = 0;
let occludedFrames = 0;
let occlusionHitSum = 0;
let occlusionHitMax = 0;
let clampedFrames = 0;
let boresightBlockedFrames = 0;
let boresightHitSum = 0;

/** One sampled frame: whether the eye was inside a building, whether the near plane clipped one,
 * and how many indexed buildings sat on the eye→car segment (`null` = no player vehicle this
 * frame — GARAGE/menus — so no boresight to measure; the frame still counts in the denominator,
 * but every measured battery window runs in PLAYING where a car always exists). Advances the
 * frame denominator — call it exactly once per rendered frame. */
export function sampleCameraClip(
  eyeInside: boolean,
  nearPlaneInside: boolean,
  boresightHits: number | null = null,
): void {
  frames++;
  if (eyeInside) eyeInsideFrames++;
  if (nearPlaneInside) nearPlaneFrames++;
  if (boresightHits !== null && boresightHits > 0) {
    boresightBlockedFrames++;
    boresightHitSum += boresightHits;
  }
}

/** Record this frame's camera→car occluder count (0 = clear). Fed by the occlusion-fade pass,
 * which already computes the hit list — this never casts its own ray. */
export function recordOcclusionHits(hits: number): void {
  if (hits <= 0) return;
  occludedFrames++;
  occlusionHitSum += hits;
  if (hits > occlusionHitMax) occlusionHitMax = hits;
}

/** Record that the camera clamp acted this frame. */
export function recordClampFired(): void {
  clampedFrames++;
}

/** Zero every counter (start of a measured drive). */
export function resetCameraClipStats(): void {
  frames = 0;
  eyeInsideFrames = 0;
  nearPlaneFrames = 0;
  occludedFrames = 0;
  occlusionHitSum = 0;
  occlusionHitMax = 0;
  clampedFrames = 0;
  boresightBlockedFrames = 0;
  boresightHitSum = 0;
}

/** Plain snapshot (no functions — safe to serialize across page.evaluate). */
export function readCameraClipStats(): CameraClipStats {
  return {
    frames,
    eyeInsideFrames,
    nearPlaneFrames,
    occludedFrames,
    occlusionHitSum,
    occlusionHitMax,
    clampedFrames,
    boresightBlockedFrames,
    boresightHitSum,
  };
}
