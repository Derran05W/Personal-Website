// Toronto map v2 — hero primitive meshes (TORONTO-MAP-SPEC-v2.md §5, Addendum A.3/A.5;
// phase-25-plan Task 1). The CN Tower and Rogers Centre, hand-built from primitives per the
// spec's own decision ("hand-build from primitives; use CC models as proportion reference only")
// — Sketchfab CC meshes are 42k–87k tris and clash with the flat/vertex-coloured box aesthetic
// by two orders of magnitude, so primitives ARE the right look, not a compromise.
//
// SINGLE SOURCE OF TRUTH: total heights come from data/toronto/building-specs.json via
// hGame(real_h_m) — the same rule namedBuildings.ts follows. Nothing here hardcodes a height or a
// footprint; the §5 proportion fractions (0.62/0.81·h pod centres, top-12% needle, bottom-8%
// legs, ⌀66 dome) are the only literals, and each is asserted by heroes.test.ts against the band
// the spec names.
//
// UNLIT-LITERAL, like every other Toronto surface (the P23/P24 "material verdict": a grazing
// blue-hour sun crushes lit boxes to black, so the authored colour IS the on-screen colour). To
// keep a single flat-coloured mesh from reading as a silhouette we BAKE a cheap directional shade
// into the vertex colours per face (facets facing the light read brighter) — the classic low-poly
// trick — while the EMISSIVE pod ring keeps its full brightness (bright red/white texels ARE the
// LED ring on an unlit slice, the same trick the window textures use). One merged non-indexed
// BufferGeometry per hero → one draw call each; triangle count = position.count / 3 (test-pinned).
//
// Pure geometry: three's BufferGeometry/Color are pure JS (no WebGL), so this whole module runs
// in the vitest/jsdom env and its tri budgets + proportions are unit-testable without a canvas.

import { BufferGeometry, Color, Float32BufferAttribute } from 'three';
import buildingSpecsJson from '../../../../data/toronto/building-specs.json';
import { hGame } from './heightCurve';

/** A.3 tri budgets — exported so the test and any future perf audit share one source. */
export const CN_TOWER_MAX_TRIS = 600 as const;
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
const CONCRETE = '#8f8c95'; // CN grey precast shaft/needle/legs
const GLASS_POD = '#8098ad'; // CN observation + SkyPod glass
const RING_RED = '#ff4747'; // pod-ring LED (bright — reads as light on the unlit slice)
const RING_WHITE = '#fff0f0';
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

// --- geometry accumulator (non-indexed, flat-shaded, per-vertex colour) ----------------------
type Vec3 = readonly [number, number, number];
interface Accum {
  readonly positions: number[];
  readonly normals: number[];
  readonly colors: number[];
}
const createAccum = (): Accum => ({ positions: [], normals: [], colors: [] });

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
function addTri(acc: Accum, a: Vec3, b: Vec3, c: Vec3, hex: string, emissive = false): void {
  const [nx, ny, nz] = faceNormal(a, b, c);
  const [r, g, bl] = linearRgb(hex);
  const s = emissive ? 1 : shadeFor(nx, ny, nz);
  for (const p of [a, b, c]) {
    acc.positions.push(p[0], p[1], p[2]);
    acc.normals.push(nx, ny, nz);
    acc.colors.push(r * s, g * s, bl * s);
  }
}

/** Quad (0,1,2)+(0,2,3), wound CCW as seen from outside so the baked normal points outward. */
function addQuad(acc: Accum, corners: readonly [Vec3, Vec3, Vec3, Vec3], hex: string, emissive = false): void {
  addTri(acc, corners[0], corners[1], corners[2], hex, emissive);
  addTri(acc, corners[0], corners[2], corners[3], hex, emissive);
}

interface RingOpts {
  readonly capBottom?: boolean;
  readonly capTop?: boolean;
  readonly emissive?: boolean;
  /** Per-segment colour override (LED ring alternation, sliding-panel slice). */
  readonly colorAt?: (segment: number, sides: number) => string;
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
  const ring = (radius: number, y: number, i: number): Vec3 => {
    const ang = i * step;
    return [radius * Math.sin(ang), y, radius * Math.cos(ang)];
  };
  const colorOf = (i: number): string => opts.colorAt?.(i, sides) ?? hex;
  for (let i = 0; i < sides; i++) {
    const b0 = ring(baseRadius, y0, i);
    const b1 = ring(baseRadius, y0, i + 1);
    const t1 = ring(topRadius, y1, i + 1);
    const t0 = ring(topRadius, y1, i);
    if (topRadius === 0) {
      addTri(acc, b0, b1, [0, y1, 0], colorOf(i), opts.emissive);
    } else if (baseRadius === 0) {
      addTri(acc, [0, y0, 0], t1, t0, colorOf(i), opts.emissive);
    } else {
      addQuad(acc, [b0, b1, t1, t0], colorOf(i), opts.emissive);
    }
  }
  if (opts.capBottom && baseRadius > 0) {
    const c: Vec3 = [0, y0, 0];
    for (let i = 0; i < sides; i++) addTri(acc, c, ring(baseRadius, y0, i + 1), ring(baseRadius, y0, i), hex, opts.emissive);
  }
  if (opts.capTop && topRadius > 0) {
    const c: Vec3 = [0, y1, 0];
    for (let i = 0; i < sides; i++) addTri(acc, c, ring(topRadius, y1, i), ring(topRadius, y1, i + 1), hex, opts.emissive);
  }
}

/** A box in local XZ, yawed about Y and dropped at world (ox, oz). Local +Z is the "outward"
 * radial axis before yaw. Emits all six faces with correct outward normals (rotated locals). */
function addYawBox(
  acc: Accum,
  local: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number },
  yaw: number,
  ox: number,
  oz: number,
  hex: string,
): void {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const tp = (x: number, y: number, z: number): Vec3 => [x * cy + z * sy + ox, y, -x * sy + z * cy + oz];
  const { minX, maxX, minY, maxY, minZ, maxZ } = local;
  // 8 corners
  const p000 = tp(minX, minY, minZ);
  const p100 = tp(maxX, minY, minZ);
  const p110 = tp(maxX, maxY, minZ);
  const p010 = tp(minX, maxY, minZ);
  const p001 = tp(minX, minY, maxZ);
  const p101 = tp(maxX, minY, maxZ);
  const p111 = tp(maxX, maxY, maxZ);
  const p011 = tp(minX, maxY, maxZ);
  addQuad(acc, [p001, p101, p111, p011], hex); // +Z (outward)
  addQuad(acc, [p100, p000, p010, p110], hex); // -Z
  addQuad(acc, [p101, p100, p110, p111], hex); // +X
  addQuad(acc, [p000, p001, p011, p010], hex); // -X
  addQuad(acc, [p010, p011, p111, p110], hex); // +Y
  addQuad(acc, [p000, p100, p101, p001], hex); // -Y
}

function toGeometry(acc: Accum): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(acc.positions, 3));
  g.setAttribute('normal', new Float32BufferAttribute(acc.normals, 3));
  g.setAttribute('color', new Float32BufferAttribute(acc.colors, 3));
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
  readonly legTopY: number;
  /** Base-cylinder collider hint (radius / half-height / centre-y) for the scene. */
  readonly collider: { readonly radius: number; readonly halfHeight: number; readonly centerY: number };
}

export interface CnTowerModel {
  readonly geometry: BufferGeometry;
  readonly meta: CnTowerMeta;
}

/** CN Tower: 3-segment hex taper shaft (⌀21→⌀6) + thin upper shaft, a squashed observation pod at
 * 0.62·h wrapped by an emissive red/white LED ring, a SkyPod at 0.81·h, a cone+cylinder needle in
 * the top 12%, and 3 splayed buttress legs in the bottom 8%. ≤ 600 tris (test-pinned). */
export function buildCnTowerGeometry(): CnTowerModel {
  const s = heroSpec('cn-tower');
  const h = hGame(s.real_h_m);
  const baseR = s.footprint_wu / 2; // 10.5 (⌀21)
  const belowPodR = 3; // ⌀6 below the pod

  const podCenterY = 0.62 * h;
  const skyPodCenterY = 0.81 * h;
  const needleMinY = 0.88 * h; // top 12%
  const legTopY = 0.077 * h; // bottom ~8%

  const podHalfH = 3.6;
  const podR = 7.2;
  const podBottomY = podCenterY - podHalfH;
  const podTopY = podCenterY + podHalfH;

  const acc = createAccum();

  // Shaft: three taper segments from the base (⌀21) to ⌀6 just below the pod (the "3 taper
  // segments" §5 names). Radii lerp linearly base→belowPod across the three equal Y spans.
  const shaftTopY = podBottomY;
  const radiusAt = (y: number): number => baseR + (belowPodR - baseR) * (y / shaftTopY);
  for (let i = 0; i < 3; i++) {
    const yA = (shaftTopY * i) / 3;
    const yB = (shaftTopY * (i + 1)) / 3;
    addPrismFrustum(acc, 6, yA, yB, radiusAt(yA), radiusAt(yB), CONCRETE, { capBottom: i === 0 });
  }
  // Thin upper shaft, pod → needle (continues past both pods, slight continued taper).
  addPrismFrustum(acc, 6, podBottomY, needleMinY, belowPodR, 2.2, CONCRETE);

  // Main observation pod — a squashed 16-gon cylinder centred at 0.62·h.
  addPrismFrustum(acc, 16, podBottomY, podTopY, podR, podR, GLASS_POD, { capBottom: true, capTop: true });

  // Emissive LED pod ring — a bright red/white band around the pod's waist (alternating segments).
  const ringMinY = podCenterY - 1.3;
  const ringMaxY = podCenterY + 1.3;
  addPrismFrustum(acc, 16, ringMinY, ringMaxY, podR + 0.35, podR + 0.35, RING_RED, {
    emissive: true,
    colorAt: (i) => (i % 2 === 0 ? RING_RED : RING_WHITE),
  });

  // SkyPod — a smaller squashed 12-gon cylinder at 0.81·h.
  const skyHalfH = 2;
  const skyR = 4.6;
  addPrismFrustum(acc, 12, skyPodCenterY - skyHalfH, skyPodCenterY + skyHalfH, skyR, skyR, GLASS_POD, {
    capBottom: true,
    capTop: true,
  });

  // Needle — cylinder + cone occupying the top 12% (bottom at 0.88·h, apex at h).
  const needleCylTopY = needleMinY + (h - needleMinY) * 0.45;
  addPrismFrustum(acc, 8, needleMinY, needleCylTopY, 1.5, 1.2, CONCRETE, { capBottom: true });
  addPrismFrustum(acc, 8, needleCylTopY, h, 1.2, 0, CONCRETE);

  // Three splayed buttress legs on the bottom 8% (Y-legs, at 120°).
  for (let k = 0; k < 3; k++) {
    const yaw = (k * Math.PI * 2) / 3;
    addYawBox(acc, { minX: -2.6, maxX: 2.6, minY: 0, maxY: legTopY, minZ: 2, maxZ: 9.5 }, yaw, 0, 0, CONCRETE);
  }

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
      collider: { radius: 10.5, halfHeight: legTopY / 2 + 0.2, centerY: legTopY / 2 + 0.2 },
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
