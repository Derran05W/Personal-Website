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
import { SURFACE_ANCHOR } from '../../config/layering';
import {
  BENCH_ROW,
  BUS_STOP_ROW,
  DRESS_DENSITY_SCALAR,
  HYDRANT_ROW,
  MANHOLE_ROW,
  PARKED,
  POWER_BOX,
  SIDEWALK_ROW,
  STOP_SIGN,
  TORONTO_TIER_IDENTITY,
  TRAFFIC_LIGHT,
  TRAFFIC_LIGHT_FULL_CLASSES,
  TRASH_CAN_ROW,
  TREE_ROW,
  type TorontoTierParams,
} from '../../config/torontoDress';
import { TORONTO_DISTRICTS, type DistrictDensity, type DistrictId, type TorontoDistrictDef } from '../../config/torontoDistricts';
import { ROAD_CLASSES, SIDEWALK } from '../../config/torontoMap';
import { getCityPackModel } from '../../assets/cityPackManifest';
import { neutralVehicleModelId } from '../../config/carVariety';
import { createCarVarietySequencer } from '../../vehicles/carVariety';
import { createRng, type Rng } from '../rng';
import { aabbAround, createClaimIndex, footprintHalfExtents, overlaps, type Aabb, type ClaimIndex } from './claimIndex';
import { districtAt, type ResolvedDistrict } from './districts';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import { mapToWorld, type MapPoint } from './projection';
import { type Intersection } from './roadGraph';
import { type MapRect, type Street } from './streets';
import { busRouteStreetCoverage, isOnBusRoute } from './transitRoutes';
import { BLOCKING_QUERY, EXCLUSION_ZONE_KINDS, type PlacementContext } from './worldContext';

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
  /** Phase 29 (D4/D5): the NEUTRAL-BODY variant id (config/carVariety.ts neutralVehicleModelId) so
   * the per-car `tint` multiplies to a true body colour; collider/scale resolve identically to the
   * base id (same native dims). */
  readonly modelId: string;
  readonly position: readonly [number, number, number];
  readonly rotationY: number;
  readonly districtId: DistrictId;
  /** Phase 29 (D4): carVariety body colour (sRGB hex) applied as the render material colour. */
  readonly tint?: string;
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

// --- Phase 40: the placement-arbiter gate ---------------------------------------------------

/**
 * The claim footprint of one furniture item, through the SAME rotation rule composeWorld uses when
 * it registers the accepted placements (claimIndex.footprintHalfExtents: exact for axis-aligned
 * yaws, circumscribed square for the seeded spins). Two documented "claim the trunk, not the
 * canopy" exceptions:
 *   • `tree` — TREE_ROW.trunkHalfWidthWu, matching the D12 trunk-collider convention. The canopy
 *     box would claim ~3 wu of sidewalk the player drives straight through.
 *   • `traffic-light` — TRAFFIC_LIGHT.postHalfWidthWu, because the model's width is the ARM
 *     reaching over the roadway at 3.78 wu, not anything standing on the corner.
 */
function furnitureFootprint(modelId: string, p: MapPoint, rotationY: number): Aabb {
  const base =
    modelId === 'tree'
      ? { hx: TREE_ROW.trunkHalfWidthWu, hz: TREE_ROW.trunkHalfWidthWu }
      : modelId === 'traffic-light'
        ? { hx: TRAFFIC_LIGHT.postHalfWidthWu, hz: TRAFFIC_LIGHT.postHalfWidthWu }
        : colliderHalfExtents(modelId);
  const rotated = footprintHalfExtents(base.hx, base.hz, rotationY);
  return aabbAround(p.x, p.y, rotated.hx, rotated.hz);
}

/**
 * Furniture's view of the arbiter: `taken(fp)` is true when the footprint interior-overlaps
 * ANYTHING already on the map. Two sources, both bucket-indexed:
 *   1. `ctx.index` — every earlier layer (named boxes, the world-edge ring, the frontage
 *      streetwall + corner fills + backdrop towers, venue dressing props/queues, and the whole
 *      infill layer: back lots, parking/construction fixtures + cars, laneway clutter, deep
 *      scatter). Gaps 1, 2 and 5 of the Phase-40 audit close here, all at once.
 *   2. `own` — a LOCAL claim index this layer fills as it goes, so furniture also stops standing
 *      inside its own placements (a hydrant in a tree, a bench in a bus shelter). Same bucket
 *      machinery, discarded when the build ends; composeWorld registers the final output into the
 *      global index for the layers after this one.
 */
interface FurnitureArbiter {
  taken(fp: Aabb): boolean;
  claim(id: string, fp: Aabb): void;
}

function createFurnitureArbiter(ctx: PlacementContext): FurnitureArbiter {
  const own: ClaimIndex = createClaimIndex();
  let ordinal = 0;
  return {
    taken: (fp) => ctx.index.overlapsAny(fp, BLOCKING_QUERY) || own.overlapsAny(fp),
    claim: (id, fp) => {
      own.register({ id: `${id}:${ordinal++}`, kind: 'furniture', source: 'furniture', aabb: fp });
    },
  };
}

// --- geometry helpers --------------------------------------------------------------------

/** Squared point-to-rect distance is enough for a >0 clearance test; avoids a sqrt per check.
 * Phase 40: the rects now arrive from the claim index as world-XZ `Aabb`s (minZ/maxZ) rather than
 * map-space `MapRect`s (minY/maxY) — same numbers, one rename, since mapToWorld is the identity
 * swap. */
function pointRectDistSq(p: MapPoint, r: Aabb): number {
  const dx = Math.max(r.minX - p.x, 0, p.x - r.maxX);
  const dz = Math.max(r.minZ - p.y, 0, p.y - r.maxZ);
  return dx * dx + dz * dz;
}

function tooCloseToExclusion(p: MapPoint, exclusions: readonly Aabb[], marginWu: number): boolean {
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

/** Map point → world placement. `y` is the SURFACE the model's own floor lands on (the renderer
 * lifts each model by its own bounding-box min, cityPackBaked's `lift`), so it defaults to 0 —
 * the ground plane — for every item that is a real 3D prop standing on a sidewalk: their bottom
 * faces are never visible under the fixed §5.3 camera, so they need no anchor. Pass a
 * config/layering.ts SURFACE_ANCHOR rung only for the (near-)FLAT props that would otherwise be
 * coplanar with the surface they sit on — today that is manhole covers on asphalt (Phase 39). */
function toWorldPlacement(
  modelId: string,
  p: MapPoint,
  rotationY: number,
  districtId: DistrictId,
  y = 0,
): FurniturePlacement {
  const [x, z] = mapToWorld(p);
  return { modelId, position: [x, y, z], rotationY, districtId };
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
  exclusions: readonly Aabb[],
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
      // Part-8 (D1): corner clamps now land close enough to a compacted named-building lot that
      // this exclusion check (already standard for the row categories below) is load-bearing —
      // was previously a no-op saved by pre-compaction spacing alone.
      if (tooCloseToExclusion(p, exclusions, 1)) continue;
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
  /** `along` (Phase 31, Part-8 D5): the candidate's along-street coordinate — only the
   * route-derived bus-stop spec reads it (busRouteStreetCoverage); every other row's eligible
   * function ignores the extra argument (TS/JS both allow a narrower-arity callback to satisfy a
   * wider function type). */
  readonly eligible: (street: Street, district: TorontoDistrictDef, along: number) => boolean;
  readonly rotation: 'spin' | 'faceRoad';
}

function buildRow(
  spec: RowSpec,
  streets: readonly Street[],
  intersectionsByStreet: ReadonlyMap<string, readonly StreetCrossing[]>,
  districts: readonly ResolvedDistrict[],
  exclusions: readonly Aabb[],
  allRibbons: readonly MapRect[],
  arbiter: FurnitureArbiter,
  rng: Rng,
  densityScalar: number,
): readonly FurniturePlacement[] {
  const halfWidth = (s: Street): number => s.width / 2;
  const out: FurniturePlacement[] = [];
  // This row's own accepted footprints — self-gating so two stops of the SAME row can't share
  // ground. Cross-category gating goes through the arbiter, which the orchestrator loads with each
  // category's FINAL (post-thin) placements.
  const rowKept: Aabb[] = [];
  // Phase 40 (zone law): ribbons as world-XZ Aabbs, for the FOOTPRINT-vs-roadway check below. The
  // point-in-ribbon check at the candidate stage can't see a wide item (a spun trash can is a
  // ~1.1 wu square) whose CENTRE sits on the sidewalk near a cross street while its footprint
  // pokes into that street's asphalt — the invariant sweep's seed-7/-1337 catches.
  const ribbonAabbs: readonly Aabb[] = allRibbons.map((r) => ({ minX: r.minX, maxX: r.maxX, minZ: r.minY, maxZ: r.maxY }));
  const effectiveSpacing = spec.spacingWu / densityScalar;

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
        if (!spec.eligible(street, district, along)) continue;
        if (tooCloseToExclusion(p, exclusions, 1)) continue;
        const rotationY = spec.rotation === 'spin' ? seededSpin(streetRng) : faceRoadRotationY(street, side);
        // Phase 40 (gaps 1/2/5): footprint-vs-footprint against everything already placed — the
        // frontage streetwall, the infill layer, venue dressing props — plus this row's own items.
        // The point-margin `tooCloseToExclusion` gate above is UNCHANGED and still runs first;
        // this is purely additive.
        const fp = furnitureFootprint(spec.modelId, p, rotationY);
        // No row item's FOOTPRINT may reach any roadway — own-street clearance already holds by
        // the perpendicular offset, so this only ever fires near a cross street's ribbon.
        if (ribbonAabbs.some((r) => overlaps(fp, r))) continue;
        if (arbiter.taken(fp)) continue;
        if (rowKept.some((r) => overlaps(fp, r))) continue;
        rowKept.push(fp);
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
  arbiter: FurnitureArbiter,
  rng: Rng,
  densityScalar: number,
): readonly FurniturePlacement[] {
  const out: FurniturePlacement[] = [];
  const kept: Aabb[] = [];
  const eligible = new Set<string>(MANHOLE_ROW.eligibleClasses);
  const effectiveSpacing = MANHOLE_ROW.spacingWu / densityScalar;

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
      const rotationY = seededSpin(streetRng);
      const fp = furnitureFootprint('manhole-cover', p, rotationY);
      if (arbiter.taken(fp)) continue;
      if (kept.some((r) => overlaps(fp, r))) continue;
      kept.push(fp);
      // Phase 39: manholes are the audited on-asphalt coplanar case — the model is only
      // ~0.018 wu tall, so placed at y=0 its TOP face landed essentially ON the road ribbon's
      // own surface (GROUND_STACK.roadSurface, 0.020) and every cover z-fought the asphalt it
      // sat in. SURFACE_ANCHOR.road floors it one full ground separation above the ribbon.
      out.push(toWorldPlacement('manhole-cover', p, rotationY, district.id, SURFACE_ANCHOR.road));
    }
  }
  return thinToCap(out, MANHOLE_ROW.capMapWide);
}

// --- parked vehicles (D18) -------------------------------------------------------------------

function buildParked(
  streets: readonly Street[],
  intersectionsByStreet: ReadonlyMap<string, readonly StreetCrossing[]>,
  districts: readonly ResolvedDistrict[],
  exclusions: readonly Aabb[],
  arbiter: FurnitureArbiter,
  rng: Rng,
  densityScalar: number,
  cap: number,
): readonly ParkedVehicle[] {
  const out: ParkedVehicle[] = [];
  const kept: Aabb[] = [];
  const eligible = new Set<string>(PARKED.eligibleClasses);
  const densityFactor: Record<DistrictDensity, number> = { dense: 0, medium: 0.5, sparse: 1 };
  // Phase 29 (D4): one carVariety sequencer for the whole parked layer (its own rng fork, so the
  // rest of buildParked's per-street rolls are untouched). Drawn in deterministic placement order,
  // it gives each car a weighted {model, colour} with anti-repeat across the street.
  const variety = createCarVarietySequencer(rng.fork('carVariety'));

  for (const street of streets) {
    if (!eligible.has(street.cls)) continue;
    const crossings = intersectionsByStreet.get(street.id) ?? [];
    for (const side of [1, -1] as const) {
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
        const spacing = (spacingLo + (spacingHi - spacingLo) * densityFactor[districtDensity]) / densityScalar;
        if (district && !tooCloseToExclusion(p, exclusions, 1.5)) {
          const v = variety.next();
          const rotationY = faceRoadRotationY(street, side) + Math.PI / 2; // parallel-parked: long axis along the street
          const modelId = neutralVehicleModelId(v.modelId);
          const fp = furnitureFootprint(modelId, p, rotationY);
          // The car-variety draw stays UNCONDITIONAL (it advances the sequencer once per parking
          // slot regardless of the outcome) so an arbiter rejection can never re-shuffle which
          // model/colour every later car gets.
          if (!arbiter.taken(fp) && !kept.some((r) => overlaps(fp, r))) {
            kept.push(fp);
            out.push({
              modelId,
              position: withY(mapToWorld(p), 0),
              rotationY,
              districtId: district.id,
              tint: v.colorHex,
            });
          }
        }
        along += spacing;
      }
    }
  }
  return thinToCap(out, cap);
}

// --- global no-furniture-on-ribbon invariant (D10) -------------------------------------------

/** Phase 25.8 (D10): a furniture point (map x,z = world x,z, identity swap) sits STRICTLY inside a
 * street ribbon rect. The global invariant every placement must satisfy — manholes + parked are the
 * only exemptions (both placed ON the asphalt by design). Exported for furniture.test.ts's map-wide
 * assertion. */
export function isOnAnyRibbon(x: number, z: number, ribbons: readonly MapRect[]): boolean {
  return ribbons.some((r) => x > r.minX && x < r.maxX && z > r.minY && z < r.maxY);
}

/** Deterministic DROP rule enforcing the invariant above — order-preserving filter, so it never
 * disturbs determinism. Catches the 25.6 Bloor-boundary corner masts that clamp onto a ribbon after
 * clampInsidePolygon, and any future map-wide regression (defense-in-depth, the P6 pattern). */
function dropOnRibbon<T extends { readonly position: readonly [number, number, number] }>(
  items: readonly T[],
  ribbons: readonly MapRect[],
): T[] {
  return items.filter((p) => !isOnAnyRibbon(p.position[0], p.position[2], ribbons));
}

// --- top-level orchestrator ------------------------------------------------------------------

/** Builds the whole street-furniture + parked-vehicle layout for `seed` (deterministic,
 * mulberry32 forks — same contract as world/rng.ts). Pure function of the street/district/
 * exclusion data; no react/three.
 *
 * `tierParams` (Phase 25.8 D8) defaults to TORONTO_TIER_IDENTITY — every pre-25.8 call site that
 * omits it gets byte-identical pre-tier output. `dressDensityScalar` widens/narrows every
 * row-spacing category's effective spacing (trees/hydrants/benches/trash-cans/bus-stops/manholes/
 * parked); intersection-rule furniture (masts/stop-signs/power-boxes) is untouched.
 * `parkedCarKeepFraction` scales the parked-vehicle hard cap.
 *
 * `ctx` (Phase 40) is REQUIRED: furniture is the last seed-dependent layer in the composition and
 * its output depends on what every earlier layer already put on the ground, so there is no honest
 * standalone form of it. `world/toronto/composeWorld.ts` is the one caller in the game; tests go
 * through `composeWorld(seed).furniture` for exactly the same reason (a defaulted, half-empty
 * context would silently describe a city that never ships). */
export function buildFurniture(
  seed: number,
  ctx: PlacementContext,
  tierParams: TorontoTierParams = TORONTO_TIER_IDENTITY,
): FurnitureLayout {
  const base = createRng(seed).fork('toronto-furniture-v1');
  const { streets, intersections, districts } = ctx;
  // Phase 40: the point-margin exclusion ZONES (named ∪ places ∪ parks). Parks joining this set
  // IS the audit's gap 3 — furniture used to compose named ∪ places by hand and silently omit
  // parks.exclusions, so generic street trees landed inside park rects that already have their
  // own tree rings, both merging into the same 'tree' BatchedMesh.
  const exclusions: readonly Aabb[] = ctx.index.rects({ kinds: EXCLUSION_ZONE_KINDS });
  const allRibbons: readonly MapRect[] = streets.map((s) => s.ribbon);

  const intersectionsByStreet = new Map<string, readonly StreetCrossing[]>(
    streets.map((s) => [s.id, crossingsOn(s, intersections)]),
  );

  // Phase 25.8 (D8): the composed row-spacing scalar — the config "master" dial (currently 1.0,
  // D21's pre-wired hook) times this render's tier scale. Every row-spacing category (never the
  // intersection-rule categories built above/below this) divides its base spacingWu by this.
  const densityScalar = DRESS_DENSITY_SCALAR * tierParams.dressDensityScalar;

  // Phase 40: categories are now built, ribbon-filtered and CLAIMED one at a time, in the same
  // declaration order as before, so each one rejects against the ones already standing. Claiming
  // happens AFTER dropOnRibbon + thinToCap, i.e. only what actually ships occupies ground.
  const arbiter = createFurnitureArbiter(ctx);
  const claimAll = (items: readonly FurniturePlacement[] | readonly ParkedVehicle[], label: string): void => {
    for (const item of items as readonly FurniturePlacement[]) {
      arbiter.claim(label, furnitureFootprint(item.modelId, { x: item.position[0], y: item.position[2] }, item.rotationY));
    }
  };

  // INTERSECTION-RULE furniture (masts / stop signs / power boxes) CLAIMS but is not GATED. Its
  // positions are pinned to intersection corners inside the sidewalk band, it is already
  // ribbon-filtered, and each category carries gameplay identity that a silent geometric drop
  // would damage: the masts are lampClock's signal heads AND the LightPool's emitter source, and
  // the power boxes are Toronto's 74 transformers — the district blackout chain needs every
  // district to keep at least one.
  const { trafficLights: trafficLightsRaw, stopSigns: stopSignsRaw } = buildTrafficLightsAndStopSigns(intersections, districts);
  const trafficLights = dropOnRibbon(trafficLightsRaw, allRibbons);
  claimAll(trafficLights, 'mast');
  const stopSigns = orderByDistrict(dropOnRibbon(stopSignsRaw, allRibbons));
  claimAll(stopSigns.items, 'stop-sign');
  const powerBoxesRaw = buildPowerBoxes(intersections, districts, exclusions, base.fork('power-box'));
  const powerBoxes = orderByDistrict(dropOnRibbon(powerBoxesRaw, allRibbons));
  claimAll(powerBoxes.items, 'power-box');

  // BUS STOPS CLAIM FIRST among the spacing rows — the same "authored outranks fungible" rule
  // that put venueDress ahead of this whole layer in composeWorld. Shelters are route-DERIVED
  // (Phase 31: they exist only where a real TTC route rides the street), carry the transit read
  // of the city, and have the largest footprint of any row item (~3.5 × 2.3 wu) — built last
  // they lost 30 of their 50-cap to benches and bins that had already grabbed the sidewalk.
  // rng-neutral: every row draws from its own named fork, so the move shifts no other row's rolls.
  const busStopEligible = new Set<string>(BUS_STOP_ROW.eligibleClasses);
  // Phase 31 (Part-8 D5): bus stops are now ROUTE-derived — eligible only where an actual bus
  // route rides this street AND at this along-street position (data/toronto/transit-routes.json
  // via world/toronto/transitRoutes.ts's resolver). A street of an eligible CLASS with no route
  // on it (e.g. University, Bathurst south of Bloor) no longer grows stops.
  const busCoverage = busRouteStreetCoverage();
  // The shelter is the ONE row item too deep for SIDEWALK_ROW.facadeOffsetWu: at 2.4 wu its
  // ~1.14 wu half-depth reached 3.54 wu — 0.5 wu past the 3 wu sidewalk band, INSIDE the flush
  // streetwall facade (the arbiter's band census: 774 of 917 blocked samples were the facade
  // itself, which is why the old layer shipped 30 of its 50 shelters embedded in building faces).
  // So its offset is DERIVED, not picked: back panel flush at the facade plane. Flush touching is
  // legal by the arbiter's interior-overlap predicate — touching never counts.
  const busStopRowOffsetWu = SIDEWALK.widthWu - colliderHalfExtents('bus-stop').hz;
  const busStopsRaw = buildRow(
    {
      modelId: 'bus-stop',
      spacingWu: BUS_STOP_ROW.spacingWu,
      capMapWide: BUS_STOP_ROW.capMapWide,
      rowOffsetWu: busStopRowOffsetWu,
      cornerClearanceWu: 6,
      eligible: (street, _district, along) => busStopEligible.has(street.cls) && isOnBusRoute(street.id, along, busCoverage),
      rotation: 'faceRoad',
    },
    streets,
    intersectionsByStreet,
    districts,
    exclusions,
    allRibbons,
    arbiter,
    base.fork('bus-stop'),
    densityScalar,
  );
  const busStops = orderByDistrict(dropOnRibbon(busStopsRaw, allRibbons));
  claimAll(busStops.items, 'bus-stop');

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
    arbiter,
    base.fork('tree'),
    densityScalar,
  );
  const trees = orderByDistrict(dropOnRibbon(treesRaw, allRibbons));
  claimAll(trees.items, 'tree');

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
    arbiter,
    base.fork('hydrant'),
    densityScalar,
  );
  const hydrants = orderByDistrict(dropOnRibbon(hydrantsRaw, allRibbons));
  claimAll(hydrants.items, 'hydrant');

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
    arbiter,
    base.fork('bench'),
    densityScalar,
  );
  const benches = orderByDistrict(dropOnRibbon(benchesRaw, allRibbons));
  claimAll(benches.items, 'bench');

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
    arbiter,
    base.fork('trash-can'),
    densityScalar,
  );
  const trashCans = orderByDistrict(dropOnRibbon(trashCansRaw, allRibbons));
  claimAll(trashCans.items, 'trash-can');

  const manholesRaw = buildManholes(streets, intersectionsByStreet, districts, arbiter, base.fork('manhole'), densityScalar);
  const manholes = orderByDistrict(manholesRaw);
  claimAll(manholes.items, 'manhole');
  // Phase 25.8 (D8): the parked-vehicle hard cap scales with the SAME QUALITY_TIERS field the
  // legacy world's cityInstances.ts thinning already uses (parkedCarKeepFraction) — a new
  // consumer of an existing tier field, not a new concept. Never below 1.
  const parkedCap = Math.max(1, Math.round(PARKED.cap * tierParams.parkedCarKeepFraction));
  const parkedRaw = buildParked(streets, intersectionsByStreet, districts, exclusions, arbiter, base.fork('parked'), densityScalar, parkedCap);
  const parked = orderByDistrict(parkedRaw);

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

  // Phase 25.8 (D10): the no-furniture-on-ribbon invariant is enforced map-wide by the
  // `dropOnRibbon` filters interleaved above (manholes + parked are the on-road exemptions). The
  // row categories are already ribbon-safe via buildRow's own gate, so it is a no-op for them and
  // the real fix for the intersection-rule categories (masts / stop-signs / power boxes) that
  // clamp onto a boundary ribbon (the 25.6 Bloor residual).
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
