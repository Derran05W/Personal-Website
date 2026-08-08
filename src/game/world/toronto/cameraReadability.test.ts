// Phase 76 camera lab — readability instrumentation. The metrics are the evidence the camera
// decision gets made on, so their geometry is pinned here rather than eyeballed off a contact
// sheet: a frustum test that quietly reported everything on screen, or a coverage number that
// tracked box COUNT instead of screen area, would produce a confident wrong recommendation.
//
// THE CONTROLS, AND WHY THEY EXIST (added after the metric shipped broken). `cityInFrameFraction`
// read 100.0 % at the shipped rig's spawn vantage off a single box, against a true 18.8 %, because
// the estimator bounded a near-plane-clipped silhouette with an axis-aligned RECT and a box
// straddling the eye plane throws vertices to |NDC| in the hundreds on both sides. Nothing in this
// file could have caught it: every city-in-frame test was a hand-built scene whose answer was
// argued rather than measured, and the pursuer metrics — which had never once returned non-zero in
// the field — were only ever exercised through `always`/`never` stubs, so their live geometry was
// never on trial at all. Both are now pinned against controls:
//   • an independent RAY-TRACED ORACLE (`rayTracedCoverage`) that shares no code with the
//     estimator, run over the REAL spawn scene and over a randomized pose sweep;
//   • a positive and a negative control for each metric, plus monotonicity, plus the pursuer
//     visibility ENVELOPE — the measurement that explains the field zeros without excusing them.
import { beforeEach, describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { countPursuersNear } from '../../combat/runLoop';
import type { UnitKind, UnitSlot, UnitState } from '../../ai/pursuitTypes';
import {
  readCameraClipStats,
  resetCameraClipStats,
  sampleCameraReadability,
} from './cameraClipStats';
import type { ClipAabb } from './cameraClipIndex';
import {
  COVERAGE_GRID_COLS,
  COVERAGE_GRID_ROWS,
  PURSUER_SPHERE_RADIUS_WU,
  createPursuerVisibility,
  frameGroundBandWu,
  isSphereOnScreen,
  measureCityInFrame,
  resetPursuerVisibility,
  samplePursuerVisibility,
  updateViewVolume,
} from './cameraReadability';
import { CAMERA, CAMERA_EYE_MIN_WU, cameraGroundBandWu } from '../../config/camera';
import { TORONTO_SPAWN } from '../../config/torontoMap';
import { WORLD_GEN } from '../../config/world';
import { composeWorld } from './composeWorld';

const DEG2RAD = Math.PI / 180;

/** A camera at `eye` looking at `target`, matrices refreshed exactly as the scene pass leaves
 * them (updateMatrixWorld also refreshes matrixWorldInverse on a three Camera). */
function cameraAt(
  eye: readonly [number, number, number],
  target: readonly [number, number, number],
  fov: number = CAMERA.fov,
): PerspectiveCamera {
  const camera = new PerspectiveCamera(fov, 16 / 9, 0.1, 1000);
  camera.position.set(eye[0], eye[1], eye[2]);
  camera.lookAt(target[0], target[1], target[2]);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

/** The shipped rig's rest pose over a car at `(cx, 0, cz)`: yaw 45, pitch 58, dist 26. Same
 * spherical offset fx/cameraRig solves for at rest, so a pose reconstructed here is the pose the
 * battery photographed — which is what makes the spawn regression below the REAL failing case. */
function restRigCameraOver(cx: number, cz: number): PerspectiveCamera {
  const pitch = CAMERA.pitchDeg * DEG2RAD;
  const yaw = CAMERA.yawDeg * DEG2RAD;
  const d = CAMERA.baseDist;
  return cameraAt(
    [
      cx + d * Math.cos(pitch) * Math.sin(yaw),
      d * Math.sin(pitch),
      cz + d * Math.cos(pitch) * Math.cos(yaw),
    ],
    [cx, 0, cz],
  );
}

function restRigCamera(): PerspectiveCamera {
  return restRigCameraOver(0, 0);
}

// --- the ray-traced oracle ---------------------------------------------------------------------
// An INDEPENDENT second implementation of "what fraction of the frame shows city", sharing not one
// line with the estimator: unproject each of the 64×36 lattice sample points, cast the eye ray, and
// slab-test it against every box. That is the definition the metric's name claims, computed the
// slow honest way — so agreement between the two is evidence rather than a tautology, and the
// original defect (100 % on a frame whose true answer was 18.8 %) fails it by 81 points.

const rayDir = new Vector3();

function rayHitsBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  b: ClipAabb,
): boolean {
  let tMin = 0;
  let tMax = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const o = axis === 0 ? ox : axis === 1 ? oy : oz;
    const d = axis === 0 ? dx : axis === 1 ? dy : dz;
    const lo = axis === 0 ? b.minX : axis === 1 ? b.minY : b.minZ;
    const hi = axis === 0 ? b.maxX : axis === 1 ? b.maxY : b.maxZ;
    if (d === 0) {
      if (o < lo || o > hi) return false;
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return false;
  }
  return true;
}

/** Fraction of the 64×36 lattice sample points whose eye ray hits any box. */
function rayTracedCoverage(camera: PerspectiveCamera, boxes: readonly ClipAabb[]): number {
  const eye = camera.position;
  let hits = 0;
  for (let row = 0; row < COVERAGE_GRID_ROWS; row++) {
    const ndcY = ((row + 0.5) / COVERAGE_GRID_ROWS) * 2 - 1;
    for (let col = 0; col < COVERAGE_GRID_COLS; col++) {
      const ndcX = ((col + 0.5) / COVERAGE_GRID_COLS) * 2 - 1;
      rayDir.set(ndcX, ndcY, 0.5).unproject(camera).sub(eye).normalize();
      for (const b of boxes) {
        if (rayHitsBox(eye.x, eye.y, eye.z, rayDir.x, rayDir.y, rayDir.z, b)) {
          hits++;
          break;
        }
      }
    }
  }
  return hits / (COVERAGE_GRID_COLS * COVERAGE_GRID_ROWS);
}

/** Difference between two coverage fractions, expressed in LATTICE CELLS — the unit the tolerance
 * below is actually stated in, so a comparison cannot fail by a float ulp on an exact one-cell
 * disagreement. */
function cellsApart(a: number, b: number): number {
  return Math.abs(a - b) * COVERAGE_GRID_COLS * COVERAGE_GRID_ROWS;
}

function slot(over: Partial<UnitSlot> & { id: number }): UnitSlot {
  return {
    id: over.id,
    // `??` would swallow an explicit `kind: null` (a FREE pool slot), which is exactly the case
    // these tests are about — so presence, not nullishness, decides.
    kind: 'kind' in over ? (over.kind ?? null) : 'police',
    state: over.state ?? 'pursuing',
    x: over.x ?? 0,
    y: over.y ?? 0,
    z: over.z ?? 0,
    qx: 0,
    qy: 0,
    qz: 0,
    qw: 1,
    hp: over.hp ?? 10,
    behaviorLabel: over.behaviorLabel ?? 'pursue',
  };
}

/** A box centred at (x,z) with a square footprint and a floor at y=0 — the clip index's own Y
 * convention (see cameraClipIndex.ts's header). */
function box(x: number, z: number, half: number, height: number): ClipAabb {
  return {
    minX: x - half,
    maxX: x + half,
    minY: 0,
    maxY: height,
    minZ: z - half,
    maxZ: z + half,
  };
}

beforeEach(() => {
  resetPursuerVisibility();
  // The readability counters are module state accumulated across frames; the positive controls
  // below read them back, so every test starts from a zeroed window.
  resetCameraClipStats();
});

// --- frustum membership ----------------------------------------------------------------------

describe('isSphereOnScreen (view-volume membership)', () => {
  it('sees a point ahead of the camera and not one behind it', () => {
    updateViewVolume(cameraAt([0, 0, 0], [0, 0, -1]));
    expect(isSphereOnScreen(0, 0, -20, 1)).toBe(true);
    expect(isSphereOnScreen(0, 0, 20, 1)).toBe(false);
  });

  it('is a SPHERE test, not a point test — a body straddling the frame edge counts', () => {
    const camera = cameraAt([0, 0, 0], [0, 0, -1]);
    updateViewVolume(camera);
    // Horizontal half-angle of the frame at 20 m out.
    const halfW = 20 * Math.tan((camera.fov * DEG2RAD) / 2) * camera.aspect;
    const justOutside = halfW + PURSUER_SPHERE_RADIUS_WU * 0.5;
    expect(isSphereOnScreen(justOutside, 0, -20, 0)).toBe(false);
    expect(isSphereOnScreen(justOutside, 0, -20, PURSUER_SPHERE_RADIUS_WU)).toBe(true);
  });

  it('under the shipped rig, the car it follows is on screen and a cop 200 m away is not', () => {
    updateViewVolume(restRigCamera());
    expect(isSphereOnScreen(0, 0, 0, PURSUER_SPHERE_RADIUS_WU)).toBe(true);
    expect(isSphereOnScreen(200, 0, 200, PURSUER_SPHERE_RADIUS_WU)).toBe(false);
  });

  it('derives the pursuer radius from the reference car, not a literal', () => {
    // Half the diagonal of CAR_REF's 2.2 x 4.5 visual envelope.
    expect(PURSUER_SPHERE_RADIUS_WU).toBeCloseTo(Math.hypot(2.2, 4.5) / 2, 10);
  });
});

// --- pursuer visibility ------------------------------------------------------------------------

describe('pursuer visibility tracker', () => {
  const player = { x: 0, y: 0, z: 0 };
  const never = (): boolean => false;
  const always = (): boolean => true;

  it('counts only LIVE pursuers, matching the BUSTED enumeration', () => {
    const slots = [
      slot({ id: 0 }),
      slot({ id: 1, state: 'wrecked' }),
      slot({ id: 2, kind: null }),
      slot({ id: 3, kind: 'tank' }),
    ];
    const tracker = createPursuerVisibility();
    expect(tracker.sample(slots, always, player).onScreen).toBe(2);
    // Drift guard: with everything on screen, the on-screen count must equal the BUSTED
    // proximity count taken at an unbounded radius — i.e. both agree on what a live pursuer IS.
    expect(countPursuersNear(slots, player, Number.MAX_SAFE_INTEGER)).toBe(2);
  });

  it('records a sighting on the off→on edge only, at the player→pursuer distance', () => {
    const tracker = createPursuerVisibility();
    const slots = [slot({ id: 0, x: 30, z: 40 })];
    expect(tracker.sample(slots, never, player).sightings).toBe(0);
    const seen = tracker.sample(slots, always, player);
    expect(seen.sightings).toBe(1);
    expect(seen.sightingDistanceSumM).toBeCloseTo(50, 10); // 3-4-5
    expect(seen.sightingDistanceMaxM).toBeCloseTo(50, 10);
    // Still visible next frame — no second sighting, but still on screen.
    const held = tracker.sample(slots, always, player);
    expect(held.sightings).toBe(0);
    expect(held.onScreen).toBe(1);
  });

  it('re-arms after the pursuer leaves the frame (a re-entry is a real sighting)', () => {
    const tracker = createPursuerVisibility();
    const slots = [slot({ id: 0, x: 0, z: 10 })];
    tracker.sample(slots, always, player);
    tracker.sample(slots, never, player);
    expect(tracker.sample(slots, always, player).sightings).toBe(1);
  });

  it('drops the latch when a slot stops being a live pursuer — a recycled slot starts fresh', () => {
    const tracker = createPursuerVisibility();
    const live = slot({ id: 0, x: 0, z: 10 });
    expect(tracker.sample([live], always, player).sightings).toBe(1);
    // Wrecked, then despawned to a free pool slot...
    tracker.sample([slot({ id: 0, state: 'wrecked' })], always, player);
    tracker.sample([slot({ id: 0, kind: null })], always, player);
    // ...and the pool hands slot 0 to a NEW unit, already in frame: that is a new sighting.
    expect(tracker.sample([slot({ id: 0, x: 0, z: 25 })], always, player).sightings).toBe(1);
  });

  it('a wrecked or freed slot never counts as on screen', () => {
    const tracker = createPursuerVisibility();
    const slots = [slot({ id: 0, state: 'wrecked' }), slot({ id: 1, kind: null })];
    const frame = tracker.sample(slots, always, player);
    expect(frame.onScreen).toBe(0);
    expect(frame.sightings).toBe(0);
  });

  it('sums several sightings in one frame and reports the farthest', () => {
    const tracker = createPursuerVisibility();
    const slots = [slot({ id: 0, x: 10 }), slot({ id: 1, x: 40 })];
    const frame = tracker.sample(slots, always, player);
    expect(frame.sightings).toBe(2);
    expect(frame.sightingDistanceSumM).toBeCloseTo(50, 10);
    expect(frame.sightingDistanceMaxM).toBeCloseTo(40, 10);
  });

  it('reset() forgets every latch', () => {
    const tracker = createPursuerVisibility();
    const slots = [slot({ id: 0, x: 0, z: 5 })];
    tracker.sample(slots, always, player);
    tracker.reset();
    expect(tracker.sample(slots, always, player).sightings).toBe(1);
  });

  it('the module singleton tests against the live view volume', () => {
    updateViewVolume(cameraAt([0, 0, 0], [0, 0, -1]));
    const slots = [slot({ id: 0, z: -20 }), slot({ id: 1, z: 20 })];
    expect(samplePursuerVisibility(slots, { x: 0, y: 0, z: 0 }).onScreen).toBe(1);
  });
});

// --- the drift guard the module's header promises -----------------------------------------------
// cameraReadability.ts's doc states its LIVE predicate is "byte-for-byte" combat/runLoop.ts's, and
// that the two are held together "by a drift test rather than by a shared helper" — deliberately,
// so a dev-only metric never edits a production file. That promise is only worth something if the
// test enumerates the whole product space: a single hand-picked fixture agrees with almost any
// wrong predicate (e.g. `kind !== null` alone agrees with it on every slot that is not a wrecked
// unit). This is that enumeration.

describe('LIVE-pursuer predicate — drift guard vs combat/runLoop.ts', () => {
  const player = { x: 0, y: 0, z: 0 };
  const always = (): boolean => true;
  const KINDS: readonly (UnitKind | null)[] = [
    null,
    'police',
    'armored',
    'swat',
    'gunTruck',
    'tank',
  ];
  const STATES: readonly UnitState[] = ['pursuing', 'wrecked'];

  /** One slot per (kind, state) pair, all within any radius the comparison uses. */
  function everyCombination(): UnitSlot[] {
    const slots: UnitSlot[] = [];
    let id = 0;
    for (const kind of KINDS) {
      for (const state of STATES) {
        slots.push(slot({ id: id++, kind, state, x: 1 }));
      }
    }
    return slots;
  }

  it('agrees with countPursuersNear on EVERY kind × state combination, slot by slot', () => {
    // Radius large enough to contain every fixture, so proximity cannot mask a predicate
    // disagreement: the only thing left for the two to differ about is what "live" means.
    const RADIUS = 1e6;
    for (const s of everyCombination()) {
      const onScreen = createPursuerVisibility().sample([s], always, player).onScreen;
      expect({ kind: s.kind, state: s.state, onScreen }).toEqual({
        kind: s.kind,
        state: s.state,
        onScreen: countPursuersNear([s], player, RADIUS),
      });
    }
  });

  it('agrees in aggregate too — 5 of the 12 combinations are live (the five kinds, pursuing)', () => {
    const slots = everyCombination();
    const onScreen = createPursuerVisibility().sample(slots, always, player).onScreen;
    expect(onScreen).toBe(countPursuersNear(slots, player, 1e6));
    // Pinned, not just cross-checked: if UnitKind grows a sixth class both sides move together
    // and this line reports it, which is the moment to re-read both predicates.
    expect(onScreen).toBe(5);
  });

  it('a sighting is only ever recorded for a slot the BUSTED enumeration would also count', () => {
    // The latch edge must inherit the same predicate as the count — a sighting logged for a
    // wrecked or freed slot would inflate the warning-distance denominator with non-pursuers.
    for (const s of everyCombination()) {
      const frame = createPursuerVisibility().sample([s], always, player);
      expect(frame.sightings).toBe(countPursuersNear([s], player, 1e6));
    }
  });
});

// --- latch lifetime vs the measurement window ---------------------------------------------------

describe('latch lifetime', () => {
  const player = { x: 0, y: 0, z: 0 };

  it('survives resetCameraClipStats(): a window opened mid-chase must not manufacture sightings', () => {
    // DELIBERATE, and the reason is a measurement one (recorded at resetCameraClipStats itself):
    // the latches describe the WORLD — which cops are in frame right now — not the window. Dropping
    // them when a battery opens a window would log a fresh "sighting" for every cop already on
    // screen, at whatever close range the chase had reached, and those non-events would swamp the
    // real off→on edges the metric exists to measure. A cop that was already visible is not news.
    updateViewVolume(cameraAt([0, 0, 0], [0, 0, -1]));
    const slots = [slot({ id: 0, z: -20 })];
    expect(samplePursuerVisibility(slots, player).sightings).toBe(1);
    resetCameraClipStats();
    expect(samplePursuerVisibility(slots, player).sightings).toBe(0);
  });

  it('is dropped by resetPursuerVisibility() — the WORLD boundary, which is where the leak was', () => {
    // A latch normally self-clears when its slot stops being a live pursuer, but that check only
    // runs on a frame that still sees the slot; on world unmount `unitsRef.current` goes null and
    // the sampler stops iterating, so a latch left standing would outlive its run and be inherited
    // by whatever unit the pool hands the same id to next. TorontoScene's clip-index effect calls
    // this on teardown (DEV-guarded) for exactly that reason.
    updateViewVolume(cameraAt([0, 0, 0], [0, 0, -1]));
    const slots = [slot({ id: 0, z: -20 })];
    expect(samplePursuerVisibility(slots, player).sightings).toBe(1);
    resetPursuerVisibility();
    // The next run's unit inherits slot id 0 and is on screen at spawn: a real sighting again.
    expect(samplePursuerVisibility(slots, player).sightings).toBe(1);
  });
});

// --- city in frame -----------------------------------------------------------------------------

describe('measureCityInFrame', () => {
  it('reports nothing — and an empty denominator — for an empty index', () => {
    updateViewVolume(restRigCamera());
    const frame = measureCityInFrame([]);
    expect(frame.coverage).toBe(0);
    expect(frame.boxesInFrame).toBe(0);
    expect(frame.boxesTested).toBe(0);
  });

  it('an empty street reads 0 coverage while the index is populated (the P76 finding)', () => {
    updateViewVolume(restRigCamera());
    // Buildings exist, but they are three blocks away — the frame is asphalt.
    const frame = measureCityInFrame([box(400, 400, 20, 20), box(-400, -400, 20, 20)]);
    expect(frame.boxesTested).toBe(2);
    expect(frame.boxesInFrame).toBe(0);
    expect(frame.coverage).toBe(0);
  });

  it('a wall filling the view reads near-total coverage', () => {
    // Camera at the origin looking down -Z at a big slab 10 m out.
    updateViewVolume(cameraAt([0, 5, 0], [0, 5, -1]));
    const frame = measureCityInFrame([
      { minX: -60, maxX: 60, minY: 0, maxY: 60, minZ: -12, maxZ: -10 },
    ]);
    expect(frame.boxesInFrame).toBe(1);
    expect(frame.coverage).toBeGreaterThan(0.99);
  });

  it('measures SCREEN AREA, not box count: one near wall beats many distant boxes', () => {
    const camera = cameraAt([0, 5, 0], [0, 5, -1]);
    updateViewVolume(camera);
    const nearWall = measureCityInFrame([
      { minX: -10, maxX: 10, minY: 0, maxY: 12, minZ: -16, maxZ: -14 },
    ]);
    const nearCoverage = nearWall.coverage;
    const nearCount = nearWall.boxesInFrame;
    const farCluster: ClipAabb[] = [];
    for (let i = -4; i <= 4; i++) farCluster.push(box(i * 6, -300, 2, 8));
    const far = measureCityInFrame(farCluster);
    expect(far.boxesInFrame).toBeGreaterThan(nearCount);
    expect(far.coverage).toBeLessThan(nearCoverage);
  });

  it('responds to LENS WIDTH: a city that overspills the frame covers more of a narrow one', () => {
    // The property that makes the metric comparable between candidate rigs — it is measured in NDC,
    // so the same geometry read through a longer lens occupies a larger share of the frame. Stated
    // for a city that OVERSPILLS the frame at both lenses, which is the only case in which it is a
    // theorem (see the next test for what happens when it does not).
    const city: ClipAabb[] = [
      { minX: -16, maxX: 16, minY: 0, maxY: 14, minZ: -32, maxZ: -30 },
      { minX: -34, maxX: -18, minY: 0, maxY: 20, minZ: -46, maxZ: -26 },
    ];
    let previous = Infinity;
    for (const fov of [20, 25, 30, 38, 45, 52, 60, 70, 75]) {
      const camera = cameraAt([0, 10, 0], [0, 9, -30], fov);
      updateViewVolume(camera);
      const coverage = measureCityInFrame(city).coverage;
      // Strictly decreasing across the whole sweep, and never saturating at either end — so the
      // inequality is a property of the metric, not of a clamp.
      expect(coverage).toBeLessThan(previous);
      expect(coverage).toBeGreaterThan(0);
      expect(coverage).toBeLessThan(1);
      // Pinned against the oracle at every step, because the direction of this inequality is
      // exactly the kind of claim the broken estimator used to satisfy for the wrong reason.
      expect(coverage).toBeCloseTo(rayTracedCoverage(camera, city), 6);
      previous = coverage;
    }
  });

  it('is NOT monotone in lens width when the city does not fill the frame — a MEASUREMENT', () => {
    // RECORDED, NOT FIXED. This file used to assert plain "narrower lens ⇒ more coverage" on this
    // very fixture, and it passed — because the old bounding-rect estimator inflated the narrow
    // reading. The true curve, confirmed ray-traced at every step, peaks in the middle: a long lens
    // eventually zooms INTO the gap between two buildings and reads less sky-free frame, a short one
    // shrinks them inside a wide frame. So a coverage number is only comparable between rigs
    // alongside the framing it was taken at — which is the whole reason the battery ships contact
    // sheets next to the numbers rather than the numbers alone.
    const city = [box(-14, -30, 8, 24), box(14, -30, 8, 24), box(0, -60, 10, 30)];
    const measured: number[] = [];
    for (const fov of [20, 30, 45, 60, 75]) {
      const camera = cameraAt([0, 12, 0], [0, 0, -30], fov);
      updateViewVolume(camera);
      const coverage = measureCityInFrame(city).coverage;
      expect(coverage).toBeCloseTo(rayTracedCoverage(camera, city), 6);
      measured.push(coverage);
    }
    // Rises then falls — the shape, pinned, so a re-grade of the estimator has to explain itself.
    expect(measured[1]!).toBeGreaterThan(measured[0]!);
    expect(measured[2]!).toBeGreaterThan(measured[1]!);
    expect(measured[3]!).toBeLessThan(measured[2]!);
    expect(measured[4]!).toBeLessThan(measured[3]!);
  });

  it('counts a box straddling the eye plane as the sliver it occupies, not the whole frame', () => {
    // A long wall running alongside/behind the camera, its near end just inside the frame edge.
    updateViewVolume(cameraAt([0, 5, 0], [0, 5, -1]));
    const frame = measureCityInFrame([
      { minX: 14, maxX: 18, minY: 0, maxY: 20, minZ: -40, maxZ: 40 },
    ]);
    expect(frame.boxesInFrame).toBe(1);
    expect(frame.coverage).toBeGreaterThan(0);
    expect(frame.coverage).toBeLessThan(0.5);
  });

  it('reads full coverage when the eye is inside a volume', () => {
    updateViewVolume(cameraAt([0, 5, 0], [0, 5, -1]));
    const frame = measureCityInFrame([
      { minX: -30, maxX: 30, minY: 0, maxY: 30, minZ: -30, maxZ: 30 },
    ]);
    expect(frame.coverage).toBe(1);
  });

  it('is resolution-independent: the coverage lattice is fixed, not the framebuffer', () => {
    expect(COVERAGE_GRID_COLS * COVERAGE_GRID_ROWS).toBe(64 * 36);
    updateViewVolume(cameraAt([0, 5, 0], [0, 5, -1]));
    const city = [box(0, -30, 10, 20)];
    const a = measureCityInFrame(city).coverage;
    const b = measureCityInFrame(city).coverage;
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
  });

  it('the ground cutoff never culls a box that is actually in frame', () => {
    // Ring of boxes at increasing range under the shipped rig: whatever the cutoff decides,
    // the answer must equal a brute-force frustum test with no pre-reject at all.
    updateViewVolume(restRigCamera());
    const city: ClipAabb[] = [];
    for (let r = 5; r <= 200; r += 5) {
      for (let a = 0; a < 8; a++) {
        city.push(box(r * Math.cos((a * Math.PI) / 4), r * Math.sin((a * Math.PI) / 4), 3, 18));
      }
    }
    const withCutoff = measureCityInFrame(city).boxesInFrame;
    // Brute force: one box at a time defeats nothing (the cutoff is per box), so instead re-run
    // with boxes pushed below the ground plane, which disables the pre-reject by construction.
    const sunk = city.map((b) => ({ ...b, minY: -1e-9 }));
    expect(measureCityInFrame(sunk).boxesInFrame).toBe(withCutoff);
    expect(withCutoff).toBeGreaterThan(0);
  });

  it('falls back to a full scan when a corner ray rises to the horizon (cutoff = Infinity)', () => {
    // The cheap XZ pre-reject only EXISTS because every corner ray of a legal rig descends: then
    // "beyond this range nothing at y ≥ 0 can be in frame" is a theorem and the reject is exact.
    // A level (or rising) camera has no such range, and the derivation must answer Infinity — i.e.
    // test everything — rather than a finite number that would silently delete the far half of the
    // city from the metric. Phase 38's visible-band law says no legal rig does this; a LAB about to
    // try candidate rigs is exactly where that law can stop holding, which is why the path exists.
    updateViewVolume(cameraAt([0, 10, 0], [0, 10, -1])); // dead level: two corner rays rise
    const farWall: ClipAabb = { minX: -60, maxX: 60, minY: 0, maxY: 40, minZ: -900, maxZ: -880 };
    const frame = measureCityInFrame([farWall]);
    expect(frame.boxesInFrame).toBe(1);
    expect(frame.coverage).toBeGreaterThan(0);
  });

  it('is the SILHOUETTE, not its bounding rect: a box seen corner-on leaves its corners empty', () => {
    // A cube viewed down its body diagonal projects to a hexagon whose bounding rect is ~30 %
    // larger. The old estimator measured the rect. Pinned against the oracle so the assertion is a
    // measurement, not an argument.
    const camera = cameraAt([20, 20, 20], [0, 0, 0]);
    updateViewVolume(camera);
    const cube: ClipAabb = { minX: -6, maxX: 6, minY: 0, maxY: 12, minZ: -6, maxZ: 6 };
    const frame = measureCityInFrame([cube]);
    expect(frame.coverage).toBeCloseTo(rayTracedCoverage(camera, [cube]), 6);
    expect(frame.coverage).toBeGreaterThan(0);
    expect(frame.coverage).toBeLessThan(1);
  });

  it('a rig that only just clears the horizon still measures what a level one does', () => {
    // The boundary either side of the fallback: a hair below level the cutoff is finite (~3.4 km
    // at this eye height — 10 / tan(0.17°) — far past anything on a 1440 x 2724 wu map), a hair
    // above it is Infinity. Both must report the same wall, or the metric would step
    // discontinuously as a candidate rig's pitch ramp crosses level.
    const wall: ClipAabb = { minX: -60, maxX: 60, minY: 0, maxY: 40, minZ: -900, maxZ: -880 };
    updateViewVolume(cameraAt([0, 10, 0], [0, 10 - Math.tan(0.003), -1]));
    const justBelow = measureCityInFrame([wall]);
    updateViewVolume(cameraAt([0, 10, 0], [0, 10 + Math.tan(0.003), -1]));
    const justAbove = measureCityInFrame([wall]);
    expect(justBelow.boxesInFrame).toBe(1);
    expect(justAbove.boxesInFrame).toBe(1);
    expect(justAbove.coverage).toBeCloseTo(justBelow.coverage, 2);
  });
});

// --- city-in-frame CONTROLS ---------------------------------------------------------------------
// The metric shipped without a single one of these, which is exactly how it shipped reading 100 %
// on a frame that was 18.8 % building. Positive, negative, monotone, and pinned against an oracle.

describe('measureCityInFrame — controls', () => {
  it('POSITIVE CONTROL: a near facade filling the view reads a whole frame of city', () => {
    // Camera 5 wu up looking level at a slab 10 wu out that overspills the frustum in both axes.
    // Nothing about this is approximate: EVERY sample point must land on the wall.
    const camera = cameraAt([0, 5, 0], [0, 5, -1]);
    updateViewVolume(camera);
    const facade: ClipAabb = { minX: -80, maxX: 80, minY: 0, maxY: 80, minZ: -12, maxZ: -10 };
    const frame = measureCityInFrame([facade]);
    expect(frame.boxesInFrame).toBe(1);
    expect(frame.coverage).toBe(1);
    expect(frame.coverage).toBeCloseTo(rayTracedCoverage(camera, [facade]), 6);
  });

  it('NEGATIVE CONTROL: a frame with no building in the frustum reads exactly 0', () => {
    const camera = restRigCamera();
    updateViewVolume(camera);
    // Real volumes, three blocks away in every direction — the index is populated, the frame is not.
    const city = [box(400, 400, 20, 20), box(-400, -400, 20, 20), box(400, -400, 20, 20)];
    const frame = measureCityInFrame(city);
    expect(frame.boxesTested).toBe(3);
    expect(frame.boxesInFrame).toBe(0);
    expect(frame.coverage).toBe(0);
    expect(rayTracedCoverage(camera, city)).toBe(0);
  });

  it('NEGATIVE CONTROL, in the defect’s own shape: a slab beside and BEHIND the eye reads 0', () => {
    // THE FAILING GEOMETRY, minimised. A long wall that straddles the eye plane and lies outside
    // the frustum used to project corners to NDC x ≈ −1000 and ≈ +1, whose bounding rect is the
    // whole screen. It must read nothing at all — and it must not even be counted as in frame,
    // which `frustum.intersectsBox` alone (conservative) cannot promise.
    const camera = cameraAt([0, 5, 0], [0, 5, -1]);
    updateViewVolume(camera);
    const behindAndBeside: ClipAabb = {
      minX: 30,
      maxX: 34,
      minY: 0,
      maxY: 40,
      minZ: -40,
      maxZ: 60,
    };
    const frame = measureCityInFrame([behindAndBeside]);
    expect(frame.boxesTested).toBe(1);
    expect(frame.coverage).toBe(0);
    expect(frame.boxesInFrame).toBe(0);
    expect(rayTracedCoverage(camera, [behindAndBeside])).toBe(0);
  });

  it('MONOTONICITY: the same box moved closer never covers less', () => {
    const camera = cameraAt([0, 5, 0], [0, 5, -1]);
    updateViewVolume(camera);
    let previous = -1;
    // 90 → 12 wu out, so the box crosses from a few cells to filling the frame.
    for (let z = 90; z >= 12; z -= 2) {
      const coverage = measureCityInFrame([
        { minX: -10, maxX: 10, minY: 0, maxY: 14, minZ: -z - 2, maxZ: -z },
      ]).coverage;
      expect(coverage).toBeGreaterThanOrEqual(previous);
      previous = coverage;
    }
    expect(previous).toBe(1);
  });

  it('MONOTONICITY: the same box grown about its centre never covers less', () => {
    const camera = cameraAt([0, 5, 0], [0, 5, -1]);
    updateViewVolume(camera);
    let previous = -1;
    for (let half = 0.5; half <= 40; half += 0.5) {
      const coverage = measureCityInFrame([
        {
          minX: -half,
          maxX: half,
          minY: 5 - half,
          maxY: 5 + half,
          minZ: -30 - half,
          maxZ: -30 + half,
        },
      ]).coverage;
      expect(coverage).toBeGreaterThanOrEqual(previous);
      previous = coverage;
    }
    expect(previous).toBe(1);
  });

  it('agrees with the ray-traced oracle across a randomized pose sweep, straddles included', () => {
    // A synthetic block of streetwall the camera is driven THROUGH, so a large share of the poses
    // put a slab beside/behind the eye — the exact configuration the old estimator broke on. The
    // oracle and the estimator share no code; agreement to a single cell is the guarantee.
    const city: ClipAabb[] = [];
    for (let i = -3; i <= 3; i++) {
      city.push({ minX: -22, maxX: -8, minY: 0, maxY: 18, minZ: i * 30 - 12, maxZ: i * 30 + 12 });
      city.push({ minX: 8, maxX: 22, minY: 0, maxY: 26, minZ: i * 30 - 12, maxZ: i * 30 + 12 });
    }
    let rng = 20260807;
    const next = (): number => (rng = (rng * 1664525 + 1013904223) >>> 0) / 4294967296;
    let compared = 0;
    let nonTrivial = 0;
    for (let i = 0; i < 120; i++) {
      const camera = restRigCameraOver((next() - 0.5) * 44, (next() - 0.5) * 200);
      updateViewVolume(camera);
      const frame = measureCityInFrame(city);
      const oracle = rayTracedCoverage(camera, city);
      // One cell of slack, and only because the two disagree on cells whose CENTRE sits within a
      // float epsilon of a silhouette edge; nothing here is allowed to drift further than that.
      expect(cellsApart(frame.coverage, oracle)).toBeLessThanOrEqual(1 + 1e-6);
      compared++;
      if (oracle > 0.02 && oracle < 0.98) nonTrivial++;
    }
    expect(compared).toBe(120);
    // The sweep has to actually EXERCISE partial frames — a sweep that only ever saw 0 % and 100 %
    // would pass while proving nothing.
    expect(nonTrivial).toBeGreaterThan(40);
  });

  it('THE PHASE-76 REGRESSION: the shipped rig at the shipped spawn, on the real world', () => {
    // Reconstructed from the same inputs the battery uses — config/torontoMap's TORONTO_SPAWN, the
    // shipped CAMERA rig at rest, and the arbiter's real clip volumes at the standing seed — so
    // this is the failing measurement itself, not a model of it. It read coverage 1.0 (100.0 % of
    // the frame) off ONE box: the Eaton Centre galleria, whose 129 wu of z runs straight through
    // the eye plane 17.7 wu west of the lens.
    const world = composeWorld(WORLD_GEN.defaultSeed);
    const camera = restRigCameraOver(TORONTO_SPAWN.x, TORONTO_SPAWN.y);
    updateViewVolume(camera);
    const frame = measureCityInFrame(world.clipVolumes);
    expect(frame.boxesTested).toBeGreaterThan(2000);
    expect(frame.boxesInFrame).toBe(1);
    // Against the oracle, on the real geometry.
    expect(frame.coverage).toBeCloseTo(rayTracedCoverage(camera, world.clipVolumes), 6);
    // And the blunt guard the oracle cannot give on its own: whatever the map does next, ONE low
    // slab beside the lens must never again be reported as most of the screen.
    expect(frame.coverage).toBeGreaterThan(0.1);
    expect(frame.coverage).toBeLessThan(0.35);
  });
});

// --- pursuer visibility CONTROLS ----------------------------------------------------------------
// `onScreenPursuerCount`, `pursuerWarningDistanceM` and `sightings` have never returned a non-zero
// value in the field: a 393-frame ★3 chase with six live units produced 0 on all three. That is
// consistent with the geometry below — but a metric that has only ever emitted 0 has proven only
// that it CAN emit 0. These are the missing halves: the live predicate driving the real
// accumulators off zero, the off→on edge firing exactly once, and the ENVELOPE measurement that
// says why the field number is what it is.

/** Largest range (m) from the car, on `bearingDeg`, at which a pursuer's bounding sphere is still
 * inside the captured view volume. Stepped, so deterministic; `updateViewVolume` must have run. */
function maxOnScreenRangeM(bearingDeg: number): number {
  const a = bearingDeg * DEG2RAD;
  let best = 0;
  for (let r = 0; r <= 120; r += 0.25) {
    if (isSphereOnScreen(Math.cos(a) * r, 0.5, Math.sin(a) * r, PURSUER_SPHERE_RADIUS_WU)) best = r;
  }
  return best;
}

/** The bearing the shipped rig shows the most road on, and how much — measured, not chosen. */
function bestVisibleBearing(): { bearingDeg: number; rangeM: number } {
  let bearingDeg = 0;
  let rangeM = 0;
  for (let deg = 0; deg < 360; deg += 15) {
    const r = maxOnScreenRangeM(deg);
    if (r > rangeM) {
      rangeM = r;
      bearingDeg = deg;
    }
  }
  return { bearingDeg, rangeM };
}

describe('pursuer visibility — controls', () => {
  const car = { x: 0, y: 0, z: 0 };

  it('POSITIVE CONTROL: a pursuer inside the frame drives every derived metric off zero', () => {
    // End to end through the SHIPPED path — the live sphere-vs-frustum predicate, the module
    // singleton's latch, and cameraClipStats' accumulation + derivation. Nothing is stubbed.
    const camera = restRigCamera();
    updateViewVolume(camera);
    const best = bestVisibleBearing();
    // DERIVED placement: 60 % of the range the rig can actually show on its best bearing. A chosen
    // coordinate would silently stop being inside the frame the moment the rig moved.
    const a = best.bearingDeg * DEG2RAD;
    const range = best.rangeM * 0.6;
    const cop = slot({ id: 0, x: Math.cos(a) * range, y: 0.5, z: Math.sin(a) * range });
    expect(isSphereOnScreen(cop.x, cop.y, cop.z, PURSUER_SPHERE_RADIUS_WU)).toBe(true);

    for (let frame = 0; frame < 3; frame++) {
      sampleCameraReadability(
        samplePursuerVisibility([cop], car),
        measureCityInFrame([]),
        frameGroundBandWu(camera.position, car),
      );
    }

    const stats = readCameraClipStats().readability;
    expect(stats.frames).toBe(3);
    expect(stats.onScreenPursuerSum).toBe(3);
    expect(stats.onScreenPursuerMax).toBe(1);
    // The three headline derived fields, all non-zero.
    expect(stats.onScreenPursuerCount).toBe(1);
    expect(stats.pursuerWarningDistanceM).toBeCloseTo(Math.hypot(cop.x, cop.y, cop.z), 9);
    expect(stats.pursuerWarningDistanceM!).toBeGreaterThan(0);
    // The LATCH: three frames of continuous visibility is ONE sighting, not three.
    expect(stats.sightings).toBe(1);
    expect(stats.sightingDistanceMaxM).toBeCloseTo(Math.hypot(cop.x, cop.y, cop.z), 9);
  });

  it('POSITIVE CONTROL: the off→on edge fires once per entry, and re-entry is a new sighting', () => {
    const camera = restRigCamera();
    updateViewVolume(camera);
    const best = bestVisibleBearing();
    const a = best.bearingDeg * DEG2RAD;
    const inFrame = best.rangeM * 0.5;
    const cop = slot({ id: 0, x: Math.cos(a) * inFrame, y: 0.5, z: Math.sin(a) * inFrame });
    const offFrame = { x: Math.cos(a) * 400, y: 0.5, z: Math.sin(a) * 400 };

    const place = (p: { x: number; y: number; z: number }): void => {
      cop.x = p.x;
      cop.y = p.y;
      cop.z = p.z;
      sampleCameraReadability(
        samplePursuerVisibility([cop], car),
        measureCityInFrame([]),
        frameGroundBandWu(camera.position, car),
      );
    };
    const here = { x: cop.x, y: cop.y, z: cop.z };
    place(here); // enter  → sighting 1
    place(here); // hold   → no edge
    place(here); // hold   → no edge
    place(offFrame); // leave
    place(offFrame); // stay away
    place(here); // re-enter → sighting 2

    const stats = readCameraClipStats().readability;
    expect(stats.frames).toBe(6);
    expect(stats.sightings).toBe(2);
    expect(stats.onScreenPursuerSum).toBe(4);
    expect(stats.onScreenPursuerCount).toBeCloseTo(4 / 6, 9);
  });

  it('NEGATIVE CONTROL: an off-screen pursuer leaves every derived metric at a HONEST zero', () => {
    const camera = restRigCamera();
    updateViewVolume(camera);
    const cop = slot({ id: 0, x: 120, y: 0.5, z: 120 });
    expect(isSphereOnScreen(cop.x, cop.y, cop.z, PURSUER_SPHERE_RADIUS_WU)).toBe(false);
    for (let frame = 0; frame < 5; frame++) {
      sampleCameraReadability(
        samplePursuerVisibility([cop], car),
        measureCityInFrame([]),
        frameGroundBandWu(camera.position, car),
      );
    }
    const stats = readCameraClipStats().readability;
    // Zero, but with a live denominator — the distinction a zero must always be read against.
    expect(stats.frames).toBe(5);
    expect(stats.onScreenPursuerCount).toBe(0);
    expect(stats.sightings).toBe(0);
    // No sighting means no denominator, so the warning distance is null rather than a fake 0.
    expect(stats.pursuerWarningDistanceM).toBeNull();
  });

  it('THE ENVELOPE: no pursuer beyond ~26 m from the car can be on screen at the shipped rig', () => {
    // THE MEASUREMENT BEHIND THE FIELD ZEROS, pinned so it reports itself when the rig moves. It is
    // why a ★3 chase whose nearest pursuer sat at 37 m recorded 0 on-screen pursuers for 393
    // straight frames: at rig E that is outside the visible band on EVERY bearing, and no amount of
    // pursuit tuning changes it — only the camera does.
    updateViewVolume(restRigCamera());
    const best = bestVisibleBearing();
    expect(best.rangeM).toBeCloseTo(26.25, 5);
    // The camera side is far worse than the best bearing: the eye is only 13.78 wu out that way.
    expect(maxOnScreenRangeM(CAMERA.yawDeg)).toBeLessThan(13);
    // The field's nearest pursuer, tried on every bearing.
    for (let deg = 0; deg < 360; deg += 5) {
      const a = deg * DEG2RAD;
      expect(
        isSphereOnScreen(Math.cos(a) * 37, 0.5, Math.sin(a) * 37, PURSUER_SPHERE_RADIUS_WU),
      ).toBe(false);
    }
  });
});

// --- ground band -------------------------------------------------------------------------------

describe('frameGroundBandWu', () => {
  it('reproduces config/camera.ts at the shipped rig’s rest pose', () => {
    const pitch = CAMERA.pitchDeg * DEG2RAD;
    const yaw = CAMERA.yawDeg * DEG2RAD;
    const d = CAMERA.baseDist;
    const eye = {
      x: d * Math.cos(pitch) * Math.sin(yaw),
      y: d * Math.sin(pitch),
      z: d * Math.cos(pitch) * Math.cos(yaw),
    };
    const band = frameGroundBandWu(eye, { x: 0, y: 0, z: 0 });
    expect(band).not.toBeNull();
    expect(band!).toBeCloseTo(cameraGroundBandWu(CAMERA_EYE_MIN_WU, CAMERA.pitchDeg), 6);
  });

  it('is measured car-relative, so a car on a rise does not inflate the band', () => {
    const flat = frameGroundBandWu({ x: 0, y: 20, z: 20 }, { x: 0, y: 0, z: 0 });
    const raised = frameGroundBandWu({ x: 0, y: 25, z: 20 }, { x: 0, y: 5, z: 0 });
    expect(raised).toBeCloseTo(flat!, 10);
  });

  it('returns null on a degenerate pose rather than a number nobody can defend', () => {
    expect(frameGroundBandWu({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toBeNull();
    expect(frameGroundBandWu({ x: 0, y: -5, z: 10 }, { x: 0, y: 0, z: 0 })).toBeNull();
  });

  it('a higher, steeper eye shows more ground', () => {
    const low = frameGroundBandWu({ x: 0, y: 12, z: 12 }, { x: 0, y: 0, z: 0 })!;
    const high = frameGroundBandWu({ x: 0, y: 24, z: 24 }, { x: 0, y: 0, z: 0 })!;
    expect(high).toBeGreaterThan(low);
  });
});
