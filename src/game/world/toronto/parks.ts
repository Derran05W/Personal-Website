// Phase 25.8 (D7) — park patches: the "lively, relatable, recognizable" green layer. FIVE named
// knowledge-status parks anchored to already-verified street centrelines (Queen's Park, Allan
// Gardens, Berczy Park, Grange Park, Mel Lastman Square) + a handful of SEEDED small patches in
// medium/sparse non-tower districts. Pure TS (no three/react), deterministic (mulberry fork), same
// contract as frontage.ts/furniture.ts. Each park is a grass-toned rect (rendered by TorontoScene as
// a merged noise-textured mesh, ABOVE the sidewalk in the ladder) + a tree ring/cluster whose
// placements MERGE into the tree batch, and each rect JOINS the frontage exclusion set (built BEFORE
// buildFrontage, like named/places footprints) so the streetwall legitimately gaps at a park.
//
// District-level accuracy is fine for a vibe layer (flagged `knowledge` — no researcher round). The
// named anchors are STREET-referenced (survive a width/grid retune); a generous block-interior offset
// keeps each rect clear of the ribbons + sidewalks. Venue-claim addresses are asserted disjoint from
// every park rect (parks.test.ts), and seeded patches take the named+places exclusions as input.

import type { DistrictId } from '../../config/torontoDistricts';
import { createRng, type Rng } from '../rng';
import { buildDistricts, districtAt } from './districts';
import { buildNamedBuildings } from './namedBuildings';
import { buildPlacesLayer } from './placesLayer';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import { mapToWorld, type MapPoint } from './projection';
import { buildStreets, type MapRect, type Street } from './streets';

/** A placed park rect in map space (= world XZ; mapToWorld is the identity swap). */
export interface ParkRect {
  readonly id: string;
  readonly name: string;
  readonly kind: 'named' | 'seeded';
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly districtId: DistrictId;
}

/** One park tree placement (world space) — merges into the tree batch (id 'tree'). */
export interface ParkTree {
  readonly position: readonly [number, number, number];
  readonly rotationY: number;
}

export interface ParksLayout {
  readonly parks: readonly ParkRect[];
  readonly trees: readonly ParkTree[];
  /** Every park rect as a map-space MapRect — the frontage/furniture exclusion contribution. */
  readonly exclusions: readonly MapRect[];
}

/** A named park: anchored to the crossing of an NS + an EW street, offset into a block quadrant so
 * the rect clears the ribbons + sidewalks. dx>0 = east, dy<0 = north (map +y = south). */
interface NamedParkDef {
  readonly id: string;
  readonly name: string;
  readonly nsStreet: string;
  readonly ewStreet: string;
  readonly dx: number;
  readonly dy: number;
  readonly w: number;
  readonly h: number;
}

const NAMED_PARKS: readonly NamedParkDef[] = [
  // Queen's Park — University × College, N of College / W of University (uoft / Discovery).
  { id: 'queens-park', name: "Queen's Park", nsStreet: 'university', ewStreet: 'college', dx: -48, dy: -70, w: 52, h: 96 },
  // Allan Gardens — Jarvis × College line, W of Jarvis / N of College (churchWellesley).
  { id: 'allan-gardens', name: 'Allan Gardens', nsStreet: 'jarvis', ewStreet: 'college', dx: -46, dy: -44, w: 58, h: 52 },
  // Berczy Park — Front × Church, E of Church / N of Front (St Lawrence / Old Town).
  { id: 'berczy-park', name: 'Berczy Park', nsStreet: 'church', ewStreet: 'front', dx: 40, dy: -34, w: 44, h: 40 },
  // Grange Park — E of Spadina, between Queen & Dundas (Chinatown/Kensington edge, queenWest).
  { id: 'grange-park', name: 'Grange Park', nsStreet: 'spadina', ewStreet: 'queen', dx: 74, dy: -58, w: 54, h: 58 },
  // Mel Lastman Square — Yonge × ParkHome (North York Centre).
  { id: 'mel-lastman', name: 'Mel Lastman Square', nsStreet: 'yonge', ewStreet: 'parkhome', dx: -42, dy: -40, w: 48, h: 48 },
];

const SEEDED = {
  /** Hard cap on seeded patches (D7). */
  cap: 10,
  /** Patch side range (wu). */
  sizeRangeWu: [16, 26] as const,
  /** Candidate attempts per district before giving up. */
  attemptsPerDistrict: 8,
  /** Districts eligible for seeded patches: medium/sparse density, NOT tower (backdropTowers)
   * districts and NOT the fold corridor (sparse midtown interior reads odd with a random park). */
  excludeIds: new Set<DistrictId>(['financial', 'harbourfront', 'northYorkCentre', 'foldCorridor']),
} as const;

function rectOverlaps(a: MapRect, b: MapRect): boolean {
  const t = 1e-6;
  return a.minX < b.maxX - t && a.maxX > b.minX + t && a.minY < b.maxY - t && a.maxY > b.minY + t;
}

function rectInsidePolygon(r: MapRect): boolean {
  return (
    pointInPolygon({ x: r.minX, y: r.minY }, PLAYABLE_POLYGON) &&
    pointInPolygon({ x: r.maxX, y: r.minY }, PLAYABLE_POLYGON) &&
    pointInPolygon({ x: r.maxX, y: r.maxY }, PLAYABLE_POLYGON) &&
    pointInPolygon({ x: r.minX, y: r.maxY }, PLAYABLE_POLYGON)
  );
}

/** Tree ring/cluster for a park: a jittered perimeter ring inset from the edges so the interior
 * reads as open grass. Deterministic per rect (rng forked from the park id). */
function parkTrees(rect: ParkRect, rng: Rng): ParkTree[] {
  const inset = 4;
  const spacing = 12;
  const out: ParkTree[] = [];
  const x0 = rect.minX + inset;
  const x1 = rect.maxX - inset;
  const y0 = rect.minY + inset;
  const y1 = rect.maxY - inset;
  if (x1 <= x0 || y1 <= y0) return out;
  const push = (x: number, y: number): void => {
    const jx = x + (rng.next() * 2 - 1) * 2;
    const jy = y + (rng.next() * 2 - 1) * 2;
    const p: MapPoint = { x: jx, y: jy };
    if (!pointInPolygon(p, PLAYABLE_POLYGON)) return;
    const [wx, wz] = mapToWorld(p);
    out.push({ position: [wx, 0, wz], rotationY: rng.next() * Math.PI * 2 });
  };
  // Top + bottom edges.
  for (let x = x0; x <= x1 + 1e-6; x += spacing) {
    push(x, y0);
    push(x, y1);
  }
  // Left + right edges (skip the corners already placed).
  for (let y = y0 + spacing; y <= y1 - spacing + 1e-6; y += spacing) {
    push(x0, y);
    push(x1, y);
  }
  return out;
}

/** Fixed internal seed for the "seeded" patches. Parks are deliberately SEED-INDEPENDENT (the same
 * layout across every world seed / "New city"): named parks are fixed civic landmarks, and — the
 * load-bearing reason — the park rects join the frontage CLAIM exclusion set, so a seed-dependent
 * park set would make venue claims seed-dependent and break the 25.7 seed-independence invariant.
 * A consistent park layout across cities is natural (parks don't move when you regenerate). */
const FIXED_PARK_SEED = 0x9e37;

/** Build the whole park layout. SEED-INDEPENDENT + deterministic + pure (no three/react). */
export function buildParks(): ParksLayout {
  const base = createRng(FIXED_PARK_SEED).fork('toronto-parks-v1');
  const streets = buildStreets().streets;
  const streetById = new Map<string, Street>(streets.map((s) => [s.id, s]));
  const districts = buildDistricts();
  const named = buildNamedBuildings();
  const places = buildPlacesLayer(named);
  const ribbons: readonly MapRect[] = streets.map((s) => s.ribbon);
  const staticExclusions: readonly MapRect[] = [...named.exclusions, ...places.exclusions];

  const parks: ParkRect[] = [];

  // --- named parks (seed-independent) ------------------------------------------------------
  for (const def of NAMED_PARKS) {
    const ns = streetById.get(def.nsStreet);
    const ew = streetById.get(def.ewStreet);
    if (!ns || !ew) continue; // a street rename would drop the park rather than throw (vibe layer)
    const cx = ns.centerline + def.dx;
    const cy = ew.centerline + def.dy;
    const rect: MapRect = { minX: cx - def.w / 2, maxX: cx + def.w / 2, minY: cy - def.h / 2, maxY: cy + def.h / 2 };
    if (!rectInsidePolygon(rect)) continue;
    if (ribbons.some((r) => rectOverlaps(rect, r))) continue; // never lay grass over a road
    const districtId = districtAt({ x: cx, y: cy }, districts)?.id ?? 'genericDowntown';
    parks.push({ id: def.id, name: def.name, kind: 'named', ...rect, districtId });
  }

  // --- seeded patches ----------------------------------------------------------------------
  const [sizeLo, sizeHi] = SEEDED.sizeRangeWu;
  for (const d of districts) {
    if (parks.filter((p) => p.kind === 'seeded').length >= SEEDED.cap) break;
    if (SEEDED.excludeIds.has(d.def.id)) continue;
    if (d.def.density === 'dense') continue; // dense cores stay wall-to-wall (parks feel wrong)
    const rng = base.fork(`seeded:${d.def.id}`);
    for (const rect of d.rects) {
      let placed = false;
      for (let attempt = 0; attempt < SEEDED.attemptsPerDistrict && !placed; attempt++) {
        const w = sizeLo + rng.next() * (sizeHi - sizeLo);
        const h = sizeLo + rng.next() * (sizeHi - sizeLo);
        const cx = rect.minX + w / 2 + rng.next() * Math.max(0, rect.maxX - rect.minX - w);
        const cy = rect.minY + h / 2 + rng.next() * Math.max(0, rect.maxY - rect.minY - h);
        const cand: MapRect = { minX: cx - w / 2, maxX: cx + w / 2, minY: cy - h / 2, maxY: cy + h / 2 };
        if (!rectInsidePolygon(cand)) continue;
        if (ribbons.some((r) => rectOverlaps(cand, r))) continue;
        if (staticExclusions.some((r) => rectOverlaps(cand, r))) continue;
        if (parks.some((p) => rectOverlaps(cand, p))) continue;
        if (districtAt({ x: cx, y: cy }, districts)?.id !== d.def.id) continue;
        parks.push({ id: `park-${d.def.id}-${attempt}`, name: `${d.def.name} Parkette`, kind: 'seeded', ...cand, districtId: d.def.id });
        placed = true;
      }
      if (parks.filter((p) => p.kind === 'seeded').length >= SEEDED.cap) break;
    }
  }

  // --- trees (ring per park) ---------------------------------------------------------------
  const trees: ParkTree[] = [];
  for (const park of parks) trees.push(...parkTrees(park, base.fork(`trees:${park.id}`)));

  const exclusions: MapRect[] = parks.map((p) => ({ minX: p.minX, maxX: p.maxX, minY: p.minY, maxY: p.maxY }));
  return { parks, trees, exclusions };
}
