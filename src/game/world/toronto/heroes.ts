// Toronto map v2 — hero primitive meshes (TORONTO-MAP-SPEC-v2.md §5, Addendum A.3/A.5;
// phase-25-plan Task 1). The CN Tower and Rogers Centre, hand-built from primitives per the
// spec's own decision ("hand-build from primitives; use CC models as proportion reference only")
// — Sketchfab CC meshes are 42k–87k tris and clash with the flat/vertex-coloured box aesthetic
// by two orders of magnitude, so primitives ARE the right look, not a compromise.
//
// SINGLE SOURCE OF TRUTH: total heights come from data/toronto/building-specs.json via
// hGame(real_h_m) — the same rule namedBuildings.ts follows. Nothing here hardcodes a height or a
// footprint; the §5 proportion fractions (0.62/0.81·h pod centres, top-12% needle, 0.22·h legs,
// ⌀66 dome) are the only literals, and each is asserted by heroes.test.ts against the band the
// spec names.
//
// PHASE 43 (Part 11) — CN Tower v2. The v1 mesh was a generic 266-tri hex taper: it read as "a
// tower", not as THE tower. v2 rebuilds it around the four features that actually make the
// silhouette recognizable, all researcher-verified 2026-07-27:
//   • an arched base — three legs at 120° splaying to the ⌀21 footprint, with the PARABOLIC ARCH
//     negative space between them (its soffit modelled, because at the §5.3 camera's pitch the
//     underside is what you actually see from the street);
//   • legs that merge into the closed shaft at ~0.22·h (the real ones close at 100–150 m; v1's
//     "bottom 8%" was wrong — spec §5's fraction is superseded, addendum recorded in the notes);
//   • a FLUTED shaft: hexagonal core plus three thin fin ribs that are the legs' own continuation,
//     running the full shaft and narrowing as they rise (Phase 44 lights those crest ridges, so
//     each rib's crest is one coherent strip, never fragmented);
//   • real pod massing — flared mushroom underside, white radome, dark glass band with the
//     glass-floor line, and a RECESSED mechanical channel that holds the LED ring.
// Tri budget rises 600 → 2,500 deliberately (overview tri-budget addendum, Part 11 rule 2).
//
// Orientation is camera law, not taste: the fixed rig always looks NW from the SE, so ONE leg
// points exactly NW and the gap between the other two centres on the SE diagonal — the arch void
// faces the camera in every street-level and drive-past frame.
//
// UNLIT-LITERAL, like every other Toronto surface (the P23/P24 "material verdict": a grazing
// blue-hour sun crushes lit boxes to black, so the authored colour IS the on-screen colour). To
// keep a single flat-coloured mesh from reading as a silhouette we BAKE a cheap directional shade
// into the vertex colours per face (facets facing the light read brighter) — the classic low-poly
// trick — while the EMISSIVE pod ring keeps its full brightness (bright red/white texels ARE the
// LED ring on an unlit slice, the same trick the window textures use). One merged non-indexed
// BufferGeometry per hero → one draw call each; triangle count = position.count / 3 (test-pinned).
//
// PHASE 44 (Part 11) — the NIGHT PROGRAM's spatial half. The tower's light show is not new
// geometry and not new draw calls: every surface the program can light already exists, so this
// module only has to TAG it. Two extra float attributes ride along with position/normal/color:
//   • `aProgram` — which program element a vertex belongs to (CN_PROGRAM below: RING / BEACON /
//     CREST / FLOOD, or STATIC for everything else);
//   • `aProgramT` — that element's parametric coordinate (LED cell fraction around the ring,
//     height fraction up a fin crest, wash strength up from the ground).
// The fragment patch (world/toronto/cnNightMaterial.ts) does ONLY the spatial mapping off those
// two; all timing/intensity logic is CPU-side pure functions (world/toronto/cnNightProgram.ts)
// handed over as uniforms. Consequence: the whole show is +0 draw calls, +0 lights, +0 bodies, and
// freeze-aware by construction (the caller passes simNowMs()).
// The LED channel's BASE colour changed here at the same time: v1 baked bright red/white texels
// into the ring (colour-as-light on the unlit slice). With a real program driving it, a baked
// bright ring would be light that no palette/mode/blackout could ever turn off — so the channel is
// now baked as its dark housing (#2a2e33) and every photon comes from the program.
//
// Pure geometry: three's BufferGeometry/Color are pure JS (no WebGL), so this whole module runs
// in the vitest/jsdom env and its tri budgets + proportions are unit-testable without a canvas.

import { BufferGeometry, Color, Float32BufferAttribute } from 'three';
import buildingSpecsJson from '../../../../data/toronto/building-specs.json';
import { hGame } from './heightCurve';

/**
 * A.3 tri budgets — exported so the test and any future perf audit share one source.
 * CN's rises 600 → 2,500 at Phase 43 (the overview's tri-budget addendum: budgets in Parts 11–12
 * rise DELIBERATELY and get re-pinned, never silently). The actual mesh lands well under it —
 * the headroom is Phase 44's (night program) and the segment counts below are the knob.
 */
export const CN_TOWER_MAX_TRIS = 2500 as const;
export const ROGERS_MAX_TRIS = 500 as const;

interface HeroSpecRow {
  readonly id: string;
  readonly real_h_m: number;
  readonly footprint_wu: number;
  readonly dome_diameter_wu?: number;
}
const SPECS = buildingSpecsJson.buildings as readonly HeroSpecRow[];
function heroSpec(id: string): HeroSpecRow {
  const s = SPECS.find((b) => b.id === id);
  if (!s) throw new Error(`heroes: building-specs.json has no building "${id}"`);
  return s;
}

// --- palette (unlit-literal; blue-hour-legible greys + glassy pods + the LED ring) -----------
// CN concrete is SLIPFORMED WEATHERED GREY — cool, never beige (researcher round 2026-07-27).
const CONCRETE = '#8b9098'; // core shaft / needle / skirt
const RIB_CONCRETE = '#99a0a8'; // the three fins: a shade lighter so the flutes read at distance
const SOFFIT_CONCRETE = '#767b83'; // arch underside — darker, so the void reads as depth
const GLASS_POD = '#8098ad'; // SkyPod glass
const GLASS_DARK = '#4a5560'; // main pod's tinted observation band
const GLASS_FLOOR = '#8fa3b4'; // the one lighter strip inside it = the glass-floor level
const RADOME_WHITE = '#e8e6e2'; // pod's lower radome band
const POD_CREAM = '#d8d4c9'; // cream tier bands between pod levels
const MECH_GREY = '#7d838c'; // upper mechanical ring (the LED channel's housing)
const RING_CHANNEL = '#2a2e33'; // Phase 44: the LED channel's HOUSING — dark. The light is the program.
const BEACON_RED = '#ff5a4a'; // aircraft-beacon housings (needle stub + pod-corner strobes)
const ROGERS_RING = '#9aa0ab'; // stadium outer ring base (grey precast)
// Four nested roof-panel greys (visible seams between adjacent bands, §5) + the retractable panel.
const DOME_BANDS = ['#c6c6cc', '#b6b6be', '#a6a6b0', '#9a9aa4'] as const;
const DOME_PANEL = '#7f8894'; // the one sliding-section band-slice, a distinct darker grey

// Baked directional light — a fixed dusk key over +x / up / +z (roughly the §5.3 camera bearing),
// so the facets the camera sees catch the most light. shade ∈ [SHADE_MIN, 1].
const LIGHT: readonly [number, number, number] = (() => {
  const [x, y, z] = [0.45, 1, 0.5];
  const len = Math.hypot(x, y, z);
  return [x / len, y / len, z / len];
})();
const SHADE_MIN = 0.5;
function shadeFor(nx: number, ny: number, nz: number): number {
  const d = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
  return SHADE_MIN + (1 - SHADE_MIN) * d;
}

// --- Phase 44 night-program element ids (the `aProgram` attribute's alphabet) -----------------
/**
 * WHICH light the fragment patch adds to a surface. One float per vertex; the shader branches on
 * it with 0.5-wide windows, so the ids must stay small consecutive integers.
 *
 * STATIC is the default for EVERY existing call site (Rogers included), which is why adding the
 * tags changed no other geometry: an untagged vertex carries (0, 0) and the patch adds nothing.
 */
export const CN_PROGRAM = {
  /** Unlit by the program — plain baked vertex colour. */
  STATIC: 0,
  /** The recessed pod LED channel. `aProgramT` = that LED cell's centre fraction around the ring. */
  RING: 1,
  /** Aircraft-warning beacons: the needle-tip stub + the four pod-corner strobe fixtures. */
  BEACON: 2,
  /** Fin crest chamfers + ridge (the real tower's light bars run up the elevator shafts INSIDE
   *  these fins — researcher round 2026-07-27). `aProgramT` = height fraction 0→1 to the fin top. */
  CREST: 3,
  /** Base floodwash receivers (skirt / soffit / trunk / fin flanks). `aProgramT` = wash strength,
   *  1 at the ground → 0 at the leg merge, so the gradient is baked, not computed per frame. */
  FLOOD: 4,
} as const;
export type CnProgramId = (typeof CN_PROGRAM)[keyof typeof CN_PROGRAM];

// --- geometry accumulator (non-indexed, flat-shaded, per-vertex colour) ----------------------
type Vec3 = readonly [number, number, number];

/**
 * A night-program tag for a face. `t` is either a constant for the whole face (LED cells are flat
 * by design — see the ring band) or a per-vertex function of position (crest height, flood wash).
 */
interface ProgramTag {
  readonly id: number;
  readonly t: number | ((p: Vec3) => number);
}
const STATIC_TAG: ProgramTag = { id: CN_PROGRAM.STATIC, t: 0 };
/** Per-segment tag resolver (the ring needs one tag per LED cell). */
type ProgramSpec = ProgramTag | ((segment: number, sides: number) => ProgramTag);
const resolveProgram = (spec: ProgramSpec | undefined, segment: number, sides: number): ProgramTag =>
  spec === undefined ? STATIC_TAG : typeof spec === 'function' ? spec(segment, sides) : spec;

interface Accum {
  readonly positions: number[];
  readonly normals: number[];
  readonly colors: number[];
  /** Phase 44: per-vertex night-program element id (CN_PROGRAM). */
  readonly programs: number[];
  /** Phase 44: per-vertex parametric coordinate within that element. */
  readonly programTs: number[];
}
const createAccum = (): Accum => ({ positions: [], normals: [], colors: [], programs: [], programTs: [] });

const scratchColor = new Color();
/** sRGB hex → linear rgb (three's ColorManagement path — matches the roads' vertexColors look). */
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

/** One flat triangle: normal from winding, colour = base × baked shade (or full-bright emissive). */
function addTri(
  acc: Accum,
  a: Vec3,
  b: Vec3,
  c: Vec3,
  hex: string,
  emissive = false,
  program: ProgramTag = STATIC_TAG,
): void {
  const [nx, ny, nz] = faceNormal(a, b, c);
  const [r, g, bl] = linearRgb(hex);
  const s = emissive ? 1 : shadeFor(nx, ny, nz);
  const constT = typeof program.t === 'number' ? program.t : null;
  for (const p of [a, b, c]) {
    acc.positions.push(p[0], p[1], p[2]);
    acc.normals.push(nx, ny, nz);
    acc.colors.push(r * s, g * s, bl * s);
    acc.programs.push(program.id);
    acc.programTs.push(constT ?? (program.t as (q: Vec3) => number)(p));
  }
}

/** Quad (0,1,2)+(0,2,3), wound CCW as seen from outside so the baked normal points outward. */
function addQuad(
  acc: Accum,
  corners: readonly [Vec3, Vec3, Vec3, Vec3],
  hex: string,
  emissive = false,
  program: ProgramTag = STATIC_TAG,
): void {
  addTri(acc, corners[0], corners[1], corners[2], hex, emissive, program);
  addTri(acc, corners[0], corners[2], corners[3], hex, emissive, program);
}

/**
 * A quad whose winding is CORRECTED to face `outward` — the one place in this file that doesn't
 * hand-wind. The pod-corner beacon fixtures (Phase 44) are little boxes in a rotated radial frame
 * where hand-winding six faces is exactly the kind of sign error that ships an invisible
 * (back-face-culled) fixture; a runtime dot against the intended outward normal is deterministic,
 * costs nothing at build time, and makes the fixture's orientation un-get-wrong-able.
 */
function addQuadOriented(
  acc: Accum,
  corners: readonly [Vec3, Vec3, Vec3, Vec3],
  outward: Vec3,
  hex: string,
  program: ProgramTag = STATIC_TAG,
): void {
  const [nx, ny, nz] = faceNormal(corners[0], corners[1], corners[2]);
  const facing = nx * outward[0] + ny * outward[1] + nz * outward[2];
  if (facing >= 0) addQuad(acc, corners, hex, false, program);
  else addQuad(acc, [corners[3], corners[2], corners[1], corners[0]], hex, false, program);
}

interface RingOpts {
  readonly capBottom?: boolean;
  readonly capTop?: boolean;
  readonly emissive?: boolean;
  /** Per-segment colour override (LED ring alternation, sliding-panel slice). */
  readonly colorAt?: (segment: number, sides: number) => string;
  /**
   * Azimuth of vertex 0 (radians). Phase 43: the CN hex core is rolled so that a FACET (not a
   * corner) is centred on each of the three rib azimuths — the ribs then protrude at plane angles
   * distinct from every core facet, which is the anti-z-fight rule from Phase 42. Default 0 keeps
   * every pre-existing caller (Rogers) bit-for-bit unchanged: `i * step + 0 === i * step`.
   */
  readonly angleOffset?: number;
  /** Phase 44 night-program tag — one for the whole ring, or one per segment (the LED cells). */
  readonly program?: ProgramSpec;
}

/**
 * An N-gon prism / frustum / cone centred on the Y axis (`baseRadius`→`topRadius` from `y0`→`y1`).
 * topRadius === 0 gives a cone apex (single tri per side, no degenerate quad). Caps optional.
 */
function addPrismFrustum(
  acc: Accum,
  sides: number,
  y0: number,
  y1: number,
  baseRadius: number,
  topRadius: number,
  hex: string,
  opts: RingOpts = {},
): void {
  const step = (Math.PI * 2) / sides;
  const offset = opts.angleOffset ?? 0;
  const ring = (radius: number, y: number, i: number): Vec3 => {
    const ang = i * step + offset;
    return [radius * Math.sin(ang), y, radius * Math.cos(ang)];
  };
  const colorOf = (i: number): string => opts.colorAt?.(i, sides) ?? hex;
  const programOf = (i: number): ProgramTag => resolveProgram(opts.program, i, sides);
  for (let i = 0; i < sides; i++) {
    const b0 = ring(baseRadius, y0, i);
    const b1 = ring(baseRadius, y0, i + 1);
    const t1 = ring(topRadius, y1, i + 1);
    const t0 = ring(topRadius, y1, i);
    if (topRadius === 0) {
      addTri(acc, b0, b1, [0, y1, 0], colorOf(i), opts.emissive, programOf(i));
    } else if (baseRadius === 0) {
      addTri(acc, [0, y0, 0], t1, t0, colorOf(i), opts.emissive, programOf(i));
    } else {
      addQuad(acc, [b0, b1, t1, t0], colorOf(i), opts.emissive, programOf(i));
    }
  }
  if (opts.capBottom && baseRadius > 0) {
    const c: Vec3 = [0, y0, 0];
    for (let i = 0; i < sides; i++)
      addTri(acc, c, ring(baseRadius, y0, i + 1), ring(baseRadius, y0, i), hex, opts.emissive, programOf(i));
  }
  if (opts.capTop && topRadius > 0) {
    const c: Vec3 = [0, y1, 0];
    for (let i = 0; i < sides; i++)
      addTri(acc, c, ring(topRadius, y1, i), ring(topRadius, y1, i + 1), hex, opts.emissive, programOf(i));
  }
}

/**
 * One band of a lathed profile: the frustum from (y0, r0) to (y1, r1). y0 === y1 with r0 ≠ r1 is a
 * legal, useful band — a flat annulus (an in/out STEP), which is how the pod's recessed LED
 * channel gets its lips and the needle gets its stepped taper. Winding is addPrismFrustum's, so
 * an inward step faces up and an outward step faces down, both correct without special-casing.
 */
interface LatheBand {
  readonly y0: number;
  readonly r0: number;
  readonly y1: number;
  readonly r1: number;
  readonly hex: string;
  readonly emissive?: boolean;
  readonly colorAt?: (segment: number, sides: number) => string;
  readonly capBottom?: boolean;
  readonly capTop?: boolean;
  /** Phase 44 night-program tag for this band (see RingOpts.program). */
  readonly program?: ProgramSpec;
}

/** Lathe a whole profile in one call. Consecutive bands share their edge ring exactly (each band's
 * (y1, r1) is the next's (y0, r0)), so the surface is closed — no cracks, no coplanar overlaps. */
function addLathe(acc: Accum, sides: number, bands: readonly LatheBand[], angleOffset = 0): void {
  for (const b of bands) {
    addPrismFrustum(acc, sides, b.y0, b.y1, b.r0, b.r1, b.hex, {
      emissive: b.emissive,
      colorAt: b.colorAt,
      capBottom: b.capBottom,
      capTop: b.capTop,
      angleOffset,
      program: b.program,
    });
  }
}

/** One cross-section of a swept fin, in the fin's own (radial, lateral) frame at height y. */
interface FinSection {
  readonly y: number;
  /** Ridge point — the crest's outermost edge; this is the strip Phase 44 lights. */
  readonly apexR: number;
  /** Shoulder radius + half-width where the crest chamfer meets the flanks. */
  readonly crestR: number;
  readonly crestHalfW: number;
  /** Root radius + half-width — kept strictly INSIDE the core so the fin has no visible base seam. */
  readonly rootR: number;
  readonly rootHalfW: number;
}

/**
 * Sweep a 5-point fin section (root-left → crest-left → ridge → crest-right → root-right) up a
 * list of sections: four exposed faces per span (two flanks + two crest chamfers meeting at the
 * ridge). This is ONE volume for the whole leg-and-rib run — the leg IS the rib's lower half, so
 * there is no junction to hide and the ridge is a single unbroken strip from the ground to the pod.
 */
function addSweptFin(
  acc: Accum,
  azimuth: number,
  sections: readonly FinSection[],
  hex: string,
  crestProgram: ProgramTag = STATIC_TAG,
  flankProgram: ProgramTag = STATIC_TAG,
): void {
  const ux = Math.sin(azimuth);
  const uz = Math.cos(azimuth);
  const tx = uz; // tangential = radial rotated −90° (u × t = +Y, so section order below is CW → −Y)
  const tz = -ux;
  const at = (radial: number, lateral: number, y: number): Vec3 => [
    ux * radial + tx * lateral,
    y,
    uz * radial + tz * lateral,
  ];
  const rings = sections.map((s): Vec3[] => [
    at(s.rootR, s.rootHalfW, s.y),
    at(s.crestR, s.crestHalfW, s.y),
    at(s.apexR, 0, s.y),
    at(s.crestR, -s.crestHalfW, s.y),
    at(s.rootR, -s.rootHalfW, s.y),
  ]);
  for (let i = 0; i + 1 < rings.length; i++) {
    const lo = rings[i];
    const hi = rings[i + 1];
    for (let k = 0; k + 1 < lo.length; k++) {
      // Section points are [rootL, crestL, ridge, crestR, rootR], so face strips k=1 and k=2 are
      // the two crest chamfers meeting at the ridge — the CREST light bars — and k=0/k=3 are the
      // flanks, which take the base floodwash (its own `t` goes to 0 above the merge, so one tag
      // covers the whole run without splitting the sweep).
      const program = k === 1 || k === 2 ? crestProgram : flankProgram;
      addQuad(acc, [lo[k], hi[k], hi[k + 1], lo[k + 1]], hex, false, program);
    }
  }
  // End caps (fans). Both are hidden by construction — the bottom one is a down-facing face at the
  // ground plane and the top one terminates inside the pod's flare — but they close the solid.
  const first = rings[0];
  const last = rings[rings.length - 1];
  for (let k = 1; k + 1 < first.length; k++) addTri(acc, first[0], first[k], first[k + 1], hex);
  for (let k = 1; k + 1 < last.length; k++) addTri(acc, last[0], last[k + 1], last[k], hex);
}

/**
 * A small box standing PROUD of a lathed surface, in the (radial, tangential, y) frame at
 * `azimuth`. Used for the Phase 44 pod-corner beacon strobes: `rInner` is buried inside the host
 * band's own surface and `rOuter` sticks out past it, so the fixture shares no plane with anything
 * (the Phase 42 anti-coplanar law — a decal-flat fixture is exactly the z-fight this project hunts).
 */
function addRadialBox(
  acc: Accum,
  azimuth: number,
  rInner: number,
  rOuter: number,
  halfWidth: number,
  y0: number,
  y1: number,
  hex: string,
  program: ProgramTag = STATIC_TAG,
): void {
  const ux = Math.sin(azimuth);
  const uz = Math.cos(azimuth);
  const tx = uz;
  const tz = -ux;
  const at = (radial: number, lateral: number, y: number): Vec3 => [
    ux * radial + tx * lateral,
    y,
    uz * radial + tz * lateral,
  ];
  const outRadial: Vec3 = [ux, 0, uz];
  const inRadial: Vec3 = [-ux, 0, -uz];
  const outLateral: Vec3 = [tx, 0, tz];
  const inLateral: Vec3 = [-tx, 0, -tz];
  const w = halfWidth;
  // Outer / inner radial faces.
  addQuadOriented(acc, [at(rOuter, w, y0), at(rOuter, -w, y0), at(rOuter, -w, y1), at(rOuter, w, y1)], outRadial, hex, program);
  addQuadOriented(acc, [at(rInner, w, y0), at(rInner, -w, y0), at(rInner, -w, y1), at(rInner, w, y1)], inRadial, hex, program);
  // Lateral sides.
  addQuadOriented(acc, [at(rInner, w, y0), at(rOuter, w, y0), at(rOuter, w, y1), at(rInner, w, y1)], outLateral, hex, program);
  addQuadOriented(acc, [at(rInner, -w, y0), at(rOuter, -w, y0), at(rOuter, -w, y1), at(rInner, -w, y1)], inLateral, hex, program);
  // Top / bottom.
  addQuadOriented(acc, [at(rInner, w, y1), at(rOuter, w, y1), at(rOuter, -w, y1), at(rInner, -w, y1)], [0, 1, 0], hex, program);
  addQuadOriented(acc, [at(rInner, w, y0), at(rOuter, w, y0), at(rOuter, -w, y0), at(rInner, -w, y0)], [0, -1, 0], hex, program);
}

function toGeometry(acc: Accum): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(acc.positions, 3));
  g.setAttribute('normal', new Float32BufferAttribute(acc.normals, 3));
  g.setAttribute('color', new Float32BufferAttribute(acc.colors, 3));
  // Phase 44 night program. Emitted UNCONDITIONALLY (Rogers carries an all-STATIC pair): two
  // float attributes on a ≤2.5k-tri mesh is ~40 KB total, and uniformity means no builder can ever
  // ship a geometry the CN material would bind a missing attribute for.
  g.setAttribute('aProgram', new Float32BufferAttribute(acc.programs, 1));
  g.setAttribute('aProgramT', new Float32BufferAttribute(acc.programTs, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

// --- CN Tower --------------------------------------------------------------------------------

export interface CnTowerMeta {
  readonly triangles: number;
  readonly height: number;
  readonly baseDiameter: number;
  readonly podCenterY: number;
  readonly podBottomY: number;
  readonly podTopY: number;
  readonly ringMinY: number;
  readonly ringMaxY: number;
  readonly skyPodCenterY: number;
  readonly needleMinY: number;
  readonly needleMaxY: number;
  /** Where the three legs have fully merged into the closed shaft (0.22·h — researcher-verified). */
  readonly legTopY: number;
  /**
   * Phase 43 additions.
   * `ringChannel` is the RECESSED mechanical channel the LED ring lives in — its radius is
   * strictly inside the lip bands above and below it, which is what makes the ring read as a
   * channel rather than a painted stripe. ringMinY/ringMaxY are the same band (kept for the
   * pre-existing consumers/tests); Phase 44's night program takes the radius too.
   */
  readonly ringChannel: { readonly minY: number; readonly maxY: number; readonly radius: number };
  /** Apex of the needle-tip beacon stub — where Phase 44 hangs the aircraft-warning light. */
  readonly beaconTipY: number;
  /**
   * Phase 44 night-program hooks — GEOMETRY-DERIVED, never re-typed in config (the P27 literal-
   * drift class). `ringCells` is how many discrete LEDs the channel has (= the pod lathe's segment
   * count), which the fragment patch needs to discretize `aProgramT`; `finTopY` is the CREST
   * element's `aProgramT` denominator; `beaconFixtures` describes the four pod-corner strobes so a
   * test can probe that they really stand proud of the mechanical ring's lip.
   */
  readonly ringCells: number;
  readonly finTopY: number;
  readonly beaconFixtures: readonly {
    readonly azimuth: number;
    readonly rInner: number;
    readonly rOuter: number;
    readonly y0: number;
    readonly y1: number;
  }[];
  /** Highest point of the parabolic arch soffit between two legs (the void's ceiling). */
  readonly archApexY: number;
  /** Azimuths (radians, atan2-style about +Z toward +X) of the three legs/fins. One points NW. */
  readonly ribAzimuths: readonly number[];
  /** Base-cylinder collider hint (radius / half-height / centre-y) for the scene. */
  readonly collider: { readonly radius: number; readonly halfHeight: number; readonly centerY: number };
  /**
   * Phase 36 — camera-volume hints for the taper shaft ABOVE the base collider: one entry per
   * taper segment (the same three spans the mesh itself builds), radius = that segment's bottom
   * (widest) radius so each box tightly contains its band's concrete. The camera clip index takes
   * these so the anti-clip guard and the eye-inside counter can SEE the shaft — without them the
   * eye can rest inside it at law heights (the shaft is still ⌀~14 at the eye line) and, because
   * the prism's faces all point outward, an inside-the-shaft camera back-face-culls the whole
   * tower and reads as clean see-through rather than a wall. The first band starts at legTopY:
   * below that, `collider` already covers the wider base footprint.
   */
  readonly shaftColliders: readonly { readonly radius: number; readonly halfHeight: number; readonly centerY: number }[];
}

export interface CnTowerModel {
  readonly geometry: BufferGeometry;
  readonly meta: CnTowerMeta;
}

// --- CN Tower v2 geometry laws (Phase 43) ------------------------------------------------------

/**
 * HEX ROLL — the core hexagon is turned 15° so a FACET CENTRE, never a corner, sits on each rib
 * azimuth. Rolled by 15° the facet centres land at 45/105/165/225/285/345°, which contains all
 * three ribs (120° apart), so ONE offset serves every fin. Each fin's flanks then cross their own
 * facet at 90° instead of grazing two facets at a shallow angle — the Phase 42 anti-z-fight rule
 * applied at the source rather than patched afterwards.
 */
const HEX_ROLL = Math.PI / 12;
const HEX_SIDES = 6;

/**
 * COMPASS — DERIVED, not guessed. projection.ts's mapToWorld is explicit: map-y (south) maps to
 * +Z, so **map north = −Z and map east = +X**; namedBuildings.ts pins every decal face SOUTH (+Z)
 * and EAST (+X) precisely because the fixed rig sits at +X/+Z of the car (fx/cameraRig.ts:
 * offset.x = d·cosθ·sin45, offset.z = d·cosθ·cos45, both positive). The lens therefore looks
 * NORTH-WEST, i.e. toward (−X, −Z). In the azimuth frame this file's sweeper and prism use
 * ([sin az, y, cos az] — az measured from +Z toward +X) that direction is 225°: ONE leg takes it,
 * the other two sit ±120° away, and the gap between THOSE two centres on 45° — the SE diagonal,
 * straight down the boresight. The arch void faces the camera in every street-level frame.
 */
const CN_NW_AZIMUTH = (5 * Math.PI) / 4;
const CN_RIB_AZIMUTHS: readonly number[] = [
  CN_NW_AZIMUTH - (2 * Math.PI) / 3, // 105°
  CN_NW_AZIMUTH, //                     225° — the NW leg, on the far side from the lens
  CN_NW_AZIMUTH + (2 * Math.PI) / 3, // 345°
];

/**
 * Boundary radius of a regular hexagon of circumradius `circumR`, rolled by `roll`, at azimuth
 * `az`. The arch skirt is sampled every 15° and needs to meet the 6-sided shaft EXACTLY at
 * legTopY: sampling the hexagon's own outline (rather than a circle) makes the two rings coincide
 * to float precision, so the junction is a shared edge instead of a 0.9 wu lip.
 */
function hexRadiusAt(circumR: number, az: number, roll: number): number {
  const step = Math.PI / 3;
  const d = (((az - roll) % step) + step) % step; // [0, 60°)
  return (circumR * Math.cos(Math.PI / 6)) / Math.cos(d - Math.PI / 6);
}

/** Absolute angular distance between two azimuths, wrapped into [0, π]. */
function angularDistance(a: number, b: number): number {
  const tau = Math.PI * 2;
  const d = (((a - b) % tau) + tau) % tau;
  return d > Math.PI ? tau - d : d;
}

/**
 * CN Tower v2 (Phase 43). Bottom to top, all of it the researcher-verified read:
 *  • THREE LEGS at 120° — one aimed NW so the arch void between the other two faces the fixed SE
 *    camera — swept as single fins that never stop: the leg IS the lower half of the shaft rib, so
 *    each crest is one unbroken ridge from the ground to the pod (Phase 44 lights those ridges);
 *  • a set-back hexagonal TRUNK you see through the openings, closed above by a flared SKIRT whose
 *    bottom edge is a sampled PARABOLA (apex 0.14·h) with its SOFFIT modelled in a darker grey —
 *    at the §5.3 camera's 58° pitch the underside is what you actually see from the street;
 *  • the legs merge into the closed shaft at 0.22·h (the real ones close at 100–150 m; §5's
 *    "bottom 8%" is superseded), above which the hex core tapers ⌀14 → ⌀6 in five bands with the
 *    three fins narrowing as they rise;
 *  • the main POD at 0.62·h with real massing — mushroom flare, white radome, dark glass band
 *    carrying the glass-floor strip, and an upper mechanical ring whose RECESSED channel (radius
 *    strictly inside the lips above and below) holds the emissive red/white LED ring;
 *  • the SkyPod bulge at 0.81·h on the thinner upper shaft, and a needle 0.88·h → h with four
 *    subtle diameter steps capped by the aircraft-beacon stub.
 * ONE merged non-indexed geometry (one draw call), ≤ 2,500 tris — both test-pinned.
 */
export function buildCnTowerGeometry(): CnTowerModel {
  const s = heroSpec('cn-tower');
  const h = hGame(s.real_h_m);
  const baseR = s.footprint_wu / 2; // 10.5 (⌀21) — the leg splay's envelope AND the collider radius

  // --- §5 proportions (the only literals; each asserted by heroes.test.ts) --------------------
  const podCenterY = 0.62 * h;
  const skyPodCenterY = 0.81 * h;
  const needleMinY = 0.88 * h;
  const legTopY = 0.22 * h; // legs fully merged into the closed shaft
  const archApexY = 0.14 * h; // ceiling of the parabolic void between two legs

  // The pod is deliberately ASYMMETRIC about its centre — the mushroom flare hangs 4.4 wu below,
  // the roof rises 2.6 above — which is what keeps the LED channel (up in the mechanical ring)
  // inside the ±2%·h window the spec pins around 0.62·h.
  const podBottomY = podCenterY - 4.4;
  const podTopY = podCenterY + 2.6;
  const podR = 7.2; // the glass band's radius (⌀14.4)

  // --- radius laws ---------------------------------------------------------------------------
  const SHAFT_BASE_R = 7; // ⌀14 where the legs have merged
  const SHAFT_TOP_R = 3; // ⌀6 just below the pod
  const NEEDLE_BASE_R = 2; // the upper shaft's top, where the needle stands on it
  const TRUNK_GROUND_R = 4.4; // the set-back core seen THROUGH the arches
  const SKIRT_GROUND_R = 9.8; // the arch springing, hugging each leg
  const FIN_DEPTH_MERGE = 2; // rib crest beyond the core radius at legTopY
  const FIN_DEPTH_TIP = 0.5; // …and just below the pod
  const LEG_GROUND_R = baseR - 0.2; // 10.3 — inside the collider, footprint-derived

  const shaftR = (y: number): number =>
    SHAFT_BASE_R + ((SHAFT_TOP_R - SHAFT_BASE_R) * (y - legTopY)) / (podBottomY - legTopY);
  const trunkR = (y: number): number =>
    TRUNK_GROUND_R + (SHAFT_BASE_R - TRUNK_GROUND_R) * Math.pow(Math.min(1, y / legTopY), 1.3);
  /** The concrete core's circumradius at any height — trunk below the merge, shaft above it. */
  const coreR = (y: number): number => (y <= legTopY ? trunkR(y) : shaftR(y));
  const skirtR = (y: number): number =>
    SHAFT_BASE_R + (SKIRT_GROUND_R - SHAFT_BASE_R) * Math.pow(Math.max(0, 1 - y / legTopY), 0.75);
  const upperShaftR = (y: number): number =>
    SHAFT_TOP_R + ((NEEDLE_BASE_R - SHAFT_TOP_R) * (y - podBottomY)) / (needleMinY - podBottomY);

  const acc = createAccum();

  // --- Phase 44 night-program tags -------------------------------------------------------------
  // Two pure spatial parameterizations, baked once here so the fragment patch never has to know
  // the tower's dimensions:
  //   • FLOOD wash strength — 1 at the ground, 0 at the leg merge, with a 1.4 power so the light
  //     stays concentrated in the arch zone the real uplights wash rather than smearing evenly up
  //     the skirt. Because it reaches 0 exactly at legTopY, the SAME tag can be handed to surfaces
  //     that continue above the merge (the fin flanks) with no split and no discontinuity.
  //   • CREST height fraction — 0 at the ground, 1 at the fin top, driving the slow upward sweep.
  const floodT = (p: Vec3): number => Math.pow(Math.max(0, Math.min(1, 1 - p[1] / legTopY)), 1.4);
  const FLOOD_TAG: ProgramTag = { id: CN_PROGRAM.FLOOD, t: floodT };
  /** BEACON needs no parameter — the whole element flashes together off one CPU-computed envelope. */
  const BEACON_TAG: ProgramTag = { id: CN_PROGRAM.BEACON, t: 1 };

  // --- the three legs-and-ribs (one swept fin each, ground → under the pod) --------------------
  // Sections are sampled tight near the ground (where the splay curves hardest) and then on the
  // shaft's own band boundaries, so every taper ring has a fin ring at exactly the same height —
  // which is what lets the rib-presence test compare radial extents within one thin band.
  const SHAFT_BANDS = 5;
  const shaftBandY = Array.from(
    { length: SHAFT_BANDS + 1 },
    (_, i) => legTopY + ((podBottomY - legTopY) * i) / SHAFT_BANDS,
  );
  const FIN_TOP_Y = podBottomY + 1; // terminates inside the pod's flare — no visible junction
  const finSection = (y: number): FinSection => {
    const core = coreR(y);
    const apothem = core * Math.cos(Math.PI / 6);
    const apexR =
      y <= legTopY
        ? SHAFT_BASE_R +
          FIN_DEPTH_MERGE +
          (LEG_GROUND_R - SHAFT_BASE_R - FIN_DEPTH_MERGE) * Math.pow(1 - y / legTopY, 1.5)
        : core +
          FIN_DEPTH_MERGE +
          ((FIN_DEPTH_TIP - FIN_DEPTH_MERGE) * (y - legTopY)) / (FIN_TOP_Y - legTopY);
    const halfW =
      y <= legTopY
        ? 1.95 - 0.1 * (y / legTopY)
        : 1.85 - (1.1 * (y - legTopY)) / (FIN_TOP_Y - legTopY);
    return {
      y,
      apexR,
      crestR: apexR - 0.18 * (apexR - apothem),
      crestHalfW: 0.72 * halfW,
      // Roots sit strictly INSIDE the hexagonal core at every height (checked against the apothem,
      // not the circumradius), so the fin's open back is buried and there is no flush base seam.
      rootR: Math.max(0.4, apothem - 0.8),
      rootHalfW: halfW,
    };
  };
  const finHeights = [0, 1.8, 3.6, 5.6, 7.8, 10.2, archApexY, (archApexY + legTopY) / 2, ...shaftBandY, FIN_TOP_Y];
  const finSections = finHeights.map(finSection);
  const CREST_TAG: ProgramTag = { id: CN_PROGRAM.CREST, t: (p: Vec3) => Math.max(0, Math.min(1, p[1] / FIN_TOP_Y)) };
  for (const az of CN_RIB_AZIMUTHS) addSweptFin(acc, az, finSections, RIB_CONCRETE, CREST_TAG, FLOOD_TAG);

  // --- trunk: the set-back hex core seen through the arch voids --------------------------------
  // It stops 3 wu above the arch apex, strictly inside the skirt (⌀12.6 vs ⌀15.8) — a trunk that
  // ran all the way to legTopY would pinch against the skirt to zero thickness there, which is the
  // near-coplanar pair Phase 42 hunts. Enclosed, not flush: the Chinatown-gate lesson.
  const trunkTopY = archApexY + 3;
  const TRUNK_BANDS = 4;
  for (let i = 0; i < TRUNK_BANDS; i++) {
    const yA = (trunkTopY * i) / TRUNK_BANDS;
    const yB = (trunkTopY * (i + 1)) / TRUNK_BANDS;
    addPrismFrustum(acc, HEX_SIDES, yA, yB, trunkR(yA), trunkR(yB), CONCRETE, {
      capBottom: i === 0,
      angleOffset: HEX_ROLL,
      program: FLOOD_TAG, // the core seen THROUGH the arches — the brightest thing the uplights hit
    });
  }

  // --- arch skirt + soffit ----------------------------------------------------------------------
  // ONE azimuth-sampled shell from the parabola up to legTopY. 24 samples = every 15°, which lands
  // exactly on all three rib azimuths AND all six hex corners, so the skirt's top ring IS the
  // shaft's bottom ring. The bottom edge is the arch: apex over each gap centre, dropping to the
  // ground at each leg (where the leg covers it anyway) — a 4-segment-per-side parabola sample.
  const SKIRT_SAMPLES = 24;
  const SKIRT_BANDS = 4;
  const SOFFIT_RISE = 0.5; // the vault slopes up as it runs inward — reads as depth, not a shelf
  const gapCenters = CN_RIB_AZIMUTHS.map((az) => az + Math.PI / 3);
  const azAt = (k: number): number => (k * Math.PI * 2) / SKIRT_SAMPLES;
  const archY = (az: number): number => {
    let d = Math.PI;
    for (const g of gapCenters) d = Math.min(d, angularDistance(az, g));
    const t = d / (Math.PI / 3);
    return archApexY * Math.max(0, 1 - t * t);
  };
  const skirtPoint = (az: number, y: number): Vec3 => {
    const r = hexRadiusAt(skirtR(y), az, HEX_ROLL);
    return [r * Math.sin(az), y, r * Math.cos(az)];
  };
  const soffitInner = (az: number, y: number): Vec3 => {
    const r = hexRadiusAt(trunkR(y), az, HEX_ROLL) - 0.35; // buried inside the trunk
    return [r * Math.sin(az), y, r * Math.cos(az)];
  };
  for (let k = 0; k < SKIRT_SAMPLES; k++) {
    const a0 = azAt(k);
    const a1 = azAt(k + 1);
    const s0 = archY(a0);
    const s1 = archY(a1);
    for (let b = 0; b < SKIRT_BANDS; b++) {
      const f0 = b / SKIRT_BANDS;
      const f1 = (b + 1) / SKIRT_BANDS;
      addQuad(
        acc,
        [
          skirtPoint(a0, s0 + (legTopY - s0) * f0),
          skirtPoint(a1, s1 + (legTopY - s1) * f0),
          skirtPoint(a1, s1 + (legTopY - s1) * f1),
          skirtPoint(a0, s0 + (legTopY - s0) * f1),
        ],
        CONCRETE,
        false,
        FLOOD_TAG,
      );
    }
    // The soffit: the down-facing underside closing skirt → trunk along the parabola. Darker, so
    // the void reads as depth rather than as another grey wall.
    addQuad(
      acc,
      [skirtPoint(a0, s0), soffitInner(a0, s0 + SOFFIT_RISE), soffitInner(a1, s1 + SOFFIT_RISE), skirtPoint(a1, s1)],
      SOFFIT_CONCRETE,
      false,
      FLOOD_TAG,
    );
  }

  // --- shaft: hex core, ⌀14 → ⌀6, five taper bands ---------------------------------------------
  for (let i = 0; i < SHAFT_BANDS; i++) {
    const yA = shaftBandY[i];
    const yB = shaftBandY[i + 1];
    addPrismFrustum(acc, HEX_SIDES, yA, yB, shaftR(yA), shaftR(yB), CONCRETE, { angleOffset: HEX_ROLL });
  }

  // --- upper shaft: pod → needle, split on the two pods so its taper is exact at each junction ---
  const skyPodBottomY = skyPodCenterY - 2.4;
  const skyPodTopY = skyPodCenterY + 2.1;
  const upperCuts = [podBottomY, podTopY, skyPodBottomY, skyPodTopY, needleMinY];
  for (let i = 0; i + 1 < upperCuts.length; i++) {
    const yA = upperCuts[i];
    const yB = upperCuts[i + 1];
    addPrismFrustum(acc, HEX_SIDES, yA, yB, upperShaftR(yA), upperShaftR(yB), CONCRETE, {
      angleOffset: HEX_ROLL,
      // Capped at the top so the needle (which stands inside the cap's apothem) closes the tube.
      capTop: i + 2 === upperCuts.length,
    });
  }

  // --- main pod: a lathed profile, flare → radome → glass → recessed LED channel → roof ---------
  const POD_SIDES = 16;
  const RING_R = 6.7; // the channel floor
  const LIP_R = 7.15; // the mechanical ring's lips, above and below it
  const ringMinY = podCenterY + 0.9;
  const ringMaxY = podCenterY + 1.7;
  addLathe(acc, POD_SIDES, [
    // Mushroom underside. Starts INSIDE the shaft (2.35 < the hex's 2.60 apothem there) so the
    // flare has no annular crack around the concrete it hangs from.
    { y0: podBottomY, r0: 2.35, y1: podCenterY - 3.2, r1: 5, hex: CONCRETE },
    { y0: podCenterY - 3.2, r0: 5, y1: podCenterY - 2.2, r1: 7, hex: CONCRETE },
    { y0: podCenterY - 2.2, r0: 7, y1: podCenterY - 1.9, r1: 7.3, hex: RADOME_WHITE },
    { y0: podCenterY - 1.9, r0: 7.3, y1: podCenterY - 1.1, r1: 7.3, hex: RADOME_WHITE },
    { y0: podCenterY - 1.1, r0: 7.3, y1: podCenterY - 0.95, r1: podR, hex: POD_CREAM },
    { y0: podCenterY - 0.95, r0: podR, y1: podCenterY - 0.55, r1: podR, hex: GLASS_DARK },
    // The glass floor, one level below the LookOut — the single lighter strip in the dark band.
    { y0: podCenterY - 0.55, r0: podR, y1: podCenterY - 0.2, r1: podR, hex: GLASS_FLOOR },
    { y0: podCenterY - 0.2, r0: podR, y1: podCenterY + 0.55, r1: podR, hex: GLASS_DARK },
    { y0: podCenterY + 0.55, r0: podR, y1: podCenterY + 0.75, r1: LIP_R, hex: POD_CREAM },
    { y0: podCenterY + 0.75, r0: LIP_R, y1: ringMinY, r1: LIP_R, hex: MECH_GREY },
    // Step IN (a flat annulus — the lower lip's top face, which winds up-facing on its own).
    { y0: ringMinY, r0: LIP_R, y1: ringMinY, r1: RING_R, hex: MECH_GREY },
    // THE LED CHANNEL, sheltered 0.45 wu inside both lips. PHASE 44: baked as its dark HOUSING
    // and tagged RING — the light now comes from the night program, one uniform-driven cell per
    // lathe segment. `aProgramT` is CONSTANT across each segment's quad (the cell's own centre
    // fraction) rather than interpolated per vertex: an interpolated azimuth would wrap 15/16 → 0
    // across the last cell and would put a discretization seam inside every cell, which is exactly
    // the sub-pixel strobe the Phase 41 surface law forbids. Flat cells are also what a real LED
    // channel looks like.
    {
      y0: ringMinY,
      r0: RING_R,
      y1: ringMaxY,
      r1: RING_R,
      hex: RING_CHANNEL,
      emissive: true, // literal dark housing — the baked directional shade would fight the program
      program: (segment, sides) => ({ id: CN_PROGRAM.RING, t: (segment + 0.5) / sides }),
    },
    // Step OUT (the upper lip's underside — winds down-facing).
    { y0: ringMaxY, r0: RING_R, y1: ringMaxY, r1: LIP_R, hex: MECH_GREY },
    { y0: ringMaxY, r0: LIP_R, y1: podCenterY + 2.2, r1: LIP_R, hex: MECH_GREY },
    { y0: podCenterY + 2.2, r0: LIP_R, y1: podCenterY + 2.45, r1: 6.9, hex: MECH_GREY },
    // Flat roof deck, closing onto the shaft: its inner edge stops inside the hex's apothem so the
    // shaft carries on through a hole rather than being capped over by the pod.
    { y0: podCenterY + 2.45, r0: 6.9, y1: podTopY, r1: 2.3, hex: MECH_GREY },
  ]);

  // --- SkyPod: the 12-gon bulge, re-proportioned for the thinner upper shaft --------------------
  addLathe(acc, 12, [
    { y0: skyPodBottomY, r0: 1.9, y1: skyPodCenterY - 1.5, r1: 4.3, hex: CONCRETE },
    { y0: skyPodCenterY - 1.5, r0: 4.3, y1: skyPodCenterY - 1.2, r1: 4.6, hex: POD_CREAM },
    { y0: skyPodCenterY - 1.2, r0: 4.6, y1: skyPodCenterY + 0.9, r1: 4.6, hex: GLASS_POD },
    { y0: skyPodCenterY + 0.9, r0: 4.6, y1: skyPodCenterY + 1.2, r1: 4.5, hex: POD_CREAM },
    { y0: skyPodCenterY + 1.2, r0: 4.5, y1: skyPodCenterY + 1.7, r1: 4.2, hex: MECH_GREY },
    { y0: skyPodCenterY + 1.7, r0: 4.2, y1: skyPodTopY, r1: 1.7, hex: MECH_GREY },
  ]);

  // --- needle: four SUBTLE diameter steps + the beacon stub ------------------------------------
  // Research: the real mast's sections are not readable at distance, so the steps are flat annulus
  // bands of 0.16-0.24 wu rather than the chunky collars a "stepped taper" invites.
  // Cuts are FRACTIONS of the needle's own span, so a spec height change moves them in proportion
  // instead of drifting (the P27 literal-drift class).
  const nAt = (t: number): number => needleMinY + (h - needleMinY) * t;
  const nCuts = [0, 0.19, 0.38, 0.57, 0.76, 0.88].map(nAt);
  const beaconTipY = h;
  addLathe(acc, 8, [
    { y0: nCuts[0], r0: 1.6, y1: nCuts[1], r1: 1.52, hex: CONCRETE },
    { y0: nCuts[1], r0: 1.52, y1: nCuts[1], r1: 1.28, hex: CONCRETE },
    { y0: nCuts[1], r0: 1.28, y1: nCuts[2], r1: 1.2, hex: CONCRETE },
    { y0: nCuts[2], r0: 1.2, y1: nCuts[2], r1: 0.98, hex: CONCRETE },
    { y0: nCuts[2], r0: 0.98, y1: nCuts[3], r1: 0.9, hex: CONCRETE },
    { y0: nCuts[3], r0: 0.9, y1: nCuts[3], r1: 0.7, hex: CONCRETE },
    { y0: nCuts[3], r0: 0.7, y1: nCuts[4], r1: 0.62, hex: CONCRETE },
    { y0: nCuts[4], r0: 0.62, y1: nCuts[4], r1: 0.46, hex: CONCRETE },
    { y0: nCuts[4], r0: 0.46, y1: nCuts[5], r1: 0.4, hex: CONCRETE },
    // Beacon stub: a distinct little housing that steps back OUT at the very top. PHASE 44 tags it
    // BEACON so the double-flash strobe drives it; the baked colour stays the dark aircraft-warning
    // red, which is what the housing reads as between flashes.
    { y0: nCuts[5], r0: 0.4, y1: nCuts[5], r1: 0.66, hex: BEACON_RED, program: BEACON_TAG },
    { y0: nCuts[5], r0: 0.66, y1: nAt(0.96), r1: 0.62, hex: BEACON_RED, program: BEACON_TAG },
    { y0: nAt(0.96), r0: 0.62, y1: beaconTipY, r1: 0.24, hex: BEACON_RED, capTop: true, program: BEACON_TAG },
  ]);

  // --- pod-corner aircraft strobes (Phase 44) ---------------------------------------------------
  // Four little housings standing proud of the mechanical ring's upper lip — the second half of
  // the tower's warning-light set (the needle stub is the first). They sit at LATHE-SEGMENT
  // CENTRES, deliberately not on the segment boundaries: a fixture straddling a lathe edge would
  // put its buried inner face within microns of two facet planes at once, and the whole point of
  // `rInner` diving inside the lip's apothem is that no face of the fixture is ever near-coplanar
  // with the host (Phase 42's law, applied at the source like the hex roll).
  const BEACON_FIXTURES = 4;
  const beaconY0 = ringMaxY + 0.11;
  const beaconY1 = ringMaxY + 0.39; // strictly inside the lip band [ringMaxY, podCenterY + 2.2]
  const lipApothem = LIP_R * Math.cos(Math.PI / POD_SIDES);
  const beaconFixtures = Array.from({ length: BEACON_FIXTURES }, (_, i) => ({
    // 1.5 segments in = a segment CENTRE, and the first one lands at 33.75° — within 12° of the
    // fixed rig's SE boresight, so a strobe is essentially always facing the lens.
    azimuth: ((i * (POD_SIDES / BEACON_FIXTURES) + 1.5) * Math.PI * 2) / POD_SIDES,
    rInner: lipApothem - 0.16, // buried under the lip surface at every azimuth
    rOuter: LIP_R + 0.3,
    y0: beaconY0,
    y1: beaconY1,
  }));
  for (const f of beaconFixtures) {
    addRadialBox(acc, f.azimuth, f.rInner, f.rOuter, 0.17, f.y0, f.y1, BEACON_RED, BEACON_TAG);
  }

  // Shaft camera-volume hints (see CnTowerMeta.shaftColliders): the mesh's own five taper bands,
  // each box sized to its band's widest extent — which since Phase 43 is the FIN CREST, not the
  // core, so the P36 see-through cover keeps covering the ribs too.
  const shaftColliders = Array.from({ length: SHAFT_BANDS }, (_, i) => {
    const yA = shaftBandY[i];
    const yB = shaftBandY[i + 1];
    return { radius: finSection(yA).apexR, halfHeight: (yB - yA) / 2, centerY: (yA + yB) / 2 };
  });

  return {
    geometry: toGeometry(acc),
    meta: {
      triangles: acc.positions.length / 9,
      height: h,
      baseDiameter: baseR * 2,
      podCenterY,
      podBottomY,
      podTopY,
      ringMinY,
      ringMaxY,
      skyPodCenterY,
      needleMinY,
      needleMaxY: h,
      legTopY,
      ringChannel: { minY: ringMinY, maxY: ringMaxY, radius: RING_R },
      beaconTipY,
      ringCells: POD_SIDES,
      finTopY: FIN_TOP_Y,
      beaconFixtures,
      archApexY,
      ribAzimuths: CN_RIB_AZIMUTHS,
      // Same collider CLASS as v1 (one base cylinder over the leg zone, same formula shape) — only
      // its height follows the new legTopY. Radius is the JSON footprint, not a re-typed 10.5.
      collider: { radius: baseR, halfHeight: legTopY / 2 + 0.2, centerY: legTopY / 2 + 0.2 },
      shaftColliders,
    },
  };
}

// --- Rogers Centre ---------------------------------------------------------------------------

export interface RogersMeta {
  readonly triangles: number;
  readonly height: number;
  readonly domeDiameter: number;
  readonly ringBaseTopY: number;
  readonly apexY: number;
  /** Ring-base cylinder collider hint (radius / half-height / centre-y) for the scene. */
  readonly collider: { readonly radius: number; readonly halfHeight: number; readonly centerY: number };
}

export interface RogersModel {
  readonly geometry: BufferGeometry;
  readonly meta: RogersMeta;
}

/** Rogers Centre: a grey precast ring base (15%·h) + a squashed lathed half-dome cap built as 4
 * nested roof-panel bands with visible grey seams, one azimuthal slice drawn as the sliding
 * (retractable) panel in a distinct grey. Grey-white only, never brand-coloured. ≤ 500 tris. */
export function buildRogersGeometry(): RogersModel {
  const s = heroSpec('rogers-centre');
  const h = hGame(s.real_h_m);
  const domeR = (s.dome_diameter_wu ?? s.footprint_wu) / 2; // 33 (⌀66)
  const ringBaseTopY = 0.15 * h;

  const acc = createAccum();
  const SIDES = 24;

  // Ring base — a short precast cylinder wall (no bottom cap: it sits on the ground).
  addPrismFrustum(acc, SIDES, 0, ringBaseTopY, domeR, domeR, ROGERS_RING);

  // Half-dome cap — a squashed quarter-ellipse profile (radius domeR at the base → 0 at the apex),
  // sampled into 4 nested latitude bands so the seams between adjacent greys read as roof panels.
  // One azimuthal quarter (the panel slice) is drawn in the sliding-panel grey across every band.
  const BANDS = 4;
  const profileR = (t: number): number => domeR * Math.cos((t * Math.PI) / 2);
  const profileY = (t: number): number => ringBaseTopY + (h - ringBaseTopY) * Math.sin((t * Math.PI) / 2);
  const panelSlice = (i: number, sides: number): boolean => i < Math.round(sides / 4); // one quarter = the retractable roof
  for (let bnd = 0; bnd < BANDS; bnd++) {
    const t0 = bnd / BANDS;
    const t1 = (bnd + 1) / BANDS;
    addPrismFrustum(acc, SIDES, profileY(t0), profileY(t1), profileR(t0), profileR(t1), DOME_BANDS[bnd], {
      colorAt: (i, sides) => (panelSlice(i, sides) ? DOME_PANEL : DOME_BANDS[bnd]),
    });
  }

  return {
    geometry: toGeometry(acc),
    meta: {
      triangles: acc.positions.length / 9,
      height: h,
      domeDiameter: domeR * 2,
      ringBaseTopY,
      apexY: h,
      collider: { radius: domeR, halfHeight: ringBaseTopY / 2 + 0.1, centerY: ringBaseTopY / 2 + 0.1 },
    },
  };
}
