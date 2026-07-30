// Phase 46 (Part 11) — THE SHARED BESPOKE-MESH TOOLKIT.
//
// Every hand-built Toronto landmark is the same kind of object: ONE merged, non-indexed,
// flat-shaded, vertex-coloured BufferGeometry with a cheap directional shade baked into the
// colours (the unlit-literal slice — the P23/P24 material verdict — plus the classic low-poly
// trick that keeps a single flat-coloured mesh from reading as a silhouette). heroes.ts grew that
// accumulator first; railLands.ts deliberately kept its OWN copy of it (its header records why:
// heroes.ts owns the Phase-44 night-program vertex attributes and is not a general toolkit).
//
// Phase 46 introduces the `namedGeometryBuilders` seam, which by design hosts MANY builders — this
// phase's Union Station and Royal York, and Phases 47/48/51/52/54 after them. A private copy of
// the accumulator per builder is a copy per phase, so the third copy becomes the LAST one: this
// module is the shared leaf every bespoke named builder imports. heroes.ts and railLands.ts are
// deliberately NOT migrated onto it — both are shipped, tri-count-pinned and byte-identity-tested,
// and re-plumbing them would churn goldens for zero user-visible gain.
//
// WINDING IS NEVER HAND-TRUSTED where it matters: `addFace`/`addTriFacing` take the direction the
// face is MEANT to point and fix the winding themselves (heroes.ts's `addQuadOriented` idea), so a
// back-face-culled invisible wall — the single easiest mistake in hand-wound geometry — cannot
// ship. `addBox` hand-winds (it is axis-aligned and exhaustively covered by the box tests) and
// takes a FACE MASK so a builder never pays triangles for faces it has buried inside another
// solid.
//
// Pure geometry: three's BufferGeometry/Color are pure JS (no WebGL), so everything here runs in
// the vitest/jsdom env and every tri budget built on it is unit-testable without a canvas.

import { BufferGeometry, Color, Float32BufferAttribute } from 'three';

export type Vec3 = readonly [number, number, number];
export type Uv = readonly [number, number];
export type Quad = readonly [Vec3, Vec3, Vec3, Vec3];

/** Baked dusk key over +x / up / +z (roughly the §5.3 camera bearing), so the facets the camera
 * sees catch the most light. Identical to heroes.ts's and railLands.ts's — the three modules must
 * shade the same way or two adjacent landmarks read as two different times of day. */
const LIGHT: readonly [number, number, number] = (() => {
  const [x, y, z] = [0.45, 1, 0.5];
  const len = Math.hypot(x, y, z);
  return [x / len, y / len, z / len];
})();
const SHADE_MIN = 0.5;

export interface Accum {
  readonly positions: number[];
  readonly normals: number[];
  readonly colors: number[];
  /** UVs ride along so textured SIGN quads share one accumulator shape with the solids. */
  readonly uvs: number[];
}

export function createAccum(): Accum {
  return { positions: [], normals: [], colors: [], uvs: [] };
}

/** Triangles accumulated so far — the tri-budget measure (3 vertices × 3 floats per triangle). */
export function triangleCount(acc: Accum): number {
  return acc.positions.length / 9;
}

const scratchColor = new Color();

/** sRGB hex → linear rgb (three's ColorManagement path — matches every other vertexColors mesh). */
export function linearRgb(hex: string): [number, number, number] {
  scratchColor.set(hex);
  return [scratchColor.r, scratchColor.g, scratchColor.b];
}

export function faceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
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

export interface FaceOpts {
  /** Skip the baked directional shade (textured sign quads must stay full-bright). */
  readonly unshaded?: boolean;
  readonly uv?: readonly Uv[];
}

/** One flat triangle: normal from winding, colour = base × baked shade. */
export function addTri(acc: Accum, a: Vec3, b: Vec3, c: Vec3, hex: string, opts: FaceOpts = {}): void {
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
export function addQuad(acc: Accum, q: Quad, hex: string, opts: FaceOpts = {}): void {
  const uv = opts.uv;
  addTri(acc, q[0], q[1], q[2], hex, { ...opts, uv: uv ? [uv[0], uv[1], uv[2]] : undefined });
  addTri(acc, q[0], q[2], q[3], hex, { ...opts, uv: uv ? [uv[0], uv[2], uv[3]] : undefined });
}

/** A quad whose winding is CORRECTED to face `outward`. */
export function addFace(acc: Accum, q: Quad, outward: Vec3, hex: string, opts: FaceOpts = {}): void {
  const [nx, ny, nz] = faceNormal(q[0], q[1], q[2]);
  if (nx * outward[0] + ny * outward[1] + nz * outward[2] >= 0) {
    addQuad(acc, q, hex, opts);
  } else {
    const uv = opts.uv;
    addQuad(acc, [q[3], q[2], q[1], q[0]], hex, {
      ...opts,
      uv: uv ? [uv[3], uv[2], uv[1], uv[0]] : undefined,
    });
  }
}

/** A triangle whose winding is corrected to face `outward`. */
export function addTriFacing(acc: Accum, a: Vec3, b: Vec3, c: Vec3, outward: Vec3, hex: string): void {
  const [nx, ny, nz] = faceNormal(a, b, c);
  if (nx * outward[0] + ny * outward[1] + nz * outward[2] >= 0) addTri(acc, a, b, c, hex);
  else addTri(acc, a, c, b, hex);
}

/**
 * Which faces of an axis-aligned box to emit. Every flag defaults to TRUE except `ny` (a box's
 * underside is never visible under the fixed §5.3 camera and is never built) — so a builder pays
 * only for the faces it can actually see, and burying a face inside another solid is a one-word
 * change rather than a hand-wound special case.
 */
export interface BoxFaces {
  readonly pz?: boolean;
  readonly nz?: boolean;
  readonly px?: boolean;
  readonly nx?: boolean;
  readonly py?: boolean;
  readonly ny?: boolean;
}

const ALL_FACES: Required<BoxFaces> = { pz: true, nz: true, px: true, nx: true, py: true, ny: false };

/**
 * An axis-aligned box. `faces` masks individual faces (see BoxFaces); `opts` is the same FaceOpts
 * every other primitive takes — Phase 47 added it so a full-bright box (a lit sign letter, a flag)
 * doesn't have to be hand-wound out of `addFace` calls just to skip the directional bake.
 */
export function addBox(
  acc: Accum,
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
  hex: string,
  faces: BoxFaces = {},
  opts: FaceOpts = {},
): void {
  const f = { ...ALL_FACES, ...faces };
  const x0 = cx - hx;
  const x1 = cx + hx;
  const y0 = cy - hy;
  const y1 = cy + hy;
  const z0 = cz - hz;
  const z1 = cz + hz;
  if (f.pz) addQuad(acc, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], hex, opts);
  if (f.nz) addQuad(acc, [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], hex, opts);
  if (f.px) addQuad(acc, [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], hex, opts);
  if (f.nx) addQuad(acc, [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], hex, opts);
  if (f.py) addQuad(acc, [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], hex, opts);
  if (f.ny) addQuad(acc, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], hex, opts);
}

export interface PrismOpts {
  /** Azimuth of vertex 0 (radians) — rolls an N-gon so a FACET, not a corner, faces a chosen way. */
  readonly angleOffset?: number;
  readonly capTop?: boolean;
  readonly capBottom?: boolean;
}

/**
 * An N-gon prism / frustum standing on the Y axis (`r0` at `y0` → `r1` at `y1`), centred on
 * (cx, cz). Caps are optional and OFF by default: a column whose capital is covered by the
 * entablature above it must not pay 4 triangles for a face nobody can see.
 */
export function addPrismY(
  acc: Accum,
  sides: number,
  y0: number,
  y1: number,
  cx: number,
  cz: number,
  r0: number,
  r1: number,
  hex: string,
  opts: PrismOpts = {},
): void {
  const step = (Math.PI * 2) / sides;
  const offset = opts.angleOffset ?? 0;
  const at = (y: number, r: number, i: number): Vec3 => [
    cx + r * Math.sin(i * step + offset),
    y,
    cz + r * Math.cos(i * step + offset),
  ];
  for (let i = 0; i < sides; i++) {
    const mid = (i + 0.5) * step + offset;
    const out: Vec3 = [Math.sin(mid), 0, Math.cos(mid)];
    addFace(acc, [at(y0, r0, i), at(y0, r0, i + 1), at(y1, r1, i + 1), at(y1, r1, i)], out, hex);
  }
  if (opts.capTop) {
    for (let i = 1; i + 1 < sides; i++) addTriFacing(acc, at(y1, r1, 0), at(y1, r1, i), at(y1, r1, i + 1), [0, 1, 0], hex);
  }
  if (opts.capBottom) {
    for (let i = 1; i + 1 < sides; i++) addTriFacing(acc, at(y0, r0, 0), at(y0, r0, i), at(y0, r0, i + 1), [0, -1, 0], hex);
  }
}

// --- circular arcs in plan (Phase 47) ------------------------------------------------------------
//
// Phase 46's toolkit could build anything derived from a BOX or a centred N-gon prism, which is
// every landmark the seam had. Phase 47's Toronto City Hall is the first one whose PLAN is a curve:
// two crescent office slabs embracing a saucer. Building that with private arithmetic inside
// newCityHall.ts would be exactly the "third copy" this module's header exists to prevent (the P46
// handoff names an arc helper as the toolkit's expected next growth), so the three primitives a
// curved-plan landmark actually needs live here: a curved WALL band, a curved horizontal RING, and
// the point/normal/tangent accessors detail (rib fins, dormers, signage) hangs off.

/**
 * A horizontal circular arc: centre `(cx, cz)`, angular span `[a0, a1]` split into `segments`
 * facets. Angle convention: `x = cx + r·cos(a)`, `z = cz + r·sin(a)` — `a = 0` points +X and
 * `a = π/2` points +Z. `a1 < a0` is legal (the arc simply runs the other way); every helper below
 * derives its own outward direction from the angle, so winding is never hand-trusted.
 */
export interface ArcSpec {
  readonly cx: number;
  readonly cz: number;
  readonly a0: number;
  readonly a1: number;
  readonly segments: number;
}

/** Angle (radians) at arc parameter `i` — 0 … `segments`, fractional values allowed (a rib fin
 * sitting at a FACET CENTRE, i.e. `i + 0.5`, is the reason this takes a float). */
export function arcAngle(arc: ArcSpec, i: number): number {
  return arc.a0 + ((arc.a1 - arc.a0) * i) / arc.segments;
}

/** The point at parameter `i`, radius `r`, height `y`. */
export function arcPoint(arc: ArcSpec, i: number, r: number, y: number): Vec3 {
  const a = arcAngle(arc, i);
  return [arc.cx + r * Math.cos(a), y, arc.cz + r * Math.sin(a)];
}

/** Unit vector pointing radially AWAY from the arc centre at parameter `i`. */
export function arcOutward(arc: ArcSpec, i: number): Vec3 {
  const a = arcAngle(arc, i);
  return [Math.cos(a), 0, Math.sin(a)];
}

/** Unit vector along the arc, in the direction of increasing `i`. */
export function arcTangent(arc: ArcSpec, i: number): Vec3 {
  const a = arcAngle(arc, i);
  const s = Math.sign(arc.a1 - arc.a0) || 1;
  return [-Math.sin(a) * s, 0, Math.cos(a) * s];
}

/**
 * A curved WALL band: `segments` quads at radius `r`, from `y0` to `y1`, facing radially outward
 * (`'out'`) or inward (`'in'`). Stacking several bands with shared Y edges is the row-strip
 * pattern the GO shed's ribs use (adjacent strips of ONE surface, never overlapping ones), which
 * is what lets a lit-window band sit in a concrete wall with no offset and no z-fight.
 */
export function addArcBand(
  acc: Accum,
  arc: ArcSpec,
  r: number,
  y0: number,
  y1: number,
  hex: string,
  facing: 'out' | 'in',
  opts: FaceOpts = {},
): void {
  const sign = facing === 'out' ? 1 : -1;
  for (let i = 0; i < arc.segments; i++) {
    const n = arcOutward(arc, i + 0.5);
    const outward: Vec3 = [n[0] * sign, 0, n[2] * sign];
    addFace(
      acc,
      [arcPoint(arc, i, r, y0), arcPoint(arc, i + 1, r, y0), arcPoint(arc, i + 1, r, y1), arcPoint(arc, i, r, y1)],
      outward,
      hex,
      opts,
    );
  }
}

/** A curved horizontal RING strip between two radii at one height — a curved wall's top cap, or a
 * curved band painted on the ground. */
export function addArcRing(
  acc: Accum,
  arc: ArcSpec,
  rInner: number,
  rOuter: number,
  y: number,
  hex: string,
  facing: 'up' | 'down' = 'up',
  opts: FaceOpts = {},
): void {
  const outward: Vec3 = facing === 'up' ? [0, 1, 0] : [0, -1, 0];
  for (let i = 0; i < arc.segments; i++) {
    addFace(
      acc,
      [arcPoint(arc, i, rInner, y), arcPoint(arc, i, rOuter, y), arcPoint(arc, i + 1, rOuter, y), arcPoint(arc, i + 1, rInner, y)],
      outward,
      hex,
      opts,
    );
  }
}

/** Freeze an accumulator into a BufferGeometry. `withUv` emits the uv attribute (sign meshes). */
export function toGeometry(acc: Accum, withUv: boolean): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(acc.positions, 3));
  g.setAttribute('normal', new Float32BufferAttribute(acc.normals, 3));
  g.setAttribute('color', new Float32BufferAttribute(acc.colors, 3));
  if (withUv) g.setAttribute('uv', new Float32BufferAttribute(acc.uvs, 2));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}
