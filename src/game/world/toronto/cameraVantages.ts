// Phase 33 camera lab — the standard vantage battery's anchor points.
// Phase 76 (T3) — extended to TEN anchors, and made self-describing.
//
// Named spots the Playwright battery teleports the car to, so every candidate rig is judged on
// the SAME framings. They are DERIVED, never authored: every point resolves out of
// world/toronto/streets.ts + roadGraph.ts's listIntersections (+ districts.ts for the two
// district-referenced ones), so a teleported car always lands on asphalt and the battery cannot
// drift out of sync with the map the way a hardcoded coordinate table would. Every lookup throws
// loudly rather than falling back: a missing crossing/street/district means the vantage no longer
// means what its name says, which is exactly the drift a derived battery exists to catch.
//
// Pure + deterministic (the street table is seed-independent), and consumed only by dev tooling
// (core/debugBridge.ts's `cameraVantages()`, core/devPanel.tsx's teleport buttons,
// scripts/camera-lab.mjs), so it never enters a production chunk.
//
// ─── PHASE 76: THE JUNCTION BIAS, AND WHY THE FIRST SEVEN DID NOT MOVE ───────────────────────
//
// All seven Phase 33 anchors are street-CENTRELINE crossings. After Phase 75 doubled the ribbons
// that is 22 × 17.6 wu of open asphalt at a spine/major crossing, which at rig E's ~28 wu visible
// ground band is most of the frame — the shipped-build battery photographed financial-canyon,
// yonge-dundas, ny-centre and kensington with essentially no city in them. That emptiness is a
// REAL consequence of Phase 75 and worth measuring, but a battery that only samples junctions
// cannot separate "wide junction" from "wide street". Hence the three mid-block anchors below.
//
// TWO ARTEFACTS OF THE ORIGINAL SEVEN, recorded here rather than silently fixed:
//
//   1. `fold-corridor` sits on Yonge's CENTRELINE mid-band, i.e. on the Phase 75 planted median.
//      The median is visual-only (`MEDIAN_PLANTING.colliders === false`) so the pose is physically
//      legal and the car does sit there — but it is not a normal driving pose and the grass strip
//      is in every frame. The other three Yonge anchors are crossings, and roadStrips.ts's
//      `medianBandRuns` CUTS the median at every crossing, so they land on bare asphalt.
//      `vantagePose().onMedian` reports this per anchor and cameraVantages.test.ts pins the set,
//      so it is a measurement rather than folklore.
//
//   2. Every one of the seven is centreline-referenced, so none of them exercises the
//      camera-side LANE — the reference world/toronto/corridorLaw.ts calls `worstLane` and the one
//      that describes normal play (Phase 75 roughly tripled `LANE_OFFSET_WU`).
//
// They were deliberately NOT moved. The ids are append-only and their coordinates are the
// comparison basis for evidence already on disk (`.planning/screenshots/phase-76/baseline-E/`);
// moving them would silently change what a prior screenshot means while buying nothing, since the
// phase's honest comparison is candidate-to-candidate WITHIN one run. The three new anchors add
// the missing poses instead: `spine-midblock` is the on-lane, off-median spine framing that
// `fold-corridor` is not, and `minor-midblock` is the first minor-street pose in any battery —
// without which the Phase 76 corridor-law question (`minor` is the binding class) is unanswerable.

import { TORONTO_SPAWN, type RoadClass } from '../../config/torontoMap';
import { laneOffsetWu } from './corridorLaw';
import { buildDistricts, districtAt, type ResolvedDistrict } from './districts';
import { ZONE_BOUNDARIES } from './projection';
import { listIntersections, type Intersection } from './roadGraph';
import { buildStreets, type MapRect, type Street } from './streets';

/** Whether an anchor sits where two streets cross, or on an open block run between crossings. */
export type VantageKind = 'junction' | 'midblock';

/**
 * One battery anchor. `x`/`z` are WORLD coordinates (map x → world x, map y → world z — the
 * identity swap every Toronto module uses).
 *
 * Everything after `z` is DERIVED FROM THE POINT (see `vantagePose`), not authored alongside it:
 * the anchor set describes itself, so the contact sheet can label a cell "junction, on the
 * median" without the harness knowing anything about the map.
 */
export interface CameraVantage {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  /** Every street whose ribbon contains this point. Two of DIFFERENT axes ⇒ a junction; two of
   * the SAME axis ⇒ a Phase 75 swallowed carriageway (Bay over York), which is worth seeing. */
  readonly streetIds: readonly string[];
  /** The widest containing street — the asphalt the pose is actually on. */
  readonly streetId: string;
  readonly cls: RoadClass;
  readonly kind: VantageKind;
  /** Signed lateral offset (wu) from `streetId`'s centreline, POSITIVE toward the camera side
   * (+x for an 'ns' street, +z for an 'ew' one — the eye's own offset is positive on both axes at
   * the pinned yaw 45). 0 ⇒ a centreline pose. */
  readonly laneOffsetWu: number;
  /** True when the pose sits on a Phase 75 planted median (artefact 1 in the header). */
  readonly onMedian: boolean;
}

/** The district whose bounds the "kensington" vantage must land inside. */
const KENSINGTON_DISTRICT_ID = 'chinatownKensington';

function crossing(intersections: readonly Intersection[], nsId: string, ewId: string): Intersection {
  const hit = intersections.find((i) => i.nsId === nsId && i.ewId === ewId);
  if (!hit) {
    // Loud, not silent: a missing crossing means the street table moved and the vantage no longer
    // means what its name says — exactly the drift a derived battery exists to catch.
    throw new Error(`cameraVantages: no crossing of "${nsId}" and "${ewId}" in the street table`);
  }
  return hit;
}

function streetById(streets: readonly Street[], id: string): Street {
  const s = streets.find((st) => st.id === id);
  if (!s) throw new Error(`cameraVantages: street "${id}" is missing from the street table`);
  return s;
}

function districtById(id: string): ResolvedDistrict {
  const d = buildDistricts().find((rd) => rd.def.id === id);
  if (!d) throw new Error(`cameraVantages: district "${id}" is not in TORONTO_DISTRICTS`);
  return d;
}

/** The intersection inside `district`'s bounds nearest its centroid — a deterministic "somewhere
 * representative, and on a road" pick that needs no authored coordinate. */
function districtIntersection(district: ResolvedDistrict, intersections: readonly Intersection[]): Intersection {
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
  const inside = intersections.filter((i) =>
    district.rects.some((r) => i.x >= r.minX && i.x <= r.maxX && i.y >= r.minY && i.y <= r.maxY),
  );
  if (inside.length === 0) {
    throw new Error(`cameraVantages: district "${district.def.id}" contains no street crossing`);
  }
  let best = inside[0];
  let bestDistSq = Infinity;
  for (const i of inside) {
    const d = (i.x - cx) ** 2 + (i.y - cz) ** 2;
    // listIntersections is sorted deterministically, so a strict < keeps the first of any tie.
    if (d < bestDistSq) {
      bestDistSq = d;
      best = i;
    }
  }
  return best;
}

// --- mid-block derivation (Phase 76) ---------------------------------------------------------

function inRect(x: number, y: number, r: MapRect): boolean {
  return x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY;
}

/** Every street whose ribbon contains a map point, widest first (ties broken by id) — so
 * `[0]` is always the street whose asphalt dominates the pose. */
function containingStreets(x: number, y: number, streets: readonly Street[]): readonly Street[] {
  return streets
    .filter((s) => inRect(x, y, s.ribbon))
    .sort((a, b) => b.width - a.width || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The point one lane-width off `street`'s centreline TOWARD THE CAMERA, at along-axis `along`.
 *
 * The lateral distance is world/toronto/corridorLaw.ts's `laneOffsetWu` — the street's own
 * carriageway centre, honouring a per-street median opt-in — never a re-derivation and never a
 * literal, so this lands exactly where the traffic graph puts a lane chain.
 *
 * WHY THE CAMERA SIDE. fx/cameraRig's eye offset is positive on BOTH horizontal axes at the
 * pinned yaw 45, so +x on an 'ns' street and +y (map south / world +z) on an 'ew' one is the lane
 * that leaves the camera the least room — corridorLaw's `worstLane` reference, and a real travel
 * lane in both cases (roadGraph's right-hand convention puts northbound at +x and eastbound
 * at +y). Sampling the far lane would flatter every candidate.
 */
function cameraSideLanePoint(street: Street, along: number): { x: number; y: number } {
  const off = laneOffsetWu(street);
  return street.axis === 'ns' ? { x: street.centerline + off, y: along } : { x: along, y: street.centerline + off };
}

/** Along-axis coordinates at which another street crosses `street`, inside its own span. */
function crossingsAlong(street: Street, intersections: readonly Intersection[]): readonly number[] {
  const [lo, hi] = street.span;
  return intersections
    .filter((i) => (street.axis === 'ns' ? i.nsId === street.id : i.ewId === street.id))
    .map((i) => (street.axis === 'ns' ? i.y : i.x))
    .filter((v) => v > lo && v < hi);
}

/** One candidate mid-block pose: the camera-side lane point at the MIDPOINT of an open block run,
 * carrying the run's length so "most mid-block" (= furthest from any crossing) is selectable. */
interface MidBlockPose {
  readonly street: Street;
  readonly gapWu: number;
  readonly x: number;
  readonly y: number;
  readonly containing: readonly Street[];
}

/**
 * Every open block run on every street, as a camera-side lane pose at its midpoint.
 *
 * A run is the gap between two consecutive along-axis cuts (span end / crossing). Its midpoint is
 * the point furthest from any junction on that run, which is exactly what "mid-block" means here.
 */
function midBlockPoses(streets: readonly Street[], intersections: readonly Intersection[]): readonly MidBlockPose[] {
  const out: MidBlockPose[] = [];
  for (const street of streets) {
    const [lo, hi] = street.span;
    const cuts = [lo, ...crossingsAlong(street, intersections), hi].sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i++) {
      const gapWu = cuts[i + 1] - cuts[i];
      if (gapWu <= 0) continue;
      const p = cameraSideLanePoint(street, (cuts[i] + cuts[i + 1]) / 2);
      out.push({ street, gapWu, x: p.x, y: p.y, containing: containingStreets(p.x, p.y, streets) });
    }
  }
  return out;
}

/**
 * A pose is CLEAN when its own street is the only ribbon under it.
 *
 * One predicate, two failure modes: a point still inside a crossing street's ribbon is not
 * mid-block at all, and a point inside a WIDER parallel street's ribbon is a Phase 75 swallowed
 * carriageway (Bay's 17.6 wu ribbon swallows York's centreline outright — roadGraph.ts's
 * `swallowedSpans`), which would put a vantage named "minor" on a major road's asphalt.
 */
function isCleanMidBlock(pose: MidBlockPose): boolean {
  return pose.containing.length === 1 && pose.containing[0].id === pose.street.id;
}

/** Inside the downtown band — the only zone with a real streetwall, and the two Yonge-stem zones
 * are already represented by `fold-corridor` (fold) and `ny-centre` (capsule). */
function inDowntownBand(y: number): boolean {
  return y > ZONE_BOUNDARIES[2] && y < ZONE_BOUNDARIES[3];
}

/**
 * THE BUILT-FORM MEASUREMENT the three Phase 76 anchors are selected on: how tall the TYPICAL
 * building is in the district containing a point, in metres, or 0 off-district.
 *
 * `TorontoDistrictDef.heightRangeM` is the live per-district building-height range — frontage.ts's
 * backdrop-tower row (`buildBackdropTowers`) and infill.ts's back-lot boxes both draw their heights
 * from it — so it is what actually determines how much city stands behind a facade line. The
 * range FLOOR is the "continuous" half of "tallest continuous streetwall": a district whose EVERY
 * building is tall reads as a canyon, one with a tall outlier does not.
 *
 * Compared in metres rather than through heightCurve's `hGame`, which is strictly monotonic
 * (`2.05·h^0.6`) and therefore cannot change any ranking taken on it.
 */
function builtFormFloorM(x: number, y: number, districts: readonly ResolvedDistrict[]): number {
  return districtAt({ x, y }, districts)?.heightRangeM[0] ?? 0;
}

/**
 * THE ONE SELECTOR all three Phase 76 anchors use: among clean mid-block poses passing `where`,
 * take the pose with the most city around it (`builtFormFloorM`), tie-broken by the LONGEST block
 * run (the pose furthest from any junction), then by (x, y) so the pick is total and stable under
 * any future re-ordering of the street table.
 *
 * Stated once, in one place, and applied three times with different filters — "the most mid-block
 * pose where there is the most city to see". Selecting on run length alone put `minor-midblock` on
 * Bremner Blvd in the rail lands, where a minor street's corridor bound cannot bite because there
 * is no tall streetwall to bite on; the built-form term is what makes each anchor answer its own
 * question. Every branch throws rather than falling back: an anchor that silently relocates is
 * worse than no anchor.
 */
function pickMidBlock(
  poses: readonly MidBlockPose[],
  districts: readonly ResolvedDistrict[],
  where: (p: MidBlockPose) => boolean,
  label: string,
): MidBlockPose {
  const ok = poses.filter((p) => isCleanMidBlock(p) && where(p));
  if (ok.length === 0) {
    throw new Error(
      `cameraVantages: no clean mid-block pose satisfies "${label}" — the street table, the lane ` +
        'offsets or the zone bands moved, and this anchor no longer means what its name says',
    );
  }
  return [...ok].sort(
    (a, b) =>
      builtFormFloorM(b.x, b.y, districts) - builtFormFloorM(a.x, a.y, districts) ||
      b.gapWu - a.gapWu ||
      a.x - b.x ||
      a.y - b.y,
  )[0];
}

/**
 * The district with the tallest continuous built form, by the same `builtFormFloorM` measurement —
 * the district `streetwall-canyon` is constrained to, exported so cameraVantages.test.ts can pin
 * the winner and the whole score table as a MEASUREMENT (the Phase 75 tripwire tradition): a
 * district re-grade then reports itself instead of silently relocating the anchor.
 */
export function tallestStreetwallDistrict(): ResolvedDistrict {
  const ranked = [...buildDistricts()].sort(
    (a, b) =>
      b.def.heightRangeM[0] - a.def.heightRangeM[0] ||
      b.def.heightRangeM[1] - a.def.heightRangeM[1] ||
      (a.def.id < b.def.id ? -1 : a.def.id > b.def.id ? 1 : 0),
  );
  if (ranked.length === 0) throw new Error('cameraVantages: no districts to rank for streetwall-canyon');
  return ranked[0];
}

// --- pose description -------------------------------------------------------------------------

/**
 * Describe a resolved anchor point: which ribbons it sits on, whether that is a junction, how far
 * off the dominant street's centreline it is, and whether that puts it on a planted median.
 *
 * Derived from the point + the street table alone, so the seven historic anchors get labelled by
 * the same rules as the three new ones and nobody has to trust an annotation.
 */
function vantagePose(id: string, x: number, y: number, streets: readonly Street[]): CameraVantage {
  const containing = containingStreets(x, y, streets);
  if (containing.length === 0) {
    throw new Error(`cameraVantages: anchor "${id}" (${x}, ${y}) is not on any street ribbon`);
  }
  const primary = containing[0];
  const lateral = primary.axis === 'ns' ? x - primary.centerline : y - primary.centerline;
  // A junction needs ribbons of BOTH axes under the point; two same-axis ribbons is a swallowed
  // carriageway, which is a different (and separately interesting) thing.
  const kind: VantageKind =
    containing.some((s) => s.axis === 'ns') && containing.some((s) => s.axis === 'ew') ? 'junction' : 'midblock';
  // roadStrips.ts's medianBandRuns cuts the planted strip at every crossing, so a junction pose is
  // on bare asphalt however close to the centreline it sits.
  const onMedian = kind !== 'junction' && primary.medianWidth > 0 && Math.abs(lateral) < primary.medianHalfWidth;
  return {
    id,
    x,
    z: y,
    streetIds: containing.map((s) => s.id),
    streetId: primary.id,
    cls: primary.cls,
    kind,
    laneOffsetWu: lateral,
    onMedian,
  };
}

/**
 * The ten battery anchors, in a stable order. Every one sits on a road surface:
 *   - the five crossings are street-centreline intersections;
 *   - `fold-corridor` sits on the Yonge spine (which spans the whole map) at the MIDPOINT of the
 *     fold band — the stem's narrowest, most clamp-stressed stretch, which no named EW street
 *     bisects exactly (and, post-Phase-75, on the planted median — see the header);
 *   - `spawn` is the shipped player spawn (config/torontoMap.ts's TORONTO_SPAWN, already
 *     lane-offset onto southbound Yonge);
 *   - the three Phase 76 anchors are camera-side LANE points on the block run their own filter +
 *     `pickMidBlock`'s built-form rule select (never authored coordinates).
 *
 * WHAT THE THREE NEW ANCHORS RESOLVE TO TODAY (measured, pinned in cameraVantages.test.ts — this
 * is a record of the current map, not an input):
 *   - `minor-midblock`    → Richmond St, mid-block between Bay and Yonge, financial district
 *   - `spine-midblock`    → Yonge, mid-block between Front and Queens Quay, harbourfront district
 *   - `streetwall-canyon` → Queen St, mid-block between Bay and Yonge, financial district
 * Three different road classes (minor / spine / major) and two controlled junction↔mid-block pairs
 * with the historic set: `financial-canyon` ↔ the two financial anchors, `harbourfront` ↔
 * `spine-midblock`. Richmond and Queen land one block apart on the same Bay–Yonge line — that is a
 * deliberate minor-vs-major width A/B in one district, not a duplicate: at ~32 wu of separation
 * they frame adjacent, non-overlapping content under the rig's ~28 wu visible ground band.
 */
export function cameraVantages(): readonly CameraVantage[] {
  const { streets } = buildStreets();
  const intersections = listIntersections(streets);
  const yonge = streetById(streets, 'yonge');
  const bayKing = crossing(intersections, 'bay', 'king');
  const yongeDundas = crossing(intersections, 'yonge', 'dundas');
  const yongeSheppard = crossing(intersections, 'yonge', 'sheppard');
  const yongeQuay = crossing(intersections, 'yonge', 'queensquay');
  const kensington = districtIntersection(districtById(KENSINGTON_DISTRICT_ID), intersections);

  const districts = buildDistricts();
  const poses = midBlockPoses(streets, intersections);
  // The corridor law's binding class post-Phase-75 — and the first minor-street pose in any
  // battery. Downtown-only: the fold/capsule minors have no streetwall to clear.
  const minorMid = pickMidBlock(
    poses,
    districts,
    (p) => p.street.cls === 'minor' && inDowntownBand(p.y),
    'downtown minor street',
  );
  // The on-lane, off-median spine framing `fold-corridor` cannot be: separates "wide junction"
  // from "wide street" in the emptiness read.
  const spineMid = pickMidBlock(
    poses,
    districts,
    (p) => p.street.id === yonge.id && inDowntownBand(p.y),
    'downtown Yonge spine',
  );
  // Best case for city-in-frame, and the controlled partner of `financial-canyon`: whichever
  // district `tallestStreetwallDistrict()` measures, sampled MID-BLOCK instead of at a crossing.
  // Resolved LAST and barred from the two streets already claimed above, so the three new anchors
  // are three distinct corridors rather than (as the unconstrained rule would allow) two poses on
  // one street — the corridor law is per road CLASS, and a battery that samples one width twice
  // answers less than one that samples three.
  const canyonDistrict = tallestStreetwallDistrict();
  const claimed = new Set([minorMid.street.id, spineMid.street.id]);
  const canyonMid = pickMidBlock(
    poses,
    districts,
    (p) => !claimed.has(p.street.id) && canyonDistrict.rects.some((r) => inRect(p.x, p.y, r)),
    `tallest-streetwall district "${canyonDistrict.def.id}"`,
  );

  return [
    vantagePose('financial-canyon', bayKing.x, bayKing.y, streets),
    vantagePose('yonge-dundas', yongeDundas.x, yongeDundas.y, streets),
    vantagePose('fold-corridor', yonge.centerline, (ZONE_BOUNDARIES[1] + ZONE_BOUNDARIES[2]) / 2, streets),
    vantagePose('ny-centre', yongeSheppard.x, yongeSheppard.y, streets),
    vantagePose('kensington', kensington.x, kensington.y, streets),
    vantagePose('harbourfront', yongeQuay.x, yongeQuay.y, streets),
    vantagePose('spawn', TORONTO_SPAWN.x, TORONTO_SPAWN.y, streets),
    vantagePose('minor-midblock', minorMid.x, minorMid.y, streets),
    vantagePose('spine-midblock', spineMid.x, spineMid.y, streets),
    vantagePose('streetwall-canyon', canyonMid.x, canyonMid.y, streets),
  ];
}

/** Every vantage id, in builder order — the devPanel's teleport buttons and the battery's row
 * order both read this. APPEND-ONLY (the header says why): the three Phase 76 ids are added after
 * the seven Phase 33 ones, whose coordinates are unchanged so prior evidence stays comparable.
 * Kept in lockstep with the builder by cameraVantages.test.ts. */
export const CAMERA_VANTAGE_IDS: readonly string[] = [
  'financial-canyon',
  'yonge-dundas',
  'fold-corridor',
  'ny-centre',
  'kensington',
  'harbourfront',
  'spawn',
  'minor-midblock',
  'spine-midblock',
  'streetwall-canyon',
];
