// Toronto map v2 — filler massing (TORONTO-MAP-SPEC-v2.md §3b/§6, Addendum A.4;
// phase-23-plan Task 2). "Extruded coloured boxes ARE the Smashy-Road look; the filler city
// costs zero art time" — so this module IS the downtown-at-a-glance look until Phase 24 drops
// named heroes on top. No OSM this session (container firewall + the part file's authorized
// procedural fallback): the road grid is already real, and a seeded block-fill against it is
// most of "reads as Toronto" at the fixed §5.3 zoom. The output is a flat footprint list, so a
// future OSM importer can replace this generator without touching the renderer.
//
// DETERMINISM (hard requirement, same contract as world/rng.ts): the whole layout is a pure
// function of `seed` via mulberry32 forks — no Math.random, no Date. Same seed → deep-equal
// output on every machine (the seed is shown/shared on the score screen).
//
// DISTRICT-ORDERED RANGES (CLAUDE.md sacred convention): instances are emitted district by
// district in config order, and `districtRanges` records each district's contiguous
// [start,count] slice over the flat array — the address a future blackout write pokes.
//
// Every placement is REJECTED unless it clears four gates: it must not intrude on any road
// ribbon (inflated by a sidewalk margin), it must sit wholly inside the playable polygon, it
// must stay out of the lake band, and it must not overlap an already-placed footprint in the
// same district. What survives is the city.

import type { DistrictDensity, DistrictId, TorontoDistrictDef } from '../../config/torontoDistricts';
import { createRng, type Rng } from '../rng';
import { buildDistricts, type MapRect } from './districts';
import { buildRibbons } from './roadGraph';
import { buildStreets } from './streets';
import { hGame } from './heightCurve';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';

/** One filler box. Centre is in WORLD space (map x → world x, map y → world z; the identity
 * swap of projection.mapToWorld), the box sits on the ground so its centre y = hy. */
export interface MassingInstance {
  /** World-space centre x (= map x). */
  readonly x: number;
  /** World-space centre z (= map y). */
  readonly z: number;
  readonly hx: number;
  /** Half-height = hGame(realHeightM) / 2 — the box floor is at y=0, its roof at 2·hy. */
  readonly hy: number;
  readonly hz: number;
  /** Wall colour, a seeded pick from the district's §6 filler palette. */
  readonly color: string;
  readonly districtId: DistrictId;
}

/** A collider box mirroring one instance (indestructible BUILDING group — locked decision).
 * Same geometry as the instance; centre y = hy so the box rests on the ground slab. */
export interface MassingCollider {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
}

/** The contiguous slice one district owns over the flat instance array (sacred convention). */
export interface DistrictRange {
  readonly districtId: DistrictId;
  readonly start: number;
  readonly count: number;
}

export interface Massing {
  readonly instances: readonly MassingInstance[];
  readonly districtRanges: readonly DistrictRange[];
  readonly colliders: readonly MassingCollider[];
}

// --- tunables (LOOK + count budget; §3b half-scale footprints, §6 stock) -------------------
// FRONTAGE-BIASED LATTICE. A uniform full-district lattice at the budget count (≤800) scatters
// buildings ~90 wu apart — isolated boxes the fixed low camera almost never frames while
// driving. Instead we keep the spec's tight "≈22/30/45" pitch but ACCEPT a candidate only if it
// sits in the FRONTAGE BAND of a road (its centre within FRONTAGE_MAX of some ribbon): buildings
// line the streets the player actually drives (§6 "storefront strips" generalised), block
// interiors stay open, and the total still lands in budget because the bands are a fraction of
// the area. This is the plan's "blocks = spaces between adjacent street ribbons" intent —
// buildings front the streets — done as a cheap distance filter rather than block extraction.
const PITCH: Record<DistrictDensity, number> = {
  dense: 24, // §3a-ish tight — dense districts line their frontages nearly solid
  medium: 32,
  sparse: 46,
};

/** A footprint centre must be within this distance (wu) of a road ribbon to be placed — the
 * frontage band. Beyond it is open block interior (the camera rarely sees it; keeping it empty
 * both reads truer and holds the count budget). */
const FRONTAGE_MAX = 16;

/** Positional jitter as a fraction of pitch — organic offset off the lattice (rejection
 * handles the overlaps this occasionally causes). */
const JITTER_FRAC = 0.3;

/** Footprint side range (wu) by stock. §3b makes buildings half projected size; these are the
 * resulting small footprints. financial + northYorkCentre read as tower plots (wider). */
const FOOTPRINT_TOWER: readonly [number, number] = [10, 18];
const FOOTPRINT_DENSE: readonly [number, number] = [6, 11];
const FOOTPRINT_MEDIUM: readonly [number, number] = [8, 14];

/** Road ribbons get this much extra clearance (a "sidewalk") before a footprint is rejected. */
const SIDEWALK_MARGIN_WU = 2;

/** The lake band floor in world z (= map y). Any footprint reaching it is rejected. */
const WATER_Z = 3700;

// --- North York Yonge storefront strip (§6 "storefront strips") ----------------------------
const STOREFRONT_W: readonly [number, number] = [5, 7]; // perpendicular to Yonge
const STOREFRONT_D: readonly [number, number] = [7, 9]; // along Yonge
const STOREFRONT_M: readonly [number, number] = [8, 12]; // real height (2-3 storeys)
const STOREFRONT_STEP = 26; // y-spacing between storefronts along Yonge
const STOREFRONT_CLEARANCE = SIDEWALK_MARGIN_WU + 1; // gap from the Yonge ribbon edge

const STRIP_DISTRICTS: ReadonlySet<DistrictId> = new Set(['willowdaleFinch', 'northYorkCentre']);

/** A footprint AABB in world/map space (mapToWorld is the identity swap, so both are equal). */
interface Aabb {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

function footprintRange(def: TorontoDistrictDef): readonly [number, number] {
  if (def.id === 'financial' || def.id === 'northYorkCentre') return FOOTPRINT_TOWER;
  if (def.density === 'dense') return FOOTPRINT_DENSE;
  return FOOTPRINT_MEDIUM; // medium + sparse
}

/** Interior overlap (touching edges never count) — one predicate for road, water, and
 * same-district checks, so the generator and the test agree on the boundary. */
function overlaps(a: Aabb, b: Aabb): boolean {
  const t = 1e-9;
  return a.minX < b.maxX - t && a.maxX > b.minX + t && a.minZ < b.maxZ - t && a.maxZ > b.minZ + t;
}

/** Euclidean distance from point (px,pz) to the nearest point of rect `r` (0 if inside). */
function pointRectDist(px: number, pz: number, r: Aabb): number {
  const dx = Math.max(r.minX - px, 0, px - r.maxX);
  const dz = Math.max(r.minZ - pz, 0, pz - r.maxZ);
  return Math.hypot(dx, dz);
}

/** All four corners of a footprint inside the playable polygon (boundary-inclusive). */
function insidePolygon(fp: Aabb): boolean {
  return (
    pointInPolygon({ x: fp.minX, y: fp.minZ }, PLAYABLE_POLYGON) &&
    pointInPolygon({ x: fp.maxX, y: fp.minZ }, PLAYABLE_POLYGON) &&
    pointInPolygon({ x: fp.maxX, y: fp.maxZ }, PLAYABLE_POLYGON) &&
    pointInPolygon({ x: fp.minX, y: fp.maxZ }, PLAYABLE_POLYGON)
  );
}

function uniform(rng: Rng, range: readonly [number, number]): number {
  return range[0] + rng.next() * (range[1] - range[0]);
}

/**
 * Build the whole filler city for `seed`. Deterministic (mulberry forks), district-ordered
 * (config order = buffer order), road/polygon/water/overlap-safe by construction.
 */
export function buildMassing(seed: number): Massing {
  const base = createRng(seed).fork('toronto-massing-v1');
  const districts = buildDistricts();
  const streets = buildStreets().streets;
  const ribbons = buildRibbons(streets);
  const yonge = streets.find((s) => s.id === 'yonge');

  // Road ribbons, raw + inflated by the sidewalk margin (index-aligned), precomputed once. Raw
  // rects drive the frontage-distance filter; inflated rects drive the sidewalk-clearance reject.
  const rawRibbons: Aabb[] = ribbons.map((r) => ({ minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ }));
  const inflatedRibbons: Aabb[] = ribbons.map((r) => ({
    minX: r.minX - SIDEWALK_MARGIN_WU,
    maxX: r.maxX + SIDEWALK_MARGIN_WU,
    minZ: r.minZ - SIDEWALK_MARGIN_WU,
    maxZ: r.maxZ + SIDEWALK_MARGIN_WU,
  }));

  const instances: MassingInstance[] = [];
  const districtRanges: DistrictRange[] = [];

  for (const { def, rects } of districts) {
    const start = instances.length;
    const placed: Aabb[] = []; // same-district footprints, shared across the district's rects

    /** Attempt one footprint centred at (cx, cz) with half-extents (hx, hz) + a chosen height.
     * Runs the four rejection gates against everything placed so far; on success appends the
     * instance and records the footprint. Returns whether it was placed. */
    const tryPlace = (cx: number, cz: number, hx: number, hz: number, realM: number, color: string): boolean => {
      const fp: Aabb = { minX: cx - hx, maxX: cx + hx, minZ: cz - hz, maxZ: cz + hz };
      // (c) water band — cheapest reject first.
      if (fp.maxZ >= WATER_Z) return false;
      // (b) wholly inside the polygon.
      if (!insidePolygon(fp)) return false;
      // (a) clear of every road ribbon + sidewalk margin, AND (frontage) within FRONTAGE_MAX of
      // some road — one pass over the ribbons does both.
      let nearestRoad = Infinity;
      for (let ri = 0; ri < rawRibbons.length; ri++) {
        if (overlaps(fp, inflatedRibbons[ri])) return false; // on the road + sidewalk
        const d = pointRectDist(cx, cz, rawRibbons[ri]);
        if (d < nearestRoad) nearestRoad = d;
      }
      if (nearestRoad > FRONTAGE_MAX) return false; // too deep in the block interior
      // (d) no overlap with an already-placed footprint in this district.
      for (const p of placed) if (overlaps(fp, p)) return false;

      placed.push(fp);
      instances.push({ x: cx, z: cz, hx, hy: hGame(realM) / 2, hz, color, districtId: def.id });
      return true;
    };

    // --- lattice scan of each rect this district owns ---
    const pitch = PITCH[def.density];
    const jitter = pitch * JITTER_FRAC;
    const [sizeLo, sizeHi] = footprintRange(def);
    const rng = base.fork(def.id);
    for (const rect of rects) {
      lattice(rect, pitch, (gx, gz) => {
        // Fixed roll order per candidate (jitter, size, height, colour) → stable stream.
        const cx = gx + (rng.next() * 2 - 1) * jitter;
        const cz = gz + (rng.next() * 2 - 1) * jitter;
        const hx = uniform(rng, [sizeLo, sizeHi]) / 2;
        const hz = uniform(rng, [sizeLo, sizeHi]) / 2;
        const realM = uniform(rng, def.heightRangeM);
        const color = rng.pick(def.fillerColors);
        tryPlace(cx, cz, hx, hz, realM, color);
      });
    }

    // --- North York Yonge storefront strip (§6) ---
    if (STRIP_DISTRICTS.has(def.id) && yonge) {
      const stripRng = base.fork(`${def.id}:strip`);
      const westEdge = yonge.ribbon.minX;
      const eastEdge = yonge.ribbon.maxX;
      // The district's own y-band (its single rect); walk it in STOREFRONT_STEP rows.
      const band = rects[0];
      for (let cz = band.minY + STOREFRONT_STEP / 2; cz < band.maxY; cz += STOREFRONT_STEP) {
        // West frontage box.
        const wHx = uniform(stripRng, STOREFRONT_W) / 2;
        const wHz = uniform(stripRng, STOREFRONT_D) / 2;
        const wRealM = uniform(stripRng, STOREFRONT_M);
        const wColor = stripRng.pick(def.fillerColors);
        tryPlace(westEdge - STOREFRONT_CLEARANCE - wHx, cz, wHx, wHz, wRealM, wColor);
        // East frontage box.
        const eHx = uniform(stripRng, STOREFRONT_W) / 2;
        const eHz = uniform(stripRng, STOREFRONT_D) / 2;
        const eRealM = uniform(stripRng, STOREFRONT_M);
        const eColor = stripRng.pick(def.fillerColors);
        tryPlace(eastEdge + STOREFRONT_CLEARANCE + eHx, cz, eHx, eHz, eRealM, eColor);
      }
    }

    districtRanges.push({ districtId: def.id, start, count: instances.length - start });
  }

  const colliders: MassingCollider[] = instances.map((i) => ({
    x: i.x,
    y: i.hy,
    z: i.z,
    hx: i.hx,
    hy: i.hy,
    hz: i.hz,
  }));

  return { instances, districtRanges, colliders };
}

/** Walk a rect on a `pitch` lattice (half-pitch inset so cells sit inside the rect), calling
 * `visit(gx, gz)` at each grid point. Deterministic iteration order (x-major, then z). */
function lattice(rect: MapRect, pitch: number, visit: (gx: number, gz: number) => void): void {
  for (let gx = rect.minX + pitch / 2; gx < rect.maxX; gx += pitch) {
    for (let gz = rect.minY + pitch / 2; gz < rect.maxY; gz += pitch) {
      visit(gx, gz);
    }
  }
}
