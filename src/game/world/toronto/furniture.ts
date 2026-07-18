// Toronto map v2 — street furniture + parked-vehicle placement DATA (Phase 25.6 D16/D18,
// CLAUDE.md CITY-PACK REAPPROACH criterion 3). Pure TS: no three/react, no fs at runtime,
// deterministic (mulberry32 forks via world/rng.ts, same contract as massing.ts/frontage.ts).
// Consumers (a separate mounting task) turn these into CityPackInstances/CityPackBatched
// placements + Rapier bodies — this module never touches three or @react-three/rapier.
//
// SCOPE (honest, matches the plan's own optionality): the "garnish tier" (road-bits patches,
// dumpster/trash-bag/debris-papers alley clusters, greenhouse companion prop) is explicitly
// "build only if time permits" in the plan (D16) and is NOT built here — every other rule
// (traffic-light signalization, power boxes, tree/hydrant/bench/trash/bus-stop rows, manholes,
// parked vehicles) is implemented and tested.
//
// EXCLUSION-AWARE: every placement avoids the same named-building + places-layer footprints
// buildMassing/frontage.ts avoid (buildNamedBuildings().exclusions ∪ buildPlacesLayer().
// exclusions) — furniture never spawns inside a landmark or storefront lot.
//
// DISTRICT-ORDERED (CLAUDE.md sacred convention): every per-item-type array is grouped by
// district in TORONTO_DISTRICTS config order, with recorded [start,count] `*Ranges` — the
// address a future blackout write (street lamps going dark) could poke, even though nothing
// reads it yet. Traffic-light masts are the one exception (an intersection can straddle two
// districts) — they carry `districtId` per mast but are ordered by intersection, not grouped.

import { colliderHalfExtents, resolveCityPackScale, type ColliderHalfExtents } from '../../config/cityPackScale';
import {
  BENCH_ROW,
  BUS_STOP_ROW,
  DRESS_DENSITY_SCALAR,
  HYDRANT_ROW,
  MANHOLE_ROW,
  PARKED,
  PARKED_MODELS,
  POWER_BOX,
  SIDEWALK_ROW,
  STOP_SIGN,
  TRAFFIC_LIGHT,
  TRAFFIC_LIGHT_FULL_CLASSES,
  TRASH_CAN_ROW,
  TREE_ROW,
} from '../../config/torontoDress';
import { TORONTO_DISTRICTS, type DistrictDensity, type DistrictId, type TorontoDistrictDef } from '../../config/torontoDistricts';
import { ROAD_CLASSES } from '../../config/torontoMap';
import { getCityPackModel } from '../../assets/cityPackManifest';
import { createRng, type Rng } from '../rng';
import { buildDistricts, districtAt, type ResolvedDistrict } from './districts';
import { buildNamedBuildings } from './namedBuildings';
import { buildPlacesLayer } from './placesLayer';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import { mapToWorld, type MapPoint } from './projection';
import { listIntersections, type Intersection } from './roadGraph';
import { buildStreets, type MapRect, type Street } from './streets';

// --- output shapes -----------------------------------------------------------------------

/** One furniture/prop placement — matches world/toronto/cityPack/CityPackInstances.tsx's
 * `CityPackPlacement` shape exactly (position/rotationY) plus the bookkeeping the mounting task
 * needs to sort instances into per-model groups and district-ordered ranges. */
export interface FurniturePlacement {
  readonly modelId: string;
  /** World-space [x, y, z] (mapToWorld'd; y is ground = 0 unless documented otherwise). */
  readonly position: readonly [number, number, number];
  readonly rotationY: number;
  readonly districtId: DistrictId;
}

export type LampAxis = 'ns' | 'ew';

/** One traffic-light mast. `axis` is which through-street this mast's lamp overlay tracks
 * (cosmetic assignment — D17: "no traffic obeys it"); `intersectionIndex` + `parityOffsetMs`
 * feed world/toronto/lampClock.ts's per-intersection desync. */
export interface LampMast extends FurniturePlacement {
  readonly axis: LampAxis;
  readonly intersectionIndex: number;
}

export interface ParkedVehicle {
  readonly modelId: string;
  readonly position: readonly [number, number, number];
  readonly rotationY: number;
  readonly districtId: DistrictId;
}

export interface DistrictRange {
  readonly districtId: DistrictId;
  readonly start: number;
  readonly count: number;
}

export interface DistrictOrdered<T> {
  readonly items: readonly T[];
  readonly ranges: readonly DistrictRange[];
}

export interface FurnitureColliderSpecs {
  /** Fixed TRUNK cuboid (D12) — never the tree's canopy colliderHalfExtents('tree'). Shared by
   * every tree placement (same model/scale, so one shared value). */
  readonly treeTrunk: ColliderHalfExtents;
  /** Fixed collider (D12) — shared by every bus-stop placement. */
  readonly busStop: ColliderHalfExtents;
  /** Dynamic body spec (D12) — shared by every parked-vehicle placement (mass/damping only;
   * per-model half-extents are colliderHalfExtents(modelId), computed by the mounting task). */
  readonly parkedBody: typeof PARKED.body;
}

export interface FurnitureLayout {
  readonly trafficLights: readonly LampMast[];
  /** Stop-sign corner posts (minor x minor intersections) — one per intersection, cosmetic. */
  readonly stopSigns: DistrictOrdered<FurniturePlacement>;
  readonly powerBoxes: DistrictOrdered<FurniturePlacement>;
  readonly trees: DistrictOrdered<FurniturePlacement>;
  readonly hydrants: DistrictOrdered<FurniturePlacement>;
  readonly benches: DistrictOrdered<FurniturePlacement>;
  readonly trashCans: DistrictOrdered<FurniturePlacement>;
  readonly busStops: DistrictOrdered<FurniturePlacement>;
  readonly manholes: DistrictOrdered<FurniturePlacement>;
  readonly parked: DistrictOrdered<ParkedVehicle>;
  readonly colliderSpecs: FurnitureColliderSpecs;
  /** category -> placed count, for tests/debug/the verification-plan dump (D16 "record exact"). */
  readonly counts: Readonly<Record<string, number>>;
}

// --- district-order bookkeeping (sacred convention) -------------------------------------------

const DISTRICT_ORDER: readonly DistrictId[] = TORONTO_DISTRICTS.map((d) => d.id);
const DISTRICT_INDEX = new Map<DistrictId, number>(DISTRICT_ORDER.map((id, i) => [id, i]));

function orderByDistrict<T extends { districtId: DistrictId }>(items: readonly T[]): DistrictOrdered<T> {
  const sorted = [...items].sort((a, b) => DISTRICT_INDEX.get(a.districtId)! - DISTRICT_INDEX.get(b.districtId)!);
  const ranges: DistrictRange[] = [];
  let i = 0;
  while (i < sorted.length) {
    const districtId = sorted[i].districtId;
    const start = i;
    while (i < sorted.length && sorted[i].districtId === districtId) i++;
    ranges.push({ districtId, start, count: i - start });
  }
  return { items: sorted, ranges };
}

// --- geometry helpers --------------------------------------------------------------------

/** Squared point-to-rect distance is enough for a >0 clearance test; avoids a sqrt per check. */
function pointRectDistSq(p: MapPoint, r: MapRect): number {
  const dx = Math.max(r.minX - p.x, 0, p.x - r.maxX);
  const dz = Math.max(r.minY - p.y, 0, p.y - r.maxY);
  return dx * dx + dz * dz;
}

function tooCloseToExclusion(p: MapPoint, exclusions: readonly MapRect[], marginWu: number): boolean {
  const m2 = marginWu * marginWu;
  return exclusions.some((r) => pointRectDistSq(p, r) < m2);
}

/**
 * Nudges `p` toward `fallback` (a point KNOWN to be inside the polygon — e.g. the intersection
 * centre, which sits on a street and is therefore inside by construction) until it lands inside
 * PLAYABLE_POLYGON. Handles the rare case where a corner offset (ribbon edge + cornerOffsetWu)
 * pokes past a polygon/zone boundary near the map edge — the boundary-nudge in streets.ts only
 * guarantees the RIBBON stays inside, not a point offset further out beyond it. Terminates in
 * <=10 steps; `fallback` itself is the guaranteed-safe last resort.
 */
function clampInsidePolygon(p: MapPoint, fallback: MapPoint): MapPoint {
  if (pointInPolygon(p, PLAYABLE_POLYGON)) return p;
  for (let step = 1; step <= 10; step++) {
    const t = step / 10;
    const candidate: MapPoint = { x: p.x + (fallback.x - p.x) * t, y: p.y + (fallback.y - p.y) * t };
    if (pointInPolygon(candidate, PLAYABLE_POLYGON)) return candidate;
  }
  return fallback;
}

/** Point at `along` the street's own axis, offset `perpWu` perpendicular to the centreline
 * (positive = the street's +x/+y side). */
function pointAlong(street: Street, along: number, perpWu: number): MapPoint {
  if (street.axis === 'ns') return { x: street.centerline + perpWu, y: along };
  return { x: along, y: street.centerline + perpWu };
}

/**
 * Best-effort "face the road" yaw (codebase's documented `atan2(dx, dz)` heading convention,
 * world +Z forward at yaw 0 — CLAUDE.md / config/torontoMap.ts's TORONTO_SPAWN doc comment).
 * Points from the sidewalk position back toward the street centreline. Cosmetically harmless
 * for radially-symmetric props (hydrant/tree/manhole/power-box); a reasonable default for
 * benches/bus-stops pending the mounting task's visual tuning.
 */
function faceRoadRotationY(street: Street, side: 1 | -1): number {
  const dx = street.axis === 'ns' ? -side : 0;
  const dz = street.axis === 'ns' ? 0 : -side;
  return Math.atan2(dx, dz);
}

/** Deterministic full-turn spin for radially-symmetric props (visual variety; meaningless for
 * the model's silhouette but avoids every instance facing identically). */
function seededSpin(rng: Rng): number {
  return rng.next() * Math.PI * 2;
}

function toWorldPlacement(modelId: string, p: MapPoint, rotationY: number, districtId: DistrictId): FurniturePlacement {
  const [x, z] = mapToWorld(p);
  return { modelId, position: [x, 0, z], rotationY, districtId };
}

function weightedPick(rng: Rng, entries: readonly { readonly id: string; readonly weight: number }[]): string {
  const total = entries.reduce((s, e) => s + e.weight, 0);
  let r = rng.next() * total;
  for (const e of entries) {
    r -= e.weight;
    if (r <= 0) return e.id;
  }
  return entries[entries.length - 1].id;
}

/** Deterministic even-stride thinning to a hard cap — preserves the walk's spatial spread
 * better than truncating the tail (same policy spirit as D6's frontage 900-cap thinning). */
function thinToCap<T>(items: readonly T[], cap: number): readonly T[] {
  if (items.length <= cap) return items;
  const stride = items.length / cap;
  const out: T[] = [];
  for (let i = 0; i < cap; i++) out.push(items[Math.floor(i * stride)]);
  return out;
}

/** Walk a street's span at ~spacingWu intervals (light seeded jitter for an organic feel),
 * yielding the along-axis coordinate of each candidate stop. Deterministic: same rng stream ->
 * same stops. */
function walkSpan(street: Street, spacingWu: number, rng: Rng): readonly number[] {
  const [lo, hi] = street.span;
  const length = hi - lo;
  if (length <= 0) return [];
  const n = Math.max(1, Math.round(length / spacingWu));
  const step = length / n;
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const jitter = (rng.next() * 2 - 1) * step * 0.15;
    out.push(Math.min(hi, Math.max(lo, lo + i * step + jitter)));
  }
  return out;
}

/** One place THIS street crosses another: `along` this street's own axis, plus the CROSSING
 * street's own halfWidth — its ribbon extends that far either side of `along`, so a sidewalk/
 * road item offset perpendicular from THIS street can still land inside the CROSS street's
 * ribbon even well clear of the exact crossing point (the bug this shape exists to prevent). */
interface StreetCrossing {
  readonly along: number;
  readonly crossHalfWidth: number;
}

function crossingsOn(street: Street, intersections: readonly Intersection[]): readonly StreetCrossing[] {
  return intersections
    .filter((c) => (street.axis === 'ns' ? c.nsId === street.id : c.ewId === street.id))
    .map((c) => ({
      along: street.axis === 'ns' ? c.y : c.x,
      crossHalfWidth: ROAD_CLASSES[street.axis === 'ns' ? c.ewCls : c.nsCls] / 2,
    }));
}

/** True if `along` falls within `extraMarginWu` of the full width of ANY crossing street's
 * ribbon (not just the bare crossing point) — the correct clearance test for an item offset
 * perpendicular off `street`'s own centreline. */
function nearAnyCrossing(along: number, crossings: readonly StreetCrossing[], extraMarginWu: number): boolean {
  return crossings.some((c) => Math.abs(along - c.along) < c.crossHalfWidth + extraMarginWu);
}

// --- traffic lights / stop signs (D16) ----------------------------------------------------

const FULL_CLASS_SET = new Set<string>(TRAFFIC_LIGHT_FULL_CLASSES);

type IntersectionKind = 'signalized' | 'diagonal' | 'stopSign';

function classifyIntersection(i: Intersection): IntersectionKind {
  const nsFull = FULL_CLASS_SET.has(i.nsCls);
  const ewFull = FULL_CLASS_SET.has(i.ewCls);
  if (nsFull && ewFull) return 'signalized';
  if (nsFull || ewFull) return 'diagonal';
  return 'stopSign';
}

/** The 4 corner points around an intersection, offset `ROAD_CLASSES[cls]/2 + cornerOffsetWu` on
 * both axes (D16: "ribbon edge + 0.8 on both axes"). Fixed index order: [+ns/-ew, +ns/+ew,
 * -ns/-ew, -ns/+ew] — TRAFFIC_LIGHT.diagonalCornerIndices picks two of these for a 2-mast
 * intersection. */
function cornerPoints(i: Intersection): readonly MapPoint[] {
  const nsHalf = ROAD_CLASSES[i.nsCls] / 2 + TRAFFIC_LIGHT.cornerOffsetWu;
  const ewHalf = ROAD_CLASSES[i.ewCls] / 2 + TRAFFIC_LIGHT.cornerOffsetWu;
  return [
    { x: i.x + nsHalf, y: i.y - ewHalf },
    { x: i.x + nsHalf, y: i.y + ewHalf },
    { x: i.x - nsHalf, y: i.y - ewHalf },
    { x: i.x - nsHalf, y: i.y + ewHalf },
  ];
}

/**
 * Arm rotation (verified convention — CityPackPreview.tsx's traffic-light placement, D16): the
 * model's native arm is on local -X. World direction (ux,0,uz) is reached at
 * `rotationY = atan2(uz, -ux)`. Arms reach from the corner mast TOWARD the intersection centre
 * (over the near approach lane).
 */
function armRotationY(mast: MapPoint, target: MapPoint): number {
  const dx = target.x - mast.x;
  const dz = target.y - mast.y; // map y -> world z
  const len = Math.hypot(dx, dz) || 1;
  return Math.atan2(dz / len, -(dx / len));
}

function buildTrafficLightsAndStopSigns(
  intersections: readonly Intersection[],
  districts: readonly ResolvedDistrict[],
): { trafficLights: LampMast[]; stopSigns: FurniturePlacement[] } {
  const trafficLights: LampMast[] = [];
  const stopSigns: FurniturePlacement[] = [];

  intersections.forEach((intersection, intersectionIndex) => {
    const kind = classifyIntersection(intersection);
    const corners = cornerPoints(intersection);
    const centre: MapPoint = { x: intersection.x, y: intersection.y };
    const district = districtAt(centre, districts);
    if (!district) return; // outside every resolved district rect — skip (rare edge case)

    if (kind === 'stopSign') {
      const p = clampInsidePolygon(corners[STOP_SIGN.cornerIndex], centre);
      stopSigns.push(toWorldPlacement('stop-sign', p, faceRoadRotationYFromCentre(p, centre), district.id));
      return;
    }

    const cornerIndices = kind === 'signalized' ? [0, 1, 2, 3] : [...TRAFFIC_LIGHT.diagonalCornerIndices];
    cornerIndices.forEach((cornerIdx, slot) => {
      const p = clampInsidePolygon(corners[cornerIdx], centre);
      const cornerDistrict = districtAt(p, districts) ?? district;
      // Cosmetic-only axis assignment (D17: "no traffic obeys it") — alternates by placement
      // slot so a 4-mast intersection shows 2 NS-tracking + 2 EW-tracking lamps.
      const axis: LampAxis = slot % 2 === 0 ? 'ns' : 'ew';
      trafficLights.push({
        modelId: 'traffic-light',
        position: withY(mapToWorld(p), 0),
        rotationY: armRotationY(p, centre),
        districtId: cornerDistrict.id,
        axis,
        intersectionIndex,
      });
    });
  });

  return { trafficLights, stopSigns };
}

function withY([x, z]: readonly [number, number], y: number): readonly [number, number, number] {
  return [x, y, z];
}

/** Stop-sign posts don't need the arm's -X convention (no arm) — a simple "face the
 * intersection centre" yaw via the codebase's standard atan2(dx,dz) heading convention. */
function faceRoadRotationYFromCentre(p: MapPoint, centre: MapPoint): number {
  const dx = centre.x - p.x;
  const dz = centre.y - p.y;
  const len = Math.hypot(dx, dz) || 1;
  return Math.atan2(dx / len, dz / len);
}

// --- power boxes (D16) ---------------------------------------------------------------------

function buildPowerBoxes(
  intersections: readonly Intersection[],
  districts: readonly ResolvedDistrict[],
  rng: Rng,
): readonly FurniturePlacement[] {
  const out: FurniturePlacement[] = [];
  let corner = 0;
  intersections.forEach((intersection) => {
    if (classifyIntersection(intersection) === 'stopSign') return;
    const centre: MapPoint = { x: intersection.x, y: intersection.y };
    const corners = cornerPoints(intersection);
    for (const rawP of corners) {
      corner += 1;
      if (corner % POWER_BOX.everyNthSignalizedCorner !== 0) continue;
      if (rng.next() > 0.9) continue; // light seeded skip, avoids a perfectly periodic grid
      const p = clampInsidePolygon(rawP, centre);
      const district = districtAt(p, districts);
      if (!district) continue;
      out.push(toWorldPlacement('power-box', p, seededSpin(rng), district.id));
    }
  });
  return thinToCap(out, POWER_BOX.capMapWide);
}

// --- generic sidewalk rows (trees / hydrants / benches / trash cans / bus stops) -----------

interface RowSpec {
  readonly modelId: string;
  readonly spacingWu: number;
  readonly capMapWide: number;
  readonly rowOffsetWu: number; // from SIDEWALK_ROW (kerb or facade)
  readonly cornerClearanceWu: number;
  readonly eligible: (street: Street, district: TorontoDistrictDef) => boolean;
  readonly rotation: 'spin' | 'faceRoad';
}

function buildRow(
  spec: RowSpec,
  streets: readonly Street[],
  intersectionsByStreet: ReadonlyMap<string, readonly StreetCrossing[]>,
  districts: readonly ResolvedDistrict[],
  exclusions: readonly MapRect[],
  allRibbons: readonly MapRect[],
  rng: Rng,
): readonly FurniturePlacement[] {
  const halfWidth = (s: Street): number => s.width / 2;
  const out: FurniturePlacement[] = [];
  const effectiveSpacing = spec.spacingWu / DRESS_DENSITY_SCALAR;

  for (const street of streets) {
    const crossings = intersectionsByStreet.get(street.id) ?? [];
    for (const side of [1, -1] as const) {
      const streetRng = rng.fork(`${street.id}:${side}:${spec.modelId}`);
      const stops = walkSpan(street, effectiveSpacing, streetRng);
      for (const along of stops) {
        if (nearAnyCrossing(along, crossings, spec.cornerClearanceWu)) continue;
        const perp = (halfWidth(street) + spec.rowOffsetWu) * side;
        const p = pointAlong(street, along, perp);
        if (!pointInPolygon(p, PLAYABLE_POLYGON)) continue;
        // Own street is already cleared by the perpendicular offset — this catches a DIFFERENT,
        // nearby-parallel street's ribbon the offset happens to still land inside (no "crossing"
        // exists between two parallel streets, so nearAnyCrossing can't see this case).
        if (allRibbons.some((r) => p.x > r.minX && p.x < r.maxX && p.y > r.minY && p.y < r.maxY)) continue;
        const district = districtAt(p, districts);
        if (!district) continue;
        if (!spec.eligible(street, district)) continue;
        if (tooCloseToExclusion(p, exclusions, 1)) continue;
        const rotationY = spec.rotation === 'spin' ? seededSpin(streetRng) : faceRoadRotationY(street, side);
        out.push(toWorldPlacement(spec.modelId, p, rotationY, district.id));
      }
    }
  }
  return thinToCap(out, spec.capMapWide);
}

// --- manholes (on-road, D16) ----------------------------------------------------------------

function buildManholes(
  streets: readonly Street[],
  intersectionsByStreet: ReadonlyMap<string, readonly StreetCrossing[]>,
  districts: readonly ResolvedDistrict[],
  rng: Rng,
): readonly FurniturePlacement[] {
  const out: FurniturePlacement[] = [];
  const eligible = new Set<string>(MANHOLE_ROW.eligibleClasses);
  const effectiveSpacing = MANHOLE_ROW.spacingWu / DRESS_DENSITY_SCALAR;

  for (const street of streets) {
    if (!eligible.has(street.cls)) continue;
    const crossings = intersectionsByStreet.get(street.id) ?? [];
    const streetRng = rng.fork(`manhole:${street.id}`);
    const stops = walkSpan(street, effectiveSpacing, streetRng);
    let side: 1 | -1 = 1;
    for (const along of stops) {
      if (nearAnyCrossing(along, crossings, MANHOLE_ROW.centerlineOffsetWu + 1)) continue;
      const p = pointAlong(street, along, MANHOLE_ROW.centerlineOffsetWu * side);
      side = side === 1 ? -1 : 1; // alternate sides of the centreline
      const district = districtAt(p, districts);
      if (!district) continue;
      out.push(toWorldPlacement('manhole-cover', p, seededSpin(streetRng), district.id));
    }
  }
  return thinToCap(out, MANHOLE_ROW.capMapWide);
}

// --- parked vehicles (D18) -------------------------------------------------------------------

function buildParked(
  streets: readonly Street[],
  intersectionsByStreet: ReadonlyMap<string, readonly StreetCrossing[]>,
  districts: readonly ResolvedDistrict[],
  exclusions: readonly MapRect[],
  rng: Rng,
): readonly ParkedVehicle[] {
  const out: ParkedVehicle[] = [];
  const eligible = new Set<string>(PARKED.eligibleClasses);
  const densityFactor: Record<DistrictDensity, number> = { dense: 0, medium: 0.5, sparse: 1 };

  for (const street of streets) {
    if (!eligible.has(street.cls)) continue;
    const crossings = intersectionsByStreet.get(street.id) ?? [];
    for (const side of [1, -1] as const) {
      const streetRng = rng.fork(`parked:${street.id}:${side}`);
      const [lo, hi] = street.span;
      let along = lo;
      while (along < hi) {
        if (nearAnyCrossing(along, crossings, PARKED.minDistFromCornerWu)) {
          along += PARKED.minDistFromCornerWu;
          continue;
        }
        const halfWidth = street.width / 2;
        const perp = (halfWidth - PARKED.insetFromRibbonEdgeWu) * side;
        const p = pointAlong(street, along, perp);
        const district = districtAt(p, districts);
        const [spacingLo, spacingHi] = PARKED.spacingRangeWu;
        const districtDensity: DistrictDensity = district?.density ?? 'medium';
        const spacing = (spacingLo + (spacingHi - spacingLo) * densityFactor[districtDensity]) / DRESS_DENSITY_SCALAR;
        if (district && !tooCloseToExclusion(p, exclusions, 1.5)) {
          const modelId = weightedPick(streetRng, PARKED_MODELS);
          const rotationY = faceRoadRotationY(street, side) + Math.PI / 2; // parallel-parked: long axis along the street
          out.push({ modelId, position: withY(mapToWorld(p), 0), rotationY, districtId: district.id });
        }
        along += spacing;
      }
    }
  }
  return thinToCap(out, PARKED.cap);
}

// --- top-level orchestrator ------------------------------------------------------------------

/** Builds the whole street-furniture + parked-vehicle layout for `seed` (deterministic,
 * mulberry32 forks — same contract as world/rng.ts). Pure function of the street/district/
 * exclusion data; no react/three. */
export function buildFurniture(seed: number): FurnitureLayout {
  const base = createRng(seed).fork('toronto-furniture-v1');
  const { streets } = buildStreets();
  const intersections = listIntersections(streets);
  const districts = buildDistricts();
  const named = buildNamedBuildings();
  const places = buildPlacesLayer(named);
  const exclusions: readonly MapRect[] = [...named.exclusions, ...places.exclusions];
  const allRibbons: readonly MapRect[] = streets.map((s) => s.ribbon);

  const intersectionsByStreet = new Map<string, readonly StreetCrossing[]>(
    streets.map((s) => [s.id, crossingsOn(s, intersections)]),
  );

  const { trafficLights, stopSigns: stopSignsRaw } = buildTrafficLightsAndStopSigns(intersections, districts);
  const powerBoxesRaw = buildPowerBoxes(intersections, districts, base.fork('power-box'));

  const treesRaw = buildRow(
    {
      modelId: 'tree',
      spacingWu: TREE_ROW.spacingWu,
      capMapWide: TREE_ROW.capMapWide,
      rowOffsetWu: SIDEWALK_ROW.kerbOffsetWu,
      cornerClearanceWu: 4,
      eligible: (_street, district) => district.packStock.treeDensity === 'rows',
      rotation: 'spin',
    },
    streets,
    intersectionsByStreet,
    districts,
    exclusions,
    allRibbons,
    base.fork('tree'),
  );

  const hydrantsRaw = buildRow(
    {
      modelId: 'fire-hydrant',
      spacingWu: HYDRANT_ROW.spacingWu,
      capMapWide: HYDRANT_ROW.capMapWide,
      rowOffsetWu: SIDEWALK_ROW.kerbOffsetWu,
      cornerClearanceWu: 6,
      eligible: () => true,
      rotation: 'spin',
    },
    streets,
    intersectionsByStreet,
    districts,
    exclusions,
    allRibbons,
    base.fork('hydrant'),
  );

  const benchesRaw = buildRow(
    {
      modelId: 'bench',
      spacingWu: BENCH_ROW.spacingWu,
      capMapWide: BENCH_ROW.capMapWide,
      rowOffsetWu: SIDEWALK_ROW.facadeOffsetWu,
      cornerClearanceWu: 3,
      eligible: (_street, district) => district.density !== 'sparse',
      rotation: 'faceRoad',
    },
    streets,
    intersectionsByStreet,
    districts,
    exclusions,
    allRibbons,
    base.fork('bench'),
  );

  const trashCansRaw = buildRow(
    {
      modelId: 'trash-can',
      spacingWu: TRASH_CAN_ROW.spacingWu,
      capMapWide: TRASH_CAN_ROW.capMapWide,
      rowOffsetWu: SIDEWALK_ROW.facadeOffsetWu,
      cornerClearanceWu: 3,
      eligible: (_street, district) => district.density !== 'sparse',
      rotation: 'spin',
    },
    streets,
    intersectionsByStreet,
    districts,
    exclusions,
    allRibbons,
    base.fork('trash-can'),
  );

  const busStopEligible = new Set<string>(BUS_STOP_ROW.eligibleClasses);
  const busStopsRaw = buildRow(
    {
      modelId: 'bus-stop',
      spacingWu: BUS_STOP_ROW.spacingWu,
      capMapWide: BUS_STOP_ROW.capMapWide,
      rowOffsetWu: SIDEWALK_ROW.facadeOffsetWu,
      cornerClearanceWu: 6,
      eligible: (street) => busStopEligible.has(street.cls),
      rotation: 'faceRoad',
    },
    streets,
    intersectionsByStreet,
    districts,
    exclusions,
    allRibbons,
    base.fork('bus-stop'),
  );

  const manholesRaw = buildManholes(streets, intersectionsByStreet, districts, base.fork('manhole'));
  const parkedRaw = buildParked(streets, intersectionsByStreet, districts, exclusions, base.fork('parked'));

  const treeScale = resolveCityPackScale('tree');
  const treeNativeH = getCityPackModel('tree').nativeDims.h;
  const treeTrunkHy = (treeNativeH * treeScale) / 2;

  const colliderSpecs: FurnitureColliderSpecs = {
    treeTrunk: { hx: TREE_ROW.trunkHalfWidthWu, hy: treeTrunkHy, hz: TREE_ROW.trunkHalfWidthWu },
    // Bus-stop DOES get its real canopy box (D12) — only trees special-case a trunk-only
    // collider, so this reuses the shared cityPackScale resolver rather than re-deriving it.
    busStop: colliderHalfExtents('bus-stop'),
    parkedBody: PARKED.body,
  };

  const stopSigns = orderByDistrict(stopSignsRaw);
  const powerBoxes = orderByDistrict(powerBoxesRaw);
  const trees = orderByDistrict(treesRaw);
  const hydrants = orderByDistrict(hydrantsRaw);
  const benches = orderByDistrict(benchesRaw);
  const trashCans = orderByDistrict(trashCansRaw);
  const busStops = orderByDistrict(busStopsRaw);
  const manholes = orderByDistrict(manholesRaw);
  const parked = orderByDistrict(parkedRaw);

  return {
    trafficLights,
    stopSigns,
    powerBoxes,
    trees,
    hydrants,
    benches,
    trashCans,
    busStops,
    manholes,
    parked,
    colliderSpecs,
    counts: {
      trafficLights: trafficLights.length,
      stopSigns: stopSigns.items.length,
      powerBoxes: powerBoxes.items.length,
      trees: trees.items.length,
      hydrants: hydrants.items.length,
      benches: benches.items.length,
      trashCans: trashCans.items.length,
      busStops: busStops.items.length,
      manholes: manholes.items.length,
      parked: parked.items.length,
    },
  };
}
