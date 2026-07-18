// Toronto map v2 — pack-building FRONTAGE placement (Phase 25.6 D6/D7/D8/D10/D11). The
// street-walk placer that RETIRES the box-lattice massing.ts: instead of scattering boxes on a
// lattice, it walks every street side block-by-block and lines the frontage with city-pack
// building models that FACE the street and sit flush behind the sidewalk. Pure TS — no three/
// react, no fs at runtime, deterministic (mulberry32 forks via world/rng.ts, same contract as
// furniture.ts). A separate mounting task (world/toronto/cityPack/CityPackBatched.tsx) turns the
// output into per-model BatchedMeshes + fixed BUILDING colliders; this module never touches three.
//
// WHY A STREET-WALK (not a lattice): pack buildings must front the streets the player actually
// drives and sit flush behind the sidewalk — a lattice can't express "faces the street". This is
// levers (a)+(d) from the 25.5 tri-wall analysis (re-grain to frontage-only rows). The four
// massing rejection gates SURVIVE as gates here (on-ribbon / off-polygon / in-water / overlap /
// exclusion), re-asserted by frontage.test.ts (the massing property suite reborn).
//
// STABLE SLOT IDS (`${streetId}:${side}:${index}`) are the 25.7 personalization seam: business
// personalization will claim specific slots by id (swap the model to a blank + decal)
// deterministically. The per-candidate rng is forked FROM the slot id, so a slot's model/tint/
// occupancy roll is stable regardless of how many neighbours were skipped.
//
// DISTRICT-ORDERED RANGES (CLAUDE.md sacred convention): slots are grouped by district in config
// order with recorded [start,count] ranges — the blackout-address a future powergrid write pokes.

import { colliderHalfExtents, type ColliderHalfExtents } from '../../config/cityPackScale';
import { BACKDROP_TOWER, FRONTAGE } from '../../config/torontoDress';
import {
  TORONTO_DISTRICTS,
  type DistrictDensity,
  type DistrictId,
  type PackStockEntry,
  type TorontoDistrictDef,
} from '../../config/torontoDistricts';
import { ROAD_CLASSES } from '../../config/torontoMap';
import { SIDEWALK } from '../../config/torontoMap';
import { createRng, type Rng } from '../rng';
import { buildDistricts, districtAt, type ResolvedDistrict } from './districts';
import { hGame } from './heightCurve';
import { buildNamedBuildings } from './namedBuildings';
import { buildPlacesLayer } from './placesLayer';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import type { MapPoint } from './projection';
import { listIntersections, type Intersection } from './roadGraph';
import { buildStreets, type Street } from './streets';

// --- shared geometry helpers (ported from the retired massing.ts — the ONE home now) ----------

/** An axis-aligned footprint in map space (= world XZ; mapToWorld is the identity swap). */
export interface Aabb {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/** Interior overlap (touching edges never count) — the shared predicate for ribbon / exclusion /
 * same-district checks, so generator and test agree on the boundary (massing.ts's `overlaps`). */
export function overlaps(a: Aabb, b: Aabb): boolean {
  const t = 1e-9;
  return a.minX < b.maxX - t && a.maxX > b.minX + t && a.minZ < b.maxZ - t && a.maxZ > b.minZ + t;
}

/** All four corners of a footprint inside the playable polygon (boundary-inclusive). */
export function insidePolygon(fp: Aabb): boolean {
  return (
    pointInPolygon({ x: fp.minX, y: fp.minZ }, PLAYABLE_POLYGON) &&
    pointInPolygon({ x: fp.maxX, y: fp.minZ }, PLAYABLE_POLYGON) &&
    pointInPolygon({ x: fp.maxX, y: fp.maxZ }, PLAYABLE_POLYGON) &&
    pointInPolygon({ x: fp.minX, y: fp.maxZ }, PLAYABLE_POLYGON)
  );
}

// --- output shapes ---------------------------------------------------------------------------

/** One placed pack-building frontage slot. Position is WORLD-space [x, 0, z] (ground = 0); the
 * mounting task grounds the model floor via its groundOffset. `hx`/`hy`/`hz` are the POST-YAW
 * world-AABB half-extents (the ±90° frontage rotations swap width/depth), so the collider mounts
 * axis-aligned and tests read footprints without re-deriving the rotation. */
export interface FrontageSlot {
  /** `${streetId}:${side}:${candidateIndex}` — stable across seeds/occupancy (the 25.7 seam). */
  readonly slotId: string;
  readonly modelId: string;
  readonly position: readonly [number, number, number];
  readonly rotationY: number;
  /** Near-white per-instance tint (D11) — instanceColor multiplies over the palette texture. */
  readonly tint: string;
  readonly districtId: DistrictId;
  /** True for slots flanking an intersection (block-segment ends) — they prefer cornerModels. */
  readonly isCorner: boolean;
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
}

/** One D7 backdrop-tower box (rendered through the legacy box InstancedMesh path). Centre in
 * world space; box floor at y=0 so centre y = hy (same convention as the retired MassingInstance). */
export interface BackdropBox {
  readonly x: number;
  readonly z: number;
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
  readonly color: string;
  readonly districtId: DistrictId;
}

export interface DistrictRange {
  readonly districtId: DistrictId;
  readonly start: number;
  readonly count: number;
}

export interface FrontageLayout {
  /** All placed frontage slots, DISTRICT-ORDERED (config order), the sacred contiguous buffer. */
  readonly slots: readonly FrontageSlot[];
  readonly ranges: readonly DistrictRange[];
  /** Distinct building model ids actually placed, sorted — the renderer maps over these to build
   * one BatchedMesh per type; filtering `slots` by modelId preserves district order per batch. */
  readonly modelIds: readonly string[];
  /** D7 sparse backdrop boxes behind the frontage in the three tower districts. */
  readonly towerBoxes: readonly BackdropBox[];
  /** category/district -> count, for tests + the verification dump (D6 "record exact"). */
  readonly counts: Readonly<Record<string, number>>;
}

// --- district-order bookkeeping (sacred convention) ------------------------------------------

const DISTRICT_ORDER: readonly DistrictId[] = TORONTO_DISTRICTS.map((d) => d.id);
const DISTRICT_INDEX = new Map<DistrictId, number>(DISTRICT_ORDER.map((id, i) => [id, i]));

/** The lake band floor in world z (= map y). Any footprint reaching it is rejected (massing's
 * WATER_Z gate). */
const WATER_Z = 3700;

// --- placement math --------------------------------------------------------------------------

/** Yaw (radians) that turns the model's front face (local +Z) toward the street it fronts.
 * `side` = +1 places the building on the street's +perp side (larger x for ns / larger z for ew);
 * the front then points back toward the centreline (−side along the perpendicular axis). Verified
 * against CityPackPreview.tsx's building-red/rb-blank flank placements. */
function frontageRotationY(axis: Street['axis'], side: 1 | -1): number {
  if (axis === 'ns') return side === 1 ? -Math.PI / 2 : Math.PI / 2;
  return side === 1 ? Math.PI : 0;
}

/** Post-yaw world-AABB half-extents for a model fronting a street on `axis`. The frontage (native
 * width) always runs ALONG the street; the depth (native z) always runs perpendicular. For an ns
 * street the perpendicular is world X, so hx = native depth, hz = native frontage; for an ew
 * street it is the identity. */
function worldHalfExtents(half: ColliderHalfExtents, axis: Street['axis']): { hx: number; hy: number; hz: number } {
  if (axis === 'ns') return { hx: half.hz, hy: half.hy, hz: half.hx };
  return { hx: half.hx, hy: half.hy, hz: half.hz };
}

/** The centre map-point of a frontage slot given the street, side, along-coord, and the model's
 * DEPTH half-extent (perpendicular). Centre sits depth-half beyond the facade line (ribbon edge +
 * sidewalk) so the front face lands flush on the sidewalk edge. */
function slotCenter(street: Street, side: 1 | -1, along: number, depthHalf: number): MapPoint {
  const perp = (street.halfWidth + SIDEWALK.widthWu + depthHalf) * side;
  if (street.axis === 'ns') return { x: street.centerline + perp, y: along };
  return { x: along, y: street.centerline + perp };
}

/** A model-independent reference point into the block for a slot's district/occupancy lookup, so
 * which district owns a slot never shifts with the specific model rolled. */
function districtRefPoint(street: Street, side: 1 | -1, along: number): MapPoint {
  const perp = (street.halfWidth + SIDEWALK.widthWu + FRONTAGE.districtRefDepthWu) * side;
  if (street.axis === 'ns') return { x: street.centerline + perp, y: along };
  return { x: along, y: street.centerline + perp };
}

// --- crossings on a street (block-segment boundaries) ----------------------------------------

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
    }))
    .sort((a, b) => a.along - b.along);
}

/** The free block-segments of a street's span — the span minus the intersection boxes (each
 * crossing ± its cross-halfWidth + cornerClearance). Frontage slots only sit inside these. */
function blockSegments(street: Street, crossings: readonly StreetCrossing[]): readonly [number, number][] {
  const [lo, hi] = street.span;
  // Excluded intervals around each crossing, merged.
  const excluded: [number, number][] = crossings
    .map((c): [number, number] => [
      c.along - c.crossHalfWidth - FRONTAGE.cornerClearanceWu,
      c.along + c.crossHalfWidth + FRONTAGE.cornerClearanceWu,
    ])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const iv of excluded) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  // Free = span minus the merged excluded intervals.
  const free: [number, number][] = [];
  let cursor = lo;
  for (const [elo, ehi] of merged) {
    if (elo > cursor) free.push([cursor, Math.min(elo, hi)]);
    cursor = Math.max(cursor, ehi);
    if (cursor >= hi) break;
  }
  if (cursor < hi) free.push([cursor, hi]);
  return free.filter(([a, b]) => b - a > FRONTAGE.pitchWu * 0.5);
}

// --- model / tint picking --------------------------------------------------------------------

function weightedPick(rng: Rng, entries: readonly PackStockEntry[]): string {
  const total = entries.reduce((s, e) => s + e.weight, 0);
  let r = rng.next() * total;
  for (const e of entries) {
    r -= e.weight;
    if (r <= 0) return e.id;
  }
  return entries[entries.length - 1].id;
}

/** Corner slots prefer cornerModels; an empty corner pool (financial/harbourfront/northYorkCentre
 * — big-building-only districts) falls back to the regular model pool (D10). */
function pickModel(rng: Rng, def: TorontoDistrictDef, isCorner: boolean): string {
  const pool = isCorner && def.packStock.cornerModels.length > 0 ? def.packStock.cornerModels : def.packStock.models;
  return weightedPick(rng, pool);
}

// --- backdrop towers (D7) --------------------------------------------------------------------

function buildBackdropTowers(
  streets: readonly Street[],
  districts: readonly ResolvedDistrict[],
  exclusions: readonly Aabb[],
  ribbons: readonly Aabb[],
  base: Rng,
): readonly BackdropBox[] {
  const out: BackdropBox[] = [];
  const [sizeLo, sizeHi] = BACKDROP_TOWER.footprintRangeWu;
  for (const street of streets) {
    for (const side of [1, -1] as const) {
      const rng = base.fork(`${street.id}:${side}`);
      const [lo, hi] = street.span;
      for (let along = lo + BACKDROP_TOWER.pitchWu / 2; along < hi; along += BACKDROP_TOWER.pitchWu) {
        // A tower box sits behind the facade line by setbackFromFacadeWu (+ its own half-depth).
        const hx = (sizeLo + rng.next() * (sizeHi - sizeLo)) / 2;
        const hz = (sizeLo + rng.next() * (sizeHi - sizeLo)) / 2;
        const backHalf = SIDEWALK.widthWu + BACKDROP_TOWER.setbackFromFacadeWu + Math.max(hx, hz);
        const perp = (street.halfWidth + backHalf) * side;
        const p: MapPoint = street.axis === 'ns' ? { x: street.centerline + perp, y: along } : { x: along, y: street.centerline + perp };
        const def = districtAt(p, districts);
        // Only the three backdropTowers districts get a backdrop row.
        if (!def || def.packStock.backdropTowers !== true) continue;
        const realM = def.heightRangeM[0] + rng.next() * (def.heightRangeM[1] - def.heightRangeM[0]);
        const hy = hGame(realM) / 2;
        const fp: Aabb = { minX: p.x - hx, maxX: p.x + hx, minZ: p.y - hz, maxZ: p.y + hz };
        if (fp.maxZ >= WATER_Z) continue;
        if (!insidePolygon(fp)) continue;
        if (ribbons.some((r) => overlaps(fp, r))) continue;
        if (exclusions.some((r) => overlaps(fp, r))) continue;
        const color = def.fillerColors[Math.floor(rng.next() * def.fillerColors.length) % def.fillerColors.length];
        out.push({ x: p.x, z: p.y, hx, hy, hz, color, districtId: def.id });
      }
    }
  }
  return thinToCap(out, BACKDROP_TOWER.capMapWide);
}

// --- deterministic even-stride thinning to a cap ---------------------------------------------

function thinToCap<T>(items: readonly T[], cap: number): readonly T[] {
  if (items.length <= cap) return items.slice();
  const stride = items.length / cap;
  const out: T[] = [];
  for (let i = 0; i < cap; i++) out.push(items[Math.floor(i * stride)]);
  return out;
}

// --- top-level orchestrator ------------------------------------------------------------------

interface RawSlot extends FrontageSlot {
  readonly order: number; // stable insertion order, for a deterministic secondary sort key
}

/** Build the whole pack-building frontage layout for `seed`. Deterministic (mulberry forks),
 * district-ordered (config order = buffer order), ribbon/polygon/water/overlap/exclusion-safe by
 * construction (the four massing gates + exclusions), hard-capped at FRONTAGE.hardCap. */
export function buildFrontage(seed: number): FrontageLayout {
  const base = createRng(seed).fork('toronto-packdress-v1');
  const { streets } = buildStreets();
  const intersections = listIntersections(streets);
  const districts = buildDistricts();
  const named = buildNamedBuildings();
  const places = buildPlacesLayer(named);

  const exclusions: Aabb[] = [...named.exclusions, ...places.exclusions].map((r) => ({
    minX: r.minX,
    maxX: r.maxX,
    minZ: r.minY,
    maxZ: r.maxY,
  }));
  // Ribbons as AABBs (map space = world XZ), inflated a hair so a wide corner facade can't clip a
  // perpendicular cross-street's asphalt.
  const ribbons: Aabb[] = streets.map((s) => ({
    minX: s.ribbon.minX - 0.5,
    maxX: s.ribbon.maxX + 0.5,
    minZ: s.ribbon.minY - 0.5,
    maxZ: s.ribbon.maxY + 0.5,
  }));

  // Placed footprints per district (for the same-district no-overlap gate — massing's gate d).
  const placedByDistrict = new Map<DistrictId, Aabb[]>();
  const raw: RawSlot[] = [];
  let order = 0;

  for (const street of streets) {
    const crossings = crossingsOn(street, intersections);
    const segments = blockSegments(street, crossings);
    for (const side of [1, -1] as const) {
      let candidateIndex = 0;
      for (const [segLo, segHi] of segments) {
        const length = segHi - segLo;
        const n = Math.max(1, Math.round(length / FRONTAGE.pitchWu));
        const step = length / n;
        for (let i = 0; i <= n; i++) {
          const along = segLo + i * step;
          const isCorner = i === 0 || i === n; // block-segment ends flank the intersection/edge
          const slotId = `${street.id}:${side === 1 ? 'p' : 'n'}:${candidateIndex}`;
          candidateIndex += 1;

          const refPoint = districtRefPoint(street, side, along);
          const def = districtAt(refPoint, districts) ?? undefined;
          if (!def) continue; // outside every resolved district rect — no packStock to draw from

          const slotRng = base.fork(slotId);
          // Fixed roll order (occupancy, model, tint) → the slot's identity is stable per id.
          const occupancy = FRONTAGE.occupancy[def.density as DistrictDensity];
          const kept = slotRng.next() < occupancy;
          const modelId = pickModel(slotRng, def, isCorner);
          const tint = def.packStock.tints[Math.floor(slotRng.next() * def.packStock.tints.length) % def.packStock.tints.length];
          if (!kept) continue;

          const half = colliderHalfExtents(modelId);
          const centre = slotCenter(street, side, along, half.hz);
          const { hx, hy, hz } = worldHalfExtents(half, street.axis);
          const fp: Aabb = { minX: centre.x - hx, maxX: centre.x + hx, minZ: centre.y - hz, maxZ: centre.y + hz };

          // The four massing gates + exclusions (cheapest reject first).
          if (fp.maxZ >= WATER_Z) continue;
          if (exclusions.some((r) => overlaps(fp, r))) continue;
          if (!insidePolygon(fp)) continue;
          if (ribbons.some((r) => overlaps(fp, r))) continue;
          const placed = placedByDistrict.get(def.id) ?? [];
          if (placed.some((r) => overlaps(fp, r))) continue;
          placed.push(fp);
          placedByDistrict.set(def.id, placed);

          raw.push({
            slotId,
            modelId,
            position: [centre.x, 0, centre.y],
            rotationY: frontageRotationY(street.axis, side),
            tint,
            districtId: def.id,
            isCorner,
            hx,
            hy,
            hz,
            order: order++,
          });
        }
      }
    }
  }

  // District-order the raw slots (config order), stable within a district via insertion order.
  raw.sort((a, b) => DISTRICT_INDEX.get(a.districtId)! - DISTRICT_INDEX.get(b.districtId)! || a.order - b.order);
  const capped = thinToCap(raw, FRONTAGE.hardCap);

  const slots: FrontageSlot[] = capped.map((s) => ({
    slotId: s.slotId,
    modelId: s.modelId,
    position: s.position,
    rotationY: s.rotationY,
    tint: s.tint,
    districtId: s.districtId,
    isCorner: s.isCorner,
    hx: s.hx,
    hy: s.hy,
    hz: s.hz,
  }));
  const ranges = buildRanges(slots);
  const modelIds = [...new Set(slots.map((s) => s.modelId))].sort();

  const towerBoxes = buildBackdropTowers(streets, districts, exclusions, ribbons, base.fork('backdrop-towers'));

  const counts: Record<string, number> = { total: slots.length, towerBoxes: towerBoxes.length };
  for (const id of DISTRICT_ORDER) counts[id] = 0;
  for (const s of slots) counts[s.districtId] += 1;

  return { slots, ranges, modelIds, towerBoxes, counts };
}

function buildRanges(slots: readonly FrontageSlot[]): readonly DistrictRange[] {
  const ranges: DistrictRange[] = [];
  let i = 0;
  while (i < slots.length) {
    const districtId = slots[i].districtId;
    const start = i;
    while (i < slots.length && slots[i].districtId === districtId) i++;
    ranges.push({ districtId, start, count: i - start });
  }
  return ranges;
}

/** All frontage slots for one model id, in district order (the per-BatchedMesh instance list). */
export function slotsForModel(layout: FrontageLayout, modelId: string): readonly FrontageSlot[] {
  return layout.slots.filter((s) => s.modelId === modelId);
}
