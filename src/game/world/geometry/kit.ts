// Low-level indexed-geometry accumulator shared by every world/geometry/*.ts builder (TDD
// §8.1-8.2; CLAUDE.md's low-poly/flat-shaded/single-palette-texture conventions).
//
// EVERY face this kit emits samples ONE palette cell: all vertices of a face carry the SAME
// uv (and uv2) value — the cell's exact center (world/archetypes.ts's paletteCellUv) —
// because every palette cell is a flat, unlerped colour, so there is nothing to interpolate
// across a face and sampling dead-center avoids any bilinear bleed into a neighbouring cell.
// `uv` is the albedo sample; `uv2` is the emissive sample, gated per-INSTANCE (not per-face)
// by the shared material's aEmissiveOn attribute (world/palette.ts, Phase 5 Task 1).
//
// uv2-for-non-emissive-faces choice (documented per the Task 2 brief): every non-emissive
// face still needs a real uv2 the shader can safely sample — see DEFAULT_EMISSIVE_CELL below.
//
// Flat shading throughout: normals are per-FACE (hard edges), so every face gets its own
// unique vertices even where positions coincide with a neighbouring face — nothing here ever
// calls computeVertexNormals() (that would smooth/average and destroy the chunky look).
//
// All builders below produce ONE indexed BufferGeometry per call via toBufferGeometry() —
// no merging of separately-created BufferGeometry instances (and no dependency on
// three/examples/jsm/utils/BufferGeometryUtils, which ships no .d.ts in this three version
// and would break `pnpm typecheck`); every part (walls, windows, poles, arms…) is appended
// straight into the same accumulator instead.

import { BufferGeometry, Float32BufferAttribute } from 'three';
import { PaletteCell, paletteCellUv } from '../archetypes';

export type Vec3 = readonly [number, number, number];

/** Mutable accumulator threaded by reference through a family of add* calls, then frozen
 * into a BufferGeometry once via toBufferGeometry(). */
export interface GeometryBuilder {
  readonly positions: number[];
  readonly normals: number[];
  readonly uvs: number[];
  readonly uv2s: number[];
  readonly indices: number[];
}

export function createBuilder(): GeometryBuilder {
  return { positions: [], normals: [], uvs: [], uv2s: [], indices: [] };
}

/**
 * Default uv2 for faces that never emit light. `asphalt` is a guaranteed-dark, never-
 * emissive palette cell, so even a worst-case sampling mistake (e.g. an emissive term
 * leaking across an instance boundary inside one draw call) reads as "off", never as a
 * stray bright artifact — cheaper and safer than trying to special-case "no emissive
 * contribution" in the shader itself. Emissive faces (windows, streetlight heads, signal
 * cells) pass their real emissive cell explicitly instead of relying on this default.
 */
const DEFAULT_EMISSIVE_CELL: number = PaletteCell.asphalt;

function pushVertex(b: GeometryBuilder, p: Vec3, n: Vec3, albedoCell: number, emissiveCell: number): void {
  const uv = paletteCellUv(albedoCell);
  const uv2 = paletteCellUv(emissiveCell);
  b.positions.push(p[0], p[1], p[2]);
  b.normals.push(n[0], n[1], n[2]);
  b.uvs.push(uv.u, uv.v);
  b.uv2s.push(uv2.u, uv2.v);
}

/**
 * Append one flat-shaded quad. `corners` must be wound CCW as seen from the direction
 * `normal` points (three.js front-face convention) — the two triangles are (0,1,2) and
 * (0,2,3). All 4 vertices sample the same palette cell centers (see file header).
 */
export function addQuad(
  b: GeometryBuilder,
  corners: readonly [Vec3, Vec3, Vec3, Vec3],
  normal: Vec3,
  albedoCell: number,
  emissiveCell: number = DEFAULT_EMISSIVE_CELL,
): void {
  const base = b.positions.length / 3;
  for (const c of corners) pushVertex(b, c, normal, albedoCell, emissiveCell);
  b.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function faceNormal(v0: Vec3, v1: Vec3, v2: Vec3): Vec3 {
  const ax = v1[0] - v0[0];
  const ay = v1[1] - v0[1];
  const az = v1[2] - v0[2];
  const bx = v2[0] - v0[0];
  const by = v2[1] - v0[1];
  const bz = v2[2] - v0[2];
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/** Like addQuad, but the flat normal is computed from the corners themselves (cross
 * product of the first two edges) instead of supplied — for non-axis-aligned quads (prism
 * sides, angled arms) where hand-deriving the normal isn't worth it. */
export function addQuadAuto(
  b: GeometryBuilder,
  corners: readonly [Vec3, Vec3, Vec3, Vec3],
  albedoCell: number,
  emissiveCell: number = DEFAULT_EMISSIVE_CELL,
): void {
  addQuad(b, corners, faceNormal(corners[0], corners[1], corners[2]), albedoCell, emissiveCell);
}

/** Append one flat-shaded triangle with an explicit (planar) normal — used for prism end
 * caps, where a quad fan would otherwise degrade to N-2 nearly-flat triangles anyway. */
export function addTri(
  b: GeometryBuilder,
  v0: Vec3,
  v1: Vec3,
  v2: Vec3,
  normal: Vec3,
  albedoCell: number,
  emissiveCell: number = DEFAULT_EMISSIVE_CELL,
): void {
  const base = b.positions.length / 3;
  pushVertex(b, v0, normal, albedoCell, emissiveCell);
  pushVertex(b, v1, normal, albedoCell, emissiveCell);
  pushVertex(b, v2, normal, albedoCell, emissiveCell);
  b.indices.push(base, base + 1, base + 2);
}

export interface FaceCells {
  readonly albedo: number;
  readonly emissive?: number;
}

export interface BoxFaces {
  readonly px?: FaceCells;
  readonly nx?: FaceCells;
  readonly py?: FaceCells;
  readonly ny?: FaceCells;
  readonly pz?: FaceCells;
  readonly nz?: FaceCells;
}

export interface BoxExtent {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/**
 * Axis-aligned box built from explicit min/max extents (NOT centered — callers position it
 * by choosing the extents directly, keeping every part's origin math in one place). Any
 * face may be omitted (buried/interior/never-seen faces cost zero triangles). Winding for
 * each included face is hand-verified to produce the correct outward normal via the
 * cross-product convention (see faceNormal/addQuad above).
 */
export function addBox(b: GeometryBuilder, e: BoxExtent, faces: BoxFaces): void {
  const { minX, maxX, minY, maxY, minZ, maxZ } = e;
  if (faces.px) {
    addQuad(
      b,
      [
        [maxX, minY, maxZ],
        [maxX, minY, minZ],
        [maxX, maxY, minZ],
        [maxX, maxY, maxZ],
      ],
      [1, 0, 0],
      faces.px.albedo,
      faces.px.emissive,
    );
  }
  if (faces.nx) {
    addQuad(
      b,
      [
        [minX, minY, minZ],
        [minX, minY, maxZ],
        [minX, maxY, maxZ],
        [minX, maxY, minZ],
      ],
      [-1, 0, 0],
      faces.nx.albedo,
      faces.nx.emissive,
    );
  }
  if (faces.py) {
    addQuad(
      b,
      [
        [minX, maxY, minZ],
        [minX, maxY, maxZ],
        [maxX, maxY, maxZ],
        [maxX, maxY, minZ],
      ],
      [0, 1, 0],
      faces.py.albedo,
      faces.py.emissive,
    );
  }
  if (faces.ny) {
    addQuad(
      b,
      [
        [minX, minY, maxZ],
        [minX, minY, minZ],
        [maxX, minY, minZ],
        [maxX, minY, maxZ],
      ],
      [0, -1, 0],
      faces.ny.albedo,
      faces.ny.emissive,
    );
  }
  if (faces.pz) {
    addQuad(
      b,
      [
        [minX, minY, maxZ],
        [maxX, minY, maxZ],
        [maxX, maxY, maxZ],
        [minX, maxY, maxZ],
      ],
      [0, 0, 1],
      faces.pz.albedo,
      faces.pz.emissive,
    );
  }
  if (faces.nz) {
    addQuad(
      b,
      [
        [maxX, minY, minZ],
        [minX, minY, minZ],
        [minX, maxY, minZ],
        [maxX, maxY, minZ],
      ],
      [0, 0, -1],
      faces.nz.albedo,
      faces.nz.emissive,
    );
  }
}

export interface PrismOptions {
  readonly capTop?: boolean;
  readonly capBottom?: boolean;
  /** Local XZ offset of the prism's central axis — lets a caller place several prisms
   * (e.g. transformerBox's insulator knobs) at different points within ONE accumulator
   * without a separate translate pass. Defaults to the origin. */
  readonly offsetX?: number;
  readonly offsetZ?: number;
}

/**
 * Low-poly (`sides`-gon) prism/frustum/cone centered on the local Y axis (optionally offset
 * in XZ — see PrismOptions), base ring at `minY`, top ring at `maxY`. `topRadius ===
 * baseRadius` gives a straight prism (chunky "cylinder"); `topRadius === 0` gives a true
 * cone (apex point, no cap needed — degenerate top edge, so `capTop` is ignored when
 * topRadius is 0); anything between gives a tapered frustum. Ring angle 0 sits on +Z (so an
 * un-rotated prism's "front" reads along +Z, in keeping with the file-family's +Z-forward
 * convention for orientable parts).
 */
export function addPrismFrustum(
  b: GeometryBuilder,
  sides: number,
  minY: number,
  maxY: number,
  baseRadius: number,
  topRadius: number,
  cell: number,
  options: PrismOptions = {},
): void {
  const step = (Math.PI * 2) / sides;
  const ox = options.offsetX ?? 0;
  const oz = options.offsetZ ?? 0;
  const ringAt = (radius: number, y: number, i: number): Vec3 => {
    const a = i * step;
    return [radius * Math.sin(a) + ox, y, radius * Math.cos(a) + oz];
  };
  for (let i = 0; i < sides; i++) {
    const b0 = ringAt(baseRadius, minY, i);
    const b1 = ringAt(baseRadius, minY, i + 1);
    const t1 = ringAt(topRadius, maxY, i + 1);
    const t0 = ringAt(topRadius, maxY, i);
    // True cone (either end collapsed to a point): a quad here would be degenerate — one
    // of its two triangles has zero area — so emit the real single triangle instead. Halves
    // the triangle cost of e.g. buildTree()'s foliage cones vs. the naive quad approach.
    if (topRadius === 0) {
      const apex: Vec3 = [ox, maxY, oz];
      addTri(b, b0, b1, apex, faceNormal(b0, b1, apex), cell);
    } else if (baseRadius === 0) {
      const apex: Vec3 = [ox, minY, oz];
      addTri(b, apex, t1, t0, faceNormal(apex, t1, t0), cell);
    } else {
      addQuadAuto(b, [b0, b1, t1, t0], cell);
    }
  }
  if (options.capTop && topRadius > 0) {
    const center: Vec3 = [ox, maxY, oz];
    for (let i = 0; i < sides; i++) {
      addTri(b, center, ringAt(topRadius, maxY, i), ringAt(topRadius, maxY, i + 1), [0, 1, 0], cell);
    }
  }
  if (options.capBottom && baseRadius > 0) {
    const center: Vec3 = [ox, minY, oz];
    for (let i = 0; i < sides; i++) {
      addTri(b, center, ringAt(baseRadius, minY, i + 1), ringAt(baseRadius, minY, i), [0, -1, 0], cell);
    }
  }
}

/** Freeze an accumulator into an indexed BufferGeometry (position/normal/uv/uv2), flat
 * normals as-authored (no recompute). */
export function toBufferGeometry(b: GeometryBuilder): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(b.positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(b.normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(b.uvs, 2));
  geometry.setAttribute('uv2', new Float32BufferAttribute(b.uv2s, 2));
  geometry.setIndex(b.indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Triangle count of the accumulator so far (also equal to the resulting geometry's
 * index.count / 3) — used for the per-variant budget logging every builder documents. */
export function triCount(b: GeometryBuilder): number {
  return b.indices.length / 3;
}
