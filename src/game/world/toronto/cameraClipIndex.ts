// Phase 33 camera lab — a static, building-class AABB index for camera clip queries.
//
// THROWAWAY BY DESIGN. This exists to answer two questions the camera decision needs objective
// numbers for — "is the camera eye inside a building?" and "how much geometry sits between the
// lens and the car?" — plus to feed preset D's canyon-aware spring arm. **Phase 40 replaces it**
// with the global placement arbiter's one claim index (every placer registers there, not here);
// when that lands, delete this module and re-point its two consumers (fx/cameraLab.ts, the
// TorontoScene sampler) at the arbiter. Nothing else may grow a dependency on it.
//
// SCOPE: BUILDING-CLASS VOLUMES ONLY — the things a camera can be inside of or lose the car
// behind. Frontage streetwall + corner fills, backdrop/back-lot boxes, back-lot pack buildings,
// named landmarks, and the two hero base cylinders (as AABBs). Explicitly NOT furniture, trees,
// cones, parked cars, decor or laneway clutter: they are below the eye line by construction and
// would triple the index for nothing.
//
// Y CONVENTION (verified against the live collider mounts, not assumed): every pack/frontage/
// infill placement carries a ground-anchored `position: [x, 0, z]` and its collider mounts at
// `position: [x, hy, z]` with half-extents `[hx, hy, hz]` (cityPack/CityDress.tsx) — so the solid
// volume spans y ∈ [0, 2·hy]. Backdrop boxes ("box floor at y=0 so centre y = hy") and named
// boxes ("the box floor is at y=0, so its centre y is hy", TorontoScene's NamedBuildingsLayer)
// follow the same rule. The index therefore stores minY = 0 for every box.
//
// COST: the index carries ~2.3k boxes on the shipped map, and the sampler runs 5 point tests +
// 1 segment test per frame. A naive full scan is ~14k AABB tests/frame (~0.1–0.2 ms) — over the
// budget the plan sets for instrumentation, so queries go through a uniform XZ bucket grid:
// a point test touches ONE cell (a handful of boxes) and the near-field segment (≤ ~10 wu) spans
// at most 2×2 cells. Measured build cost is a few ms, once per world mount, in dev only.

/** An axis-aligned world-space building volume. */
export interface ClipAabb {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
  /**
   * Phase 36 — the DITHER-FADE identity of this volume, or null/absent when the volume is not
   * dither-fadeable (named-building boxes + hero bases: they ride the legacy material-opacity
   * fader in occlusionFade.ts, so the dither pass must skip them or both paths would fight over
   * the same mesh). Optional so every pre-Phase-36 construction site (tests, ad-hoc index writes)
   * stays valid unchanged; `buildClipIndexEntries` below is the one place real keys are minted.
   */
  readonly fadeKey?: string | null;
}

/** A clip volume with its fade identity resolved — what `buildClipIndexEntries` produces and what
 * `setClipIndex` is fed in production. Structurally a ClipAabb, so every existing query works on it
 * untouched. */
export interface ClipEntry extends ClipAabb {
  readonly fadeKey: string | null;
}

// --- source shapes (structural — deliberately NOT importing the layout types) ------------------
// Kept structural so this module stays free of frontage/infill/namedBuildings imports: it is a
// throwaway, and Phase 40's arbiter should be able to delete it without unpicking a type web.

/** A ground-anchored placement: `position` = [x, 0, z], solid volume y ∈ [0, 2·hy]. Matches
 * frontage.ts's PlacedBox/FrontageSlot and infill.ts's FixedInfillItem. `slotId` is optional here
 * only so the structural shape still admits a bare PlacedBox; every REAL frontage/corner-fill item
 * carries one (it is the Phase 25.7 seam) and it becomes the volume's fade key. */
export interface GroundedBoxLike {
  readonly position: readonly [number, number, number];
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
  readonly slotId?: string;
}

/** A centre-x/z extruded box with its floor at y=0 (frontage.ts's BackdropBox). */
export interface CentredBoxLike {
  readonly x: number;
  readonly z: number;
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
}

/** A named-building box (namedBuildings.ts's NamedBox: world centre cx/cz, floor at y=0). */
export interface NamedBoxLike {
  readonly cx: number;
  readonly cz: number;
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
}

/** A hero base cylinder (heroes.ts's `meta.collider` + its world lot centre), indexed as the
 * AABB that bounds it — the hero shafts above the base taper away from the eye line anyway. */
export interface HeroBaseLike {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly halfHeight: number;
  readonly centerY: number;
}

/**
 * infill.ts's `fixed` list mixes real back-lot BUILDINGS with parking-lot cars, construction
 * fences, dumpsters and billboards. Its `id` prefix is the only discriminator the layout exposes
 * (`backlot:${street}:${side}:${n}` vs `${site}-car-${n}` / `-fence-` / `-dumpster` / `-billboard`
 * / `deep-scatter:*`), so that prefix is the filter — and it is asserted by this module's tests so
 * a rename in infill.ts fails loudly here instead of silently emptying the index.
 */
export const INFILL_BUILDING_ID_PREFIX = 'backlot:' as const;

export interface ClipIndexSources {
  /** Frontage streetwall slots + corner fills (both FrontageSlot-shaped). */
  readonly groundedBuildings: readonly GroundedBoxLike[];
  /** Backdrop towers + back-lot extruded boxes. */
  readonly centredBoxes: readonly CentredBoxLike[];
  /** infill.ts `fixed` items, unfiltered — the prefix filter is applied here. */
  readonly infillFixed: readonly (GroundedBoxLike & { readonly id: string })[];
  readonly namedBoxes: readonly NamedBoxLike[];
  readonly heroBases: readonly HeroBaseLike[];
}

// --- fade keys (Phase 36) ----------------------------------------------------------------------
// THE SINGLE-SOURCING RULE: the clip index (which decides WHAT the boresight hit) and the mesh side
// (CityDress's batched/instanced renderers, which decide WHERE to write the fade) are two different
// walks over the same layout arrays. They agree only if both call the SAME key function on the SAME
// layout item — never on a shared array position, which drifts the moment a toggle (showInfill) or a
// filter (the back-lot prefix below) changes one walk and not the other. Hence: keys are derived
// from the item's own data, and these three functions are the only place that derivation exists.

/** Fade key for a frontage streetwall slot or a corner fill (both FrontageSlot-shaped). `slotId` is
 * already stable across seeds and occupancy (the Phase 25.7 seam), and corner fills carry their own
 * `corner:` prefix, so the two families cannot collide. */
export function frontageFadeKey(slot: { readonly slotId: string }): string {
  return `frontage:${slot.slotId}`;
}

/** Fade key for an infill.ts `fixed` item (back-lot pack buildings — the only class this index
 * keeps; see INFILL_BUILDING_ID_PREFIX). `id` is minted by the generator and unique per layout. */
export function infillFadeKey(item: { readonly id: string }): string {
  return `infill:${item.id}`;
}

/**
 * Fade key for a centred extruded box — frontage.ts's backdrop-tower row and infill.ts's back-lot
 * boxes, which share both a shape and (on the mesh side) ONE InstancedMesh.
 *
 * BackdropBox carries no id of its own, and adding one belongs to the generators (out of scope for
 * this task), so the key is derived from the placement itself: centre XZ quantized to centimetres.
 * That is deterministic per seed, identical on both walks, and — unlike an array position —
 * immune to the two arrays being merged, filtered or toggled differently on either side. Boxes are
 * placed non-overlapping by construction, so distinct boxes cannot share a centre (asserted against
 * the real layout in this module's tests).
 */
export function backdropFadeKey(box: { readonly x: number; readonly z: number }): string {
  return `backdrop:${Math.round(box.x * 100)}:${Math.round(box.z * 100)}`;
}

/** Flatten every building-class source into one AABB list. Pure — the whole index build is this
 * plus the bucket grid, so tests exercise exactly what the scene populates.
 *
 * Fade-key-free view of `buildClipIndexEntries` (kept as the pre-Phase-36 shape so the Phase 33
 * lab's consumers and tests read exactly as before). */
export function buildClipAabbs(sources: ClipIndexSources): ClipAabb[] {
  return buildClipIndexEntries(sources).map((e) => ({
    minX: e.minX,
    maxX: e.maxX,
    minY: e.minY,
    maxY: e.maxY,
    minZ: e.minZ,
    maxZ: e.maxZ,
  }));
}

/** Flatten every building-class source into one list of volumes WITH their fade identity — the
 * production index build (Phase 36). Named boxes and hero bases get `fadeKey: null`: they fade
 * through occlusionFade.ts's material-opacity path instead, and the dither pass skips them. */
export function buildClipIndexEntries(sources: ClipIndexSources): ClipEntry[] {
  const out: ClipEntry[] = [];
  const pushGrounded = (b: GroundedBoxLike, fadeKey: string | null): void => {
    out.push({
      minX: b.position[0] - b.hx,
      maxX: b.position[0] + b.hx,
      minY: 0,
      maxY: 2 * b.hy,
      minZ: b.position[2] - b.hz,
      maxZ: b.position[2] + b.hz,
      fadeKey,
    });
  };
  for (const b of sources.groundedBuildings) {
    pushGrounded(b, b.slotId === undefined ? null : frontageFadeKey({ slotId: b.slotId }));
  }
  for (const b of sources.infillFixed) {
    if (b.id.startsWith(INFILL_BUILDING_ID_PREFIX)) pushGrounded(b, infillFadeKey(b));
  }
  for (const b of sources.centredBoxes) {
    out.push({
      minX: b.x - b.hx,
      maxX: b.x + b.hx,
      minY: 0,
      maxY: 2 * b.hy,
      minZ: b.z - b.hz,
      maxZ: b.z + b.hz,
      fadeKey: backdropFadeKey(b),
    });
  }
  for (const b of sources.namedBoxes) {
    out.push({
      minX: b.cx - b.hx,
      maxX: b.cx + b.hx,
      minY: 0,
      maxY: 2 * b.hy,
      minZ: b.cz - b.hz,
      maxZ: b.cz + b.hz,
      fadeKey: null,
    });
  }
  for (const h of sources.heroBases) {
    out.push({
      minX: h.x - h.radius,
      maxX: h.x + h.radius,
      minY: Math.max(0, h.centerY - h.halfHeight),
      maxY: h.centerY + h.halfHeight,
      minZ: h.z - h.radius,
      maxZ: h.z + h.radius,
      fadeKey: null,
    });
  }
  return out;
}

// --- the live index ---------------------------------------------------------------------------

/** Bucket edge (wu). ~64 wu is a couple of city blocks on the compacted map: big enough that the
 * grid stays ~1k cells for a 1440×2724 wu world, small enough that a cell holds only a handful of
 * boxes. Implementation constant, not a gameplay tunable (same carve-out as cameraRig.ts's
 * shake-noise constants). */
const CELL_SIZE_WU = 64;

let boxes: readonly ClipAabb[] = [];
// Flattened bucket grid over the index's XZ bounds. `buckets[cz * cellsX + cx]` holds the indices
// of every box whose XZ footprint touches that cell (a box spanning several cells is listed in
// each — the `visited` stamp below de-duplicates at query time).
let buckets: number[][] = [];
let cellsX = 0;
let cellsZ = 0;
let originX = 0;
let originZ = 0;
// Per-query de-duplication stamp: `visited[i] === visitGen` means box i was already tested by the
// current query. An incrementing generation avoids clearing the array between queries.
let visited = new Int32Array(0);
let visitGen = 0;

function cellXOf(x: number): number {
  const c = Math.floor((x - originX) / CELL_SIZE_WU);
  return c < 0 ? 0 : c >= cellsX ? cellsX - 1 : c;
}

function cellZOf(z: number): number {
  const c = Math.floor((z - originZ) / CELL_SIZE_WU);
  return c < 0 ? 0 : c >= cellsZ ? cellsZ - 1 : c;
}

/** Replace the index (and rebuild the bucket grid). Called once per world mount — PROD-ACTIVE
 * since Phase 36 (the dither targeting + anti-clip guard consume it every frame). */
export function setClipIndex(next: readonly ClipAabb[]): void {
  boxes = next;
  visited = new Int32Array(next.length);
  visitGen = 0;
  if (next.length === 0) {
    buckets = [];
    cellsX = cellsZ = 0;
    originX = originZ = 0;
    return;
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const b of next) {
    if (b.minX < minX) minX = b.minX;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.minZ < minZ) minZ = b.minZ;
    if (b.maxZ > maxZ) maxZ = b.maxZ;
  }
  originX = minX;
  originZ = minZ;
  cellsX = Math.max(1, Math.ceil((maxX - minX) / CELL_SIZE_WU) + 1);
  cellsZ = Math.max(1, Math.ceil((maxZ - minZ) / CELL_SIZE_WU) + 1);
  buckets = Array.from({ length: cellsX * cellsZ }, () => [] as number[]);
  for (let i = 0; i < next.length; i++) {
    const b = next[i];
    const x0 = cellXOf(b.minX);
    const x1 = cellXOf(b.maxX);
    const z0 = cellZOf(b.minZ);
    const z1 = cellZOf(b.maxZ);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) buckets[cz * cellsX + cx].push(i);
    }
  }
}

/** Drop the index (world unmount / test isolation). */
export function clearClipIndex(): void {
  setClipIndex([]);
}

/** How many building volumes the index currently holds. */
export function getClipIndexSize(): number {
  return boxes.length;
}

/** Live snapshot of the indexed boxes (not a copy — read-only). */
export function getClipIndexBoxes(): readonly ClipAabb[] {
  return boxes;
}

function containsPoint(b: ClipAabb, x: number, y: number, z: number, margin: number): boolean {
  return (
    x >= b.minX - margin &&
    x <= b.maxX + margin &&
    y >= b.minY - margin &&
    y <= b.maxY + margin &&
    z >= b.minZ - margin &&
    z <= b.maxZ + margin
  );
}

/**
 * Is `(x,y,z)` inside any indexed building, optionally inflated by `margin` (m)? Boundary-
 * inclusive: a point exactly on a face counts as inside (a lens flush with a facade is already
 * the failure this measures).
 */
export function pointInsideAny(x: number, y: number, z: number, margin = 0): boolean {
  if (boxes.length === 0) return false;
  const x0 = cellXOf(x - margin);
  const x1 = cellXOf(x + margin);
  const z0 = cellZOf(z - margin);
  const z1 = cellZOf(z + margin);
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) {
      for (const i of buckets[cz * cellsX + cx]) {
        if (containsPoint(boxes[i], x, y, z, margin)) return true;
      }
    }
  }
  return false;
}

/** Is the camera eye inside building volume? The headline clip-instrumentation question. */
export function eyeInsideAny(x: number, y: number, z: number): boolean {
  return pointInsideAny(x, y, z, 0);
}

// Slab-test scratch: the running [tMin, tMax] parametric overlap along the segment, held at module
// scope so the per-axis narrowing below needs neither a closure nor a tuple allocation per call.
let slabMin = 0;
let slabMax = 1;

/** Narrow [slabMin, slabMax] by one axis' slab. Returns false the moment the interval is empty.
 * A zero direction component is handled explicitly (never via 1/0) so a segment lying exactly in
 * a face plane can't produce a NaN comparison and silently pass. */
function narrowSlab(lo: number, hi: number, origin: number, dir: number): boolean {
  if (dir === 0) return origin >= lo && origin <= hi;
  const inv = 1 / dir;
  let t1 = (lo - origin) * inv;
  let t2 = (hi - origin) * inv;
  if (t1 > t2) {
    const swap = t1;
    t1 = t2;
    t2 = swap;
  }
  if (t1 > slabMin) slabMin = t1;
  if (t2 < slabMax) slabMax = t2;
  return slabMin <= slabMax;
}

/** Slab test: does the segment p0 → p0+d intersect this box (t ∈ [0,1])? */
function segmentHitsBox(
  b: ClipAabb,
  x0: number,
  y0: number,
  z0: number,
  dx: number,
  dy: number,
  dz: number,
): boolean {
  slabMin = 0;
  slabMax = 1;
  return (
    narrowSlab(b.minX, b.maxX, x0, dx) &&
    narrowSlab(b.minY, b.maxY, y0, dy) &&
    narrowSlab(b.minZ, b.maxZ, z0, dz)
  );
}

/**
 * How many distinct indexed buildings the segment (x0,y0,z0)→(x1,y1,z1) passes through. Used both
 * as a clip statistic (how much geometry sits between lens and car) and as preset D's near-field
 * probe. A box the segment merely touches at a face counts — the same boundary-inclusive rule as
 * pointInsideAny.
 */
export function segmentHitCount(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): number {
  if (boxes.length === 0) return 0;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const cx0 = cellXOf(Math.min(x0, x1));
  const cx1 = cellXOf(Math.max(x0, x1));
  const cz0 = cellZOf(Math.min(z0, z1));
  const cz1 = cellZOf(Math.max(z0, z1));
  visitGen++;
  let hits = 0;
  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      for (const i of buckets[cz * cellsX + cx]) {
        if (visited[i] === visitGen) continue;
        visited[i] = visitGen;
        if (segmentHitsBox(boxes[i], x0, y0, z0, dx, dy, dz)) hits++;
      }
    }
  }
  return hits;
}

/**
 * Phase 36 — the occluder-TARGETING query: add the fade key of every dither-fadeable volume the
 * segment (x0,y0,z0)→(x1,y1,z1) passes through into `out`, and return how many keys the call added
 * that were not already there.
 *
 * Same geometry, same boundary-inclusive rule and the same visited-stamp de-duplication as
 * `segmentHitCount` — this is that function with a payload, not a second traversal strategy. Volumes
 * with a null/absent key (named boxes, hero bases) are skipped: they fade through the legacy
 * material-opacity path, and letting both paths claim one mesh would make them fight.
 *
 * The caller owns `out`, so the per-frame pass (5 boresight segments unioned into ONE set) allocates
 * nothing: call this five times against the same set, then read it once.
 */
export function segmentHitFadeKeys(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  out: Set<string>,
): number {
  if (boxes.length === 0) return 0;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const cx0 = cellXOf(Math.min(x0, x1));
  const cx1 = cellXOf(Math.max(x0, x1));
  const cz0 = cellZOf(Math.min(z0, z1));
  const cz1 = cellZOf(Math.max(z0, z1));
  visitGen++;
  let added = 0;
  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      for (const i of buckets[cz * cellsX + cx]) {
        if (visited[i] === visitGen) continue;
        visited[i] = visitGen;
        const key = boxes[i].fadeKey;
        if (key === null || key === undefined) continue;
        if (out.has(key)) continue;
        if (segmentHitsBox(boxes[i], x0, y0, z0, dx, dy, dz)) {
          out.add(key);
          added++;
        }
      }
    }
  }
  return added;
}
