// Toronto map v2 — district rect derivation (TORONTO-MAP-SPEC-v2.md §6, phase-23-plan Task 1).
// Resolves the declarative bounds in config/torontoDistricts.ts against buildStreets()
// centrelines and the polygon/zone constants (ZONE_BOUNDARIES, PLAYABLE_POLYGON) into concrete
// map-space rects. Pure TS: no three/react, no randomness — same input, same output.
//
// FINAL TILING (resolved numbers, current anchors.json + STREET_DEFS — regenerate rather than
// hand-tune twice if either changes). Order matches config order (§6 table order, then
// genericDowntown, foldCorridor) — this is the stable order buildDistricts() returns.
//
// STALE POST-PART-8 (D1 "density/life flip", 2026-07-18): the table below predates the ~0.6x
// map compaction — every x/y number here is the PRE-compaction resolved value (kept for the
// relative-layout story, not as a live pin; nothing in code reads this comment). The real,
// live-derived rects are asserted by districts.test.ts, not transcribed here.
//
//   district              west/north -> east/south                          rect (x, y)
//   financial             university -> yonge     | queen -> front           x[1063.8, 1500.0]  y[2937.2, 3294.0]
//   entertainment         spadina -> university    | queen -> king           x[ 543.1, 1063.8]  y[2937.2, 3177.1]
//   kingWest              bathurst -> spadina      | queen -> front          x[ 109.0,  543.1]  y[2937.2, 3294.0]
//   queenWest             bathurst -> university   | dundas -> queen         x[ 109.0, 1063.8]  y[2715.8, 2937.2]
//   chinatownKensington   bathurst -> spadina      | college -> dundas       x[ 109.0,  543.1]  y[2457.4, 2715.8]
//   yongeDundasQueen      bay -> church            | college -> queen        x[1260.0, 1658.7]  y[2457.4, 2937.2]
//   churchWellesley       church -> jarvis         | bloor(zone) -> college  x[1658.7, 1873.8]  y[1830.0, 2457.4]
//   uoft                  spadina -> university    | bloor(zone) -> college  x[ 543.1, 1063.8]  y[1830.0, 2457.4]
//   stLawrence            yonge -> jarvis          | king -> front           x[1500.0, 1873.8]  y[3177.1, 3294.0]
//   harbourfront          downtownWest -> East(z)  | front -> shore(zone)    x[   0.0, 2400.0]  y[3294.0, 3700.0]
//   bloorYorkville        university -> church     | bloor(zone) -> college  x[1063.8, 1658.7]  y[1830.0, 2457.4]
//   northYorkCentre       capsuleWest -> East(z)    | parkhome -> sheppard(z) x[1100.0, 1900.0]  y[ 755.0, 1170.0]
//   willowdaleFinch       capsuleWest -> East(z)    | capsuleTop(z) -> parkhome x[1100.0,1900.0] y[   0.0,  755.0]
//   genericDowntown       downtownWest -> East(z)   | bloor(z) -> shore(z)   universe rect MINUS every rect above
//                                                                            that overlaps it -> N gap rects
//                                                                            (row-swept, computed below, never
//                                                                            hand-listed — count is not pinned)
//   foldCorridor          foldWest(z) -> East(z)    | sheppard(z) -> bloor(z) x[1200.0, 1800.0]  y[1170.0, 1830.0]
//
// §6 geography bent to make the tiling non-overlapping (documented on the config rows too):
//   - uoft narrowed spadina->bay to spadina->university (else it ate bloorYorkville's west half).
//   - bloorYorkville moved bay->jarvis to university->church (the true middle strip of the
//     three top-row downtown districts, between uoft and churchWellesley).
//   - yongeDundasQueen narrowed yonge->church to bay->church so its west edge lands on the same
//     "bay" corner as uoft/bloorYorkville instead of overlapping University Ave's frontage.
// The three top-row districts (uoft | bloorYorkville | churchWellesley) use the `bloor` ZONE
// edge (y=1830, the spec's own Bloor anchor and the fold/downtown polygon seam) rather than the
// nudged Bloor STREET centreline (y≈1846.5) for their north edge — that keeps them flush against
// the fold corridor's south edge with no uncovered sliver. Same reasoning for `sheppard`
// (zone y=1170, the capsule/fold seam) on northYorkCentre/willowdaleFinch's shared edge.
//
// `foldWest`/`foldEast` are a zone-edge pair not spelled out as a single named anchor in the
// spec; they are the fold corridor's own x-extent (currently 1200/1800), derived below the same
// way as every other zone edge (a horizontal slice through PLAYABLE_POLYGON) — never a literal.

import type { DistrictId, DistrictBoundsEdge, DistrictBoundsRef, DistrictZoneEdge, TorontoDistrictDef } from '../../config/torontoDistricts';
import { TORONTO_DISTRICTS } from '../../config/torontoDistricts';
import { ZONE_BOUNDARIES } from './projection';
import { PLAYABLE_POLYGON, type MapVertex } from './polygon';
import { buildStreets, type MapRect, type Street, type StreetAxis } from './streets';

export type { MapRect } from './streets';

// --- numeric district index (Phase 29 seam) ------------------------------------------------
// world/registry.ts's EntityEntry.districtId is a plain `number` (the legacy 4x4-grid
// convention: id = row*WORLD.districts+col) — Toronto's districts are keyed by the string
// DistrictId instead, so every Toronto registry writer (colliders, powergrid) needs ONE
// canonical string->number mapping, shared so a district's index is identical everywhere it's
// read. Defined as the item's position in TORONTO_DISTRICTS (config order) — the SAME order
// every district-ordered layer (frontage.ts/furniture.ts's DISTRICT_ORDER, this file's
// buildDistricts()) already sorts by, so it can never drift from those.
const DISTRICT_ORDER: readonly DistrictId[] = TORONTO_DISTRICTS.map((d) => d.id);
const DISTRICT_INDEX = new Map<DistrictId, number>(DISTRICT_ORDER.map((id, i) => [id, i]));

/** Number of Toronto districts (15: the 13 §6 rows + genericDowntown + foldCorridor) — the
 * powergrid districtCount override (game/index.tsx passes this to initPowerGrid unconditionally
 * since the Phase 32 flip) and every registry districtId in Toronto colliders is bounded by this. */
export const TORONTO_DISTRICT_COUNT = TORONTO_DISTRICTS.length;

/** The canonical numeric index for a Toronto DistrictId (0..TORONTO_DISTRICT_COUNT-1). Throws
 * on an unknown id (a typo/config drift) — every real DistrictId is a TORONTO_DISTRICTS entry
 * by construction, so this should never legitimately fail. */
export function torontoDistrictIndex(id: DistrictId): number {
  const i = DISTRICT_INDEX.get(id);
  if (i === undefined) throw new Error(`districts: unknown DistrictId '${id}'`);
  return i;
}

/** Spatial lookup variant of torontoDistrictIndex, for placements that don't carry a
 * districtId field of their own (named buildings, hero landmarks, places boxes — all
 * street-referenced rather than district-referenced). `x`/`z` are WORLD coordinates; map space
 * is the identity swap (x=x, y=z) per projection.ts's convention, matching every other
 * consumer of districtAt in this codebase. Returns -1 (registry.ts's "not districted"
 * convention) for a point that falls outside every resolved district rect (should not happen
 * for anything actually inside the playable polygon, but this is spatial geometry, not a
 * guaranteed-exhaustive lookup — never throw for it). */
export function torontoDistrictIndexAt(x: number, z: number, districts: readonly ResolvedDistrict[]): number {
  const def = districtAt({ x, y: z }, districts);
  return def ? torontoDistrictIndex(def.id) : -1;
}

/** A resolved district: its static definition plus the concrete rect(s) it owns. A district may
 * own several rects (genericDowntown's complement); order within `rects` is not meaningful. */
export interface ResolvedDistrict {
  readonly def: TorontoDistrictDef;
  readonly rects: readonly MapRect[];
}

const EPS = 1e-6;

// --- zone-edge derivation ----------------------------------------------------------------

/** Every vertical-edge crossing x at map-y `y`, min/max only. Valid for any `y` STRICTLY inside
 * one of the three horizontal bands the thermometer polygon is built from (capsule / fold /
 * downtown) — i.e. never called exactly at a band seam (0, 1170, 1830, 3700), where the slice
 * touches four edges instead of two and min/max would silently span the wrong band. Callers
 * below always pass a band MIDPOINT. */
function polygonXExtentAtY(y: number): readonly [number, number] {
  const xs: number[] = [];
  const n = PLAYABLE_POLYGON.length;
  for (let i = 0; i < n; i++) {
    const a = PLAYABLE_POLYGON[i];
    const b = PLAYABLE_POLYGON[(i + 1) % n];
    if (a.x !== b.x) continue; // only vertical edges bound a horizontal slice
    const lo = Math.min(a.y, b.y);
    const hi = Math.max(a.y, b.y);
    if (y > lo + EPS && y < hi - EPS) xs.push(a.x);
  }
  if (xs.length < 2) {
    throw new Error(`districts: polygon horizontal slice at y=${y} did not resolve (need a band midpoint)`);
  }
  return [Math.min(...xs), Math.max(...xs)];
}

/** Every DistrictZoneEdge resolved to a concrete map coordinate, plus which axis it belongs to
 * (so resolveEdge below can catch a west/east ref accidentally naming a y-edge, or vice versa). */
function buildZoneValues(): { readonly value: Record<DistrictZoneEdge, number>; readonly axis: Record<DistrictZoneEdge, StreetAxis> } {
  // Band midpoints (never a seam) for the three horizontal-slice queries.
  const capsuleMidY = (ZONE_BOUNDARIES[0] + ZONE_BOUNDARIES[1]) / 2;
  const foldMidY = (ZONE_BOUNDARIES[1] + ZONE_BOUNDARIES[2]) / 2;
  const downtownMidY = (ZONE_BOUNDARIES[2] + ZONE_BOUNDARIES[3]) / 2;
  const [capsuleWest, capsuleEast] = polygonXExtentAtY(capsuleMidY);
  const [foldWest, foldEast] = polygonXExtentAtY(foldMidY);
  const [downtownWest, downtownEast] = polygonXExtentAtY(downtownMidY);

  const value: Record<DistrictZoneEdge, number> = {
    bloor: ZONE_BOUNDARIES[2],
    sheppard: ZONE_BOUNDARIES[1],
    shore: ZONE_BOUNDARIES[3],
    capsuleTop: ZONE_BOUNDARIES[0],
    capsuleWest,
    capsuleEast,
    downtownWest,
    downtownEast,
    foldWest,
    foldEast,
  };
  const axis: Record<DistrictZoneEdge, StreetAxis> = {
    bloor: 'ew',
    sheppard: 'ew',
    shore: 'ew',
    capsuleTop: 'ew',
    capsuleWest: 'ns',
    capsuleEast: 'ns',
    downtownWest: 'ns',
    downtownEast: 'ns',
    foldWest: 'ns',
    foldEast: 'ns',
  };
  return { value, axis };
}

// --- bounds resolution ---------------------------------------------------------------------

function resolveEdge(
  edge: DistrictBoundsEdge,
  axis: StreetAxis,
  streetsById: ReadonlyMap<string, Street>,
  zones: ReturnType<typeof buildZoneValues>,
): number {
  if ('street' in edge) {
    const st = streetsById.get(edge.street);
    if (!st) throw new Error(`districts: unknown street reference '${edge.street}'`);
    if (st.axis !== axis) {
      throw new Error(`districts: street '${edge.street}' is ${st.axis}, cannot use as a ${axis} edge`);
    }
    return st.centerline;
  }
  const zoneAxis = zones.axis[edge.zone];
  if (zoneAxis !== axis) {
    throw new Error(`districts: zone '${edge.zone}' is ${zoneAxis}, cannot use as a ${axis} edge`);
  }
  return zones.value[edge.zone];
}

function resolveBounds(
  bounds: DistrictBoundsRef,
  streetsById: ReadonlyMap<string, Street>,
  zones: ReturnType<typeof buildZoneValues>,
): MapRect {
  const xa = resolveEdge(bounds.west, 'ns', streetsById, zones);
  const xb = resolveEdge(bounds.east, 'ns', streetsById, zones);
  const ya = resolveEdge(bounds.north, 'ew', streetsById, zones);
  const yb = resolveEdge(bounds.south, 'ew', streetsById, zones);
  return { minX: Math.min(xa, xb), maxX: Math.max(xa, xb), minY: Math.min(ya, yb), maxY: Math.max(ya, yb) };
}

// --- genericDowntown complement (row-sweep rectangle subtraction) --------------------------

function rectsOverlap(a: MapRect, b: MapRect): boolean {
  return a.minX < b.maxX - EPS && a.maxX > b.minX + EPS && a.minY < b.maxY - EPS && a.maxY > b.minY + EPS;
}

/**
 * `universe` minus every rect in `subtract` that overlaps it, as a set of axis-aligned rects
 * (classic rectilinear-polygon complement via a row sweep on the union of y-cuts). Each
 * subtract rect is clipped to `universe` first, so callers may pass rects that live partly or
 * wholly outside it (e.g. capsule/fold districts) without special-casing them out — they simply
 * clip away to nothing and contribute no cut.
 */
function complementRects(universe: MapRect, subtract: readonly MapRect[]): MapRect[] {
  const relevant = subtract.filter((r) => rectsOverlap(r, universe)).map((r) => ({
    minX: Math.max(r.minX, universe.minX),
    maxX: Math.min(r.maxX, universe.maxX),
    minY: Math.max(r.minY, universe.minY),
    maxY: Math.min(r.maxY, universe.maxY),
  }));

  const yCuts = new Set<number>([universe.minY, universe.maxY]);
  for (const r of relevant) {
    yCuts.add(r.minY);
    yCuts.add(r.maxY);
  }
  const ys = [...yCuts].sort((a, b) => a - b);

  const out: MapRect[] = [];
  for (let i = 0; i < ys.length - 1; i++) {
    const y0 = ys[i];
    const y1 = ys[i + 1];
    if (y1 - y0 <= EPS) continue;
    const rowMidY = (y0 + y1) / 2;
    const covered = relevant
      .filter((r) => r.minY <= rowMidY && r.maxY >= rowMidY)
      .map((r): [number, number] => [r.minX, r.maxX])
      .sort((a, b) => a[0] - b[0]);

    const merged: [number, number][] = [];
    for (const [lo, hi] of covered) {
      const last = merged[merged.length - 1];
      if (last && lo <= last[1] + EPS) {
        last[1] = Math.max(last[1], hi);
      } else {
        merged.push([lo, hi]);
      }
    }

    let cursor = universe.minX;
    for (const [lo, hi] of merged) {
      if (lo - cursor > EPS) out.push({ minX: cursor, maxX: lo, minY: y0, maxY: y1 });
      cursor = Math.max(cursor, hi);
    }
    if (universe.maxX - cursor > EPS) out.push({ minX: cursor, maxX: universe.maxX, minY: y0, maxY: y1 });
  }
  return out;
}

// --- public API ------------------------------------------------------------------------------

/**
 * Resolve every district in TORONTO_DISTRICTS (config order preserved — the CLAUDE.md
 * district-ordered-instance-buffer convention) into concrete map-space rect(s). Deterministic:
 * pure function of buildStreets() + the polygon/zone constants, no randomness.
 */
export function buildDistricts(): readonly ResolvedDistrict[] {
  const streets = buildStreets().streets;
  const streetsById = new Map(streets.map((s) => [s.id, s]));
  const zones = buildZoneValues();

  const resolved = new Map<DistrictId, MapRect>();
  for (const def of TORONTO_DISTRICTS) {
    if (def.id === 'genericDowntown') continue;
    resolved.set(def.id, resolveBounds(def.bounds, streetsById, zones));
  }

  const genericDef = TORONTO_DISTRICTS.find((d) => d.id === 'genericDowntown');
  if (!genericDef) throw new Error('districts: genericDowntown definition missing from config');
  const universe = resolveBounds(genericDef.bounds, streetsById, zones);
  const genericRects = complementRects(universe, [...resolved.values()]);

  return TORONTO_DISTRICTS.map((def): ResolvedDistrict => {
    if (def.id === 'genericDowntown') return { def, rects: genericRects };
    const rect = resolved.get(def.id);
    if (!rect) throw new Error(`districts: '${def.id}' failed to resolve`);
    return { def, rects: [rect] };
  });
}

function pointInRect(p: MapVertex, r: MapRect): boolean {
  return p.x >= r.minX - EPS && p.x <= r.maxX + EPS && p.y >= r.minY - EPS && p.y <= r.maxY + EPS;
}

/** The district owning `point` (first match in config order — rects never overlap by
 * construction, so order only matters for boundary-touching points), or `undefined` if the
 * point falls outside every resolved rect. */
export function districtAt(point: MapVertex, districts: readonly ResolvedDistrict[]): TorontoDistrictDef | undefined {
  for (const { def, rects } of districts) {
    for (const r of rects) {
      if (pointInRect(point, r)) return def;
    }
  }
  return undefined;
}
