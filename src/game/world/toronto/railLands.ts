// Phase 45 (Part 11) — THE RAIL LANDS: the block south of Front between Spadina and Bay that the
// CN Tower and Rogers Centre already stand in. This module adds its neighbourhood — the Ripley's
// aquarium homage, the John Street Roundhouse homage with its turntable and a museum steam
// locomotive, the ground dressing (ballast beds + tie-banded track), the brewery patio — and, just
// as importantly, CLAIMS THE WHOLE STRIP so nothing generic ever generates in it again. Phase 57
// fills the reserved room with the real rail corridor (berm, GO trains, signals, street bridges).
//
// WHY A STRIP CLAIM: the rail lands are OPEN in reality — tracks, not buildings. Before this phase
// the generic placers filled the block interior with backdrop towers, back-lot boxes, laneway
// clutter and a construction site, which read as "generic downtown" rather than as the corridor
// everybody photographs the tower from. The claim is a `namedExclusion` ZONE (the same channel the
// two hero lots have used since Phase 24), registered with the seed-independent prefix so every
// seed-dependent placer below rejects against it (reject-never-relocate).
//
// THE STREETWALL SURVIVES: the strip is INSET from all four bounding streets by the sidewalk band
// plus one pack-streetwall depth, so the frontage rows facing Front / Bremner / Spadina / Bay —
// and Union Station's researched footprint on Front's south side, which Phase 46 rebuilds — are
// untouched. Only the block INTERIOR is reserved.
//
// SINGLE SOURCE OF TRUTH, as everywhere in the Toronto map:
//   • heights/footprints/materials come from data/toronto/building-specs.json (`aquarium-block`,
//     `roundhouse`), through hGame() × NAMED_HEIGHT_SCALE — both are NAMED-class, not hero-class,
//     so both land far under CAMERA_EYE_MIN_WU (railLands.test.ts is the tripwire: if a future edit
//     pushes one over the eye line it MUST register with Phase 36's dither-fade path);
//   • every street-derived coordinate is resolved off buildStreets() ribbons, and the lots are
//     authored in BASE map space and pushed through scaleAboutYonge/scaleBaseY exactly like
//     namedBuildings.ts's BASE_HERO_LOTS;
//   • every ground Y is a RUNG of config/layering.ts's GROUND_STACK (this phase splices two new
//     ones, `railBallast` and `railTrack`) and every wall offset a WALL_STACK rung;
//   • no painted band is narrower than config/surfaces.ts's THIN_GEOMETRY.minStripeWidthWu — a real
//     rail is ~0.15 wu, half the floor, so rails CANNOT ship literal under the Phase 41 law. The
//     track therefore reads the way it actually reads from 22 wu up: a ballast bed with TIE BANDS.
//
// CAMERA LAW (Phase 34's re-derived face pin): the fixed rig only ever shows a box's SOUTH (+Z) and
// EAST (+X) faces. Every fascia band, blade sign and logo decal below is authored on one of those
// two faces and nowhere else (railLands.test.ts asserts it on the emitted quad normals). The
// roundhouse arc is oriented the same way on purpose: the shed occupies the NW half of the
// turntable circle so its BAY DOORS face the SE boresight across the open apron.
//
// UNLIT-LITERAL, like every other Toronto surface (the P23/P24 material verdict), with a cheap
// baked directional shade in the vertex colours so one flat-coloured mesh still reads as solid —
// the trick heroes.ts uses. This module deliberately keeps its own small copy of that accumulator
// rather than importing from heroes.ts, which is the hero-mesh module and owns its own Phase-44
// night-program vertex attributes; it also copies heroes.ts's `addQuadOriented` idea (pass the
// intended outward direction, let the code fix the winding) because a back-face-culled invisible
// wall is the single easiest mistake to ship in hand-wound geometry.
//
// Pure geometry: three's BufferGeometry/Color are pure JS, so the whole module runs in vitest and
// its tri budgets, determinism and face law are unit-testable without a canvas.

import { BufferGeometry, Color, Float32BufferAttribute } from 'three';
import buildingSpecsJson from '../../../../data/toronto/building-specs.json';
import { BUILDING_FRONTAGE_TARGET_WU } from '../../config/cityPackScale';
import { GROUND_STACK, WALL_STACK } from '../../config/layering';
import { THIN_GEOMETRY } from '../../config/surfaces';
import { NAMED_HEIGHT_SCALE, SIDEWALK } from '../../config/torontoMap';
import { lookForMaterial } from '../../config/torontoMaterials';
import { hGame } from './heightCurve';
import { logoCellUv, type LogoBrand } from './logoAtlas';
import { PLAYABLE_POLYGON, pointInPolygon, scaleAboutYonge } from './polygon';
import { scaleBaseY } from './projection';
import { buildStreets, type MapRect, type Street } from './streets';

// --- tri budgets (Part 11 rule 2: stated per model, re-pinned in the phase that needs them) --------

/** Per-model triangle ceilings for this phase's three bespoke meshes. Pinned by railLands.test.ts. */
export const RAIL_LANDS_MAX_TRIS = {
  aquarium: 500,
  roundhouse: 700,
  locomotive: 300,
} as const;

// --- spec rows --------------------------------------------------------------------------------------

interface RailSpecRow {
  readonly id: string;
  readonly name: string;
  readonly real_h_m: number;
  readonly footprint_wu: number;
  readonly material: string;
}
const SPECS = buildingSpecsJson.buildings as readonly RailSpecRow[];
function railSpec(id: string): RailSpecRow {
  const s = SPECS.find((b) => b.id === id);
  if (!s) throw new Error(`railLands: building-specs.json has no building "${id}"`);
  return s;
}

/** NAMED-class height rule (Part 11 rule 3 / Part-8 D4) — identical to namedBuildings.ts's. */
function namedHeight(realM: number): number {
  return hGame(realM) * NAMED_HEIGHT_SCALE;
}

/** The two spec ids this module owns; namedBuildings.ts excludes them from its box placement. */
export const RAIL_LANDS_SPEC_IDS = ['aquarium-block', 'roundhouse'] as const;

/** Researcher-derived aquarium plan aspect (~110 × 57 m → ~1.9); the spec row's `footprint_wu`
 * stores the LONG side and its `footprint_note` records this ratio. */
const AQUARIUM_ASPECT = 1.9;

// --- lots + the reserved strip -------------------------------------------------------------------------

/**
 * The rail-lands lots in BASE (pre-compaction) map coordinates, exactly like namedBuildings.ts's
 * `BASE_HERO_LOTS`: authored once against the uncompacted map and re-derived through the SAME
 * scaleAboutYonge / scaleBaseY transform, so a future DENSITY change moves them with everything else
 * instead of drifting (the P27 literal-drift class).
 *
 * Arrangement (real-world order, west → east): Rogers Centre → CN Tower → aquarium → roundhouse.
 * Ripley's is at 288 Bremner, at the foot of the CN Tower; Roundhouse Park sits east/south-east of
 * it. DELIBERATE MAP-VS-WORLD DEVIATION (recorded in the phase notes): on the compacted map Bremner
 * Blvd runs SOUTH of the entire hero cluster, so "south of Bremner" (true in Toronto) and "SE of the
 * CN base" (also true) are contradictory here. The ADJACENCY wins, because adjacency is what reads
 * in frame — and it keeps both buildings inside the reserved rail-lands strip.
 */
const BASE_RAIL_LANDS_LOTS: readonly { readonly id: string; readonly rect: MapRect }[] = [
  { id: 'aquarium-block', rect: { minX: 990, minY: 3400, maxX: 1060, maxY: 3450 } },
  { id: 'roundhouse', rect: { minX: 1110, minY: 3450, maxX: 1210, maxY: 3525 } },
] as const;

function liveRect(r: MapRect): MapRect {
  return {
    minX: scaleAboutYonge(r.minX),
    maxX: scaleAboutYonge(r.maxX),
    minY: scaleBaseY(r.minY),
    maxY: scaleBaseY(r.maxY),
  };
}

/** Polygon membership guard — namedBuildings.clampRectInside's contract verbatim: these rects are
 * interior by construction, and the throw is the tripwire against a future edit nudging one out. */
function clampRectInside(rect: MapRect, what: string): MapRect {
  const corners = [
    { x: rect.minX, y: rect.minY },
    { x: rect.maxX, y: rect.minY },
    { x: rect.maxX, y: rect.maxY },
    { x: rect.minX, y: rect.maxY },
  ];
  if (corners.every((p) => pointInPolygon(p, PLAYABLE_POLYGON))) return rect;
  throw new Error(`railLands: ${what} ${JSON.stringify(rect)} is not inside the polygon`);
}

/** The two lots, in live (compacted) map space — the same shape HERO_LOTS exposes. */
export const RAIL_LANDS_LOTS: readonly MapRect[] = BASE_RAIL_LANDS_LOTS.map((l) =>
  clampRectInside(liveRect(l.rect), `lot ${l.id}`),
);

const LOT_BY_ID = new Map<string, MapRect>(BASE_RAIL_LANDS_LOTS.map((l, i) => [l.id, RAIL_LANDS_LOTS[i]]));

/** A lot by spec id — each geometry builder anchors on its own lot's centre. */
export function railLandsLot(id: string): MapRect {
  const lot = LOT_BY_ID.get(id);
  if (!lot) throw new Error(`railLands: no lot for "${id}"`);
  return lot;
}

/** Centre of a rect (map space = world XZ; mapToWorld is the identity swap). */
function rectCenter(r: MapRect): { readonly x: number; readonly z: number } {
  return { x: (r.minX + r.maxX) / 2, z: (r.minY + r.maxY) / 2 };
}

/**
 * How much room the strip claim leaves between a bounding street's SIDEWALK edge and its own
 * boundary, so that street's frontage row survives the claim. DERIVED, not measured: the pack
 * streetwall family is scaled so its frontage is `BUILDING_FRONTAGE_TARGET_WU` (3 car lengths =
 * 13.5 wu, config/cityPackScale.ts) and the models are roughly square in plan, so one frontage width
 * is the depth a full streetwall row occupies behind the walk. A rolled model DEEPER than this
 * simply loses its slot to the strip (reject-never-relocate) — a gap in the wall, never an overlap,
 * and never a broken invariant.
 */
const STREETWALL_RESERVE_WU = BUILDING_FRONTAGE_TARGET_WU;

/** The four streets bounding the block. Bay rather than York on the east: the two centrelines sit
 * ~7.5 wu apart on this map (the documented Bay/York proxy artifact) and Bay is the WESTERN of the
 * pair, so its west ribbon edge is the binding one. */
const STRIP_BOUNDS = { north: 'front', south: 'bremner', west: 'spadina', east: 'bay' } as const;

function streetById(streets: readonly Street[], id: string): Street {
  const st = streets.find((s) => s.id === id);
  if (!st) throw new Error(`railLands: street "${id}" not in the built table`);
  return st;
}

/**
 * The reserved rail-lands strip: the block INTERIOR between Front and Bremner, Spadina and Bay,
 * inset past each street's sidewalk band and streetwall row.
 */
export function railLandsStrip(streets: readonly Street[] = buildStreets().streets): MapRect {
  const inset = SIDEWALK.widthWu + STREETWALL_RESERVE_WU;
  const north = streetById(streets, STRIP_BOUNDS.north);
  const south = streetById(streets, STRIP_BOUNDS.south);
  const west = streetById(streets, STRIP_BOUNDS.west);
  const east = streetById(streets, STRIP_BOUNDS.east);
  return clampRectInside(
    {
      minX: west.ribbon.maxX + inset,
      maxX: east.ribbon.minX - inset,
      minY: north.ribbon.maxY + inset,
      maxY: south.ribbon.minY - inset,
    },
    'strip',
  );
}

/**
 * Every rail-lands ZONE claim: the two lots plus the strip. namedBuildings.ts merges these into
 * `NamedBuildings.exclusions`, which worldContext.ts registers as `namedExclusion` claims in the
 * seed-independent prefix — the exact channel HERO_LOTS has used since Phase 24, so this phase adds
 * no new arbiter taxonomy.
 */
export function railLandsZones(streets: readonly Street[] = buildStreets().streets): readonly MapRect[] {
  return [...RAIL_LANDS_LOTS, railLandsStrip(streets)];
}

// --- palette (unlit-literal; §4 material looks wherever the spec row names a material) ---------------

const GLASS_FILL = lookForMaterial('glass_blue').fill; // aquarium body — the spec row's material
const GLASS_LIT = lookForMaterial('glass_blue').windowTint; // the lit glazing band / entry glow
const GLASS_DARK = '#1d3345'; // recessed entry jambs + plinth course
const ROOF_PALE = '#7d95a8'; // the wave-roof facets — paler, so the fold reads from above
const BRICK_FILL = lookForMaterial('brick_red').fill; // roundhouse body — the spec row's material
const BRICK_DARK = '#553527'; // recessed bay doors
const BRICK_BASE = '#4a3226'; // plinth course
const ROOF_SLATE = '#4b4b52'; // shed roof + clerestory monitor shell
const CLERESTORY = '#93aabb'; // the clerestory glazing strip (inner face — camera-visible)
const ANNEX_TRIM = '#6b4536'; // annex parapet
const LOCO_BLACK = '#26262b';
const LOCO_SMOKEBOX = '#5a5a60';
const LOCO_TRIM = '#8a8f96';
const LOCO_COAL = '#17171a';
const POST_WOOD = '#5a4632'; // patio string-light posts (placesLayer's PatioProp colours)
const BULB_WARM = '#ffd98a'; // patio bulb line
const PYLON_GREY = '#3a4048'; // the aquarium blade-sign pylon

// Ground dressing.
const BALLAST = '#4a4741';
const TIE = '#332d27';
const TURNTABLE_DECK = '#55524b';
const TURNTABLE_BRIDGE = '#6d6860';

// --- geometry accumulator (non-indexed, flat-shaded, per-vertex colour) --------------------------------

type Vec3 = readonly [number, number, number];
type Uv = readonly [number, number];

const LIGHT: readonly [number, number, number] = (() => {
  const [x, y, z] = [0.45, 1, 0.5];
  const len = Math.hypot(x, y, z);
  return [x / len, y / len, z / len];
})();
const SHADE_MIN = 0.5;

interface Accum {
  readonly positions: number[];
  readonly normals: number[];
  readonly colors: number[];
  /** UVs ride along so the SIGN geometry shares one accumulator shape with the solids. */
  readonly uvs: number[];
}
const createAccum = (): Accum => ({ positions: [], normals: [], colors: [], uvs: [] });

const scratchColor = new Color();
function linearRgb(hex: string): [number, number, number] {
  scratchColor.set(hex);
  return [scratchColor.r, scratchColor.g, scratchColor.b];
}

function faceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

interface FaceOpts {
  /** Skip the baked directional shade (sign quads carry a texture and must stay full-bright). */
  readonly unshaded?: boolean;
  readonly uv?: readonly Uv[];
}

/** One flat triangle: normal from winding, colour = base × baked shade. */
function addTri(acc: Accum, a: Vec3, b: Vec3, c: Vec3, hex: string, opts: FaceOpts = {}): void {
  const [nx, ny, nz] = faceNormal(a, b, c);
  const [r, g, bl] = linearRgb(hex);
  const d = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
  const s = opts.unshaded ? 1 : SHADE_MIN + (1 - SHADE_MIN) * d;
  const points = [a, b, c];
  for (let i = 0; i < 3; i++) {
    const p = points[i];
    acc.positions.push(p[0], p[1], p[2]);
    acc.normals.push(nx, ny, nz);
    acc.colors.push(r * s, g * s, bl * s);
    const t = opts.uv?.[i] ?? [0, 0];
    acc.uvs.push(t[0], t[1]);
  }
}

/** Quad (0,1,2)+(0,2,3), wound CCW as seen from outside. */
function addQuad(acc: Accum, q: readonly [Vec3, Vec3, Vec3, Vec3], hex: string, opts: FaceOpts = {}): void {
  const uv = opts.uv;
  addTri(acc, q[0], q[1], q[2], hex, { ...opts, uv: uv ? [uv[0], uv[1], uv[2]] : undefined });
  addTri(acc, q[0], q[2], q[3], hex, { ...opts, uv: uv ? [uv[0], uv[2], uv[3]] : undefined });
}

/**
 * A quad whose winding is CORRECTED to face `outward` — heroes.ts's `addQuadOriented` idea, and the
 * reason none of the arc/recess faces below can ship invisible: a runtime dot against the intended
 * outward direction is deterministic, costs nothing at build time, and makes hand-wound radial
 * geometry un-get-wrong-able.
 */
function addFace(acc: Accum, q: readonly [Vec3, Vec3, Vec3, Vec3], outward: Vec3, hex: string): void {
  const [nx, ny, nz] = faceNormal(q[0], q[1], q[2]);
  if (nx * outward[0] + ny * outward[1] + nz * outward[2] >= 0) addQuad(acc, q, hex);
  else addQuad(acc, [q[3], q[2], q[1], q[0]], hex);
}

/** A triangle whose winding is corrected to face `outward` (roof facets). */
function addTriFacing(acc: Accum, a: Vec3, b: Vec3, c: Vec3, outward: Vec3, hex: string): void {
  const [nx, ny, nz] = faceNormal(a, b, c);
  if (nx * outward[0] + ny * outward[1] + nz * outward[2] >= 0) addTri(acc, a, b, c, hex);
  else addTri(acc, a, c, b, hex);
}

/** An axis-aligned box, five visible faces (the bottom is never seen and never built). */
function addBox(acc: Accum, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, hex: string): void {
  const x0 = cx - hx;
  const x1 = cx + hx;
  const y0 = cy - hy;
  const y1 = cy + hy;
  const z0 = cz - hz;
  const z1 = cz + hz;
  addQuad(acc, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], hex); // +Z
  addQuad(acc, [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], hex); // -Z
  addQuad(acc, [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], hex); // +X
  addQuad(acc, [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], hex); // -X
  addQuad(acc, [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], hex); // +Y
}

/** An N-gon prism along the X axis (cross-section in the Y/Z plane) — wheels seen from the flank. */
function addPrismX(
  acc: Accum,
  sides: number,
  x0: number,
  x1: number,
  cy: number,
  cz: number,
  radius: number,
  hex: string,
): void {
  const step = (Math.PI * 2) / sides;
  const at = (x: number, i: number): Vec3 => [x, cy + radius * Math.cos(i * step), cz + radius * Math.sin(i * step)];
  for (let i = 0; i < sides; i++) {
    const out: Vec3 = [0, Math.cos((i + 0.5) * step), Math.sin((i + 0.5) * step)];
    addFace(acc, [at(x0, i), at(x0, i + 1), at(x1, i + 1), at(x1, i)], out, hex);
  }
  for (let i = 1; i + 1 < sides; i++) {
    addTriFacing(acc, at(x1, 0), at(x1, i), at(x1, i + 1), [1, 0, 0], hex);
    addTriFacing(acc, at(x0, 0), at(x0, i), at(x0, i + 1), [-1, 0, 0], hex);
  }
}

/** An N-gon prism/frustum along the Z axis (cross-section in the X/Y plane) — the boiler + domes. */
function addPrismZ(
  acc: Accum,
  sides: number,
  z0: number,
  z1: number,
  cx: number,
  cy: number,
  r0: number,
  r1: number,
  hex: string,
  capLo = false,
): void {
  const step = (Math.PI * 2) / sides;
  const at = (z: number, r: number, i: number): Vec3 => [cx + r * Math.sin(i * step), cy + r * Math.cos(i * step), z];
  for (let i = 0; i < sides; i++) {
    const out: Vec3 = [Math.sin((i + 0.5) * step), Math.cos((i + 0.5) * step), 0];
    addFace(acc, [at(z0, r0, i), at(z0, r0, i + 1), at(z1, r1, i + 1), at(z1, r1, i)], out, hex);
  }
  if (capLo) for (let i = 1; i + 1 < sides; i++) addTriFacing(acc, at(z0, r0, 0), at(z0, r0, i), at(z0, r0, i + 1), [0, 0, -1], hex);
}

/** An N-gon prism along the Y axis — the loco's stack. */
function addPrismY(acc: Accum, sides: number, y0: number, y1: number, cx: number, cz: number, r0: number, r1: number, hex: string): void {
  const step = (Math.PI * 2) / sides;
  const at = (y: number, r: number, i: number): Vec3 => [cx + r * Math.sin(i * step), y, cz + r * Math.cos(i * step)];
  for (let i = 0; i < sides; i++) {
    const out: Vec3 = [Math.sin((i + 0.5) * step), 0, Math.cos((i + 0.5) * step)];
    addFace(acc, [at(y0, r0, i), at(y0, r0, i + 1), at(y1, r1, i + 1), at(y1, r1, i)], out, hex);
  }
  for (let i = 1; i + 1 < sides; i++) addTriFacing(acc, at(y1, r1, 0), at(y1, r1, i), at(y1, r1, i + 1), [0, 1, 0], hex);
}

function toGeometry(acc: Accum, withUv: boolean): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(acc.positions, 3));
  g.setAttribute('normal', new Float32BufferAttribute(acc.normals, 3));
  g.setAttribute('color', new Float32BufferAttribute(acc.colors, 3));
  if (withUv) g.setAttribute('uv', new Float32BufferAttribute(acc.uvs, 2));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

const triangleCount = (acc: Accum): number => acc.positions.length / 9;

// --- shared shapes --------------------------------------------------------------------------------------

/** A collider box the scene mounts through RegisteredCuboidCollider. `yawRad` is 0 for every
 * axis-aligned box; the roundhouse's arc chords carry a real yaw (local +X = tangential). */
export interface RailLandsCollider {
  readonly id: string;
  /** Owning building — the arbiter owner (`railLands:<owner>`), which is what sanctions a
   * building's own multi-box collider set against itself. */
  readonly owner: string;
  readonly cx: number;
  readonly cz: number;
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
  readonly yawRad: number;
}

export type SignCellId = 'aquariumFascia' | 'aquariumBlade' | 'steamWhistleFascia';

/** One camera-facing sign quad. `cell` names a rect in the rail-lands sign texture; `brand`
 * (mutually exclusive with it) names a shared logo-atlas cell instead. */
export interface RailLandsSign {
  readonly id: string;
  /** Phase 34's camera-visible face pin — the ONLY two values this field may ever take. */
  readonly face: 'south' | 'east';
  readonly position: readonly [number, number, number];
  /** 0 for a south (+Z) face, π/2 for an east (+X) face — the CROWN-decal convention. */
  readonly rotationY: number;
  readonly width: number;
  readonly height: number;
  readonly cell: SignCellId | null;
  readonly brand: LogoBrand | null;
}

/** A colliderless pack prop placed by this layer (the brewery patio's dressing). */
export interface RailLandsProp {
  readonly modelId: string;
  readonly position: readonly [number, number, number];
  readonly rotationY: number;
}

/** Patio string-lights: posts + a warm bulb line — placesLayer's PatioProp idiom. */
export interface RailLandsPatio {
  readonly posts: readonly { readonly x: number; readonly z: number }[];
  readonly postTopY: number;
  readonly strips: readonly { readonly minX: number; readonly maxX: number; readonly z: number; readonly y: number }[];
}

/** One flat painted rect on the ground stack (ballast bed / tie band / turntable bridge). */
export interface RailPaintRect {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly y: number;
  readonly color: string;
}

/** The turntable's painted deck: a disc at the ballast rung; the bridge stripe rides one rung up. */
export interface RailTurntable {
  readonly cx: number;
  readonly cz: number;
  readonly radius: number;
  readonly deckY: number;
  readonly stubInnerR: number;
  readonly stubOuterR: number;
  readonly stubAzimuths: readonly number[];
  readonly stubHalfAngle: number;
}

export interface RailPartMeta {
  readonly id: string;
  readonly triangles: number;
  /** Overall height (wu) — the eye-line law's subject. */
  readonly heightWu: number;
  readonly center: { readonly x: number; readonly z: number };
}

// --- the aquarium ------------------------------------------------------------------------------------------
// Ripley's is a two-storey faceted glass block quoting glacial forms, with a wave-form roof
// (researcher round 2026-07-27). At NAMED-class height it is ~5.2 wu tall, so what the player ever
// sees is the PLAN and the roof fold — hence an irregular 8-vertex footprint with a battered wall
// (no two wall planes parallel: the Phase 42 anti-coplanar rule applied at the source) and a folded
// ridge roof, rather than a box with a texture on it.

interface AquariumLayout {
  readonly center: { readonly x: number; readonly z: number };
  readonly height: number;
  /** Footprint outline (map XZ), wound so `(-dz, dx)` is the outward normal of every edge. Edge 0
   * (v0 → v1) is the flat, axis-aligned SOUTH entry facade — the one plane a +Z fascia can sit on. */
  readonly outline: readonly (readonly [number, number])[];
  readonly facade: { readonly z: number; readonly x0: number; readonly x1: number };
  readonly bladePylon: { readonly x: number; readonly z: number; readonly hx: number; readonly hz: number; readonly top: number };
  readonly span: { readonly hx: number; readonly hz: number };
}

const AQUARIUM_PLAN: readonly (readonly [number, number])[] = [
  [-0.62, 1], // south facade, west end
  [0.5, 1], // south facade, east end
  [1, 0.42],
  [0.86, -0.55],
  [0.34, -1],
  [-0.28, -0.78], // a notch in the north elevation — the "glacial" fold
  [-0.78, -1],
  [-1, 0.1],
];
/** Per-vertex roof height as a fraction of the building height — the wave's troughs and crests.
 * The spread is deliberately wide (0.6 → 1.05): at the fixed rig's 58° pitch the ROOF is the
 * largest surface of a 5 wu building on screen, so the fold is the whole read. */
const AQUARIUM_ROOF_WAVE: readonly number[] = [0.7, 0.88, 1.05, 0.92, 0.66, 0.84, 0.6, 0.76];
/** Wall batter: the top outline is this fraction of the base outline, about the centre. */
const AQUARIUM_BATTER = 0.94;
/** Wall band split (fractions of height): plinth / lit glazing / spandrel. */
const AQUARIUM_BANDS: readonly number[] = [0, 0.18, 0.72, 1];
/** Where the recessed entry sits along the south facade (fractions of its length) + its depth. */
const AQUARIUM_ENTRY = { from: 0.2, to: 0.78, insetWu: 0.7 } as const;

function outlineSpan(outline: readonly (readonly [number, number])[]): { readonly hx: number; readonly hz: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of outline) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { hx: (maxX - minX) / 2, hz: (maxZ - minZ) / 2 };
}

function aquariumLayout(): AquariumLayout {
  const spec = railSpec('aquarium-block');
  const center = rectCenter(railLandsLot('aquarium-block'));
  const height = namedHeight(spec.real_h_m);
  const hx = spec.footprint_wu / 2;
  const hz = hx / AQUARIUM_ASPECT;
  const outline = AQUARIUM_PLAN.map(([u, v]) => [center.x + u * hx, center.z + v * hz] as const);
  const facade = { z: center.z + hz, x0: outline[0][0], x1: outline[1][0] };
  return {
    center,
    height,
    outline,
    facade,
    // The blade/fin stands OFF the facade's east end, clear of the wall AND of the plan's SE
    // chamfer, so both of its camera-visible faces read (a fin flush to a wall only ever shows one).
    bladePylon: { x: facade.x1 + 3, z: facade.z - 0.8, hx: 0.55, hz: 0.55, top: height * 1.95 },
    span: outlineSpan(outline),
  };
}

function appendAquarium(acc: Accum, layout: AquariumLayout): RailPartMeta {
  const start = triangleCount(acc);
  const { center, height, outline, facade } = layout;
  const n = outline.length;
  const batter = (p: readonly [number, number], t: number): readonly [number, number] => {
    const k = 1 + (AQUARIUM_BATTER - 1) * t;
    return [center.x + (p[0] - center.x) * k, center.z + (p[1] - center.z) * k];
  };
  const bandColor = [GLASS_DARK, GLASS_LIT, GLASS_FILL];
  const outwardOf = (a: readonly [number, number], b: readonly [number, number]): Vec3 => {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    return [-dz / len, 0, dx / len];
  };

  /** One banded wall run between two plan points, optionally pushed IN by `inset` for the lower
   * bands (the entry recess) — the recess is real geometry, never an overlay quad. */
  const wallRun = (
    a: readonly [number, number],
    b: readonly [number, number],
    recessBands: number,
    inset: number,
  ): void => {
    const out = outwardOf(a, b);
    for (let k = 0; k + 1 < AQUARIUM_BANDS.length; k++) {
      const push = k < recessBands ? inset : 0;
      const t0 = AQUARIUM_BANDS[k];
      const t1 = AQUARIUM_BANDS[k + 1];
      const p = (q: readonly [number, number], t: number): Vec3 => {
        const s = batter(q, t);
        return [s[0] - out[0] * push, t * height, s[1] - out[2] * push];
      };
      addFace(acc, [p(a, t0), p(b, t0), p(b, t1), p(a, t1)], out, bandColor[k]);
    }
  };

  // The south entry facade, split into three runs so the middle one can recess.
  const lerp = (a: readonly [number, number], b: readonly [number, number], t: number): readonly [number, number] => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
  ];
  const v0 = outline[0];
  const v1 = outline[1];
  const eA = lerp(v0, v1, AQUARIUM_ENTRY.from);
  const eB = lerp(v0, v1, AQUARIUM_ENTRY.to);
  const RECESSED_BANDS = 2; // plinth + glazing recess; the spandrel stays on the wall plane
  wallRun(v0, eA, 0, 0);
  wallRun(eA, eB, RECESSED_BANDS, AQUARIUM_ENTRY.insetWu);
  wallRun(eB, v1, 0, 0);
  for (let i = 1; i < n; i++) wallRun(outline[i], outline[(i + 1) % n], 0, 0);

  // Entry jambs + soffit, closing the recess back to the wall plane.
  const facadeOut = outwardOf(v0, v1);
  const tE = AQUARIUM_BANDS[RECESSED_BANDS];
  const jamb = (p: readonly [number, number], inwardSign: number): void => {
    const s0 = batter(p, 0);
    const s1 = batter(p, tE);
    const q: [Vec3, Vec3, Vec3, Vec3] = [
      [s0[0], 0, s0[1]],
      [s0[0] - facadeOut[0] * AQUARIUM_ENTRY.insetWu, 0, s0[1] - facadeOut[2] * AQUARIUM_ENTRY.insetWu],
      [s1[0] - facadeOut[0] * AQUARIUM_ENTRY.insetWu, tE * height, s1[1] - facadeOut[2] * AQUARIUM_ENTRY.insetWu],
      [s1[0], tE * height, s1[1]],
    ];
    // The jamb faces ACROSS the opening: +X for the west jamb, −X for the east one.
    addFace(acc, q, [inwardSign, 0, 0], GLASS_DARK);
  };
  jamb(eA, 1);
  jamb(eB, -1);
  const sA = batter(eA, tE);
  const sB = batter(eB, tE);
  addFace(
    acc,
    [
      [sA[0], tE * height, sA[1]],
      [sB[0], tE * height, sB[1]],
      [sB[0] - facadeOut[0] * AQUARIUM_ENTRY.insetWu, tE * height, sB[1] - facadeOut[2] * AQUARIUM_ENTRY.insetWu],
      [sA[0] - facadeOut[0] * AQUARIUM_ENTRY.insetWu, tE * height, sA[1] - facadeOut[2] * AQUARIUM_ENTRY.insetWu],
    ],
    [0, -1, 0],
    GLASS_DARK,
  );

  // Wave roof: a folded RIDGE (two apex points) fanned to the battered top outline — 8 large
  // facets with a visible fold, not a cone and not a flat lid.
  const top = outline.map((p) => batter(p, 1));
  const ridgeW: Vec3 = [center.x - layout.span.hx * 0.34, height * 1.3, center.z - 0.8];
  const ridgeE: Vec3 = [center.x + layout.span.hx * 0.3, height * 1.12, center.z + 1.0];
  const ridgeOf = (p: readonly [number, number]): Vec3 => (p[0] > center.x ? ridgeE : ridgeW);
  for (let i = 0; i < n; i++) {
    const a = top[i];
    const b = top[(i + 1) % n];
    const av: Vec3 = [a[0], AQUARIUM_ROOF_WAVE[i] * height, a[1]];
    const bv: Vec3 = [b[0], AQUARIUM_ROOF_WAVE[(i + 1) % n] * height, b[1]];
    const ra = ridgeOf(a);
    const rb = ridgeOf(b);
    if (ra === rb) addTriFacing(acc, av, bv, ra, [0, 1, 0], ROOF_PALE);
    else addFace(acc, [av, bv, rb, ra], [0, 1, 0], ROOF_PALE);
  }

  // Entrance canopy — a thin slab over the recess, standing proud of the facade.
  const canopyC = lerp(v0, v1, (AQUARIUM_ENTRY.from + AQUARIUM_ENTRY.to) / 2);
  addBox(
    acc,
    canopyC[0],
    tE * height + 0.2,
    facade.z + 0.9,
    (Math.abs(eB[0] - eA[0]) / 2) * 1.06,
    0.2,
    1.5,
    ROOF_PALE,
  );

  // Blade-sign pylon (its two sign faces are emitted as sign quads, not baked here).
  const p = layout.bladePylon;
  addBox(acc, p.x, p.top / 2, p.z, p.hx, p.top / 2, p.hz, PYLON_GREY);

  return { id: 'aquarium-block', triangles: triangleCount(acc) - start, heightWu: p.top, center };
}

// --- the roundhouse ------------------------------------------------------------------------------------------
// The John Street Roundhouse: red brick, 1929–31, 32 locomotive bays around a ⌀37 m turntable, with
// Steam Whistle Brewing in the west wing. The real building is ~120 m across — four times the
// compacted lot — so the spec row stores a REDUCED-ARC homage (its `footprint_note` says so): a 150°
// arc of 12 bays around a proportionally-sized turntable, which is the READ, at the size the map has.
//
// ORIENTATION IS CAMERA LAW: the shed occupies the NW half of the circle so the bay doors face the
// SE boresight across the open apron. Azimuths use heroes.ts's convention — [sin az, cos az], az
// measured from +Z (map SOUTH) toward +X (map EAST) — so az 225° is NW and the open quadrant runs
// through az 45°, straight down the lens.

interface RoundhouseLayout {
  readonly center: { readonly x: number; readonly z: number };
  readonly height: number;
  readonly innerR: number;
  readonly outerR: number;
  readonly turntableR: number;
  readonly arcFrom: number;
  readonly arcTo: number;
  readonly bays: number;
  readonly annex: { readonly cx: number; readonly cz: number; readonly hx: number; readonly hz: number; readonly h: number };
}

const ROUNDHOUSE_BAYS = 12; // "10–14 visible bays" — the reduced-arc homage of the real 32
const ROUNDHOUSE_ARC_DEG = 150;
const ROUNDHOUSE_NW_AZIMUTH = (5 * Math.PI) / 4; // 225° — the arc's centre, away from the lens
/** Shed depth as a fraction of the outer radius (a bay must be deep enough to hold a locomotive). */
const ROUNDHOUSE_DEPTH_FRAC = 0.44;
/** Turntable radius as a fraction of the shed's inner radius — the apron the bays open onto. */
const ROUNDHOUSE_TURNTABLE_FRAC = 0.78;
/** Eaves (outer wall top) as a fraction of overall height; the roof rises inward from there. */
const ROUNDHOUSE_EAVES_FRAC = 0.66;
/** Clerestory monitor rise above the inner wall, as a fraction of overall height. */
const ROUNDHOUSE_CLERESTORY_FRAC = 0.18;
/** Radial depth (wu) of the clerestory monitor standing on the roof's inner edge. */
const ROUNDHOUSE_CLERESTORY_DEPTH_WU = 1.4;

function roundhouseLayout(): RoundhouseLayout {
  const spec = railSpec('roundhouse');
  const center = rectCenter(railLandsLot('roundhouse'));
  const height = namedHeight(spec.real_h_m);
  const outerR = spec.footprint_wu / 2; // the homage's overall diameter IS the spec footprint
  const innerR = outerR * (1 - ROUNDHOUSE_DEPTH_FRAC);
  const half = ((ROUNDHOUSE_ARC_DEG / 2) * Math.PI) / 180;
  return {
    center,
    height,
    innerR,
    outerR,
    turntableR: innerR * ROUNDHOUSE_TURNTABLE_FRAC,
    arcFrom: ROUNDHOUSE_NW_AZIMUTH - half,
    arcTo: ROUNDHOUSE_NW_AZIMUTH + half,
    bays: ROUNDHOUSE_BAYS,
    // The Steam Whistle annex, attached off the arc's EAST end and extending east so both of its
    // camera-visible faces (south + east) stand clear of the shed and can carry the fascia.
    annex: {
      cx: center.x + outerR * 1.2,
      cz: center.z - outerR * 0.72,
      hx: outerR * 0.34,
      hz: outerR * 0.38,
      h: height * 0.92,
    },
  };
}

function appendRoundhouse(acc: Accum, layout: RoundhouseLayout): RailPartMeta {
  const start = triangleCount(acc);
  const { center, height, innerR, outerR, arcFrom, arcTo, bays } = layout;
  const at = (r: number, az: number, y: number): Vec3 => [center.x + r * Math.sin(az), y, center.z + r * Math.cos(az)];
  const radial = (az: number, sign: number): Vec3 => [sign * Math.sin(az), 0, sign * Math.cos(az)];
  const tangent = (az: number, sign: number): Vec3 => [sign * Math.cos(az), 0, -sign * Math.sin(az)];
  const step = (arcTo - arcFrom) / bays;
  const eaves = height * ROUNDHOUSE_EAVES_FRAC;
  const plinth = height * 0.16;
  const doorTop = eaves * 0.86;
  const recess = 0.55;
  const clerY = height + height * ROUNDHOUSE_CLERESTORY_FRAC;
  const clerR = innerR + ROUNDHOUSE_CLERESTORY_DEPTH_WU;
  const roofYAt = (r: number): number => eaves + ((height - eaves) * (outerR - r)) / (outerR - innerR);

  for (let i = 0; i < bays; i++) {
    const a0 = arcFrom + i * step;
    const a1 = a0 + step;
    const mid = (a0 + a1) / 2;
    const outR = radial(mid, 1);
    const inR = radial(mid, -1);

    // Outer wall: plinth course + brick field (two planes, so the base reads as a course rather
    // than a painted stripe).
    addFace(acc, [at(outerR, a0, 0), at(outerR, a1, 0), at(outerR, a1, plinth), at(outerR, a0, plinth)], outR, BRICK_BASE);
    addFace(acc, [at(outerR, a0, plinth), at(outerR, a1, plinth), at(outerR, a1, eaves), at(outerR, a0, eaves)], outR, BRICK_FILL);

    // Inner face: two narrow piers + a header, framing a RECESSED bay door.
    const d0 = a0 + step * 0.12;
    const d1 = a1 - step * 0.12;
    const rBack = innerR + recess;
    addFace(acc, [at(innerR, d0, doorTop), at(innerR, d1, doorTop), at(innerR, d1, height), at(innerR, d0, height)], inR, BRICK_FILL);
    addFace(acc, [at(innerR, a0, 0), at(innerR, d0, 0), at(innerR, d0, height), at(innerR, a0, height)], inR, BRICK_FILL);
    addFace(acc, [at(innerR, d1, 0), at(innerR, a1, 0), at(innerR, a1, height), at(innerR, d1, height)], inR, BRICK_FILL);
    addFace(acc, [at(rBack, d0, 0), at(rBack, d1, 0), at(rBack, d1, doorTop), at(rBack, d0, doorTop)], inR, BRICK_DARK);
    addFace(acc, [at(innerR, d0, 0), at(rBack, d0, 0), at(rBack, d0, doorTop), at(innerR, d0, doorTop)], tangent(d0, 1), BRICK_DARK);
    addFace(acc, [at(innerR, d1, 0), at(rBack, d1, 0), at(rBack, d1, doorTop), at(innerR, d1, doorTop)], tangent(d1, -1), BRICK_DARK);
    addFace(acc, [at(innerR, d0, doorTop), at(rBack, d0, doorTop), at(rBack, d1, doorTop), at(innerR, d1, doorTop)], [0, -1, 0], BRICK_DARK);

    // Roof: eaves at the outer wall rising to the clerestory monitor's outer face.
    addFace(acc, [at(outerR, a0, eaves), at(outerR, a1, eaves), at(clerR, a1, roofYAt(clerR)), at(clerR, a0, roofYAt(clerR))], [0, 1, 0], ROOF_SLATE);
    // The clerestory monitor: outer shell, top, and the GLAZED inner face the camera actually sees.
    addFace(acc, [at(clerR, a0, roofYAt(clerR)), at(clerR, a1, roofYAt(clerR)), at(clerR, a1, clerY), at(clerR, a0, clerY)], outR, ROOF_SLATE);
    addFace(acc, [at(clerR, a0, clerY), at(clerR, a1, clerY), at(innerR, a1, clerY), at(innerR, a0, clerY)], [0, 1, 0], ROOF_SLATE);
    addFace(acc, [at(innerR, a0, height), at(innerR, a1, height), at(innerR, a1, clerY), at(innerR, a0, clerY)], inR, CLERESTORY);
  }

  // Radial end walls closing the arc at both ends.
  for (const [az, sign] of [[arcFrom, -1], [arcTo, 1]] as const) {
    addFace(
      acc,
      [at(innerR, az, 0), at(outerR, az, 0), at(outerR, az, eaves), at(innerR, az, height)],
      tangent(az, sign),
      BRICK_FILL,
    );
  }

  // The Steam Whistle annex: a squat brick block with a parapet band, carrying the fascia + decal.
  const an = layout.annex;
  addBox(acc, an.cx, an.h / 2, an.cz, an.hx, an.h / 2, an.hz, BRICK_FILL);
  addBox(acc, an.cx, an.h + 0.28, an.cz, an.hx + 0.22, 0.28, an.hz + 0.22, ANNEX_TRIM);

  return { id: 'roundhouse', triangles: triangleCount(acc) - start, heightWu: clerY, center };
}

// --- the locomotive ---------------------------------------------------------------------------------------------
// A CN 6213 homage: the 4-8-4 "Northern" read — leading truck, four big drivers, trailing truck, a
// separate tender — in black with a grey smokebox. NO wordmark, no livery marks (Part 11 rule 6's
// generic-form rule); the SHAPE is the reference, not the paint.
//
// It stands on the lead track running south out of the turntable, so it is oriented N–S: the camera
// sees its EAST flank and its SOUTH end, the two faces the fixed rig ever shows.

interface LocomotiveLayout {
  readonly center: { readonly x: number; readonly z: number };
  /** North end (the pilot, pointing at the turntable) and south end (the tender's tail). */
  readonly noseZ: number;
  readonly tailZ: number;
  readonly halfWidth: number;
  readonly height: number;
}

function locomotiveLayout(rh: RoundhouseLayout): LocomotiveLayout {
  const lot = railLandsLot('roundhouse');
  // Both ends derive from the turntable + the lot, never typed twice: nose one loco-length clear of
  // the apron, tail short of the lot's south edge.
  const noseZ = rh.center.z + rh.turntableR + 1.6;
  const tailZ = lot.maxY - 1.5;
  return { center: { x: rh.center.x, z: (noseZ + tailZ) / 2 }, noseZ, tailZ, halfWidth: 1.5, height: 4.2 };
}

function appendLocomotive(acc: Accum, layout: LocomotiveLayout): RailPartMeta {
  const start = triangleCount(acc);
  const { center, noseZ, tailZ, halfWidth } = layout;
  const cx = center.x;
  const railTop = 0.15;
  const total = tailZ - noseZ;
  // Every station is a FRACTION of the consist, so a lot resize rescales the loco instead of
  // sliding it off the track.
  const smokeboxZ0 = noseZ + total * 0.03;
  const smokeboxZ1 = noseZ + total * 0.17;
  const boilerZ1 = noseZ + total * 0.47;
  const cabZ1 = noseZ + total * 0.62;
  const tenderZ0 = noseZ + total * 0.66;
  const boilerR = 1.05;
  const boilerY = railTop + 1.75;

  // Running gear: four big drivers as hexagonal prisms across the full width (the flank read), and
  // the leading / trailing / tender trucks as low blocks.
  const driverR = 0.95;
  for (let i = 0; i < 4; i++) {
    const z = smokeboxZ1 + ((boilerZ1 - smokeboxZ1) * (i + 0.5)) / 4;
    addPrismX(acc, 6, cx - halfWidth * 0.92, cx + halfWidth * 0.92, railTop + driverR, z, driverR, LOCO_TRIM);
  }
  const truck = (z0: number, z1: number): void => {
    addBox(acc, cx, railTop + 0.5, (z0 + z1) / 2, halfWidth * 0.8, 0.5, (z1 - z0) / 2, LOCO_TRIM);
  };
  truck(noseZ + total * 0.04, smokeboxZ1 - 0.25); // leading truck
  truck(boilerZ1 + 0.1, cabZ1 - 0.15); // trailing truck
  truck(tenderZ0 + 0.4, tenderZ0 + total * 0.11); // tender front truck
  truck(tailZ - total * 0.11, tailZ - 0.4); // tender rear truck

  // Frame / running boards.
  addBox(acc, cx, railTop + 1.02, (noseZ + cabZ1) / 2, halfWidth * 0.98, 0.16, (cabZ1 - noseZ) / 2, LOCO_BLACK);

  // Boiler: tapered smokebox (grey) → parallel barrel (black); an 8-gon so the round reads.
  addPrismZ(acc, 8, smokeboxZ0, smokeboxZ1, cx, boilerY, boilerR * 0.94, boilerR, LOCO_SMOKEBOX, true);
  addPrismZ(acc, 8, smokeboxZ1, boilerZ1, cx, boilerY, boilerR, boilerR * 0.96, LOCO_BLACK);
  // Smokebox door ring, the stack, and one steam dome.
  addPrismZ(acc, 6, smokeboxZ0 - 0.16, smokeboxZ0, cx, boilerY, boilerR * 0.72, boilerR * 0.84, LOCO_TRIM, true);
  addPrismY(acc, 6, boilerY + boilerR - 0.1, boilerY + boilerR + 0.75, cx, smokeboxZ1 - 0.4, 0.34, 0.42, LOCO_BLACK);
  addBox(acc, cx, boilerY + boilerR + 0.2, (smokeboxZ1 + boilerZ1) / 2, 0.42, 0.3, 0.55, LOCO_BLACK);
  // Pilot (cowcatcher) — a wedge at the nose, both faces so it reads from the flank too.
  const pilotY = railTop + 1.0;
  addTriFacing(acc, [cx - halfWidth * 0.8, railTop, smokeboxZ0], [cx + halfWidth * 0.8, railTop, smokeboxZ0], [cx, pilotY, smokeboxZ0 - 0.55], [0, 0, -1], LOCO_BLACK);
  addTriFacing(acc, [cx - halfWidth * 0.8, railTop, smokeboxZ0], [cx + halfWidth * 0.8, railTop, smokeboxZ0], [cx, pilotY, smokeboxZ0], [0, 1, 0], LOCO_BLACK);

  // Cab: body, a lighter window band, and the roof overhang.
  const cabZ0 = boilerZ1;
  addBox(acc, cx, railTop + 1.55, (cabZ0 + cabZ1) / 2, halfWidth, 1.55, (cabZ1 - cabZ0) / 2, LOCO_BLACK);
  addBox(acc, cx, railTop + 2.35, (cabZ0 + cabZ1) / 2, halfWidth + 0.05, 0.42, (cabZ1 - cabZ0) / 2 - 0.28, LOCO_SMOKEBOX);
  addBox(acc, cx, railTop + 3.18, (cabZ0 + cabZ1) / 2 + 0.1, halfWidth + 0.2, 0.14, (cabZ1 - cabZ0) / 2 + 0.3, LOCO_TRIM);

  // Tender: body + a coal load stepped above the sides.
  addBox(acc, cx, railTop + 1.25, (tenderZ0 + tailZ) / 2, halfWidth, 1.25, (tailZ - tenderZ0) / 2, LOCO_BLACK);
  addBox(acc, cx, railTop + 2.58, (tenderZ0 + tailZ) / 2 + 0.2, halfWidth * 0.82, 0.14, (tailZ - tenderZ0) / 2 - 0.7, LOCO_COAL);

  return { id: 'locomotive', triangles: triangleCount(acc) - start, heightWu: railTop + 3.32, center };
}

// --- ground dressing: ballast beds, tie-banded track, the turntable ------------------------------------------
// THE THIN-GEOMETRY LAW (config/surfaces.ts): a real rail is ~0.15 wu wide, half the 0.3 wu floor,
// so rails CANNOT ship as literal geometry — they would strobe on every camera move (the exact class
// of defect Part 10 exists to kill, and the same verdict the law already records for P60's catenary).
// The track therefore reads the way it actually reads from 22 wu up: a ballast bed with regular TIE
// BANDS across it. Every rect below is width-checked by railLands.test.ts.

const BALLAST_BED_WIDTH_WU = 3.6;
const TIE_WIDTH_WU = 0.5;
const TIE_PITCH_WU = 3.5;
const TIE_HALF_LENGTH_WU = 1.2;
/** Bed centres as fractions of the strip's depth: two in the north yard, one hugging the south edge
 * (they move with the strip instead of being re-typed). Chosen to clear all four lots. */
const BED_DEPTH_FRACS: readonly number[] = [0.03, 0.1, 0.94];
/** Half-width (wu) of the turntable bridge girder — well over the thin-geometry floor. */
const TURNTABLE_BRIDGE_HALF_WU = 1.1;
/** Gap (wu) between the turntable deck's rim and the radial bay stubs — the pit edge, and the
 * clearance that keeps the stubs off the bridge girder's rung-mate footprint. */
const TURNTABLE_PIT_GAP_WU = 0.25;

function buildPaint(strip: MapRect, rh: RoundhouseLayout): {
  readonly paint: readonly RailPaintRect[];
  readonly turntable: RailTurntable;
} {
  const paint: RailPaintRect[] = [];
  const depth = strip.maxY - strip.minY;
  const bedHalf = BALLAST_BED_WIDTH_WU / 2;

  for (const frac of BED_DEPTH_FRACS) {
    const cz = strip.minY + depth * frac;
    paint.push({ minX: strip.minX, maxX: strip.maxX, minZ: cz - bedHalf, maxZ: cz + bedHalf, y: GROUND_STACK.railBallast, color: BALLAST });
    const count = Math.floor((strip.maxX - strip.minX) / TIE_PITCH_WU);
    for (let i = 0; i < count; i++) {
      const x = strip.minX + (i + 0.5) * TIE_PITCH_WU;
      paint.push({
        minX: x - TIE_WIDTH_WU / 2,
        maxX: x + TIE_WIDTH_WU / 2,
        minZ: cz - TIE_HALF_LENGTH_WU,
        maxZ: cz + TIE_HALF_LENGTH_WU,
        y: GROUND_STACK.railTrack,
        color: TIE,
      });
    }
  }

  // The lead track: turntable apron → the south bed, with the museum locomotive standing on it.
  const leadZ0 = rh.center.z + rh.turntableR;
  const leadZ1 = strip.minY + depth * BED_DEPTH_FRACS[BED_DEPTH_FRACS.length - 1] - bedHalf;
  paint.push({ minX: rh.center.x - bedHalf, maxX: rh.center.x + bedHalf, minZ: leadZ0, maxZ: leadZ1, y: GROUND_STACK.railBallast, color: BALLAST });
  const leadTies = Math.floor((leadZ1 - leadZ0) / TIE_PITCH_WU);
  for (let i = 0; i < leadTies; i++) {
    const z = leadZ0 + (i + 0.5) * TIE_PITCH_WU;
    paint.push({
      minX: rh.center.x - TIE_HALF_LENGTH_WU,
      maxX: rh.center.x + TIE_HALF_LENGTH_WU,
      minZ: z - TIE_WIDTH_WU / 2,
      maxZ: z + TIE_WIDTH_WU / 2,
      y: GROUND_STACK.railTrack,
      color: TIE,
    });
  }

  // The turntable bridge girder, parked N–S IN LINE with the lead track (which is how a turntable
  // actually sits between moves — the bridge is a piece of track). It rides one rung ABOVE the deck
  // disc it crosses (config/layering.ts's railTrack over railBallast); two coplanar discs is exactly
  // the z-fight Phase 39's ladder exists to prevent.
  paint.push({
    minX: rh.center.x - TURNTABLE_BRIDGE_HALF_WU,
    maxX: rh.center.x + TURNTABLE_BRIDGE_HALF_WU,
    minZ: rh.center.z - rh.turntableR,
    maxZ: rh.center.z + rh.turntableR,
    y: GROUND_STACK.railTrack,
    color: TURNTABLE_BRIDGE,
  });

  const arcStep = (rh.arcTo - rh.arcFrom) / rh.bays;
  const turntable: RailTurntable = {
    cx: rh.center.x,
    cz: rh.center.z,
    radius: rh.turntableR,
    deckY: GROUND_STACK.railBallast,
    // The stubs start just OUTSIDE the deck's rim (the pit's own edge gap), which also keeps them
    // strictly clear of the bridge girder they share the `railTrack` rung with.
    stubInnerR: rh.turntableR + TURNTABLE_PIT_GAP_WU,
    stubOuterR: rh.innerR,
    // Three bays across the arc, deliberately none of them near due-west (az 270°): a stub there
    // would run collinear with the bridge girder on the same rung.
    stubAzimuths: [2, 5, 7].map((bay) => rh.arcFrom + arcStep * (bay + 0.5)),
    stubHalfAngle: arcStep * 0.34,
  };
  return { paint, turntable };
}

// --- signs -------------------------------------------------------------------------------------------------------
// ONE small CanvasTexture, three cells. Mipmaps ON + NearestMipmapLinear minification is the Phase 41
// route-board lesson applied UP FRONT: these are pixel wordmarks that WILL be minified in play (a
// ~1 wu-tall band read from across the yard), and an unmipped minified pixel wordmark strobes. The
// MAG filter stays Nearest, so the near-range pixel-art look is untouched. (The texture itself is
// baked by the scene layer, which owns the canvas; the cell table + UV math stay pure and testable.)

/** Pixel rects inside the sign canvas, top-left origin (the canvas's own coordinate system). */
export const SIGN_ATLAS = {
  width: 128,
  height: 256,
  // Cell ASPECTS are load-bearing, not layout convenience: a fascia quad's height is derived from
  // its width × the cell aspect, and these are NAMED-class buildings only ~5 wu tall, so a squarer
  // cell would put the band through the roofline. 128×24 (aspect 0.1875) is the shape a legible
  // wordmark band takes on a two-storey facade.
  cells: {
    aquariumFascia: { x: 0, y: 0, w: 128, h: 24, text: 'AQUARIUM', vertical: false },
    steamWhistleFascia: { x: 0, y: 24, w: 128, h: 24, text: 'STEAM WHISTLE', vertical: false },
    aquariumBlade: { x: 0, y: 48, w: 32, h: 192, text: 'AQUARIUM', vertical: true },
  },
} as const satisfies {
  readonly width: number;
  readonly height: number;
  readonly cells: Readonly<Record<SignCellId, { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly text: string; readonly vertical: boolean }>>;
};

/**
 * UV rect for a sign cell. Same flipY convention as logoAtlas.logoCellUv: the canvas's top row maps
 * to v → 1, so a cell's pixel rect (measured from the top) inverts into v-space.
 */
export function signCellUv(cell: SignCellId): { u0: number; v0: number; u1: number; v1: number } {
  const c = SIGN_ATLAS.cells[cell];
  return {
    u0: c.x / SIGN_ATLAS.width,
    u1: (c.x + c.w) / SIGN_ATLAS.width,
    v0: 1 - (c.y + c.h) / SIGN_ATLAS.height,
    v1: 1 - c.y / SIGN_ATLAS.height,
  };
}

/** The Steam Whistle homage cell in the shared 32×32 logo atlas (added this phase). */
const STEAM_WHISTLE_BRAND: LogoBrand = 'steamwhistle';

function buildSigns(aq: AquariumLayout, rh: RoundhouseLayout): readonly RailLandsSign[] {
  const signs: RailLandsSign[] = [];
  const band = WALL_STACK.fasciaBand;
  const decalOff = WALL_STACK.crownDecal;
  const cellAspect = (cell: SignCellId): number => SIGN_ATLAS.cells[cell].h / SIGN_ATLAS.cells[cell].w;

  // AQUARIUM fascia — on the flat south entry facade, in the spandrel band above the entry.
  const facadeW = aq.facade.x1 - aq.facade.x0;
  const fasciaW = facadeW * 0.6;
  signs.push({
    id: 'aquarium-fascia-south',
    face: 'south',
    position: [(aq.facade.x0 + aq.facade.x1) / 2, aq.height * 0.74, aq.facade.z + band],
    rotationY: 0,
    width: fasciaW,
    height: fasciaW * cellAspect('aquariumFascia'),
    cell: 'aquariumFascia',
    brand: null,
  });

  // The blade/fin: one quad per camera-visible face of the pylon (the CROWN decal S+E convention).
  const p = aq.bladePylon;
  const bladeW = p.hx * 2.4;
  const bladeH = bladeW * cellAspect('aquariumBlade');
  const bladeY = p.top - bladeH / 2 - 0.5;
  signs.push(
    { id: 'aquarium-blade-south', face: 'south', position: [p.x, bladeY, p.z + p.hz + band], rotationY: 0, width: bladeW, height: bladeH, cell: 'aquariumBlade', brand: null },
    { id: 'aquarium-blade-east', face: 'east', position: [p.x + p.hx + band, bladeY, p.z], rotationY: Math.PI / 2, width: bladeW, height: bladeH, cell: 'aquariumBlade', brand: null },
  );

  // STEAM WHISTLE fascia + logo decal on the annex's two camera-visible faces.
  const an = rh.annex;
  const swW = an.hx * 1.15;
  const swH = swW * cellAspect('steamWhistleFascia');
  const swY = an.h * 0.62;
  const logo = Math.min(an.hx, an.hz) * 0.55;
  signs.push(
    { id: 'steamwhistle-fascia-south', face: 'south', position: [an.cx - an.hx * 0.3, swY, an.cz + an.hz + band], rotationY: 0, width: swW, height: swH, cell: 'steamWhistleFascia', brand: null },
    { id: 'steamwhistle-decal-south', face: 'south', position: [an.cx + an.hx * 0.6, swY, an.cz + an.hz + decalOff], rotationY: 0, width: logo, height: logo, cell: null, brand: STEAM_WHISTLE_BRAND },
    { id: 'steamwhistle-fascia-east', face: 'east', position: [an.cx + an.hx + band, swY, an.cz - an.hz * 0.28], rotationY: Math.PI / 2, width: swW, height: swH, cell: 'steamWhistleFascia', brand: null },
    { id: 'steamwhistle-decal-east', face: 'east', position: [an.cx + an.hx + decalOff, swY, an.cz + an.hz * 0.56], rotationY: Math.PI / 2, width: logo, height: logo, cell: null, brand: STEAM_WHISTLE_BRAND },
  );

  return signs;
}

// --- the brewery patio -----------------------------------------------------------------------------------------
// Steam Whistle's patio as a homage: procedural string-lights (placesLayer's PatioProp idiom — posts
// plus a warm bulb line) and a handful of city-pack props. Cosmetic and colliderless (the venue-prop
// precedent) — but the prop FOOTPRINTS claim, so nothing else ever lands on them.

function buildPatio(rh: RoundhouseLayout): { readonly patio: RailLandsPatio; readonly props: readonly RailLandsProp[] } {
  const an = rh.annex;
  // The apron south of the annex, east of the turntable deck (clear of it by construction).
  const cz = an.cz + an.hz + 6;
  const x0 = an.cx - an.hx * 0.85;
  const x1 = an.cx + an.hx * 1.05;
  const postTopY = 4.2;
  const patio: RailLandsPatio = {
    posts: [
      { x: x0, z: cz - 2.4 },
      { x: (x0 + x1) / 2, z: cz - 2.4 },
      { x: x1, z: cz - 2.4 },
      { x: x0, z: cz + 2.4 },
      { x: x1, z: cz + 2.4 },
    ],
    postTopY,
    strips: [
      { minX: x0, maxX: x1, z: cz - 2.4, y: postTopY - 0.25 },
      { minX: x0, maxX: x1, z: cz + 2.4, y: postTopY - 0.25 },
    ],
  };
  const props: readonly RailLandsProp[] = [
    { modelId: 'bench', position: [x0 + 1.4, 0, cz - 0.6], rotationY: 0 },
    { modelId: 'bench', position: [x1 - 1.4, 0, cz - 0.6], rotationY: 0 },
    { modelId: 'planter-bushes', position: [(x0 + x1) / 2, 0, cz + 1.9], rotationY: Math.PI / 2 },
    { modelId: 'flower-pot-a', position: [x0 - 0.6, 0, cz + 1.8], rotationY: 0 },
    { modelId: 'flower-pot-a', position: [x1 + 0.6, 0, cz - 2.0], rotationY: 0 },
  ];
  return { patio, props };
}

function appendPatioLights(acc: Accum, patio: RailLandsPatio): void {
  for (const p of patio.posts) addBox(acc, p.x, patio.postTopY / 2, p.z, 0.2, patio.postTopY / 2, 0.2, POST_WOOD);
  for (const s of patio.strips) addBox(acc, (s.minX + s.maxX) / 2, s.y, s.z, (s.maxX - s.minX) / 2, 0.09, 0.13, BULB_WARM);
}

// --- colliders ---------------------------------------------------------------------------------------------------

/** FOUR deep chords, not many shallow plates — the Part-11 drive-feel rule (a car must never be able
 * to wedge into a sliver gap between two thin arc segments). */
const ROUNDHOUSE_COLLIDER_CHORDS = 4;

function buildColliders(aq: AquariumLayout, rh: RoundhouseLayout, loco: LocomotiveLayout): readonly RailLandsCollider[] {
  const out: RailLandsCollider[] = [];

  // Aquarium: two axis-aligned cuboids under the faceted plan (west + east halves), sized off the
  // outline's own extent so a plan edit moves them with it.
  const hy = aq.height / 2;
  out.push(
    { id: 'aquarium-w', owner: 'aquarium-block', cx: aq.center.x - aq.span.hx * 0.5, cz: aq.center.z, hx: aq.span.hx * 0.5, hy, hz: aq.span.hz * 0.96, yawRad: 0 },
    { id: 'aquarium-e', owner: 'aquarium-block', cx: aq.center.x + aq.span.hx * 0.5, cz: aq.center.z, hx: aq.span.hx * 0.5, hy, hz: aq.span.hz * 0.9, yawRad: 0 },
  );

  // Roundhouse: four chord boxes spanning the arc's whole radial band, plus the annex. Local +X is
  // tangential and local +Z radial; a yaw of `az` maps them onto the chord exactly.
  const chordStep = (rh.arcTo - rh.arcFrom) / ROUNDHOUSE_COLLIDER_CHORDS;
  const rMid = (rh.innerR + rh.outerR) / 2;
  const radialHalf = (rh.outerR - rh.innerR) / 2;
  for (let i = 0; i < ROUNDHOUSE_COLLIDER_CHORDS; i++) {
    const az = rh.arcFrom + chordStep * (i + 0.5);
    out.push({
      id: `roundhouse-chord-${i}`,
      owner: 'roundhouse',
      cx: rh.center.x + rMid * Math.sin(az),
      cz: rh.center.z + rMid * Math.cos(az),
      hx: rMid * Math.sin(chordStep / 2) * 1.12, // 12% overlap between neighbours — solid seams
      hy: rh.height / 2,
      hz: radialHalf,
      yawRad: az,
    });
  }
  const an = rh.annex;
  out.push({ id: 'roundhouse-annex', owner: 'roundhouse', cx: an.cx, cz: an.cz, hx: an.hx, hy: an.h / 2, hz: an.hz, yawRad: 0 });

  // Locomotive: one cuboid over the whole consist.
  out.push({
    id: 'locomotive',
    owner: 'locomotive',
    cx: loco.center.x,
    cz: loco.center.z,
    hx: loco.halfWidth,
    hy: loco.height / 2,
    hz: (loco.tailZ - loco.noseZ) / 2,
    yawRad: 0,
  });

  return out;
}

// --- the layout (pure data — what the arbiter and the scene both read) -----------------------------------------

/** The whole layer's placement data. PURE DATA (no three objects), so worldContext can carry it in
 * the seed-independent prefix without dragging geometry into the composition root. */
export interface RailLandsLayout {
  readonly lots: readonly MapRect[];
  readonly strip: MapRect;
  readonly aquarium: AquariumLayout;
  readonly roundhouse: RoundhouseLayout;
  readonly locomotive: LocomotiveLayout;
  readonly colliders: readonly RailLandsCollider[];
  readonly signs: readonly RailLandsSign[];
  readonly props: readonly RailLandsProp[];
  readonly patio: RailLandsPatio;
  readonly paint: readonly RailPaintRect[];
  readonly turntable: RailTurntable;
}

let cachedLayout: RailLandsLayout | null = null;

/**
 * Build the whole rail-lands placement layout. Deterministic and seed-independent (every input is a
 * pure function of the street table + the spec rows); memoized because worldContext builds the
 * prefix on every composition.
 */
export function buildRailLandsLayout(streets?: readonly Street[]): RailLandsLayout {
  if (streets === undefined && cachedLayout !== null) return cachedLayout;
  const strip = railLandsStrip(streets ?? buildStreets().streets);
  const aquarium = aquariumLayout();
  const roundhouse = roundhouseLayout();
  const locomotive = locomotiveLayout(roundhouse);
  const { patio, props } = buildPatio(roundhouse);
  const { paint, turntable } = buildPaint(strip, roundhouse);
  const layout: RailLandsLayout = {
    lots: RAIL_LANDS_LOTS,
    strip,
    aquarium,
    roundhouse,
    locomotive,
    colliders: buildColliders(aquarium, roundhouse, locomotive),
    signs: buildSigns(aquarium, roundhouse),
    props,
    patio,
    paint,
    turntable,
  };
  if (streets === undefined) cachedLayout = layout;
  return layout;
}

/** Test seam: drop the memo so a suite can rebuild from scratch (determinism checks). */
export function resetRailLandsLayoutCache(): void {
  cachedLayout = null;
}

// --- geometry builders (consumed by the scene layer; individually tri-budgeted) ---------------------------------

export interface RailLandsPart {
  readonly geometry: BufferGeometry;
  readonly meta: RailPartMeta;
}

export function buildAquariumGeometry(layout: RailLandsLayout = buildRailLandsLayout()): RailLandsPart {
  const acc = createAccum();
  const meta = appendAquarium(acc, layout.aquarium);
  return { geometry: toGeometry(acc, false), meta };
}

export function buildRoundhouseGeometry(layout: RailLandsLayout = buildRailLandsLayout()): RailLandsPart {
  const acc = createAccum();
  const meta = appendRoundhouse(acc, layout.roundhouse);
  return { geometry: toGeometry(acc, false), meta };
}

export function buildLocomotiveGeometry(layout: RailLandsLayout = buildRailLandsLayout()): RailLandsPart {
  const acc = createAccum();
  const meta = appendLocomotive(acc, layout.locomotive);
  return { geometry: toGeometry(acc, false), meta };
}

export interface RailLandsSolids {
  readonly geometry: BufferGeometry;
  readonly triangles: number;
  readonly parts: readonly RailPartMeta[];
}

/**
 * Every solid in the rail lands as ONE merged vertex-coloured geometry — the aquarium, the
 * roundhouse, the locomotive and the patio string-lights all share the same unlit-literal material,
 * so merging them is free and saves three draw calls.
 */
export function buildRailLandsSolids(layout: RailLandsLayout = buildRailLandsLayout()): RailLandsSolids {
  const acc = createAccum();
  const parts = [
    appendAquarium(acc, layout.aquarium),
    appendRoundhouse(acc, layout.roundhouse),
    appendLocomotive(acc, layout.locomotive),
  ];
  appendPatioLights(acc, layout.patio);
  return { geometry: toGeometry(acc, false), triangles: triangleCount(acc), parts };
}

/** Ballast beds, tie bands, the turntable deck/bridge and the radial bay stubs — one flat mesh. */
export function buildRailLandsPaint(layout: RailLandsLayout = buildRailLandsLayout()): {
  readonly geometry: BufferGeometry;
  readonly triangles: number;
} {
  const acc = createAccum();
  const t = layout.turntable;
  const DISC_SEGMENTS = 24;
  for (let i = 0; i < DISC_SEGMENTS; i++) {
    const a0 = (i * Math.PI * 2) / DISC_SEGMENTS;
    const a1 = ((i + 1) * Math.PI * 2) / DISC_SEGMENTS;
    addTriFacing(
      acc,
      [t.cx, t.deckY, t.cz],
      [t.cx + t.radius * Math.sin(a0), t.deckY, t.cz + t.radius * Math.cos(a0)],
      [t.cx + t.radius * Math.sin(a1), t.deckY, t.cz + t.radius * Math.cos(a1)],
      [0, 1, 0],
      TURNTABLE_DECK,
    );
  }
  for (const az of t.stubAzimuths) {
    const a0 = az - t.stubHalfAngle;
    const a1 = az + t.stubHalfAngle;
    const p = (r: number, a: number): Vec3 => [t.cx + r * Math.sin(a), GROUND_STACK.railTrack, t.cz + r * Math.cos(a)];
    addFace(acc, [p(t.stubInnerR, a0), p(t.stubOuterR, a0), p(t.stubOuterR, a1), p(t.stubInnerR, a1)], [0, 1, 0], TIE);
  }
  for (const r of layout.paint) {
    addFace(
      acc,
      [
        [r.minX, r.y, r.minZ],
        [r.minX, r.y, r.maxZ],
        [r.maxX, r.y, r.maxZ],
        [r.maxX, r.y, r.minZ],
      ],
      [0, 1, 0],
      r.color,
    );
  }
  return { geometry: toGeometry(acc, false), triangles: triangleCount(acc) };
}

/** One sign quad, in the world, on its pinned camera-visible face. */
function addSignQuad(acc: Accum, s: RailLandsSign, uv: { u0: number; v0: number; u1: number; v1: number }): void {
  const [cx, cy, cz] = s.position;
  const hw = s.width / 2;
  const hh = s.height / 2;
  // south (+Z, rotationY 0): the quad spans X. east (+X, rotationY π/2): it spans Z, and the sign
  // must read left-to-right for a camera standing to its EAST, hence the reversed Z ordering.
  const dx = s.face === 'south' ? hw : 0;
  const dz = s.face === 'south' ? 0 : hw;
  const out: Vec3 = s.face === 'south' ? [0, 0, 1] : [1, 0, 0];
  const q: [Vec3, Vec3, Vec3, Vec3] = [
    [cx - dx, cy - hh, cz + dz],
    [cx + dx, cy - hh, cz - dz],
    [cx + dx, cy + hh, cz - dz],
    [cx - dx, cy + hh, cz + dz],
  ];
  const [nx, ny, nz] = faceNormal(q[0], q[1], q[2]);
  const uvs: readonly Uv[] = [
    [uv.u0, uv.v0],
    [uv.u1, uv.v0],
    [uv.u1, uv.v1],
    [uv.u0, uv.v1],
  ];
  if (nx * out[0] + ny * out[1] + nz * out[2] >= 0) {
    addQuad(acc, q, '#ffffff', { unshaded: true, uv: uvs });
  } else {
    addQuad(acc, [q[3], q[2], q[1], q[0]], '#ffffff', { unshaded: true, uv: [uvs[3], uvs[2], uvs[1], uvs[0]] });
  }
}

/** The text sign quads (rail-lands sign texture) as one merged geometry with UVs. */
export function buildRailLandsSignGeometry(layout: RailLandsLayout = buildRailLandsLayout()): {
  readonly geometry: BufferGeometry;
  readonly count: number;
} {
  const acc = createAccum();
  let count = 0;
  for (const s of layout.signs) {
    if (s.cell === null) continue;
    addSignQuad(acc, s, signCellUv(s.cell));
    count++;
  }
  return { geometry: toGeometry(acc, true), count };
}

/** The logo-atlas decal quads (Steam Whistle) as one merged geometry with shared-atlas UVs. */
export function buildRailLandsDecalGeometry(layout: RailLandsLayout = buildRailLandsLayout()): {
  readonly geometry: BufferGeometry;
  readonly count: number;
} {
  const acc = createAccum();
  let count = 0;
  for (const s of layout.signs) {
    if (s.brand === null) continue;
    addSignQuad(acc, s, logoCellUv(s.brand));
    count++;
  }
  return { geometry: toGeometry(acc, true), count };
}

// --- law helpers (consumed by the tests) -----------------------------------------------------------------------

/** Every painted rect's narrow dimension — the THIN_GEOMETRY law's subject. */
export function paintStripeWidths(layout: RailLandsLayout = buildRailLandsLayout()): readonly number[] {
  return layout.paint.map((r) => Math.min(r.maxX - r.minX, r.maxZ - r.minZ));
}

/** The thin-geometry floor this module's painted bands are held to. */
export const RAIL_PAINT_MIN_WIDTH_WU = THIN_GEOMETRY.minStripeWidthWu;
