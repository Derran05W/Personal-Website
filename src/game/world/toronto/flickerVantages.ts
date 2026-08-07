// Phase 42 T2 — the flicker-sweep vantage lattice (part-10-placement-integrity.md §Phase 42,
// phase-42-plan.md T2). scripts/flicker-sweep.mjs (T3) teleports the player car to every pose
// this module returns and runs the two-frame toggle detector at each one. Pure geometry, no
// store/three/rapier reads — same discipline as cameraVantages.ts, so this whole module
// unit-tests headless and is safe to import from a Playwright driver script.
//
// Composition (in this order, lattice deduped against everything else):
//   1. LATTICE  — a 120 wu grid over the playable polygon's bounding box, polygon-filtered, then
//      snapped onto asphalt via the Toronto NavProvider's own nearestRoadPoint seam (never a
//      re-derivation of its ribbon math). Points that snap more than 90 wu are deep-interior
//      non-road ground (parks, back lots) and are dropped — the sweep only cares about surfaces a
//      driven car can actually rest on.
//   2. DISTRICT — one road-snapped pose per TORONTO_DISTRICTS entry (area-weighted rect centroid,
//      same technique cameraVantages.ts's districtIntersection uses for its 'kensington' anchor,
//      but snapped through the NavProvider instead of picked from listIntersections so every
//      district gets a hit even where no two named streets cross inside its rect).
//   3. MONEY    — the hand-verified evidence anchors from Parts 39-41's live batteries (see the
//      MONEY_SHOTS table below; every coordinate cites its source script). These are NOT
//      road-snapped: they were already teleported to and screenshotted from a running dev server,
//      so re-snapping them risks drifting a pose away from the exact framing the citation refers
//      to.
//   4. CAMERA   — cameraVantages()'s seven road-true rig-comparison anchors, reused as-is.
//
// Dedupe: a LATTICE pose within 40 wu of any district/money/camera pose is redundant (the sweep
// would just re-photograph a vantage it already has, twice) and is dropped. District/money/camera
// poses are never dropped — they are curated, not generated.
import { PLAYABLE_POLYGON, pointInPolygon, type MapVertex } from './polygon';
import { buildDistricts, type ResolvedDistrict } from './districts';
import { cameraVantages } from './cameraVantages';
import { GROUND_RECTS } from './torontoSceneHelpers';
import { createTorontoNavProvider } from '../../ai/torontoNavProvider';

/** One flicker-sweep pose. `x`/`z` are WORLD coordinates (the same map-x/world-x, map-y/world-z
 * identity swap every Toronto module uses). `source` records which composition stage produced it,
 * for triage bucketing in the T3/T4 harness output. */
export interface FlickerVantage {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly source: 'lattice' | 'district' | 'money' | 'camera';
}

/** Lattice grid stride, in wu. 120 over the 1440x2724 wu polygon gives a coarse but complete
 * sweep of every distinct block face without an unbounded pose count (see flickerVantages.test.ts
 * for the pinned total). */
const LATTICE_STRIDE_WU = 120;

/** A lattice pose is dropped if snapping it onto asphalt moves it more than this far — evidence
 * the sample point landed deep inside a park/back-lot/void rather than near an actual street. */
const LATTICE_SNAP_MAX_WU = 90;

/** A LATTICE pose within this radius of a district/money/camera pose is a redundant re-shoot of
 * a vantage the sweep already has from a curated source, and yields to it. */
const DEDUPE_RADIUS_WU = 40;

/** Half-extent of the safety square every generated pose must keep on drivable ground
 * (GROUND_RECTS). nearestRoadPoint can legally return a street's END node, and those sit on
 * seams the car cannot rest on: the shore-seam z (downtown maxY) is exactly the water sensor's
 * north face (contact = WRECKED), and the fold corridor's outer corners leave a wheel quadrant
 * over void (suspension rays miss, the car tips off, the Phase 37 OOB backstop ends the run).
 * Sweep A measured both live — 8 poses (6 shore-seam, 2 fold-corner) teleported straight to
 * GAMEOVER and could not be photographed. Sized 6 wu, NOT the ~2 wu car footprint: the teleport
 * pose faces +z (south — straight at the water on the shore seam) and the settle creep can roll
 * the car ~2-4 wu forward before it rests, so footprint alone still drowned 4 of the 6 shore
 * poses (probe: z=2482 dies x-dependently, z=2478 survives — triage in phase-42-notes.md). */
const GROUND_SAFE_INSET_WU = 6;

/** True when the ±inset axis square around (x, z) lies inside the GROUND_RECTS union. Corner
 * containment is exact here, not an approximation: the union is three axis-aligned rects each
 * far larger than the square, joined along full-width seams — the only concavities are the
 * fold corridor's outer corners, and a square spanning one always has a corner in the void. */
function squareOnGround(x: number, z: number, inset: number): boolean {
  for (const sx of [x - inset, x + inset]) {
    for (const sz of [z - inset, z + inset]) {
      if (!GROUND_RECTS.some((r) => sx >= r.minX && sx <= r.maxX && sz >= r.minY && sz <= r.maxY)) return false;
    }
  }
  return true;
}

/** Snap post-process: a pose failing the ground-safety square is clamped INTO whichever single
 * GROUND_RECT costs the least displacement (deterministic — ties resolve to the first rect in
 * GROUND_RECTS order). Nudge-not-drop: the pose keeps its id and photographs the same street;
 * it just no longer straddles the seam its road snap landed on (≤ ~2.8 wu of movement). */
function clampToGround(x: number, z: number): { x: number; z: number } {
  if (squareOnGround(x, z, GROUND_SAFE_INSET_WU)) return { x, z };
  let bestX = x;
  let bestZ = z;
  let bestD = Infinity;
  for (const r of GROUND_RECTS) {
    const cx = Math.min(Math.max(x, r.minX + GROUND_SAFE_INSET_WU), r.maxX - GROUND_SAFE_INSET_WU);
    const cz = Math.min(Math.max(z, r.minY + GROUND_SAFE_INSET_WU), r.maxY - GROUND_SAFE_INSET_WU);
    const d = Math.hypot(cx - x, cz - z);
    if (d < bestD) {
      bestD = d;
      bestX = cx;
      bestZ = cz;
    }
  }
  return { x: bestX, z: bestZ };
}

/**
 * The Phase 39-41 hand-verified evidence anchors, reused verbatim so the flicker sweep
 * re-photographs the exact sites those phases' battery scripts already proved out (a clean
 * re-sweep at these coordinates is the closeout reel's "still clean" half). Every coordinate is
 * the battery script's own car-teleport position (`tp(x, z, ...)`), not the defect object's
 * position — the whole point of a money shot is a hand-verified ON-ASPHALT camera pose, and the
 * teleport coordinate is the pose that was actually verified.
 */
const MONEY_SHOTS: readonly { readonly id: string; readonly x: number; readonly z: number }[] = [
  // --- Phase 39 collision-audit battery (.planning/tools/p39-battery.mjs) -------------------
  // Leg 'manhole': manhole-cover close-up on the Yonge spine (top face was exactly ROAD_Y before
  // the ladder fix). Also cited verbatim by Phase 41 leg 6b ("identical site to the Phase 39
  // battery's 'manhole' leg") — one entry serves both citations.
  { id: 'money-manhole', x: 1499, z: 1933.5 },
  // Leg 'rainbow': the Church rainbow crosswalk's clean "still" vantage (the money PAIR is this
  // site with a braking skid laid across it mid-slide; the still pose is the reproducible anchor).
  { id: 'money-church-rainbow', x: 1595.2, z: 1690 },
  // Leg 'laneway': the floor-hole/road-bits/debris-papers decor cluster (all three were coplanar
  // or sliced before the surface-anchor rule).
  { id: 'money-laneway-p39-decor', x: 1340, z: 4.5 },
  // Leg 'searchlight': heli searchlight ground pool over the lake (0.050 tie with WATER_Y before).
  { id: 'money-searchlight-lake', x: 1500, z: 2478 },

  // --- Phase 40 placement-arbiter battery (.planning/tools/p40-battery.mjs) ----------------
  // Leg 'shelter': Yonge bus stop close-up, east side — the flush-to-facade shelter retune site.
  { id: 'money-shelter-yonge', x: 1502, z: 1948 },
  // Leg 'shelter': second bus stop, west side of Yonge, mid-map.
  { id: 'money-shelter-yonge-2', x: 1489, z: 1599 },
  // Leg 'laneway': laneway clutter interior (dumpster run) — the most arbiter-affected layer.
  { id: 'money-laneway-p40-dumpster', x: 1508, z: 137 },
  // Leg 'parkinglot': parking-lot car rows, far north.
  { id: 'money-parkinglot', x: 1350, z: 33 },

  // --- Phase 41 surface & shimmer capture matrix (.planning/tools/p41-matrix.mjs VANTAGES) ----
  // Leg 1/2 'dashFar': lane-dash minification study, still in the fold corridor.
  //
  // PHASE 75 RE-TARGET — this anchor LOST ITS SUBJECT and had to move. It sat at (1500, 1032) on
  // the Yonge spine, chosen as the fold band's midpoint (coinciding with cam-fold-corridor and
  // district-foldCorridor). Phase 75 gave the spine a grass median, and a median street paints NO
  // centre dashes (the median IS the centre marker — see roadPaint.ts's `emitCentreDashes`). The
  // anchor would have gone on measuring a stretch of road with no dashes in it: a curated evidence
  // pose quietly reporting on nothing, which is worse than a missing pose.
  //
  // Moved to Eglinton — the fold zone's own EW `major`, centreline y = 1104.85, span x [1334,1666],
  // no median and therefore dashed. x = 1560 sits east of the Yonge junction box (dashes are skipped
  // within ROAD_CLASSES.spine/2 = 11 wu of a crossing), so the frame actually contains dashes. Still
  // the fold corridor, ~73 wu from the original spot — the study is preserved, the subject restored.
  // The other two fold ids (cam-fold-corridor, district-foldCorridor) keep the original midpoint.
  { id: 'money-dash-far', x: 1560, z: 1104.8 },
  // Leg 4 'grazingGround': open ground near Mel Lastman Square — grazing-angle ground-noise study.
  { id: 'money-grazing-ground', x: 1455, z: 660 },
  // Leg 4b 'parkBoundary': a district/park-tint boundary crossing the frame diagonally.
  { id: 'money-park-boundary', x: 1460, z: 670 },
  // Leg 3 'busStop': the same Yonge bus stop the route-board leg parks at (curb-side, off-lane).
  { id: 'money-bus-stop', x: 1507.4, z: 1942.3 },
  // Leg 6a 'venueFascia': McDonald's (Spadina) venue fascia, east-facing money frame.
  { id: 'money-venue-fascia', x: 916, z: 2023 },
  // Leg 6c 'towerFacade': TD Bank Tower's Bay-street facade, window CanvasTexture at max legal
  // driving distance.
  { id: 'money-tower-facade', x: 1362, z: 2215 },
  // Leg 5a 're-pinned' curb-cut end faces: Yonge's west sidewalk band at the Dundas curb cut.
  { id: 'money-curb-junction-near', x: 1493, z: 1884 },
  { id: 'money-curb-junction-far', x: 1493, z: 1894 },
  // Leg 5b 're-pinned': Park Home Ave's north band outer edge at Mel Lastman Square's open apron.
  { id: 'money-curb-outer-near', x: 1470, z: 444 },
  { id: 'money-curb-outer-far', x: 1470, z: 452 },
];

function polygonBBox(poly: readonly MapVertex[]): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const v of poly) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  return { minX, maxX, minY, maxY };
}

/** Area-weighted centroid of a district's rect(s) — the same technique cameraVantages.ts's
 * districtIntersection uses to pick a "representative, not arbitrary" point before snapping. */
function districtCentroid(district: ResolvedDistrict): MapVertex {
  let cx = 0;
  let cz = 0;
  let area = 0;
  for (const r of district.rects) {
    const a = (r.maxX - r.minX) * (r.maxY - r.minY);
    cx += ((r.minX + r.maxX) / 2) * a;
    cz += ((r.minY + r.maxY) / 2) * a;
    area += a;
  }
  if (area > 0) {
    cx /= area;
    cz /= area;
  }
  return { x: cx, y: cz };
}

/**
 * The full flicker-sweep vantage list: lattice + district + money + camera poses, deduped.
 * Deterministic and seed-independent — every input is pure config/geometry, so two calls always
 * return the same (deeply equal) array.
 */
export function flickerVantages(): readonly FlickerVantage[] {
  const nav = createTorontoNavProvider();
  const districts = buildDistricts();
  const bbox = polygonBBox(PLAYABLE_POLYGON);

  // --- 2. district poses (built before lattice dedupe needs them) --------------------------
  const districtPoses: FlickerVantage[] = districts.map(({ def }, i) => {
    const centroid = districtCentroid(districts[i]);
    const snapped = nav.nearestRoadPoint(centroid.x, centroid.y);
    const safe = clampToGround(snapped.x, snapped.z);
    return { id: `district-${def.id}`, x: safe.x, z: safe.z, source: 'district' };
  });

  // --- 3. money-shot poses -------------------------------------------------------------------
  const moneyPoses: FlickerVantage[] = MONEY_SHOTS.map((m) => ({ id: m.id, x: m.x, z: m.z, source: 'money' }));

  // --- 4. camera anchors -----------------------------------------------------------------------
  const cameraPoses: FlickerVantage[] = cameraVantages().map((v) => ({
    id: `cam-${v.id}`,
    x: v.x,
    z: v.z,
    source: 'camera',
  }));

  // Every non-lattice pose is a dedupe target — lattice yields to all of them.
  const priorityPoses = [...districtPoses, ...moneyPoses, ...cameraPoses];

  // --- 1. lattice poses, polygon-filtered, road-snapped, drop-if-far-snap, dedupe ------------
  // Grid anchored at world-space multiples of the stride (col/row = x0/z0 ÷ stride), not at the
  // bbox origin — so the lattice is a fixed, absolute grid over the map rather than one that
  // would silently re-index if the polygon's extents ever shifted.
  const latticePoses: FlickerVantage[] = [];
  const startCol = Math.floor(bbox.minX / LATTICE_STRIDE_WU);
  const endCol = Math.ceil(bbox.maxX / LATTICE_STRIDE_WU);
  const startRow = Math.floor(bbox.minY / LATTICE_STRIDE_WU);
  const endRow = Math.ceil(bbox.maxY / LATTICE_STRIDE_WU);
  for (let row = startRow; row <= endRow; row++) {
    const z0 = row * LATTICE_STRIDE_WU;
    if (z0 < bbox.minY || z0 > bbox.maxY) continue;
    for (let col = startCol; col <= endCol; col++) {
      const x0 = col * LATTICE_STRIDE_WU;
      if (x0 < bbox.minX || x0 > bbox.maxX) continue;
      if (!pointInPolygon({ x: x0, y: z0 }, PLAYABLE_POLYGON)) continue;

      const snapped = nav.nearestRoadPoint(x0, z0);
      const snapDist = Math.hypot(snapped.x - x0, snapped.z - z0);
      if (snapDist > LATTICE_SNAP_MAX_WU) continue;
      const safe = clampToGround(snapped.x, snapped.z);

      const tooCloseToPriority = priorityPoses.some(
        (p) => Math.hypot(p.x - safe.x, p.z - safe.z) < DEDUPE_RADIUS_WU,
      );
      if (tooCloseToPriority) continue;

      latticePoses.push({ id: `lat-${col}-${row}`, x: safe.x, z: safe.z, source: 'lattice' });
    }
  }

  return [...latticePoses, ...districtPoses, ...moneyPoses, ...cameraPoses];
}
