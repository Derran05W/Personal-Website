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
import { BACKDROP_TOWER, FRONTAGE, TORONTO_TIER_IDENTITY, type TorontoTierParams } from '../../config/torontoDress';
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
import { buildParks } from './parks';
import { buildPlacesLayer } from './placesLayer';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import type { MapPoint } from './projection';
import { listIntersections, type Intersection } from './roadGraph';
import { buildStreets, type Street } from './streets';
import {
  VENUE_AUTHORS,
  buildVenueClaims,
  facadeModelFor,
  type CandidateLookup,
  type FrontageCandidate,
  type VenueClaim,
} from './venues';

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
  /** Phase 25.7 (T2): set on the ≤18 slots a places.json venue CLAIMED (D1). A claimed slot is
   * forced-occupied, its model/tint overridden by the venue (pastel facade + facade model), and
   * exempt from `thinToCap`. Absent (undefined) on every generic slot — the seam venueDress.ts /
   * VenueDressLayer.tsx read to decorate exactly the venues (via `FrontageLayout.venueClaims`). */
  readonly venueId?: string;
}

/** Phase 25.7 (T2): which cardinal direction a frontage building's FRONT face (local +Z after its
 * `rotationY`) points — derived purely from the fronted street's axis + side. Map convention: +X =
 * east, −X = west, +Z = south, −Z = north (map north = −Z). The §5.3 camera only ever sees the
 * south/east faces, so venueDress.ts's D4 side-band rule keeps west/north-fronting venues legible.
 * Carried on every VenueClaim (not FrontageSlot — only claims are dressed). */
export type FacadeFacing = 'north' | 'south' | 'east' | 'west';

/** Phase 25.7 (T2): a resolved venue claim — the pure venues.ts `VenueClaim` (authoring + the
 * nearest-candidate lattice resolution: slotId/streetId/side/modelId/isCorner + brand/kit/name +
 * pastel/accent colours + queue flag) ENRICHED with the world geometry frontage.ts computes for
 * that claim's facade model. venueDress.ts derives every fascia/awning/prop/queue/plaque placement
 * from this alone (D2: "no street re-derivation") — position/half-extents/rotation/facing are all
 * here, byte-identical to the FrontageSlot the claim occupies. */
export interface ResolvedVenueClaim extends VenueClaim {
  /** World-space [x, 0, z] footprint centre — the same value as the claimed FrontageSlot.position. */
  readonly position: readonly [number, number, number];
  readonly rotationY: number;
  /** POST-YAW world-AABB half-extents (width/depth swapped by the ±90° frontage rotations), same
   * as the FrontageSlot's — so dressing math treats hx as the world-X half-extent directly. */
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
  readonly districtId: DistrictId;
  /** Cardinal the facade's street-facing front points (D4 fascia-face selection). */
  readonly facing: FacadeFacing;
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
  /** Phase 25.7 (T2): the resolved venue claims (≤18), in VENUE_AUTHORS order. Each corresponds
   * 1:1 to a FrontageSlot carrying its `venueId`; venueDress.ts consumes THIS (never the slots) so
   * dressing is derived from a single self-contained claim record. Empty is impossible for the real
   * lattice (every venue must resolve, D1) — it throws instead. */
  readonly venueClaims: readonly ResolvedVenueClaim[];
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

/** The cardinal the front face points, for the SAME (axis, side) frontageRotationY yaws (verified
 * by rotating local +Z by that yaw): ns/+1 → −X (west), ns/−1 → +X (east), ew/+1 → −Z (north),
 * ew/−1 → +Z (south). Used only for VenueClaim.facing (D4 fascia-face selection). */
function frontageFacing(axis: Street['axis'], side: 1 | -1): FacadeFacing {
  if (axis === 'ns') return side === 1 ? 'west' : 'east';
  return side === 1 ? 'north' : 'south';
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

// --- candidate lattice (T2 seam) -------------------------------------------------------------

/** Every pre-occupancy frontage candidate on one street SIDE, in walk order — the exact positions
 * the generic block-walk visits (segments × pitch, same slotId grammar). This is the seed-
 * independent lattice venues.ts's buildVenueClaims searches (D1); extracted so the generic walk
 * (buildFrontage) and the claim resolution share ONE candidate enumeration, never a drifting copy.
 * `candidateIndex` runs across ALL of a side's segments (matching the walk's `candidateIndex`). */
function candidatesForSide(
  street: Street,
  side: 1 | -1,
  crossings: readonly StreetCrossing[],
): readonly FrontageCandidate[] {
  const out: FrontageCandidate[] = [];
  const sideTag = side === 1 ? 'p' : 'n';
  let candidateIndex = 0;
  for (const [segLo, segHi] of blockSegments(street, crossings)) {
    const length = segHi - segLo;
    const n = Math.max(1, Math.round(length / FRONTAGE.pitchWu));
    const step = length / n;
    for (let i = 0; i <= n; i++) {
      out.push({
        slotId: `${street.id}:${sideTag}:${candidateIndex}`,
        streetId: street.id,
        side,
        along: segLo + i * step,
        isCorner: i === 0 || i === n,
      });
      candidateIndex += 1;
    }
  }
  return out;
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
  readonly claimed: boolean; // a venue claim (T2) — exempt from thinToCap
}

const byDistrictThenOrder = (a: RawSlot, b: RawSlot): number =>
  DISTRICT_INDEX.get(a.districtId)! - DISTRICT_INDEX.get(b.districtId)! || a.order - b.order;

/** thinToCap, but venue-claimed slots (T2) are exempt: every claim survives, only the generic slots
 * are even-stride thinned to fill the remaining budget (cap − claims). The union is re-sorted into
 * the sacred district order (claims already carry the earliest `order` within their district, so
 * they stay first). Total ≤ cap, claims exempt (the D1/900-cap guarantee). */
function thinPreservingClaimed(items: readonly RawSlot[], cap: number): readonly RawSlot[] {
  if (items.length <= cap) return items.slice();
  const claimed = items.filter((s) => s.claimed);
  const generic = items.filter((s) => !s.claimed);
  const genericCap = Math.max(0, cap - claimed.length);
  const kept = [...claimed, ...thinToCap(generic, genericCap)];
  return kept.sort(byDistrictThenOrder);
}

/** Build the whole pack-building frontage layout for `seed`. Deterministic (mulberry forks),
 * district-ordered (config order = buffer order), ribbon/polygon/water/overlap/exclusion-safe by
 * construction (the four massing gates + exclusions), hard-capped at FRONTAGE.hardCap.
 *
 * `tierParams` (Phase 25.8 D8) defaults to TORONTO_TIER_IDENTITY — every pre-25.8 call site
 * (devPanel, debugBridge, tests) that omits it gets byte-identical pre-tier output. Only
 * `frontageOccupancyScalar` affects this builder (multiplies FRONTAGE.occupancy's per-density
 * roll in Pass 2); venue claims (Pass 1) are forced-occupied and never scaled. */
export function buildFrontage(seed: number, tierParams: TorontoTierParams = TORONTO_TIER_IDENTITY): FrontageLayout {
  const base = createRng(seed).fork('toronto-packdress-v1');
  const { streets } = buildStreets();
  const intersections = listIntersections(streets);
  const districts = buildDistricts();
  const named = buildNamedBuildings();
  const places = buildPlacesLayer(named);

  // Phase 25.8 (D7): park rects join the exclusion set (built BEFORE this walk, like named/places)
  // so the streetwall legitimately gaps at a park. Parks are SEED-INDEPENDENT (parks.ts), so this
  // keeps the claim gate — and thus venue claims — seed-independent (the 25.7 invariant); it also
  // guarantees venue-claim ∩ park = ∅ by construction (a park excludes any candidate overlapping it).
  const exclusions: Aabb[] = [...named.exclusions, ...places.exclusions, ...buildParks().exclusions].map((r) => ({
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
  // Claim-only ribbon set: DEFLATED by CLAIM_RIBBON_TOLERANCE_WU. A pizza-corner claim flanking a
  // real intersection sits at the block-segment-end candidate (crossing − crossHalfWidth −
  // cornerClearance 3); its half-along (~3.71 wu) exceeds that 3 wu clearance by ~0.71 wu, so its
  // asphalt-facing edge pokes ~0.71 wu past the perpendicular ribbon — the strict generic gate
  // rejects it and the designed McDonald's @ Queen×Spadina pizza-corner hit is lost. Deflating the
  // ribbon by 1.5 wu for the CLAIM gate lets that narrow corner through (0.71 < 1.5) while STILL
  // rejecting a wide family footprint at the same corner (half-along ~6.75 → ~3.75 wu penetration >
  // 1.5) — so only the intended narrow corner piece gets the tiny authentic overhang. Generic slots
  // keep the strict inflated `ribbons` gate unchanged.
  const CLAIM_RIBBON_TOLERANCE_WU = 1.5;
  const claimRibbons: Aabb[] = streets.map((s) => ({
    minX: s.ribbon.minX + CLAIM_RIBBON_TOLERANCE_WU,
    maxX: s.ribbon.maxX - CLAIM_RIBBON_TOLERANCE_WU,
    minZ: s.ribbon.minY + CLAIM_RIBBON_TOLERANCE_WU,
    maxZ: s.ribbon.maxY - CLAIM_RIBBON_TOLERANCE_WU,
  }));

  const streetById = new Map<string, Street>(streets.map((s) => [s.id, s]));

  // --- the pre-occupancy candidate lattice (T2 seam) ---------------------------------------
  // Built ONCE, seed-independent, from the SAME candidatesForSide the generic walk consumes below.
  // `latticeBySlot` is the O(1) slotId → candidate map the claims pass resolves geometry through.
  const latticeByKey = new Map<string, readonly FrontageCandidate[]>();
  const latticeBySlot = new Map<string, FrontageCandidate>();
  for (const street of streets) {
    const crossings = crossingsOn(street, intersections);
    for (const side of [1, -1] as const) {
      const list = candidatesForSide(street, side, crossings);
      latticeByKey.set(`${street.id}:${side === 1 ? 'p' : 'n'}`, list);
      for (const cand of list) latticeBySlot.set(cand.slotId, cand);
    }
  }

  // The four geometric gates (water / named+places exclusions / polygon / ribbon), sized by the
  // EXACT facade model the venue would place at THIS candidate (facadeModelFor folds in the D3
  // corner-food pizza-corner swap). Model-aware sizing is load-bearing at corners: a family footprint
  // over-hangs a wide crossing's ribbon, but the narrow pizza-corner a food venue swaps to clears it
  // — so sizing per-model is what keeps McDonald's designed corner hit resolvable (a flat family
  // filter drops that corner candidate and McDonald's falls to a mid-block non-corner slot). It also
  // requires a resolved district (no packStock → the generic walk skips the slot → a claim there
  // would be homeless). places.exclusions no longer carries the venue storefront boxes (T3 shrank
  // it), so a venue never self-excludes.
  const candidatePasses = (street: Street, cand: FrontageCandidate, kitId: VenueClaim['kitId']): boolean => {
    if (!districtAt(districtRefPoint(street, cand.side, cand.along), districts)) return false;
    const half = colliderHalfExtents(facadeModelFor(kitId, cand.isCorner));
    const centre = slotCenter(street, cand.side, cand.along, half.hz);
    const { hx, hz } = worldHalfExtents(half, street.axis);
    const fp: Aabb = { minX: centre.x - hx, maxX: centre.x + hx, minZ: centre.y - hz, maxZ: centre.y + hz };
    if (fp.maxZ >= WATER_Z) return false;
    if (exclusions.some((r) => overlaps(fp, r))) return false;
    if (!insidePolygon(fp)) return false;
    if (claimRibbons.some((r) => overlaps(fp, r))) return false;
    return true;
  };

  // Resolve every venue through buildVenueClaims (D1 nearest-candidate + facadeModelFor + pastel
  // derivation), each against a lookup pre-filtered by THAT venue's own model sizing — so a
  // filtered-out nearest is simply absent and the nearest-pick fall-back to the next-nearest passing
  // candidate is deterministic and automatic. buildVenueClaims throws (venue-id-bearing) if a venue
  // has zero passing candidates on its side — every venue must resolve (D1).
  const claims: readonly VenueClaim[] = VENUE_AUTHORS.map((author) => {
    const lookup: CandidateLookup = (streetId, sideNum) => {
      const list = latticeByKey.get(`${streetId}:${sideNum === 1 ? 'p' : 'n'}`) ?? [];
      const street = streetById.get(streetId);
      if (!street) return [];
      return list.filter((c) => candidatePasses(street, c, author.kitId));
    };
    return buildVenueClaims(lookup, [author])[0];
  });

  let order = 0;
  const raw: RawSlot[] = [];
  // Global claim-footprint gate every generic slot must clear (D1: claimed footprints gate ALL later
  // generic placement, not just same-district). Also the claimed-slotId set (for generic eviction).
  const claimedFootprints: Aabb[] = [];
  const claimedSlotIds = new Set<string>();
  const venueClaims: ResolvedVenueClaim[] = [];

  // --- Pass 1: place the venue claims FIRST (forced-occupied, model/tint overridden, gate-
  // validated by the filtered lookup so they never need re-testing here). Earliest `order` → they
  // sort first within their district. ------------------------------------------------------------
  for (const claim of claims) {
    if (claimedSlotIds.has(claim.slotId)) {
      throw new Error(`frontage: two venue claims resolved to the same slot "${claim.slotId}"`);
    }
    const cand = latticeBySlot.get(claim.slotId);
    if (!cand) throw new Error(`frontage: venue "${claim.venueId}" claimed unknown slot "${claim.slotId}"`);
    const street = streetById.get(cand.streetId);
    if (!street) throw new Error(`frontage: venue "${claim.venueId}" street "${cand.streetId}" not built`);
    const def = districtAt(districtRefPoint(street, cand.side, cand.along), districts);
    if (!def) throw new Error(`frontage: venue "${claim.venueId}" claimed a district-less slot "${claim.slotId}"`);

    const half = colliderHalfExtents(claim.modelId);
    const centre = slotCenter(street, cand.side, cand.along, half.hz);
    const { hx, hy, hz } = worldHalfExtents(half, street.axis);
    const rotationY = frontageRotationY(street.axis, cand.side);
    const facing = frontageFacing(street.axis, cand.side);
    const position: [number, number, number] = [centre.x, 0, centre.y];
    const fp: Aabb = { minX: centre.x - hx, maxX: centre.x + hx, minZ: centre.y - hz, maxZ: centre.y + hz };

    claimedFootprints.push(fp);
    claimedSlotIds.add(claim.slotId);
    raw.push({
      slotId: claim.slotId,
      modelId: claim.modelId,
      position,
      rotationY,
      tint: claim.pastelTint,
      districtId: def.id,
      isCorner: cand.isCorner,
      hx,
      hy,
      hz,
      venueId: claim.venueId,
      order: order++,
      claimed: true,
    });
    venueClaims.push({ ...claim, position, rotationY, hx, hy, hz, districtId: def.id, facing });
  }

  // Placed footprints per district (the same-district no-overlap gate — massing's gate d).
  const placedByDistrict = new Map<DistrictId, Aabb[]>();

  // --- Pass 2: the generic street-walk (unchanged rolls) — but claimed slotIds are EVICTED (never
  // rolled) and every kept generic additionally clears the global claim-footprint gate. -----------
  for (const street of streets) {
    const crossings = crossingsOn(street, intersections);
    for (const side of [1, -1] as const) {
      for (const cand of candidatesForSide(street, side, crossings)) {
        const { along, isCorner, slotId } = cand;
        if (claimedSlotIds.has(slotId)) continue; // a venue owns this slot (eviction)

        const refPoint = districtRefPoint(street, side, along);
        const def = districtAt(refPoint, districts) ?? undefined;
        if (!def) continue; // outside every resolved district rect — no packStock to draw from

        const slotRng = base.fork(slotId);
        // Fixed roll order (occupancy, model, tint) → the slot's identity is stable per id.
        // Phase 25.8 (D8): tierParams.frontageOccupancyScalar scales the base occupancy down at
        // lower tiers (clamped ≤ 1 — a scalar ≥ 1 in a future tier must never exceed a
        // probability). The SAME rng draw is compared against a smaller threshold, so a slot kept
        // at a lower tier is always also kept at a higher one (monotone subset, never reordered).
        const occupancy = Math.min(1, FRONTAGE.occupancy[def.density as DistrictDensity] * tierParams.frontageOccupancyScalar);
        const kept = slotRng.next() < occupancy;
        const modelId = pickModel(slotRng, def, isCorner);
        const tint = def.packStock.tints[Math.floor(slotRng.next() * def.packStock.tints.length) % def.packStock.tints.length];
        if (!kept) continue;

        const half = colliderHalfExtents(modelId);
        const centre = slotCenter(street, side, along, half.hz);
        const { hx, hy, hz } = worldHalfExtents(half, street.axis);
        const fp: Aabb = { minX: centre.x - hx, maxX: centre.x + hx, minZ: centre.y - hz, maxZ: centre.y + hz };

        // The four massing gates + exclusions + the global venue-claim gate (cheapest reject first).
        if (fp.maxZ >= WATER_Z) continue;
        if (exclusions.some((r) => overlaps(fp, r))) continue;
        if (!insidePolygon(fp)) continue;
        if (ribbons.some((r) => overlaps(fp, r))) continue;
        if (claimedFootprints.some((r) => overlaps(fp, r))) continue;
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
          claimed: false,
        });
      }
    }
  }

  // District-order the raw slots (config order), stable within a district via insertion order.
  raw.sort(byDistrictThenOrder);
  const capped = thinPreservingClaimed(raw, FRONTAGE.hardCap);

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
    ...(s.venueId !== undefined ? { venueId: s.venueId } : {}),
  }));
  const ranges = buildRanges(slots);
  const modelIds = [...new Set(slots.map((s) => s.modelId))].sort();

  const towerBoxes = buildBackdropTowers(streets, districts, exclusions, ribbons, base.fork('backdrop-towers'));

  const counts: Record<string, number> = { total: slots.length, towerBoxes: towerBoxes.length };
  for (const id of DISTRICT_ORDER) counts[id] = 0;
  for (const s of slots) counts[s.districtId] += 1;

  return { slots, ranges, modelIds, towerBoxes, venueClaims, counts };
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

/** Phase 25.7 (T4/T5): a camera-ward standoff point (world XZ) in front of a venue's
 * camera-visible face — the drive-past teleport target the devPanel "→ venue" buttons + the
 * window.__smashy venue teleport share. The §5.3 camera sits SE of the car (+x/+z) looking NW, so
 * the car must sit on the venue's +x/+z side: an E/S-fronting venue's own street (`out` points
 * +x/+z), a W/N-fronting venue's S/E flank (whose side band the D4 rule painted). */
const VENUE_VIEWPOINT_STANDOFF_WU = 3;
export function venueViewpoint(claim: ResolvedVenueClaim): { x: number; z: number } {
  const out: readonly [number, number] =
    claim.facing === 'south' ? [0, 1] : claim.facing === 'north' ? [0, -1] : claim.facing === 'east' ? [1, 0] : [-1, 0];
  const along: readonly [number, number] = [-out[1], out[0]];
  const cam: readonly [number, number] =
    claim.facing === 'east' || claim.facing === 'south'
      ? out
      : along[0] + along[1] >= 0
        ? along
        : [-along[0], -along[1]];
  const half = Math.abs(cam[0]) * claim.hx + Math.abs(cam[1]) * claim.hz;
  return {
    x: claim.position[0] + cam[0] * (half + VENUE_VIEWPOINT_STANDOFF_WU),
    z: claim.position[2] + cam[1] * (half + VENUE_VIEWPOINT_STANDOFF_WU),
  };
}
