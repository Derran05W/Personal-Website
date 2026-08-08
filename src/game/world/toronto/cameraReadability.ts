// Phase 76 camera lab — READABILITY instrumentation: the three questions the Phase 33 clip
// counters cannot answer.
//
// Phase 33/34 measured whether the camera is BROKEN (eye inside a wall, lens clipping a facade,
// car lost behind the streetwall). Rig E answers all three with 0.0% at every battery vantage —
// and the shipped build still shows, at `financial-canyon` / `yonge-dundas` / `kensington`,
// essentially no city at all: asphalt, crosswalks and the car (`.planning/screenshots/phase-76/
// baseline-E/`). Phase 75 doubled the ribbon widths and spent city-in-frame to buy navigability;
// no existing counter can see that, because "the frame is empty" is not a failure of any of them.
// The part file (`.planning/part-17-feel-drive-model.md` § Phase 76) asks the other half of the
// same question for the chase — "can you see the cops coming".
//
// So this module measures what the frame CONTAINS, not what it collides with:
//   1. pursuer visibility  — how many live pursuit units are on screen, and at what range they
//                            enter the frame (the part file's readability metric);
//   2. city-in-frame       — how much of the screen indexed building volume covers (the metric
//                            for the emptiness finding above);
//   3. ground band         — the depth of visible ground, via config/camera.ts's own
//                            `cameraGroundBandWu` (Phase 75 made it computable for exactly this).
//
// DEV-ONLY, exactly like the Phase 33 sampler that calls it: the single call site is the
// `import.meta.env.DEV` priority-2 `useFrame` in world/toronto/TorontoScene.tsx, so a production
// build eliminates the branch and tree-shakes this module out of the game chunk entirely (proven
// by grepping the built chunk, phase-76 notes). Nothing here is ever on a shipped frame.
//
// ZERO ALLOCATION IN THE HOT PATH: every three object (Frustum, Matrix4, Box3, Sphere, Vector3),
// the clip-space corner buffer, the polygon clip buffers, the coverage grid and both result objects
// are allocated ONCE at module scope and mutated in place — the same discipline fx/cameraRig.ts's
// `frameResult` follows. Results are REUSED objects: copy anything you keep past the call.
//
// COST — designed for, NOT yet measured live (T4 owns the live battery; if it reads high, the
// remaining lever is a bucket-grid query on the clip index rather than the linear pre-reject):
// `updateViewVolume` is 4 direction transforms; `measureCityInFrame` pays one cheap XZ distance
// compare per indexed box (~2.3k on the shipped map) plus a 2.3 KB grid clear, and an 8-corner
// projection + a six-plane polygon clip of the ≤ 3 eye-facing faces only for the handful inside the
// derived ground cutoff (at rig E that cutoff is ~30 wu, so the measured battery vantages reach the
// clip with 0–5 boxes). It is DEV cost either way — a production frame never executes any of it.

import { Box3, Frustum, Matrix4, Sphere, Vector3, type PerspectiveCamera } from 'three';
import { cameraGroundBandWu } from '../../config/camera';
import { CAR_REF } from '../../config/cityPackScale';
import type { ClipAabb } from './cameraClipIndex';
import type { CityFrameSample, PursuerVisibilityFrame } from './cameraClipStats';
import type { UnitSlot } from '../../ai/pursuitTypes';

/** A world position this module reads (player car, pursuer slot) — structurally what both
 * `VehicleState.pose.position` and a `UnitSlot` already are. */
export interface ReadabilityPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

// --- pursuer visibility --------------------------------------------------------------------

/**
 * Bounding-sphere radius (wu) used for the "is this pursuer on screen" test — half the diagonal
 * of the reference car's VISUAL envelope (config/cityPackScale.ts's CAR_REF, the same envelope
 * every car-derived road width and building frontage on this map is measured against), so a unit
 * whose centre is just outside the frustum but whose body is still painted still counts.
 *
 * DERIVED, not chosen: it is a fact about the reference car, so it moves if the car does. The
 * bigger pursuit classes (armored, tank) are under-approximated on purpose — a per-kind radius
 * would make "on screen" mean a different thing for each unit and the fleet mean would stop being
 * comparable between rigs, which is the only thing this metric is for.
 */
// Computed through a NILADIC helper so the initializer is one `@__PURE__` call with no argument
// expressions: measured against the built chunk, both `Math.hypot(CAR_REF.w, CAR_REF.l) / 2` and
// the inlined-argument form leave dead arithmetic behind in production (rollup drops the annotated
// call but keeps the member accesses, which could be getters). This form leaves NOTHING — the
// A/B'd prod chunk is byte-identical with and without this module (phase-76 notes).
export const PURSUER_SPHERE_RADIUS_WU = /* @__PURE__ */ carHalfDiagonalWu();

function carHalfDiagonalWu(): number {
  return Math.hypot(CAR_REF.widthWu / 2, CAR_REF.lengthWu / 2);
}

/**
 * Per-frame pursuer-visibility sampler with a per-slot on-screen LATCH — the state machine behind
 * `pursuerWarningDistanceM`.
 *
 * DEFINITIONS (precise, because a fuzzy metric is worse than none):
 *   • A pursuer is LIVE when `kind !== null && state === 'pursuing'` — byte-for-byte the predicate
 *     combat/runLoop.ts's `countPursuersNear` (the BUSTED enumeration) applies to the same
 *     `unitsRef.current.slots` array. The two are pinned together by a drift test rather than by a
 *     shared helper: making runLoop export its predicate would edit a production file for a
 *     dev-only metric, and this phase's whole premise is that it costs production nothing.
 *   • ON SCREEN = the caller-supplied predicate (in production use: the unit's bounding sphere
 *     intersects the live view frustum — `pursuerOnScreen` below).
 *   • A SIGHTING is an off→on transition of that flag for one slot. Its `distance` is measured
 *     PLAYER→PURSUER (not camera→pursuer): the gameplay question is how much road you have before
 *     it reaches you, and the camera's own standoff is the variable under test, so putting it in
 *     the numerator would make every candidate rig measure a different thing.
 *   • The reported mean is therefore "mean player→pursuer range over every appearance in the
 *     window", not "first sighting per unit". Re-appearances are real sightings (a cop that swings
 *     out of frame and back HAS to be re-noticed), and there is no dwell hysteresis: a unit
 *     hovering on the frame edge can log several sightings at nearly the same range. That inflates
 *     the DENOMINATOR, not the mean, which is why `sightings` is reported alongside it.
 *
 * LIFECYCLE: the latch for a slot is dropped the moment the slot stops being a live pursuer
 * (despawn, wreck, pool free), so a recycled slot starts fresh and the map is bounded by the
 * pursuit pool — no leak, and no phantom sighting inherited from the previous occupant.
 */
export interface PursuerVisibility {
  /** Sample one frame. Returns a REUSED result object. */
  sample(
    slots: readonly UnitSlot[],
    isOnScreen: (x: number, y: number, z: number) => boolean,
    playerPos: ReadabilityPoint,
  ): Readonly<PursuerVisibilityFrame>;
  /** Forget every latch (test isolation / world unmount). */
  reset(): void;
}

export function createPursuerVisibility(): PursuerVisibility {
  const onScreenLatch = new Map<number, boolean>();
  const frame: PursuerVisibilityFrame = {
    onScreen: 0,
    sightings: 0,
    sightingDistanceSumM: 0,
    sightingDistanceMaxM: 0,
  };
  return {
    sample(slots, isOnScreen, playerPos) {
      frame.onScreen = 0;
      frame.sightings = 0;
      frame.sightingDistanceSumM = 0;
      frame.sightingDistanceMaxM = 0;
      for (const slot of slots) {
        if (slot.kind === null || slot.state !== 'pursuing') {
          onScreenLatch.delete(slot.id);
          continue;
        }
        const visible = isOnScreen(slot.x, slot.y, slot.z);
        if (visible && onScreenLatch.get(slot.id) !== true) {
          const dx = slot.x - playerPos.x;
          const dy = slot.y - playerPos.y;
          const dz = slot.z - playerPos.z;
          const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
          frame.sightings++;
          frame.sightingDistanceSumM += range;
          if (range > frame.sightingDistanceMaxM) frame.sightingDistanceMaxM = range;
        }
        onScreenLatch.set(slot.id, visible);
        if (visible) frame.onScreen++;
      }
      return frame;
    },
    reset() {
      onScreenLatch.clear();
    },
  };
}

// --- the live view volume ------------------------------------------------------------------

const frustum = /* @__PURE__ */ new Frustum();
const viewProj = /* @__PURE__ */ new Matrix4();
const sphereScratch = /* @__PURE__ */ new Sphere();
const boxScratch = /* @__PURE__ */ new Box3();
const dirScratch = /* @__PURE__ */ new Vector3();
// Clip-space (x, y, w) of the 8 corners of the box under test — filled per box, never re-allocated.
// z is dropped: the near/far planes are expressed on w (= −z_view for a perspective matrix), which
// is all the six-plane clip below needs.
const cornerClip = /* @__PURE__ */ new Float64Array(8 * 3);
/**
 * The 6 faces of a corner-indexed box (bit 0 = X, bit 1 = Y, bit 2 = Z), each as a 4-corner
 * rectangle loop, in the order −X, +X, −Y, +Y, −Z, +Z (so face `f`'s outward axis is `f >> 1` and
 * its sign is `f & 1`). Flat + indexed rather than an array of tuples so the per-box walk allocates
 * neither an iterator nor a destructuring target.
 */
const BOX_FACES = /* @__PURE__ */ new Uint8Array([
  0, 2, 6, 4, 1, 3, 7, 5, 0, 1, 5, 4, 2, 3, 7, 6, 0, 1, 3, 2, 4, 5, 7, 6,
]);

/**
 * The six frustum half-spaces as clip-space linear functionals `d(x, y, w) = ax·x + ay·y + aw·w + c`,
 * kept ≥ 0 INSIDE — the canonical homogeneous clip volume (|x| ≤ w, |y| ≤ w) plus the depth pair,
 * which is expressed on w rather than z because that is the coordinate `cornerClip` carries.
 * Order: near, far, left, right, bottom, top. Only the two depth constants are dynamic;
 * `updateViewVolume` writes them per frame.
 */
const CLIP_PLANES = /* @__PURE__ */ new Float64Array([
  0, 0, 1, 0, 0, 0, -1, 0, 1, 0, 1, 0, -1, 0, 1, 0, 0, 1, 1, 0, 0, -1, 1, 0,
]);
const NEAR_PLANE_CONST = 3;
const FAR_PLANE_CONST = 7;

// Sutherland–Hodgman ping-pong buffers for ONE box face in clip space (x, y, w), plus the NDC
// projection of the survivor. A quad gains at most one vertex per clip plane, so 4 + 6 = 10 is the
// true bound; 16 is slack, and every write is guarded anyway.
const POLY_MAX_VERTS = 16;
const polyBufA = /* @__PURE__ */ new Float64Array(POLY_MAX_VERTS * 3);
const polyBufB = /* @__PURE__ */ new Float64Array(POLY_MAX_VERTS * 3);
const polyNdc = /* @__PURE__ */ new Float64Array(POLY_MAX_VERTS * 2);

let eyeX = 0;
let eyeY = 0;
let eyeZ = 0;
let nearW = 0;
// Horizontal (XZ) radius from the eye beyond which nothing at or above y = 0 can be in frame.
// Infinity = the derivation did not apply this frame (see groundCutoffWu) and every box is tested.
let groundCutoffWu = Infinity;

/**
 * Largest horizontal distance from the eye at which a point with y ≥ 0 can still be inside the
 * frustum — the cheap pre-reject that keeps `measureCityInFrame` off a full 6-plane test of all
 * ~2.3k indexed boxes.
 *
 * The frustum is a cone of directions whose extreme rays are its four corner rays. Along a ray
 * with `dir.y < 0`, y reaches 0 at horizontal distance `eyeY · |dir_xz| / −dir.y`; that quantity is
 * a norm over a positive linear function, i.e. quasi-convex on the cone, so its maximum over the
 * cone is attained at one of the four generators. Taking the max over the corner rays is therefore
 * EXACT, not a heuristic — no slack constant needed.
 *
 * Returns Infinity if any corner ray is horizontal or rising, i.e. the horizon is in frame. Phase
 * 38's visible-band law says that never happens on a legal rig (the shallowest frustum edge is
 * pitch − fov/2 = 39° below horizontal), but a lab that is about to try candidate rigs is exactly
 * where that law could stop holding, so the fallback is a full scan rather than a wrong answer.
 */
function groundCutoffFor(camera: PerspectiveCamera): number {
  const tanY = Math.tan((camera.fov * Math.PI) / 360);
  const tanX = tanY * camera.aspect;
  let maxHoriz = 0;
  for (let corner = 0; corner < 4; corner++) {
    dirScratch.set(corner & 1 ? tanX : -tanX, corner & 2 ? tanY : -tanY, -1);
    dirScratch.transformDirection(camera.matrixWorld);
    if (dirScratch.y >= 0) return Infinity;
    const horiz = (camera.position.y * Math.hypot(dirScratch.x, dirScratch.z)) / -dirScratch.y;
    if (!Number.isFinite(horiz)) return Infinity;
    if (horiz > maxHoriz) maxHoriz = horiz;
  }
  return maxHoriz;
}

/**
 * Capture the frame's view volume from the LIVE camera. Call once per frame, before
 * `isSphereOnScreen` / `measureCityInFrame`, from the priority-2 pass that already observes the
 * camera exactly as it was painted (clamp + anti-clip folded in).
 *
 * `camera.matrixWorldInverse` is refreshed by the caller's `updateMatrixWorld()` (three's
 * `Camera` override maintains it), and `projectionMatrix` is R3F's to keep current.
 */
export function updateViewVolume(camera: PerspectiveCamera): void {
  viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(viewProj);
  eyeX = camera.position.x;
  eyeY = camera.position.y;
  eyeZ = camera.position.z;
  // Strictly positive: every surviving clip vertex is divided by its w, and `w ≥ nearW` is the
  // only thing standing between that division and a zero denominator. A camera with near ≤ 0 is
  // not a legal perspective camera, but the metric answers with a degenerate-but-finite frame
  // rather than NaN if one ever arrives.
  nearW = camera.near > 0 ? camera.near : Number.EPSILON;
  CLIP_PLANES[NEAR_PLANE_CONST] = -nearW;
  CLIP_PLANES[FAR_PLANE_CONST] = camera.far;
  groundCutoffWu = groundCutoffFor(camera);
}

/** Does a bounding sphere at (x,y,z) intersect the captured view volume? */
export function isSphereOnScreen(x: number, y: number, z: number, radius: number): boolean {
  sphereScratch.center.set(x, y, z);
  sphereScratch.radius = radius;
  return frustum.intersectsSphere(sphereScratch);
}

/** The production visibility predicate for a pursuit unit (module-scope so the per-frame call
 * allocates no closure). */
function pursuerOnScreen(x: number, y: number, z: number): boolean {
  return isSphereOnScreen(x, y, z, PURSUER_SPHERE_RADIUS_WU);
}

const livePursuerVisibility = /* @__PURE__ */ createPursuerVisibility();

/** Sample this frame's pursuer visibility against the captured view volume. `updateViewVolume`
 * must have run for this frame first. Returns a REUSED object. */
export function samplePursuerVisibility(
  slots: readonly UnitSlot[],
  playerPos: ReadabilityPoint,
): Readonly<PursuerVisibilityFrame> {
  return livePursuerVisibility.sample(slots, pursuerOnScreen, playerPos);
}

/** Drop every per-slot latch (world unmount / test isolation). */
export function resetPursuerVisibility(): void {
  livePursuerVisibility.reset();
}

// --- city in frame -------------------------------------------------------------------------

// Screen-space occupancy grid, in NDC — NOT the framebuffer. Coverage is measured against a fixed
// 64×36 (16:9) lattice of the normalised viewport rather than against pixels, so the number is
// resolution-independent, DPR-independent, deterministic, and identical between a headless battery
// frame and a desktop one. 2,304 cells ≈ 1.6% of frame width per cell: finer than any judgement
// the contact sheet will make of it, and a 2.3 KB fill per frame. Implementation constants, not
// gameplay tunables — the same carve-out cameraClipIndex.ts's CELL_SIZE_WU takes.
//
// THE SAMPLING RULE IS CELL-CENTRE: a cell counts as city when its CENTRE lies inside a building's
// projected silhouette. That makes `coverage` a plain 2,304-point sample of the frame — the same
// number a 64×36 downsample of the painted image would give — with no systematic bias in either
// direction. (Marking every cell a silhouette merely TOUCHES would bias every reading upward by a
// boundary ring, which on a frame full of small buildings is not a rounding error.)
export const COVERAGE_GRID_COLS = 64;
export const COVERAGE_GRID_ROWS = 36;
const COVERAGE_CELLS = COVERAGE_GRID_COLS * COVERAGE_GRID_ROWS;
const coverageGrid = /* @__PURE__ */ new Uint8Array(COVERAGE_CELLS);

const cityFrame: CityFrameSample = { coverage: 0, boxesInFrame: 0, boxesTested: 0 };

// Set by `accumulateBoxCoverage` for the box it was just handed: did any part of that box's
// silhouette survive the six-plane clip, i.e. is the box ACTUALLY on screen. Module scope so the
// accumulator stays a plain function returning its cell count (see `measureCityInFrame`).
let boxOnScreen = false;
// Cleared by `measureCityInFrame` once the grid is saturated: the clip still runs (it decides
// `boxOnScreen`, and that must not depend on how full the grid happens to be), only the marking
// is skipped.
let markCells = true;

/** Mark every cell — the exact answer when the eye is inside a volume. Returns cells added. */
function fillCoverageGrid(): number {
  let added = 0;
  for (let i = 0; i < COVERAGE_CELLS; i++) {
    if (coverageGrid[i] === 0) {
      coverageGrid[i] = 1;
      added++;
    }
  }
  return added;
}

/** Closest squared XZ distance from the eye to a box (0 when the eye is over its footprint). */
function eyeDistanceSqXz(box: ClipAabb): number {
  const dx = eyeX < box.minX ? box.minX - eyeX : eyeX > box.maxX ? eyeX - box.maxX : 0;
  const dz = eyeZ < box.minZ ? box.minZ - eyeZ : eyeZ > box.maxZ ? eyeZ - box.maxZ : 0;
  return dx * dx + dz * dz;
}

/**
 * Clip the clip-space polygon in `src[0 .. 3n)` against one of `CLIP_PLANES` into `dst`; returns
 * the survivor's vertex count (0 = the face is entirely outside that half-space). Sutherland–
 * Hodgman on a single plane, run six times to clip a face against the whole frustum.
 *
 * Clipping in CLIP space rather than after the perspective divide is the whole point: a vertex
 * behind the eye has w < 0 and its "NDC" is a sign-flipped mirage, and one merely NEAR the eye
 * divides by ~0 and flies off to |NDC| in the hundreds. Neither survives to be measured — every
 * vertex this returns satisfies |x| ≤ w and |y| ≤ w with w ≥ nearW > 0, so its NDC is inside
 * [-1, 1] by construction.
 */
function clipPolygon(src: Float64Array, n: number, dst: Float64Array, plane: number): number {
  const p = plane * 4;
  const ax = CLIP_PLANES[p]!;
  const ay = CLIP_PLANES[p + 1]!;
  const aw = CLIP_PLANES[p + 2]!;
  const c = CLIP_PLANES[p + 3]!;
  let m = 0;
  for (let i = 0; i < n; i++) {
    const oi = i * 3;
    const oj = (i + 1 === n ? 0 : i + 1) * 3;
    const xi = src[oi]!;
    const yi = src[oi + 1]!;
    const wi = src[oi + 2]!;
    const xj = src[oj]!;
    const yj = src[oj + 1]!;
    const wj = src[oj + 2]!;
    const di = ax * xi + ay * yi + aw * wi + c;
    const dj = ax * xj + ay * yj + aw * wj + c;
    if (di >= 0 && m < POLY_MAX_VERTS) {
      dst[m * 3] = xi;
      dst[m * 3 + 1] = yi;
      dst[m * 3 + 2] = wi;
      m++;
    }
    if (di >= 0 !== dj >= 0 && m < POLY_MAX_VERTS) {
      const t = di / (di - dj);
      dst[m * 3] = xi + (xj - xi) * t;
      dst[m * 3 + 1] = yi + (yj - yi) * t;
      dst[m * 3 + 2] = wi + (wj - wi) * t;
      m++;
    }
  }
  return m;
}

/**
 * Scan-convert the convex NDC polygon in `polyNdc[0 .. 2n)` into the coverage grid, sampling cell
 * CENTRES. Returns the cells it newly covered.
 *
 * Convexity is not an assumption: a planar convex polygon whose vertices all have w > 0 projects to
 * a convex polygon (the perspective map is projective, and the clip above guarantees the face never
 * crosses the plane at infinity), so its intersection with any scanline is the single interval
 * between the extreme edge crossings — which is what makes this exact rather than a bound.
 */
function markConvexNdcPolygon(n: number): number {
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const y = polyNdc[i * 2 + 1]!;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  let row0 = Math.ceil(((yMin + 1) / 2) * COVERAGE_GRID_ROWS - 0.5);
  let row1 = Math.floor(((yMax + 1) / 2) * COVERAGE_GRID_ROWS - 0.5);
  if (row0 < 0) row0 = 0;
  if (row1 > COVERAGE_GRID_ROWS - 1) row1 = COVERAGE_GRID_ROWS - 1;
  let added = 0;
  for (let row = row0; row <= row1; row++) {
    const cy = ((row + 0.5) / COVERAGE_GRID_ROWS) * 2 - 1;
    let xLo = Infinity;
    let xHi = -Infinity;
    for (let i = 0; i < n; i++) {
      const j = i + 1 === n ? 0 : i + 1;
      const yi = polyNdc[i * 2 + 1]!;
      const yj = polyNdc[j * 2 + 1]!;
      // Half-open crossing rule (`<=` on one side only): a vertex sitting exactly on the scanline
      // is counted once, not twice, so a convex polygon can never report a spurious empty span.
      if (yi <= cy === yj <= cy) continue;
      const xi = polyNdc[i * 2]!;
      const xj = polyNdc[j * 2]!;
      const x = xi + (xj - xi) * ((cy - yi) / (yj - yi));
      if (x < xLo) xLo = x;
      if (x > xHi) xHi = x;
    }
    if (xLo > xHi) continue;
    let col0 = Math.ceil(((xLo + 1) / 2) * COVERAGE_GRID_COLS - 0.5);
    let col1 = Math.floor(((xHi + 1) / 2) * COVERAGE_GRID_COLS - 0.5);
    if (col0 < 0) col0 = 0;
    if (col1 > COVERAGE_GRID_COLS - 1) col1 = COVERAGE_GRID_COLS - 1;
    const base = row * COVERAGE_GRID_COLS;
    for (let col = col0; col <= col1; col++) {
      if (coverageGrid[base + col] === 0) {
        coverageGrid[base + col] = 1;
        added++;
      }
    }
  }
  return added;
}

/** Does face `f` of `box` (BOX_FACES order: −X, +X, −Y, +Y, −Z, +Z) face the eye? */
function faceFacesEye(f: number, box: ClipAabb): boolean {
  switch (f) {
    case 0:
      return eyeX < box.minX;
    case 1:
      return eyeX > box.maxX;
    case 2:
      return eyeY < box.minY;
    case 3:
      return eyeY > box.maxY;
    case 4:
      return eyeZ < box.minZ;
    default:
      return eyeZ > box.maxZ;
  }
}

/**
 * Screen footprint of one box, accumulated into the coverage grid. Returns the cells it added and
 * sets `boxOnScreen`.
 *
 * THE MEASUREMENT: the set of pixels whose eye ray hits the box. Because the eye is outside the box
 * (the inside case is early-outed), every such ray enters through a FRONT-FACING face — so that set
 * is exactly the union of the projections of the ≤ 3 faces turned toward the eye. Each face is
 * clipped against all six frustum planes in clip space and scan-converted; the union is the box's
 * true silhouette, to the resolution of the lattice.
 *
 * WHAT THIS REPLACES, AND WHY (Phase 76, found by the validate battery). The previous estimator took
 * the NDC BOUNDING RECT of the box's near-plane-clipped corners. That is not an upper bound on
 * anything useful: near-plane clipping puts vertices at w = near, and dividing by ~0 sends them to
 * |NDC| in the hundreds — in BOTH directions once a box straddles the eye plane, which the
 * streetwall running alongside the car at yaw 45 does constantly. The bounding rect of a point at
 * NDC x = −1021 and one at +1.2 is the whole screen. Measured at the shipped rig, vantage `spawn`:
 * ONE box (the Eaton Centre galleria, resting 17.7 wu west of the eye and spanning 129 wu of z
 * through the eye plane) reported 100.0 % of the frame against a ray-traced truth of 18.8 %.
 * Clipping the polygon instead of bounding it removes the failure at the source: nothing that is
 * not on screen can contribute a coordinate to the measurement.
 */
function accumulateBoxCoverage(box: ClipAabb): number {
  boxOnScreen = false;
  // Eye strictly inside the volume ⇒ it fills the view. Exact and free — and the front-face
  // argument above needs the eye outside, so this is a precondition, not an optimisation.
  if (
    eyeX >= box.minX &&
    eyeX <= box.maxX &&
    eyeY >= box.minY &&
    eyeY <= box.maxY &&
    eyeZ >= box.minZ &&
    eyeZ <= box.maxZ
  ) {
    boxOnScreen = true;
    return markCells ? fillCoverageGrid() : 0;
  }
  const e = viewProj.elements;
  for (let corner = 0; corner < 8; corner++) {
    const x = corner & 1 ? box.maxX : box.minX;
    const y = corner & 2 ? box.maxY : box.minY;
    const z = corner & 4 ? box.maxZ : box.minZ;
    const o = corner * 3;
    cornerClip[o] = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!;
    cornerClip[o + 1] = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!;
    cornerClip[o + 2] = e[3]! * x + e[7]! * y + e[11]! * z + e[15]!;
  }
  let added = 0;
  for (let f = 0; f < 6; f++) {
    if (!faceFacesEye(f, box)) continue;
    let src = polyBufA;
    let dst = polyBufB;
    for (let k = 0; k < 4; k++) {
      const o = BOX_FACES[f * 4 + k]! * 3;
      src[k * 3] = cornerClip[o]!;
      src[k * 3 + 1] = cornerClip[o + 1]!;
      src[k * 3 + 2] = cornerClip[o + 2]!;
    }
    let n = 4;
    for (let plane = 0; plane < 6 && n >= 3; plane++) {
      n = clipPolygon(src, n, dst, plane);
      const swap = src;
      src = dst;
      dst = swap;
    }
    if (n < 3) continue;
    boxOnScreen = true;
    if (!markCells) continue;
    for (let i = 0; i < n; i++) {
      const w = src[i * 3 + 2]!;
      polyNdc[i * 2] = src[i * 3]! / w;
      polyNdc[i * 2 + 1] = src[i * 3 + 1]! / w;
    }
    added += markConvexNdcPolygon(n);
  }
  return added;
}

/**
 * How much of the frame the city occupies this sample. `updateViewVolume` must have run for this
 * frame first. Returns a REUSED object.
 *
 * WHAT `coverage` MEANS: the fraction of a fixed 64×36 lattice of the frame whose sample point
 * lands on an indexed building volume — i.e. "of 2,304 evenly spread pixels, how many show city".
 * Each box contributes the union of its ≤ 3 eye-facing faces, clipped against all six frustum
 * planes and scan-converted, so the figure is the true projected silhouette to lattice resolution,
 * not a bound. It is comparable across rigs of different FOV, pitch and distance precisely because
 * it is measured in NDC — a wider lens that pulls more streetwall into view raises it, which is the
 * whole point.
 *
 * `boxesInFrame` counts the volumes with a NON-EMPTY on-screen silhouette, decided by that same
 * clip. It is deliberately NOT `frustum.intersectsBox`, whose six half-space test is conservative:
 * at the shipped rig, vantage `minor-midblock`, it passed a backdrop box sitting entirely BEHIND
 * the eye that no ray in the frame can reach (ray-traced truth: 0 % of the frame, 0 pixels).
 *
 * WHAT IT DOES NOT MEAN — read these before quoting the number:
 *   • It measures INDEXED VOLUME, not painted pixels, and the two differ in one direction: a
 *     building the renderer has faded (Phase 36's dither / the named-mesh opacity path) still
 *     counts in full. Nothing else diverges — the index is toggle-blind and the renderer's own
 *     frustum culling removes exactly what this clip removes — so the bias is "≥ what is painted",
 *     bounded by whatever is mid-fade, and never the reverse.
 *   • The volume is the AABB, so a building that does not fill its own box (the hero bases, a
 *     stepped landmark) reads slightly high.
 *   • It is not depth-sorted: a box behind another box adds nothing (the union handles that), but a
 *     box behind the GROUND or below the road surface still counts. On this map buildings sit on
 *     y ≥ 0 with the camera above them, so this is a non-issue in practice, not a guarantee.
 *   • "City in frame" is not "city you can READ". At `spawn` this reports ~19 %, and every one of
 *     those samples is the Eaton Centre galleria's flat 10.9 wu ROOF seen from a 22 wu eye — dark,
 *     edge-on to nothing, and photographed as indistinguishable from background. The metric is
 *     evidence for the emptiness question, not a verdict on it; the contact sheet is the verdict.
 *   • Its scope is the clip index's scope — BUILDING-CLASS volumes only (frontage streetwall,
 *     corner fills, backdrop/back-lot boxes, named landmarks, the two hero bases). Trees, traffic
 *     lights, parked cars, medians and every other prop are NOT city for this metric. That is the
 *     right scope for the question ("is there a city in the frame or just asphalt") and the wrong
 *     one for "is the frame busy".
 *   • 0 coverage with `boxesTested === 0` means the index is empty (world not mounted) — the same
 *     trap `cameraClipIndexSize()` exists to catch. Check the denominator before believing a zero.
 */
export function measureCityInFrame(boxes: readonly ClipAabb[]): Readonly<CityFrameSample> {
  coverageGrid.fill(0);
  cityFrame.coverage = 0;
  cityFrame.boxesInFrame = 0;
  cityFrame.boxesTested = boxes.length;
  if (boxes.length === 0) return cityFrame;
  const cutoffSq = groundCutoffWu === Infinity ? Infinity : groundCutoffWu * groundCutoffWu;
  let covered = 0;
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i]!;
    // Cheap XZ pre-reject. Only sound for volumes that start at or above the ground plane the
    // cutoff was derived against — the index's own Y convention (minY = 0 for every box), but
    // asserted per box rather than assumed, so a future volume that dips below ground is simply
    // tested in full instead of silently vanishing from the metric.
    if (box.minY >= 0 && eyeDistanceSqXz(box) > cutoffSq) continue;
    boxScratch.min.set(box.minX, box.minY, box.minZ);
    boxScratch.max.set(box.maxX, box.maxY, box.maxZ);
    // CONSERVATIVE REJECT ONLY — it never discards a box that is on screen, and the exact answer
    // comes from the clip below. It earns its place by keeping the six-plane polygon work off the
    // boxes the ground cutoff could not already dismiss.
    if (!frustum.intersectsBox(boxScratch)) continue;
    markCells = covered < COVERAGE_CELLS;
    const added = accumulateBoxCoverage(box);
    if (!boxOnScreen) continue;
    cityFrame.boxesInFrame++;
    covered += added;
  }
  cityFrame.coverage = covered / COVERAGE_CELLS;
  return cityFrame;
}

// --- visible ground band -------------------------------------------------------------------

/**
 * Depth (wu) of the ground strip this frame actually shows, from the PAINTED camera pose.
 *
 * Delegates the geometry to config/camera.ts's `cameraGroundBandWu` — Phase 75 derived it there
 * precisely so no consumer re-derives it — and only supplies the two live arguments:
 *   • `eyeWu` = eye height above the CAR's origin, the same convention `CAMERA_EYE_MIN_WU` /
 *     `CAMERA_EYE_MAX_WU` use (the rig adds its spherical offset to the player position), so a
 *     measured band sits directly alongside those two constants;
 *   • `absPitchDeg` = the declination of the eye→car boresight, i.e. the rig's actual pitch this
 *     frame INCLUDING the speed/tier ramp, the death beat, damping lag and any anti-clip pull.
 *
 * Deliberately NOT the camera's view direction: the look-ahead lead PANS the band forward without
 * resizing it, and taking the lead's shallower declination would let the band diverge toward
 * infinity as the view tips toward the horizon. Candidate K (look-ahead) is judged on where the
 * band sits, which is a screenshot question, not on how deep it is.
 *
 * `cameraGroundBandWu` reads `CAMERA.fov` — the rig leaf, which fx/cameraLab.ts's preset apply
 * writes in lockstep with the live camera's `fov` — so each candidate is measured at its own lens
 * and a transient FOV kick does not perturb the reading.
 *
 * Returns null when the pose is degenerate (no separation, eye at or below the car, or a
 * non-finite band) rather than a number nobody can defend.
 */
export function frameGroundBandWu(eye: ReadabilityPoint, car: ReadabilityPoint): number | null {
  const dx = eye.x - car.x;
  const dy = eye.y - car.y;
  const dz = eye.z - car.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dy <= 0 || dist <= 0 || dy > dist) return null;
  const band = cameraGroundBandWu(dy, Math.asin(dy / dist) * (180 / Math.PI));
  return Number.isFinite(band) && band > 0 ? band : null;
}
