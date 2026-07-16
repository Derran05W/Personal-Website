// The buffer-building layer for the instanced city (TDD §8.2, §5.8). Turns per-archetype
// InstanceSource lists into InstancedMeshes whose instances are ORDERED, GROUPED BY DISTRICT,
// with a recorded [start,count] range per district. That ordering is SACRED (CLAUDE.md): a
// Phase 13 blackout — or the Task 5 debug tint — flips exactly one district by writing the
// one contiguous slice its range names, no per-instance scan. Everything downstream
// (blackouts, debug tooling) reaches those slices through the module-scope handle registry
// at the bottom of this file.
//
// One archetype can map to SEVERAL InstancedMeshes (discrete building variant geometries —
// see buildInstancedArchetype's `variantKey`); the registry keys by archetype name and
// fans a district flip out across every variant mesh registered under it.
//
// This module deliberately consumes only its own InstanceSource contract (below) + the
// palette material — never world/geometry or world/propPlacements directly; the city scene
// component composes those into InstanceSources at integration.

import {
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  StaticDrawUsage,
  type BufferGeometry,
  type Material,
  type Matrix4,
} from 'three';
import { WORLD } from '../config';
import type { ArchetypeName } from './archetypes';
import { getCityMaterial } from './palette';

// 4×4 district grid (TDD §5.8) → 16 districts, ids 0..15. Derived, never hardcoded.
export const DISTRICT_COUNT = WORLD.districts * WORLD.districts;

const WHITE = new Color(1, 1, 1);

// --- Input / output contracts -------------------------------------------------------------

/**
 * One instance to place. `matrix` is the fully-composed local→world transform (position +
 * rotation + scale) — buildings bake footprint/height scale into it, props bake position +
 * yaw. `districtId` (0..DISTRICT_COUNT-1) drives the grouping/range bookkeeping. `color` is
 * an OPTIONAL subtle per-instance tint (buildings' wall-tone variation) multiplied over the
 * palette albedo via InstancedMesh.instanceColor; omit it and the instance stays palette-pure
 * (instanceColor is never allocated when no source in the batch carries a tint).
 */
export interface InstanceSource {
  readonly districtId: number;
  readonly matrix: Matrix4;
  readonly color?: Color;
}

/** One district's contiguous slice within an archetype's instance buffer. */
export interface DistrictRange {
  readonly districtId: number;
  readonly start: number;
  readonly count: number;
}

/** Per-district ranges for one archetype mesh: length DISTRICT_COUNT, ascending by
 * districtId, contiguous (range[d].start === range[d-1].start + range[d-1].count), covering
 * every district (count 0 for empty ones). Index d IS district d. */
export type DistrictRanges = readonly DistrictRange[];

/** The minimal InstancedBufferAttribute surface setEmissiveRange needs. InstancedBufferAttribute
 * satisfies it structurally; tests pass a lightweight fake. */
export interface EmissiveAttribute {
  readonly array: { length: number; [index: number]: number };
  needsUpdate: boolean;
  addUpdateRange(start: number, count: number): void;
}

/** Everything a downstream flip (blackout / debug) needs about one built archetype mesh. */
export interface ArchetypeHandles {
  readonly name: ArchetypeName;
  /** Discriminates variant meshes under the same archetype (e.g. building footprint/height
   * bucket). Purely for identification/debug. */
  readonly variantKey: string;
  readonly mesh: InstancedMesh;
  /** The aEmissiveOn attribute (itemSize 1, DynamicDrawUsage) — since itemSize is 1, its
   * array index equals the instance index. */
  readonly emissiveAttr: InstancedBufferAttribute;
  readonly ranges: DistrictRanges;
}

export interface SortResult {
  /** A NEW array (input untouched), instances grouped by ascending districtId. */
  readonly sorted: readonly InstanceSource[];
  readonly ranges: DistrictRanges;
}

// --- District grouping (the sacred ordering) ----------------------------------------------

/**
 * Group `sources` by district into a new array and record each district's [start,count].
 * Stable: within a district, original relative order is preserved (bucket-and-concat, not a
 * comparator sort). The returned ranges always cover all DISTRICT_COUNT districts, ascending
 * and contiguous, so range[d] is district d and range[d].start locates its slice directly.
 *
 * @throws RangeError if any source's districtId is not an integer in [0, DISTRICT_COUNT-1].
 */
export function sortByDistrict(sources: readonly InstanceSource[]): SortResult {
  const buckets: InstanceSource[][] = Array.from({ length: DISTRICT_COUNT }, () => []);
  for (const source of sources) {
    const d = source.districtId;
    if (!Number.isInteger(d) || d < 0 || d >= DISTRICT_COUNT) {
      throw new RangeError(
        `sortByDistrict: districtId ${d} out of range [0, ${DISTRICT_COUNT - 1}]`,
      );
    }
    buckets[d].push(source);
  }

  const sorted: InstanceSource[] = [];
  const ranges: DistrictRange[] = [];
  let start = 0;
  for (let d = 0; d < DISTRICT_COUNT; d++) {
    const bucket = buckets[d];
    ranges.push({ districtId: d, start, count: bucket.length });
    for (const source of bucket) sorted.push(source);
    start += bucket.length;
  }
  return { sorted, ranges };
}

// --- Mesh construction --------------------------------------------------------------------

/**
 * Build one InstancedMesh from already-district-sorted sources. Matrices are written
 * StaticDrawUsage (never change after build); a per-instance `aEmissiveOn` float attribute
 * (all 1 = lit, DynamicDrawUsage) is added to the geometry for later blackout writes.
 *
 * The geometry MUST be dedicated to this mesh — aEmissiveOn is stored on it, so sharing one
 * geometry across archetype meshes would alias their emissive buffers. instanceColor is only
 * allocated if some source carries a `color` (others default to white); otherwise instances
 * stay palette-pure with no instanceColor buffer at all. frustumCulled is off: these meshes
 * span the whole map, so a whole-mesh frustum test is worthless and would wrongly cull them
 * when their bounding sphere leaves view (CLAUDE.md instancing note).
 */
export function createArchetypeMesh(
  geometry: BufferGeometry,
  material: Material,
  sortedSources: readonly InstanceSource[],
): { mesh: InstancedMesh; emissiveAttr: InstancedBufferAttribute } {
  const count = sortedSources.length;
  const mesh = new InstancedMesh(geometry, material, count);
  mesh.instanceMatrix.setUsage(StaticDrawUsage);
  mesh.frustumCulled = false;

  const hasTint = sortedSources.some((source) => source.color !== undefined);
  for (let i = 0; i < count; i++) {
    const source = sortedSources[i];
    mesh.setMatrixAt(i, source.matrix);
    // setColorAt lazily allocates instanceColor; only touch it when the batch actually tints.
    if (hasTint) mesh.setColorAt(i, source.color ?? WHITE);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;

  const emissiveArray = new Float32Array(count);
  emissiveArray.fill(1); // everything lit until a blackout flips it
  const emissiveAttr = new InstancedBufferAttribute(emissiveArray, 1);
  emissiveAttr.setUsage(DynamicDrawUsage);
  geometry.setAttribute('aEmissiveOn', emissiveAttr);

  mesh.computeBoundingSphere();
  return { mesh, emissiveAttr };
}

// --- District emissive / colour writes (the flip primitives) ------------------------------

/**
 * Flip one district's [start,count] slice of an aEmissiveOn buffer to `on` (1 lit / 0 dark)
 * and register the matching partial GPU upload. Writes only the slice range[districtId] names
 * — the whole point of the district-grouped ordering. Empty districts (count 0) are a no-op.
 *
 * Deliberately does NOT call clearUpdateRanges(): three clears an attribute's update ranges
 * itself right after uploading them (WebGLAttributes.updateBuffer), so multiple flips in one
 * frame must ACCUMULATE their ranges here, not clear each other's. addUpdateRange start/count
 * are in array-element units, which equal instance units for this itemSize-1 attribute.
 */
export function setEmissiveRange(
  emissiveAttr: EmissiveAttribute,
  ranges: DistrictRanges,
  districtId: number,
  on: 0 | 1,
): void {
  const range = ranges[districtId];
  if (range === undefined || range.districtId !== districtId) {
    throw new RangeError(`setEmissiveRange: no range for district ${districtId}`);
  }
  const { start, count } = range;
  if (count === 0) return;
  const { array } = emissiveAttr;
  for (let i = start; i < start + count; i++) array[i] = on;
  emissiveAttr.addUpdateRange(start, count);
  emissiveAttr.needsUpdate = true;
}

// --- Module-scope archetype handle registry -----------------------------------------------
// The Phase 13 blackout entry point and the Task 5 debug-tint hook. Keyed by archetype name;
// value is the list of variant meshes registered under it (one for most archetypes, several
// for buildings). Torn down + rebuilt on a city remount (clearArchetypeRegistry).

const registry = new Map<ArchetypeName, ArchetypeHandles[]>();
const EMPTY_HANDLES: readonly ArchetypeHandles[] = [];

/** Record a built archetype mesh so district flips can find it. Multiple variant meshes may
 * register under one name; each is appended. */
export function registerArchetypeHandles(name: ArchetypeName, handles: ArchetypeHandles): void {
  const list = registry.get(name);
  if (list !== undefined) list.push(handles);
  else registry.set(name, [handles]);
}

/** All variant-mesh handles registered under an archetype (empty if none built this run). */
export function getArchetypeHandles(name: ArchetypeName): readonly ArchetypeHandles[] {
  return registry.get(name) ?? EMPTY_HANDLES;
}

/**
 * Blackout entry point: switch every mesh of `name` lit/dark for one district by flipping
 * exactly that district's [start,count] slice of aEmissiveOn. No-op for an archetype that
 * wasn't built this run.
 */
export function setDistrictEmissive(name: ArchetypeName, districtId: number, on: 0 | 1): void {
  const handles = registry.get(name);
  if (handles === undefined) return;
  for (const h of handles) setEmissiveRange(h.emissiveAttr, h.ranges, districtId, on);
}

/**
 * Overwrite one district's instanceColor slice for an archetype (Task 5 debug tint — proves
 * the [start,count] ranges end-to-end by visibly recolouring exactly one district). Lazily
 * allocates instanceColor via setColorAt; the instanceColor update range is in element units,
 * hence ×3 (itemSize 3). No-op for an unbuilt archetype or an empty district slice.
 */
export function setDistrictColor(name: ArchetypeName, districtId: number, color: Color): void {
  const handles = registry.get(name);
  if (handles === undefined) return;
  for (const h of handles) {
    const range = h.ranges[districtId];
    if (range === undefined || range.count === 0) continue;
    for (let i = range.start; i < range.start + range.count; i++) h.mesh.setColorAt(i, color);
    if (h.mesh.instanceColor !== null) {
      h.mesh.instanceColor.addUpdateRange(range.start * 3, range.count * 3);
      h.mesh.instanceColor.needsUpdate = true;
    }
  }
}

/** Drop all registered handles (city remount / hard teardown, mirrors world/registry.ts's
 * clearRegistry). Callers dispose the meshes/geometries separately. */
export function clearArchetypeRegistry(): void {
  registry.clear();
}

// --- One-call build path ------------------------------------------------------------------

/**
 * Sort → build → register in one step: THE call the city scene uses per archetype variant
 * mesh. Uses the ONE shared palette material (getCityMaterial). Returns the handles (also now
 * discoverable via getArchetypeHandles(name)).
 */
export function buildInstancedArchetype(
  name: ArchetypeName,
  variantKey: string,
  geometry: BufferGeometry,
  sources: readonly InstanceSource[],
): ArchetypeHandles {
  const { sorted, ranges } = sortByDistrict(sources);
  const { mesh, emissiveAttr } = createArchetypeMesh(geometry, getCityMaterial(), sorted);
  const handles: ArchetypeHandles = { name, variantKey, mesh, emissiveAttr, ranges };
  registerArchetypeHandles(name, handles);
  return handles;
}
