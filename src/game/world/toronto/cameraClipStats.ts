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
//
// PHASE 76 adds the READABILITY block (bottom of CameraClipStats): pursuer visibility, city in
// frame, visible ground band — "what does the frame show", the question rig E answers with 0.0%
// on every counter above while showing a street of empty asphalt. The geometry that produces
// those samples needs three and lives in the sibling world/toronto/cameraReadability.ts; this
// module keeps only the contract (the two sample shapes) and the accumulation, so it stays
// three-free and directly unit-testable.

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
  /** Frames on which the polygon camera clamp actually MOVED the camera. Phase 33 counted these
   * because each one also cost a second gl.render(); Phase 34 folded the clamp into fx/cameraRig's
   * position-constraint seam, so the extra render is gone and the counter now means exactly what
   * it says: how much of a measured window the camera spent pinned against the map edge (expect
   * 0 mid-map, non-zero within ~a camera-length of a boundary). */
  readonly clampedFrames: number;
  /** Frames where ≥1 INDEXED building sat on the eye→car segment. The occluded* counters above
   * only see the ~18 registered named/hero meshes; this is the full-coverage version against the
   * AABB index — it is what catches "the car vanished behind the streetwall" (a frame can read
   * eye-outside yet show nothing but wall; the first tuning round proved exactly that at the
   * fold corridor under presets C/E). Counted only on frames a player vehicle exists. */
  readonly boresightBlockedFrames: number;
  /** Sum of per-frame indexed boresight hits (÷ boresightBlockedFrames = mean depth of cover). */
  readonly boresightHitSum: number;
  /** Phase 76 — the READABILITY block: what the frame CONTAINS, rather than what it collides
   * with. Sampled from the same priority-2 pass, on the frames a player vehicle exists (its own
   * `frames` denominator, which is ≤ the `frames` above). See world/toronto/cameraReadability.ts
   * for every definition. */
  readonly readability: CameraReadabilityStats;
}

// --- Phase 76 readability (see world/toronto/cameraReadability.ts for the measurement) --------
// The two sample SHAPES live here, with the counters, so the metric contract has one home: the
// geometry module produces them, this module accumulates them, the bridge serialises them.

/** One frame of pursuer visibility. Produced by cameraReadability's `samplePursuerVisibility`. */
export interface PursuerVisibilityFrame {
  /** Live pursuit units whose bounding sphere is inside the view frustum this frame. */
  onScreen: number;
  /** Off→on transitions this frame (a unit ENTERING the frame). */
  sightings: number;
  /** Σ player→pursuer distance (m) over this frame's sightings. */
  sightingDistanceSumM: number;
  /** Longest player→pursuer distance (m) among this frame's sightings (0 if none). */
  sightingDistanceMaxM: number;
}

/** One frame of city-in-frame measurement. Produced by cameraReadability's `measureCityInFrame`. */
export interface CityFrameSample {
  /** Fraction (0..1) of the NDC occupancy lattice covered by indexed building volume. */
  coverage: number;
  /** How many indexed building volumes intersected the frustum. */
  boxesInFrame: number;
  /** How many the index held at all — the sanity denominator (0 = world not mounted). */
  boxesTested: number;
}

export interface CameraReadabilityStats {
  /** Frames the readability pass sampled (denominator for the sums below). Zero means the pass
   * never ran — a player vehicle must exist — NOT that the frame was empty. */
  readonly frames: number;
  /** Σ per-frame on-screen live-pursuer counts. */
  readonly onScreenPursuerSum: number;
  /** Worst (highest) single-frame on-screen pursuer count. */
  readonly onScreenPursuerMax: number;
  /** Off→on pursuer transitions in the window (the warning-distance denominator). */
  readonly sightings: number;
  /** Σ player→pursuer distance (m) at those transitions. */
  readonly sightingDistanceSumM: number;
  /** Longest single warning distance (m) in the window. */
  readonly sightingDistanceMaxM: number;
  /** Σ per-frame city coverage fraction. */
  readonly cityCoverageSum: number;
  /** Σ per-frame count of indexed building volumes inside the frustum. */
  readonly cityBoxesInFrameSum: number;
  /** Indexed building volumes the last sampled frame tested — the "is the index populated at all"
   * gate. A window of zero coverage with this at 0 is an unmounted world, not a clean read. */
  readonly cityBoxesTested: number;
  /** Frames the ground band was measurable on (its own denominator — a degenerate pose yields no
   * band; see cameraReadability's frameGroundBandWu). */
  readonly groundBandFrames: number;
  /** Σ visible ground-band depth (wu) over those frames. */
  readonly groundBandSumWu: number;

  // --- derived (null when the corresponding denominator is 0 — never a fake zero) -------------
  /** MEAN on-screen live pursuers per sampled frame. The part file's "can you see the cops
   * coming" headline. */
  readonly onScreenPursuerCount: number | null;
  /** MEAN player→pursuer distance (m) at which a pursuer entered the frame. */
  readonly pursuerWarningDistanceM: number | null;
  /** MEAN fraction of the frame covered by indexed building volume. */
  readonly cityInFrameFraction: number | null;
  /** MEAN visible ground-band depth (wu). */
  readonly groundBandWu: number | null;
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
let readabilityFrames = 0;
let onScreenPursuerSum = 0;
let onScreenPursuerMax = 0;
let sightings = 0;
let sightingDistanceSumM = 0;
let sightingDistanceMaxM = 0;
let cityCoverageSum = 0;
let cityBoxesInFrameSum = 0;
let cityBoxesTested = 0;
let groundBandFrames = 0;
let groundBandSumWu = 0;

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

/**
 * Phase 76 — accumulate one frame of READABILITY (pursuer visibility + city-in-frame + ground
 * band). Called once per rendered frame from the same priority-2 pass as `sampleCameraClip`, on
 * the frames a player vehicle exists (the warning distance and the band are both measured against
 * the car, so a frame without one has nothing to say).
 *
 * Both arguments are the producer's REUSED result objects — this function reads them and keeps
 * nothing, so the hot path allocates nothing. `groundBandWu` is null on a degenerate pose and is
 * then excluded from its own denominator rather than counted as zero.
 */
export function sampleCameraReadability(
  pursuers: Readonly<PursuerVisibilityFrame>,
  city: Readonly<CityFrameSample>,
  groundBandWu: number | null,
): void {
  readabilityFrames++;
  onScreenPursuerSum += pursuers.onScreen;
  if (pursuers.onScreen > onScreenPursuerMax) onScreenPursuerMax = pursuers.onScreen;
  sightings += pursuers.sightings;
  sightingDistanceSumM += pursuers.sightingDistanceSumM;
  if (pursuers.sightingDistanceMaxM > sightingDistanceMaxM) {
    sightingDistanceMaxM = pursuers.sightingDistanceMaxM;
  }
  cityCoverageSum += city.coverage;
  cityBoxesInFrameSum += city.boxesInFrame;
  cityBoxesTested = city.boxesTested;
  if (groundBandWu !== null) {
    groundBandFrames++;
    groundBandSumWu += groundBandWu;
  }
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
  readabilityFrames = 0;
  onScreenPursuerSum = 0;
  onScreenPursuerMax = 0;
  sightings = 0;
  sightingDistanceSumM = 0;
  sightingDistanceMaxM = 0;
  cityCoverageSum = 0;
  cityBoxesInFrameSum = 0;
  cityBoxesTested = 0;
  groundBandFrames = 0;
  groundBandSumWu = 0;
  // NOT reset here: cameraReadability's per-slot on-screen latches. They describe the WORLD (which
  // cops are currently in frame), not the measurement window, and clearing them would manufacture
  // a fresh "sighting" — at whatever range it happened to be at — for every cop already on screen
  // the instant a battery opens a window. The latch self-clears when a slot stops being a live
  // pursuer, so it is bounded by the pursuit pool either way.
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
    readability: {
      frames: readabilityFrames,
      onScreenPursuerSum,
      onScreenPursuerMax,
      sightings,
      sightingDistanceSumM,
      sightingDistanceMaxM,
      cityCoverageSum,
      cityBoxesInFrameSum,
      cityBoxesTested,
      groundBandFrames,
      groundBandSumWu,
      onScreenPursuerCount: readabilityFrames === 0 ? null : onScreenPursuerSum / readabilityFrames,
      pursuerWarningDistanceM: sightings === 0 ? null : sightingDistanceSumM / sightings,
      cityInFrameFraction: readabilityFrames === 0 ? null : cityCoverageSum / readabilityFrames,
      groundBandWu: groundBandFrames === 0 ? null : groundBandSumWu / groundBandFrames,
    },
  };
}
