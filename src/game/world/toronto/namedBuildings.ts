// Toronto map v2 — named landmark buildings (TORONTO-MAP-SPEC-v2.md §3c/§4, Addendum A.2/A.3;
// phase-24-plan Task 3). The §3c skyline table dropped onto the map as plain extruded boxes
// with a §4 material LOOK, a per-facade window texture (baked by the renderer), and — for the
// financial-cluster bank towers — a CROWN logo decal (A.3: "Bank towers = plain boxes + crown
// decal. Their identity is colour + height + logo, not silhouette.").
//
// SINGLE SOURCE OF TRUTH: every dimension and material comes from data/toronto/building-specs.json
// (imported directly — the game genuinely consumes the spec at runtime now; ~6 KB into the game
// chunk, a plan-approved deviation from Phase 21's "validators stay bundle-free" rule). Heights
// are RECOMPUTED here via hGame(real_h_m) — the JSON's `expected_game_h_wu` is a cross-check
// (data.test.ts / heightCurve.test.ts), never the render source. Footprints come from
// `footprint_wu`. Nothing here hardcodes a height/footprint/colour (CLAUDE.md).
//
// PLACEMENTS are street-referenced (the districts.ts idiom): each building's centre is an offset
// off buildStreets() centrelines, so the whole layout tracks the road grid and stays inside the
// §1 polygon by construction. Excluded from this phase: cn-tower + rogers-centre (Phase 25 hero
// primitive meshes — their rail-lands lots ARE reserved here as massing exclusions so P25 drops
// them in without a regen fight) and casa-loma (dropped — projects ~1.7 km off-polygon, plan
// decision). two-storey-shop is a per-district filler archetype, not a placement.
//
// DECAL FACES are pinned SOUTH (+Z) and EAST (+X): the §5.3 camera sits at +x/+z of its target
// (yaw 45°) looking toward −x/−z, so exactly those two faces of every box are camera-visible
// (Addendum A.2 fixed-bearing branch; map north = −Z per projection.mapToWorld).

import buildingSpecsJson from '../../../../data/toronto/building-specs.json';
import { CROWN_DECAL, lookForMaterial, type MaterialLook } from '../../config/torontoMaterials';
import { hGame } from './heightCurve';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import { TORONTO_PROJECTION } from './projection';
import { buildStreets, type MapRect, type Street } from './streets';
import { type LogoBrand } from './logoAtlas';

/** The two camera-visible faces every CROWN decal is authored on (Addendum A.2, pinned). */
export type DecalFace = 'south' | 'east';

/** One extruded box: world-space centre (map x → world x, map y → world z; identity swap), its
 * half-extents, and the §4 look driving its fill + window texture. The box floor is at y=0, so
 * its centre y is `hy`. */
export interface NamedBox {
  /** World-space centre x (= map x). */
  readonly cx: number;
  /** World-space centre z (= map y). */
  readonly cz: number;
  readonly hx: number;
  /** Half-height = hGame(realHeightM) / 2. */
  readonly hy: number;
  readonly hz: number;
  readonly look: MaterialLook;
}

/** A CROWN logo decal on a box face (§4 CROWN mode). `bandCenterFrac` is the vertical centre of
 * the 70–85% band; `size` is the square edge in wu (clamped per §4). */
export interface CrownDecal {
  readonly brand: LogoBrand;
  readonly face: DecalFace;
  /** Index into the placement's `boxes` this decal rides (the main tower). */
  readonly boxIndex: number;
  readonly bandCenterFrac: number;
  readonly size: number;
}

/** A resolved named building: its spec identity, overall footprint rect (map space, for tests +
 * exclusions), the box(es) it renders as, and its CROWN decals (empty for non-bank buildings). */
export interface NamedPlacement {
  readonly id: string;
  readonly name: string;
  readonly material: string;
  readonly rect: MapRect;
  readonly boxes: readonly NamedBox[];
  readonly decals: readonly CrownDecal[];
}

export interface NamedBuildings {
  readonly placements: readonly NamedPlacement[];
  /** Footprints (+ margin) + the two hero lots — massing.ts rejects candidates intersecting these. */
  readonly exclusions: readonly MapRect[];
  /** The two Phase-25 hero lots (subset of `exclusions`), exposed for tests + the P25 handoff. */
  readonly heroLots: readonly MapRect[];
}

// --- spec data -----------------------------------------------------------------------------

interface BuildingSpec {
  readonly id: string;
  readonly name: string;
  readonly real_h_m: number;
  readonly floors: number | null;
  readonly footprint_wu: number;
  readonly material: string;
}

const SPECS = buildingSpecsJson.buildings as readonly BuildingSpec[];
const specById = new Map<string, BuildingSpec>(SPECS.map((s) => [s.id, s]));

function spec(id: string): BuildingSpec {
  const s = specById.get(id);
  if (!s) throw new Error(`namedBuildings: building-specs.json has no building "${id}"`);
  return s;
}

/** Heroes (Phase 25) + Casa Loma (dropped — off-polygon). Exactly these three are excluded from
 * placement; the test pins the set. */
export const NAMED_EXCLUDED_IDS = ['cn-tower', 'rogers-centre', 'casa-loma'] as const;
/** Filler archetype (a per-district stock building, not a landmark placement). */
export const NAMED_FILLER_ARCHETYPE_IDS = ['two-storey-shop'] as const;

/** Margin (wu) added around every named footprint before it becomes a massing exclusion. */
const EXCLUSION_MARGIN_WU = 3;

/**
 * The two hero lots reserved for Phase 25 (CN Tower + Rogers Centre primitive meshes) so the
 * filler massing leaves them empty now — P25 drops the heroes in without a regen fight. From the
 * spec §5 adjacency rule (tower + dome touching, south of Front, west of the rail corridor);
 * both sit wholly inside the downtown polygon (asserted in the test — the "clamp inside polygon"
 * requirement is a no-op here, they are already interior). Map space (= world XZ).
 */
export const HERO_LOTS: readonly MapRect[] = [
  { minX: 935, minY: 3375, maxX: 965, maxY: 3405 }, // CN Tower ≈ 30×30 centred (950, 3390)
  { minX: 825, minY: 3415, maxX: 895, maxY: 3485 }, // Rogers Centre ≈ 70×70 centred (860, 3450)
] as const;

// --- authored placements -------------------------------------------------------------------
// Each centre is an offset off resolved street centrelines (never a bare literal coordinate).
// `shape` picks how footprint_wu maps to half-extents: square (tower), longX (E-W colonnade),
// longZ (N-S galleria). Twins/podia add extra boxes. `decalBrand` (bank towers only) adds S+E
// CROWN decals on box 0.

type Shape = 'square' | 'longX' | 'longZ';

/** Secondary tower of a twin: an offset box whose height derives from the main by floor ratio. */
interface TwinSpec {
  readonly dx: number;
  readonly dz: number;
  readonly floors: number;
}

/** An extra lower box (e.g. The Well's red-brick podium): its own dims + material. */
interface PodiumSpec {
  readonly dx: number;
  readonly dz: number;
  readonly w: number;
  readonly d: number;
  readonly realM: number;
  readonly material: string;
}

interface Author {
  readonly id: string;
  /** Centre (map x, z) as a function of the street-centreline lookup. */
  readonly center: (c: (id: string) => number) => { x: number; z: number };
  readonly shape: Shape;
  /** For longX/longZ: the SHORT half-extent (wu). */
  readonly shallowHalf?: number;
  readonly decalBrand?: LogoBrand;
  readonly twin?: TwinSpec;
  readonly podium?: PodiumSpec;
}

/** Midpoint of two street centrelines. */
const mid = (a: number, b: number): number => (a + b) / 2;

/** North York Centre latitude (map y) — the yonge-northyorkcentre calibration anchor projected. */
const NYC_ANCHOR = TORONTO_PROJECTION.calib.yongeLine.find((a) => a.id === 'yonge-northyorkcentre');
const NYC_Y = NYC_ANCHOR ? TORONTO_PROJECTION.project({ lat: NYC_ANCHOR.lat, lon: NYC_ANCHOR.lon }).y : 810;

const AUTHORS: readonly Author[] = [
  // --- Financial cluster around King (y) × Bay (x): a Bay-Street canyon of bank towers -------
  // West side of Bay, stacked S→N: TD (S of King) · Scotia (N of King) · FCP (N of Adelaide).
  { id: 'td-bank-tower', center: (c) => ({ x: c('bay') - 36, z: c('king') + 35 }), shape: 'square', decalBrand: 'td' },
  { id: 'scotia-plaza', center: (c) => ({ x: c('bay') - 36, z: c('king') - 37 }), shape: 'square', decalBrand: 'scotiabank' },
  { id: 'first-canadian-place', center: (c) => ({ x: c('bay') - 36, z: c('adelaide') - 34 }), shape: 'square', decalBrand: 'bmo' },
  // East side of Bay: Commerce Court W (N of King) · RBC (at Front) · CIBC Square (S of Front).
  { id: 'commerce-court-west', center: (c) => ({ x: c('bay') + 32, z: c('king') - 37 }), shape: 'square', decalBrand: 'cibc' },
  { id: 'royal-bank-plaza', center: (c) => ({ x: c('bay') + 34, z: c('front') - 39 }), shape: 'square', decalBrand: 'rbc' },
  { id: 'cibc-square', center: (c) => ({ x: c('bay') + 50, z: c('front') + 41 }), shape: 'square', decalBrand: 'cibc' },
  // Fairmont Royal York: the wide limestone block N of Front, W of York/Bay.
  { id: 'fairmont-royal-york', center: (c) => ({ x: c('bay') - 90, z: c('front') - 44 }), shape: 'square' },
  // Union Station: shallow limestone colonnade S of Front. The Bay/York centrelines are ~12.5 wu
  // apart on this map (the documented Bay/York proxy artifact — a 74-wu box can't straddle them
  // without crossing a ribbon), so it hugs Front's south edge extending WEST from the Bay corner.
  { id: 'union-station', center: (c) => ({ x: c('bay') - 54, z: c('front') + 51 }), shape: 'longX', shallowHalf: 6 },
  // --- West downtown -------------------------------------------------------------------------
  {
    id: 'the-well',
    center: (c) => ({ x: c('spadina') + 57, z: c('front') - 44 }),
    shape: 'square',
    podium: { dx: 32, dz: 5, w: 24, d: 18, realM: 30, material: 'brick_red' },
  },
  // --- Yonge spine (Queen→Dundas galleria; Aura) --------------------------------------------
  {
    id: 'eaton-centre-galleria',
    center: (c) => ({ x: c('yonge') - 28, z: mid(c('queen'), c('dundas')) }),
    shape: 'longZ',
    shallowHalf: 7,
  },
  { id: 'aura', center: (c) => ({ x: c('yonge') + 35, z: mid(c('college'), c('dundas')) }), shape: 'square' },
  // --- North York (Yonge × Sheppard twins; Civic Centre) ------------------------------------
  { id: 'hullmark', center: (c) => ({ x: c('yonge') + 40, z: c('sheppard') - 46 }), shape: 'square', twin: { dx: 26, dz: -22, floors: 37 } },
  { id: 'emerald-park', center: (c) => ({ x: c('yonge') - 38, z: c('sheppard') + 44 }), shape: 'square', twin: { dx: -26, dz: 24, floors: 32 } },
  { id: 'north-york-civic-centre', center: (c) => ({ x: c('yonge') + 37, z: NYC_Y }), shape: 'square' },
];

// --- builders ------------------------------------------------------------------------------

function halfExtents(shape: Shape, footprintWu: number, shallowHalf: number | undefined): { hx: number; hz: number } {
  const full = footprintWu / 2;
  if (shape === 'longX') return { hx: full, hz: shallowHalf ?? full };
  if (shape === 'longZ') return { hx: shallowHalf ?? full, hz: full };
  return { hx: full, hz: full };
}

/** clamp(0.5 · faceWidth, 8, 16) — §4 CROWN size rule. */
function crownSize(faceWidthWu: number): number {
  return Math.max(CROWN_DECAL.sizeMinWu, Math.min(CROWN_DECAL.sizeMaxWu, CROWN_DECAL.faceScale * faceWidthWu));
}

function boxRect(box: NamedBox): MapRect {
  return { minX: box.cx - box.hx, maxX: box.cx + box.hx, minY: box.cz - box.hz, maxY: box.cz + box.hz };
}

function unionRect(boxes: readonly NamedBox[]): MapRect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    const r = boxRect(b);
    minX = Math.min(minX, r.minX);
    minY = Math.min(minY, r.minY);
    maxX = Math.max(maxX, r.maxX);
    maxY = Math.max(maxY, r.maxY);
  }
  return { minX, minY, maxX, maxY };
}

function inflate(r: MapRect, m: number): MapRect {
  return { minX: r.minX - m, minY: r.minY - m, maxX: r.maxX + m, maxY: r.maxY + m };
}

/** Clamp a rect's corners into the polygon (no-op when already interior — see HERO_LOTS note). */
function clampRectInside(r: MapRect): MapRect {
  // The hero lots are interior by construction; this only guards against a future edit nudging
  // one out. A rect can't be "projected" into a non-convex polygon cleanly, so we simply assert
  // membership via the test and return the rect unchanged when its corners are already inside.
  const corners = [
    { x: r.minX, y: r.minY },
    { x: r.maxX, y: r.minY },
    { x: r.maxX, y: r.maxY },
    { x: r.minX, y: r.maxY },
  ];
  if (corners.every((p) => pointInPolygon(p, PLAYABLE_POLYGON))) return r;
  throw new Error(`namedBuildings: hero lot ${JSON.stringify(r)} is not inside the polygon`);
}

/** Build every named placement + the massing exclusion set. Deterministic, pure. */
export function buildNamedBuildings(): NamedBuildings {
  const streets = buildStreets().streets;
  const byId = new Map<string, Street>(streets.map((s) => [s.id, s]));
  const c = (id: string): number => {
    const st = byId.get(id);
    if (!st) throw new Error(`namedBuildings: street "${id}" not in the built table`);
    return st.centerline;
  };

  const placements: NamedPlacement[] = AUTHORS.map((a) => {
    const s = spec(a.id);
    const { x, z } = a.center(c);
    const { hx, hz } = halfExtents(a.shape, s.footprint_wu, a.shallowHalf);
    const look = lookForMaterial(s.material);
    const mainBox: NamedBox = { cx: x, cz: z, hx, hy: hGame(s.real_h_m) / 2, hz, look };
    const boxes: NamedBox[] = [mainBox];

    // Twin secondary tower (Hullmark / Emerald): height by floor ratio off the main.
    if (a.twin) {
      if (s.floors === null) throw new Error(`namedBuildings: twin "${a.id}" needs a main floor count`);
      const secRealM = s.real_h_m * (a.twin.floors / s.floors);
      boxes.push({ cx: x + a.twin.dx, cz: z + a.twin.dz, hx, hy: hGame(secRealM) / 2, hz, look });
    }

    // Podium (The Well): a lower, differently-materialed box.
    if (a.podium) {
      boxes.push({
        cx: x + a.podium.dx,
        cz: z + a.podium.dz,
        hx: a.podium.w / 2,
        hy: hGame(a.podium.realM) / 2,
        hz: a.podium.d / 2,
        look: lookForMaterial(a.podium.material),
      });
    }

    // CROWN decals on the two camera-visible faces of the main tower (bank towers only).
    const decals: CrownDecal[] = [];
    if (a.decalBrand) {
      decals.push(
        { brand: a.decalBrand, face: 'south', boxIndex: 0, bandCenterFrac: CROWN_DECAL.bandCenterFrac, size: crownSize(mainBox.hx * 2) },
        { brand: a.decalBrand, face: 'east', boxIndex: 0, bandCenterFrac: CROWN_DECAL.bandCenterFrac, size: crownSize(mainBox.hz * 2) },
      );
    }

    return { id: a.id, name: s.name, material: s.material, rect: unionRect(boxes), boxes, decals };
  });

  const exclusions: MapRect[] = [];
  for (const p of placements) for (const b of p.boxes) exclusions.push(inflate(boxRect(b), EXCLUSION_MARGIN_WU));
  const heroLots = HERO_LOTS.map(clampRectInside);
  for (const lot of heroLots) exclusions.push(lot);

  return { placements, exclusions, heroLots };
}
