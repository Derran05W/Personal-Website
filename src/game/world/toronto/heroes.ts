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
// PHASE 45 (Part 11) — ROGERS CENTRE v2. The v1 stadium was 240 tris: a plain grey cylinder with a
// 4-band lathed cap. It read as "a dome", not as THE dome. v2 rebuilds it around the features the
// real building is recognized by (all researcher-verified 2026-07-27 except where noted):
//   • a PANELIZED dome — six latitude bands, each closed by a proud horizontal SEAM LIP, so the
//     roof reads as assembled sections instead of a smooth shell (the lips are geometry, never
//     painted overlays — the Phase 42 anti-coplanar law);
//   • the RETRACTABLE quarter, legible at last: the eight segments straddling SOUTH carry their own
//     tint AND ride 0.45 wu proud of the fixed shell (the real panels nest ON TOP of each other as
//     they slide north under the fixed north panel), with a raised RIB along each of its two edge
//     meridians — the leading-edge trusses;
//   • TRACK RAILS on the east and west meridians (the real panels ride motor-driven steel tracks on
//     the stadium walls), same rib treatment;
//   • a ring base with articulation PIERS and recessed ENTRANCE GATES whose lintel strips glow
//     (program-tagged, Phase-44 architecture);
//   • the gondola-HOTEL window strip on the NORTH face (55 field-view rooms — the strip is
//     camera-invisible on-rig by the fixed bearing and pays off in the off-rig postcard);
//   • the exterior LED JUMBOTRON on the SOUTH face — which IS a camera-visible face — as a mounted
//     board of colour-block columns driven by its own night program;
//   • two segmented helix RAMP ribbons on the shoulders flanking the south face (the ramps' corner
//     count could NOT be verified in the researcher round — they ship as an explicit HOMAGE).
// Tri budget rises 500 → 1,500 deliberately (overview tri-budget addendum, Part 11 rule 2).
//
// Pure geometry: three's BufferGeometry/Color are pure JS (no WebGL), so this whole module runs
// in the vitest/jsdom env and its tri budgets + proportions are unit-testable without a canvas.

import { BufferGeometry, Color, Float32BufferAttribute } from 'three';
import buildingSpecsJson from '../../../../data/toronto/building-specs.json';
import { hGame } from './heightCurve';

/**
 * A.3 tri budgets — exported so the test and any future perf audit share one source.
 * CN's rises 600 → 2,500 at Phase 43 and Rogers' 500 → 1,500 at Phase 45 (the overview's
 * tri-budget addendum: budgets in Parts 11–12 rise DELIBERATELY and get re-pinned, never
 * silently — the spec's own A.3 lines carry dated addenda for both). Each mesh lands well under
 * its ceiling; the segment counts below are the knob, and heroes.test.ts pins a FLOOR too so a
 * regression that quietly reverted either v2 fails loudly instead of passing on the ceiling.
 */
export const CN_TOWER_MAX_TRIS = 2500 as const;
export const ROGERS_MAX_TRIS = 1500 as const;

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
// --- Rogers Centre palette (grey-white ONLY — §5: the stadium is never brand-coloured) ---------
const ROGERS_RING = '#9aa0ab'; // stadium outer ring base (grey precast)
const ROGERS_PIER = '#aab0ba'; // the ring's articulation pilasters — a shade lighter so they read
const ROGERS_GATE = '#4e545d'; // recessed entrance-bay face (dark = the opening reads as a hole)
const ROGERS_GATE_HOUSING = '#3a332a'; // the gate lintel's glow-strip housing — the light is the program
const ROGERS_HOTEL_BAND = '#b3b7be'; // the north-face hotel strip's precast frame
const ROGERS_HOTEL_GLASS = '#2c313a'; // its window glass; LIT rooms come from the program, not the bake
const ROGERS_JUMBO_HOUSING = '#3c4149'; // the south LED board's mounting box
const ROGERS_JUMBO_PANEL = '#15181c'; // the board itself, baked dark (Phase-44 rule: light ≠ paint)
const ROGERS_RAMP_DECK = '#a4aab4';
const ROGERS_RAMP_FASCIA = '#8f959f';
const ROGERS_RAIL = '#878d97'; // track rails + the sliding assembly's leading-edge ribs (steel)
const ROGERS_SEAM = '#ccd0d6'; // the proud lip between roof panels — up-facing, so it catches the key
// Six nested roof-panel greys (visible seams between adjacent bands, §5) + the retractable panel.
const DOME_BANDS = ['#c6c6cc', '#bcbcc5', '#b2b2bc', '#a8a8b3', '#9e9ea9', '#94949f'] as const;
const DOME_PANEL = '#7f8894'; // the sliding (retractable) sector, a distinct darker grey

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
 * STATIC is the default for EVERY call site, which is why adding the tags changed no other
 * geometry: an untagged vertex carries (0, 0) and the patch adds nothing.
 *
 * PHASE 45 — the alphabet is now SHARED HERO-WIDE, not CN's alone (the name is kept because the
 * export is imported in five places and the ids are a single numbering space by design). Each hero
 * has its OWN patched material with its own program cache key, and each material implements only
 * the ids its own geometry carries; ids 1–4 are the CN Tower's, 5–6 are the Rogers Centre's. The
 * two patches are written so an id they don't implement falls through and adds NOTHING (CN's FLOOD
 * branch is bounded above at 4.5 for exactly this reason), so the pairing rule stays a safety net
 * rather than a load-bearing assumption.
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
  /** Phase 45 — the Rogers Centre's south-face LED board. `aProgramT` = that COLUMN's centre
   *  fraction across the board (the ring-cell idiom: flat per column, so the shader's `floor`
   *  re-derives an exact cell index and no discretization seam can land mid-column). */
  JUMBO: 5,
  /** Phase 45 — Rogers' plain emissive surfaces. `aProgramT` selects WHICH one: 0 = the entrance
   *  gates' lintel glow strips, 1 = the north hotel strip's lit windows. One id with a selector
   *  beats two ids: the shader mixes colour+intensity off the same varying it already reads. */
  EMISS: 6,
} as const;
export type CnProgramId = (typeof CN_PROGRAM)[keyof typeof CN_PROGRAM];

/** `aProgramT` selector values for CN_PROGRAM.EMISS (see above). Exported so the material's mix
 *  threshold and the geometry's tags can never drift apart. */
export const ROGERS_EMISS_T = { gate: 0, hotel: 1 } as const;

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

/** One dome latitude band, published as a camera-volume hint (the `shaftColliders` precedent). */
export interface RogersDomeBand {
  /**
   * The dome profile's radius at `maxY` — i.e. the SMALLEST radius anywhere in the band, which is
   * the widest cylinder the shell ENCLOSES across the band's whole height.
   *
   * Deliberately NOT the band's widest (bottom) radius, which is what a containment hint would
   * publish. The dome is a SHELL over air: what the camera can be "inside" is the enclosed volume,
   * and a bottom-radius box would claim a ring of OPEN AIR outside the sloping skin — the exact
   * false eye-inside the Phase 36 TODO refused to ship ("a square AABB around a 33-wu-radius dome
   * reports false eye-inside across the whole rail-lands approach"). See rogersDomeClipVolumes.
   */
  readonly radius: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface RogersMeta {
  readonly triangles: number;
  readonly height: number;
  readonly domeDiameter: number;
  readonly ringBaseTopY: number;
  readonly apexY: number;
  /** Ring-base cylinder collider hint (radius / half-height / centre-y) for the scene. */
  readonly collider: { readonly radius: number; readonly halfHeight: number; readonly centerY: number };
  /** Phase 45 — per-band enclosure hints for the camera clip index (see RogersDomeBand). */
  readonly domeBands: readonly RogersDomeBand[];
  /**
   * The south-face LED board, in the mesh's LOCAL frame: `z` is the panel plane (+Z = south = a
   * camera-visible face), `cells` the column count the night program discretizes `aProgramT` by.
   * GEOMETRY-DERIVED, exactly like CnTowerMeta.ringCells — config never re-types it.
   */
  readonly jumbotron: {
    readonly minX: number;
    readonly maxX: number;
    readonly minY: number;
    readonly maxY: number;
    readonly z: number;
    readonly cells: number;
  };
  /** Shorthand for `jumbotron.cells` (what createRogersNightMaterial takes). */
  readonly jumboCells: number;
  /** Entrance gates: azimuths (rad, from +Z toward +X) + the lintel glow strip's height band. */
  readonly gates: {
    readonly azimuths: readonly number[];
    readonly glowMinY: number;
    readonly glowMaxY: number;
  };
  /** The north-face hotel window strip's band (azimuths wrap-free: minAz < maxAz around π). */
  readonly hotel: {
    readonly minY: number;
    readonly maxY: number;
    readonly radius: number;
    readonly minAz: number;
    readonly maxAz: number;
  };
  /** The retractable assembly: half-angle about SOUTH (az 0) and how proud it rides. */
  readonly slideSector: { readonly halfAngle: number; readonly lift: number };
  /** The two helix ramp ribbons (azimuth span + height span), for tests and future dressing. */
  readonly ramps: readonly {
    readonly minAz: number;
    readonly maxAz: number;
    readonly minY: number;
    readonly maxY: number;
  }[];
}

export interface RogersModel {
  readonly geometry: BufferGeometry;
  readonly meta: RogersMeta;
}

// --- Rogers Centre v2 geometry laws (Phase 45) -------------------------------------------------
// Every count/offset the builder below runs on, named once. The tri count is (SIDES, BANDS, RAMP
// segments) — those three are the budget knob; everything else is proportion.

/** Dome + ring segments. 30 = 12° per facet ≈ 6.9 wu of arc on a ⌀66 dome — chunky on purpose
 *  (flat-shaded low-poly IS the look), and 12° divides the slide sector, gates and piers exactly. */
const ROGERS_SIDES = 30;
/** Latitude bands (§5's "nested roof-panel arcs", now six). The top one closes as a cone. */
const ROGERS_DOME_BANDS = 6;
/** How proud each band's closing lip stands. Geometry, never a painted line (Phase 42). */
const ROGERS_SEAM_RIDGE = 0.35;
/** The retractable sector: 4 segments each side of SOUTH = 96°, i.e. §5's "panel quarter". */
const ROGERS_SLIDE_SEGS = 4;
/** How far the sliding assembly rides ON TOP of the fixed shell (the nesting read). */
const ROGERS_SLIDE_LIFT = 0.45;
/** Rails/leading-edge ribs: half-width in azimuth (≈2.9° ⇒ ~1.6 wu each side) and how proud they
 *  stand. The lift MUST exceed ROGERS_SLIDE_LIFT — a rib flush with the panels it guides would be
 *  invisible on the lifted side and near-coplanar with it, which is the z-fight this project hunts. */
const ROGERS_RIB_HALF_AZ = 0.05;
const ROGERS_RIB_LIFT = 0.78;
/** The ribs start at band 1: below that is the "wall" band the ramps wrap, and a rail through a
 *  ramp deck is a defect, not a detail. */
const ROGERS_RIB_FIRST_BAND = 1;
const ROGERS_PIERS = 10;
const ROGERS_GATES = 5;
/** Board columns — the night program's colour blocks are one per column. */
const ROGERS_JUMBO_CELLS = 12;
const ROGERS_RAMP_SEGS = 14;

/**
 * Rogers Centre v2 (Phase 45). Bottom to top:
 *  • a grey precast RING BASE (15%·h — spec §5) articulated by ten pilasters, with five recessed
 *    ENTRANCE BAYS whose lintel strips are program-lit (the bay face sits barely proud of the wall
 *    while the piers stand well proud, so the opening reads as recessed WITHOUT cutting a hole in
 *    a closed cylinder — geometry the collider and the tri budget can both afford);
 *  • the SOUTH-face LED JUMBOTRON: a mounted board of `ROGERS_JUMBO_CELLS` column quads, each
 *    tagged JUMBO with its own flat cell fraction, on a housing box that buries itself in the shell;
 *  • the NORTH-face gondola-HOTEL strip: a proud precast band with two rows of window quads, the
 *    lit ones tagged EMISS (55 field-view rooms — researcher-verified north face);
 *  • the PANELIZED DOME: six latitude bands on §5's quarter-ellipse profile, each closed by an
 *    up-facing SEAM LIP that stands `ROGERS_SEAM_RIDGE` proud, so the roof reads as sections;
 *  • the RETRACTABLE quarter: the eight segments straddling SOUTH, tinted AND lifted so they ride
 *    on top of the fixed shell (the real panels slide south→north and nest under the fixed north
 *    panel), with raised RIBS along their two edge meridians — the leading-edge trusses — plus the
 *    east/west TRACK RAILS the panels ride;
 *  • two segmented helix RAMP ribbons wrapping the wall band on the shoulders that flank the south
 *    face. HOMAGE, stated plainly: the researcher round could not verify the real ramps' count or
 *    corners, and the south corner itself is the board's, so the two go east and west of it.
 * ONE merged non-indexed geometry (one draw call), grey-white only, ≤ 1,500 tris — all test-pinned.
 */
export function buildRogersGeometry(): RogersModel {
  const s = heroSpec('rogers-centre');
  const h = hGame(s.real_h_m);
  const domeR = (s.dome_diameter_wu ?? s.footprint_wu) / 2; // 33 (⌀66)
  const ringBaseTopY = 0.15 * h;

  const acc = createAccum();
  const SIDES = ROGERS_SIDES;
  const BANDS = ROGERS_DOME_BANDS;
  const step = (Math.PI * 2) / SIDES;

  /** A point at (azimuth, radius, height) in the builder's frame (az from +Z toward +X). */
  const at = (az: number, r: number, y: number): Vec3 => [r * Math.sin(az), y, r * Math.cos(az)];

  // §5's squashed quarter-ellipse: radius domeR at the springing → 0 at the apex.
  const profileR = (t: number): number => domeR * Math.cos((t * Math.PI) / 2);
  const profileY = (t: number): number => ringBaseTopY + (h - ringBaseTopY) * Math.sin((t * Math.PI) / 2);
  /** The same profile solved the other way: the shell's radius at a world height. Used by the
   *  ramps and the hotel band so neither has to re-type the curve (the P41 anchor-derivation rule). */
  const radiusAtY = (y: number): number => {
    const u = Math.max(0, Math.min(1, (y - ringBaseTopY) / (h - ringBaseTopY)));
    return domeR * Math.sqrt(Math.max(0, 1 - u * u));
  };

  // --- the retractable sector ------------------------------------------------------------------
  // Classified by SEGMENT INDEX, not by an angular distance test: the sector's edges then land
  // exactly on segment boundaries, which is what lets the leading-edge ribs sit on them without a
  // rounding-dependent sliver, and what makes the lifted/fixed radial step a clean seam the rib
  // covers rather than a crack.
  const isSlide = (i: number): boolean => i < ROGERS_SLIDE_SEGS || i >= SIDES - ROGERS_SLIDE_SEGS;
  const liftAt = (i: number): number => (isSlide(i) ? ROGERS_SLIDE_LIFT : 0);
  const liftAtAz = (az: number): number => {
    const tau = Math.PI * 2;
    const norm = ((az % tau) + tau) % tau;
    return liftAt(Math.floor(norm / step) % SIDES);
  };
  const slideEdgeAz = ROGERS_SLIDE_SEGS * step; // ±48° — the sector's own boundary meridians

  // --- ring base: wall, piers, recessed gate bays ------------------------------------------------
  addPrismFrustum(acc, SIDES, 0, ringBaseTopY, domeR, domeR, ROGERS_RING);
  for (let k = 0; k < ROGERS_PIERS; k++) {
    // Half-offset so the piers sit at facet CENTRES and the gates (below) land exactly midway
    // between two of them — no pier/gate overlap is possible by construction.
    const az = ((k + 0.5) * Math.PI * 2) / ROGERS_PIERS;
    addRadialBox(acc, az, domeR - 0.5, domeR + 0.55, 1.1, 0, ringBaseTopY + 0.35, ROGERS_PIER);
  }
  const GATE_TOP_Y = 3.2;
  const GATE_GLOW_MIN_Y = 3.3;
  const GATE_GLOW_MAX_Y = 3.75;
  const GATE_TAG: ProgramTag = { id: CN_PROGRAM.EMISS, t: ROGERS_EMISS_T.gate };
  const gateAzimuths = Array.from(
    { length: ROGERS_GATES },
    (_, k) => ((k + 0.5) * Math.PI * 2) / ROGERS_GATES,
  );
  for (const az of gateAzimuths) {
    // The bay: barely proud of the wall (0.14) between piers that stand 0.55 proud — the eye reads
    // the difference as depth. Its inner face is buried, so no face of it is coplanar with the wall.
    addRadialBox(acc, az, domeR - 0.6, domeR + 0.14, 2.6, 0, GATE_TOP_Y, ROGERS_GATE);
    // The lintel glow strip, standing proud of the bay again (program-lit; baked dark warm).
    addRadialBox(acc, az, domeR - 0.2, domeR + 0.42, 2.2, GATE_GLOW_MIN_Y, GATE_GLOW_MAX_Y, ROGERS_GATE_HOUSING, GATE_TAG);
  }

  // --- the panelized dome ------------------------------------------------------------------------
  const domeBands: RogersDomeBand[] = [];
  for (let b = 0; b < BANDS; b++) {
    const t0 = b / BANDS;
    const t1 = (b + 1) / BANDS;
    const y0 = profileY(t0);
    const y1 = profileY(t1);
    const r0 = profileR(t0);
    const r1 = profileR(t1);
    const isApex = b === BANDS - 1;
    for (let i = 0; i < SIDES; i++) {
      const lift = liftAt(i);
      const hex = isSlide(i) ? DOME_PANEL : DOME_BANDS[b];
      const a0 = i * step;
      const a1 = a0 + step;
      if (isApex) {
        addTri(acc, at(a0, r0 + lift, y0), at(a1, r0 + lift, y0), [0, y1, 0], hex);
        continue;
      }
      // The band flares 0.35 past its own top radius, then a flat annulus steps back in: that
      // annulus IS the seam. A zero-height inward step winds UP-facing (see LatheBand), so every
      // seam catches the baked key light and the roof reads as stacked sections at any distance.
      const rTop = r1 + ROGERS_SEAM_RIDGE + lift;
      addQuad(acc, [at(a0, r0 + lift, y0), at(a1, r0 + lift, y0), at(a1, rTop, y1), at(a0, rTop, y1)], hex);
      addQuad(acc, [at(a0, rTop, y1), at(a1, rTop, y1), at(a1, r1 + lift, y1), at(a0, r1 + lift, y1)], ROGERS_SEAM);
    }
    domeBands.push({ radius: r1, minY: y0, maxY: y1 });
  }
  // The sliding assembly's underside at the springing — a down-facing skirt closing the 0.45 wu
  // step between the lifted panels and the ring base they overhang. Cheap insurance: without it a
  // low off-rig vantage sees straight through the gap into the back-face-culled interior.
  for (let i = 0; i < SIDES; i++) {
    if (!isSlide(i)) continue;
    const a0 = i * step;
    const a1 = a0 + step;
    addQuad(
      acc,
      [
        at(a0, domeR, ringBaseTopY),
        at(a1, domeR, ringBaseTopY),
        at(a1, domeR + ROGERS_SLIDE_LIFT, ringBaseTopY),
        at(a0, domeR + ROGERS_SLIDE_LIFT, ringBaseTopY),
      ],
      DOME_PANEL,
    );
  }

  // --- track rails + the sliding assembly's leading-edge ribs -------------------------------------
  // Four raised meridian ribs: the sector's own two edges (the leading-edge trusses, which also
  // hide the lifted/fixed radial step) and the east/west meridians (the tracks the real panels ride
  // on the stadium walls). Each side wall drops to ITS OWN neighbour's surface, so the rib closes
  // the step from both sides whatever the lift there is.
  const ribAzimuths = [slideEdgeAz, -slideEdgeAz, Math.PI / 2, -Math.PI / 2];
  for (const A of ribAzimuths) {
    const w = ROGERS_RIB_HALF_AZ;
    const outward: Vec3 = [Math.sin(A), 0, Math.cos(A)];
    const lowSide: Vec3 = [-Math.cos(A - w), 0, Math.sin(A - w)];
    const highSide: Vec3 = [Math.cos(A + w), 0, -Math.sin(A + w)];
    const footLow = liftAtAz(A - w);
    const footHigh = liftAtAz(A + w);
    for (let b = ROGERS_RIB_FIRST_BAND; b < BANDS - 1; b++) {
      const y0 = profileY(b / BANDS);
      const y1 = profileY((b + 1) / BANDS);
      const base0 = profileR(b / BANDS);
      const base1 = profileR((b + 1) / BANDS);
      const out0 = base0 + ROGERS_RIB_LIFT;
      const out1 = base1 + ROGERS_RIB_LIFT;
      addQuadOriented(
        acc,
        [at(A - w, out0, y0), at(A + w, out0, y0), at(A + w, out1, y1), at(A - w, out1, y1)],
        outward,
        ROGERS_RAIL,
      );
      addQuadOriented(
        acc,
        [at(A - w, base0 + footLow, y0), at(A - w, out0, y0), at(A - w, out1, y1), at(A - w, base1 + footLow, y1)],
        lowSide,
        ROGERS_RAIL,
      );
      addQuadOriented(
        acc,
        [at(A + w, base0 + footHigh, y0), at(A + w, out0, y0), at(A + w, out1, y1), at(A + w, base1 + footHigh, y1)],
        highSide,
        ROGERS_RAIL,
      );
    }
  }

  // --- the north-face hotel window strip ----------------------------------------------------------
  // Six segments centred on NORTH (az π): 12·(SIDES/2 − 3) … so the arc is symmetric about the
  // north meridian whatever SIDES is. Camera-invisible on-rig by the fixed bearing — it exists for
  // the off-rig postcard and for the honest north elevation.
  const HOTEL_SEGS = 6;
  const HOTEL_SEG_START = SIDES / 2 - HOTEL_SEGS / 2;
  const HOTEL_R = domeR + 0.8;
  const HOTEL_MIN_Y = 4.6;
  const HOTEL_MAX_Y = 7.4;
  const HOTEL_TAG: ProgramTag = { id: CN_PROGRAM.EMISS, t: ROGERS_EMISS_T.hotel };
  const hotelRows: readonly { y0: number; y1: number; hex: string; window: boolean }[] = [
    { y0: HOTEL_MIN_Y, y1: 4.9, hex: ROGERS_HOTEL_BAND, window: false },
    { y0: 4.9, y1: 5.7, hex: ROGERS_HOTEL_GLASS, window: true },
    { y0: 5.7, y1: 6.0, hex: ROGERS_HOTEL_BAND, window: false },
    { y0: 6.0, y1: 6.8, hex: ROGERS_HOTEL_GLASS, window: true },
    { y0: 6.8, y1: HOTEL_MAX_Y, hex: ROGERS_HOTEL_BAND, window: false },
  ];
  /** Which rooms have their lights on — a fixed, deterministic pattern (no rng: the hero mesh is
   *  built once per process and must be byte-identical on repeat). */
  const roomLit = (segment: number, row: number): boolean => (segment * 3 + row * 5) % 4 !== 0;
  for (let j = 0; j < HOTEL_SEGS; j++) {
    const a0 = (HOTEL_SEG_START + j) * step;
    const a1 = a0 + step;
    hotelRows.forEach((row, rowIndex) => {
      const lit = row.window && roomLit(j, rowIndex);
      addQuad(
        acc,
        [at(a0, HOTEL_R, row.y0), at(a1, HOTEL_R, row.y0), at(a1, HOTEL_R, row.y1), at(a0, HOTEL_R, row.y1)],
        row.hex,
        false,
        lit ? HOTEL_TAG : STATIC_TAG,
      );
    });
    // Top (up-facing) and bottom (down-facing) lips, each running 0.6 wu INTO the shell so no
    // hairline gap can open between the band and the faceted surface it is mounted on (the facets
    // cut up to ~0.27 wu inside the smooth profile `radiusAtY` returns — azimuthal chord plus the
    // band's own vertical chord).
    const rTop = radiusAtY(HOTEL_MAX_Y) - 0.6;
    const rBot = radiusAtY(HOTEL_MIN_Y) - 0.6;
    addQuad(
      acc,
      [at(a0, HOTEL_R, HOTEL_MAX_Y), at(a1, HOTEL_R, HOTEL_MAX_Y), at(a1, rTop, HOTEL_MAX_Y), at(a0, rTop, HOTEL_MAX_Y)],
      ROGERS_HOTEL_BAND,
    );
    addQuad(
      acc,
      [at(a0, rBot, HOTEL_MIN_Y), at(a1, rBot, HOTEL_MIN_Y), at(a1, HOTEL_R, HOTEL_MIN_Y), at(a0, HOTEL_R, HOTEL_MIN_Y)],
      ROGERS_HOTEL_BAND,
    );
  }
  // The strip's two end returns.
  for (const end of [0, HOTEL_SEGS]) {
    const az = (HOTEL_SEG_START + end) * step;
    const outward: Vec3 =
      end === 0 ? [-Math.cos(az), 0, Math.sin(az)] : [Math.cos(az), 0, -Math.sin(az)];
    addQuadOriented(
      acc,
      [
        at(az, radiusAtY(HOTEL_MIN_Y) - 0.6, HOTEL_MIN_Y),
        at(az, HOTEL_R, HOTEL_MIN_Y),
        at(az, HOTEL_R, HOTEL_MAX_Y),
        at(az, radiusAtY(HOTEL_MAX_Y) - 0.6, HOTEL_MAX_Y),
      ],
      outward,
      ROGERS_HOTEL_BAND,
    );
  }

  // --- the south-face LED jumbotron ----------------------------------------------------------------
  // SOUTH (+Z) is one of the two faces the fixed rig ever sees, and the real building's exterior LED
  // board is on the south face — so this is the one program element that plays to the lens.
  const JUMBO_HALF_W = 8;
  const JUMBO_MIN_Y = 5;
  const JUMBO_MAX_Y = 9.4;
  const JUMBO_Z = domeR + 1.3; // the panel plane, standing clear of the shell's inward curve
  addRadialBox(
    acc,
    0,
    // Deep enough that even the housing's TOP corners (widest x, highest y, where the shell has
    // curved furthest in) stay buried: at x = ±8.6, y = 9.9 the shell is already at z ≈ 31.1.
    domeR - 3.4,
    JUMBO_Z - 0.4, // the housing's face, 0.4 behind the panel — never coplanar with it
    JUMBO_HALF_W + 0.6,
    JUMBO_MIN_Y - 0.5,
    JUMBO_MAX_Y + 0.5,
    ROGERS_JUMBO_HOUSING,
  );
  for (let c = 0; c < ROGERS_JUMBO_CELLS; c++) {
    const x0 = -JUMBO_HALF_W + (2 * JUMBO_HALF_W * c) / ROGERS_JUMBO_CELLS;
    const x1 = -JUMBO_HALF_W + (2 * JUMBO_HALF_W * (c + 1)) / ROGERS_JUMBO_CELLS;
    addQuad(
      acc,
      [
        [x0, JUMBO_MIN_Y, JUMBO_Z],
        [x1, JUMBO_MIN_Y, JUMBO_Z],
        [x1, JUMBO_MAX_Y, JUMBO_Z],
        [x0, JUMBO_MAX_Y, JUMBO_Z],
      ],
      ROGERS_JUMBO_PANEL,
      true, // literal dark board — the baked directional shade would fight the program
      { id: CN_PROGRAM.JUMBO, t: (c + 0.5) / ROGERS_JUMBO_CELLS },
    );
  }

  // --- the two helix ramp ribbons -------------------------------------------------------------------
  // They wrap the dome's lowest ("wall") band, above the ring base's piers and gate lintels and
  // below the first rail band, so the ramp crosses nothing. The inner edge is buried 0.55 wu inside
  // the shell — the faceted band cuts inside the smooth profile by up to ~0.27 wu, and a ribbon
  // hovering off its own wall is worse than one slightly sunk into it.
  const RAMP_MIN_Y = 5.4;
  const RAMP_MAX_Y = 10.6;
  const RAMP_INNER_OFFSET = -0.55;
  const RAMP_WIDTH = 2.9;
  const RAMP_THICKNESS = 0.45;
  const DEG = Math.PI / 180;
  const ramps = [
    { minAz: 22 * DEG, maxAz: 98 * DEG, minY: RAMP_MIN_Y, maxY: RAMP_MAX_Y }, // east of the board
    { minAz: -98 * DEG, maxAz: -22 * DEG, minY: RAMP_MIN_Y, maxY: RAMP_MAX_Y }, // west of the board
  ] as const;
  for (const ramp of ramps) {
    // The west ribbon climbs the other way, so both rise AWAY from the south face they flank.
    const climbsWithAzimuth = ramp.minAz >= 0;
    const sample = (f: number) => {
      const az = ramp.minAz + (ramp.maxAz - ramp.minAz) * f;
      const y = climbsWithAzimuth ? ramp.minY + (ramp.maxY - ramp.minY) * f : ramp.maxY - (ramp.maxY - ramp.minY) * f;
      const rIn = radiusAtY(y) + RAMP_INNER_OFFSET;
      return { az, y, rIn, rOut: rIn + RAMP_WIDTH };
    };
    for (let k = 0; k < ROGERS_RAMP_SEGS; k++) {
      const a = sample(k / ROGERS_RAMP_SEGS);
      const b = sample((k + 1) / ROGERS_RAMP_SEGS);
      const mid: Vec3 = [Math.sin((a.az + b.az) / 2), 0, Math.cos((a.az + b.az) / 2)];
      addQuadOriented(
        acc,
        [at(a.az, a.rIn, a.y), at(a.az, a.rOut, a.y), at(b.az, b.rOut, b.y), at(b.az, b.rIn, b.y)],
        [0, 1, 0],
        ROGERS_RAMP_DECK,
      );
      addQuadOriented(
        acc,
        [
          at(a.az, a.rOut, a.y - RAMP_THICKNESS),
          at(b.az, b.rOut, b.y - RAMP_THICKNESS),
          at(b.az, b.rOut, b.y),
          at(a.az, a.rOut, a.y),
        ],
        mid,
        ROGERS_RAMP_FASCIA,
      );
      addQuadOriented(
        acc,
        [
          at(a.az, a.rIn, a.y - RAMP_THICKNESS),
          at(a.az, a.rOut, a.y - RAMP_THICKNESS),
          at(b.az, b.rOut, b.y - RAMP_THICKNESS),
          at(b.az, b.rIn, b.y - RAMP_THICKNESS),
        ],
        [0, -1, 0],
        ROGERS_RAMP_FASCIA,
      );
    }
    for (const f of [0, 1]) {
      const e = sample(f);
      const outward: Vec3 =
        f === 0 ? [-Math.cos(e.az), 0, Math.sin(e.az)] : [Math.cos(e.az), 0, -Math.sin(e.az)];
      addQuadOriented(
        acc,
        [
          at(e.az, e.rIn, e.y - RAMP_THICKNESS),
          at(e.az, e.rOut, e.y - RAMP_THICKNESS),
          at(e.az, e.rOut, e.y),
          at(e.az, e.rIn, e.y),
        ],
        outward,
        ROGERS_RAMP_FASCIA,
      );
    }
  }

  return {
    geometry: toGeometry(acc),
    meta: {
      triangles: acc.positions.length / 9,
      height: h,
      domeDiameter: domeR * 2,
      ringBaseTopY,
      apexY: h,
      // Same collider CLASS as v1 (§5's ring-base cylinder) — v2 adds nothing the car can reach:
      // every new element either sits on the ring base (piers, gates) or starts above 5 wu.
      collider: { radius: domeR, halfHeight: ringBaseTopY / 2 + 0.1, centerY: ringBaseTopY / 2 + 0.1 },
      domeBands,
      jumbotron: {
        minX: -JUMBO_HALF_W,
        maxX: JUMBO_HALF_W,
        minY: JUMBO_MIN_Y,
        maxY: JUMBO_MAX_Y,
        z: JUMBO_Z,
        cells: ROGERS_JUMBO_CELLS,
      },
      jumboCells: ROGERS_JUMBO_CELLS,
      gates: { azimuths: gateAzimuths, glowMinY: GATE_GLOW_MIN_Y, glowMaxY: GATE_GLOW_MAX_Y },
      hotel: {
        minY: HOTEL_MIN_Y,
        maxY: HOTEL_MAX_Y,
        radius: HOTEL_R,
        minAz: HOTEL_SEG_START * step,
        maxAz: (HOTEL_SEG_START + HOTEL_SEGS) * step,
      },
      slideSector: { halfAngle: slideEdgeAz, lift: ROGERS_SLIDE_LIFT },
      ramps,
    },
  };
}
