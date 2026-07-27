// Phase 40 — THE GLOBAL PLACEMENT ARBITER'S CLAIM STORE.
//
// One spatial index every Toronto placer registers into and queries against, replacing the four
// mutually-blind placement systems the `.planning/part-10-placement-integrity.md` audit found
// (frontage / infill / furniture / venueDress, each hand-assembling its own exclusion set and
// none of them knowing what the others had already put on the ground).
//
// LAW after Phase 40 (`.planning/immersion-overhaul-overview.md` rule 3): every layer that puts
// something on the map — this part's placers and every landmark/prop layer Parts 11–16 add —
// REGISTERS a claim here, and every layer that needs to avoid something QUERIES here. There is
// exactly one index; `world/toronto/composeWorld.ts` owns the instance and the ordering.
//
// SHAPE (the plan's recorded decision): 2D XZ AABB + an OPTIONAL `yRange`. Every placement in
// this city is ground-anchored, so the horizontal footprint is what decides interpenetration;
// building-class claims additionally carry [0, 2·hy] so the camera-clip projection reads straight
// off the claim (see `buildingClipVolumes` below — this index is also the ONE truth the Phase 36
// occlusion/anti-clip machinery reads, absorbing the throwaway list cameraClipIndex.ts used to
// assemble by hand).
//
// TWO CATEGORIES:
//   • BLOCKING — a physical object standing on the map (a building, a bench, a cone, a parked
//     car, a barrier). Two blocking claims must not interpenetrate; that is the invariant.
//   • ZONE — a region that GATES placement without being an object (a street ribbon, the
//     sidewalk band, a crosswalk band, a named-building/places exclusion rect, a park, the water
//     band). Zone rules are DIRECTIONAL: an on-road kind is allowed over a ribbon, a building is
//     not. Zones never participate in the blocking×blocking invariant sweep.
//
// PREDICATE: interior overlap with an epsilon — touching edges never count. That is
// frontage.ts's original `overlaps` semantics (kept here, and re-exported from frontage.ts so
// every existing import path still resolves), which is what sanctions abutting fence panels,
// flush frontage and mitred corner seals by construction rather than by whitelist.
//
// INSTANCE, NEVER MODULE STATE: `createClaimIndex()` returns a fresh store. Two composeWorld
// calls in one process (a test, a StrictMode double-mount) must not see each other's claims —
// that is exactly the determinism trap a module-global would set.
//
// COST: build-time only. Uniform XZ bucket grid (CELL_SIZE_WU), so a footprint query touches the
// one-to-four cells it spans instead of the ~10k-claim list. Zero per-frame cost: nothing here
// runs inside the render loop (the camera's own query machinery stays in cameraClipIndex.ts,
// fed once per world mount by `buildingClipVolumes`).

import type { ClipEntry } from './cameraClipIndex';

// --- geometry ---------------------------------------------------------------------------------

/** An axis-aligned footprint in map space (= world XZ; mapToWorld is the identity swap). The
 * canonical home of the shape frontage.ts introduced — it lives here now because the index is a
 * leaf module and everything else (frontage, infill, furniture, composeWorld) imports it. */
export interface Aabb {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/** Interior overlap (touching edges never count) — THE shared predicate for every ribbon /
 * exclusion / footprint check in the Toronto world, so generator, arbiter and test all agree on
 * the boundary. Verbatim the rule frontage.ts's `overlaps` has enforced since Phase 25.6. */
export function overlaps(a: Aabb, b: Aabb): boolean {
  const t = 1e-9;
  return a.minX < b.maxX - t && a.maxX > b.minX + t && a.minZ < b.maxZ - t && a.maxZ > b.minZ + t;
}

/** Footprint centred on (x, z) with the given half-extents — the shape every placer computes. */
export function aabbAround(x: number, z: number, hx: number, hz: number): Aabb {
  return { minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz };
}

/**
 * A yaw-rotated box's axis-aligned footprint half-extents, the ONE rule every placer and the
 * arbiter share:
 *   • AXIS-ALIGNED yaw (0 / ±90° / 180°, i.e. one of sin/cos is exactly 0) — the exact footprint,
 *     with width/depth swapped for the quarter turns. This covers frontage's ±90° facings, the
 *     parallel-parked cars, the face-the-road benches and bus shelters, and the world-edge ring.
 *   • ANY OTHER yaw — the CIRCUMSCRIBED SQUARE (max(hx, hz) both ways). Deterministic seeded
 *     spins (trees, hydrants, bins, power boxes, manholes, laneway clutter) have no meaningful
 *     axis-aligned footprint, and a conservative square is the honest claim: it never
 *     under-reports the space the prop occupies.
 */
export function footprintHalfExtents(hx: number, hz: number, yawRad: number): { hx: number; hz: number } {
  const c = Math.abs(Math.cos(yawRad));
  const s = Math.abs(Math.sin(yawRad));
  const AXIS_EPS = 1e-9;
  if (s < AXIS_EPS) return { hx, hz };
  if (c < AXIS_EPS) return { hx: hz, hz: hx };
  const r = Math.max(hx, hz);
  return { hx: r, hz: r };
}

// --- taxonomy ---------------------------------------------------------------------------------

/**
 * BUILDING-CLASS kinds: solid volumes the camera can be inside of or lose the car behind. These
 * are exactly the claims `buildingClipVolumes` projects into the camera clip index, so a new
 * building-ish layer becomes camera-aware simply by registering with one of these kinds.
 */
export const BUILDING_CLAIM_KINDS = [
  'frontageSlot',
  'cornerFill',
  'backdropBox',
  'backlotBuilding',
  'namedBuilding',
] as const;

/** Every blocking (physical-object) kind. Building-class kinds are a subset. */
export const BLOCKING_CLAIM_KINDS = [
  ...BUILDING_CLAIM_KINDS,
  /** Venue dressing props (kit props: flower pots, ATMs, A/C units, …). */
  'venueProp',
  /** Queue posts + person-blobs (cosmetic, colliderless — but they occupy sidewalk). */
  'queueProp',
  /** Street furniture: masts, stop signs, power boxes, trees, hydrants, benches, bins, shelters. */
  'furniture',
  /** Manhole covers — ON the asphalt by design (see ON_ROAD_CLAIM_KINDS). */
  'manhole',
  /** Street-parked cars — ON the asphalt by design. */
  'parkedCar',
  /** Traffic cones (lane closures + the world-edge notch dressing) — spawn-pose claims. */
  'cone',
  /** Parking-lot / construction-site fixtures: fence panels, dumpsters, billboards. */
  'lotFixture',
  /** Parking-lot cars. */
  'lotCar',
  /** Colliderless decor: laneway clutter, construction props, lane-closure road plates, piles. */
  'decor',
  /** Deep-interior scatter: tree trunks + greenhouses. */
  'scatterProp',
  /** World-edge barrier boxes + dead-end "road closed" row colliders. */
  'barrier',
  /** World-edge visual dressing: fence panels, hoarding, rail posts, jersey barriers. */
  'barrierDressing',
] as const;

/** Every zone (gating region) kind. */
export const ZONE_CLAIM_KINDS = [
  'streetRibbon',
  'sidewalkBand',
  'crosswalkBand',
  /** Named-building footprints + the reserved hero lots (namedBuildings.exclusions). */
  'namedExclusion',
  /** Places-layer storefront/vibe footprints (placesLayer.exclusions). */
  'placesExclusion',
  'parkRect',
  /** The lake band — nothing land-based may reach it. */
  'waterBand',
  /** Reserved construction-site lots (their own fixtures/decor live inside them legitimately). */
  'constructionLot',
  /** Reserved parking lots (ditto for their fence run + cars). */
  'parkingLot',
] as const;

export type BuildingClaimKind = (typeof BUILDING_CLAIM_KINDS)[number];
export type BlockingClaimKind = (typeof BLOCKING_CLAIM_KINDS)[number];
export type ZoneClaimKind = (typeof ZONE_CLAIM_KINDS)[number];
export type ClaimKind = BlockingClaimKind | ZoneClaimKind;

/** Which layer authored a claim. Used by the sanctioned-overlap rules and by readable failures. */
export type ClaimSource =
  /** Polygon-level facts that belong to no layer (the water band). */
  | 'world'
  | 'named'
  /** Phase 45's rail-lands block (aquarium / roundhouse / locomotive / patio props). Its own
   * source rather than 'named' so a sweep failure names the layer that authored the claim — the
   * only reason this union exists. It introduces no new KIND and no new sanction rule. */
  | 'railLands'
  | 'places'
  | 'parks'
  | 'worldEdge'
  | 'streets'
  | 'frontage'
  | 'venueDress'
  | 'infill'
  | 'furniture';

const BUILDING_KIND_SET: ReadonlySet<ClaimKind> = new Set<ClaimKind>(BUILDING_CLAIM_KINDS);
const BLOCKING_KIND_SET: ReadonlySet<ClaimKind> = new Set<ClaimKind>(BLOCKING_CLAIM_KINDS);

/** Kinds that legitimately sit ON the asphalt — the directional exception to "no blocking claim
 * inside a street ribbon". Everything else must clear the ribbon (and, for buildings, the
 * sidewalk band beyond it). */
export const ON_ROAD_CLAIM_KINDS: ReadonlySet<ClaimKind> = new Set<ClaimKind>([
  'manhole',
  'parkedCar',
  'cone',
  'barrier',
  'barrierDressing',
]);

export function isBuildingClaimKind(kind: ClaimKind): boolean {
  return BUILDING_KIND_SET.has(kind);
}

export function isBlockingClaimKind(kind: ClaimKind): boolean {
  return BLOCKING_KIND_SET.has(kind);
}

// --- the claim ---------------------------------------------------------------------------------

/** One registered claim. `id` is unique within an index and stable per seed (it is derived from
 * the placement's own identity — a slot id, a generator id, a category + ordinal — never from an
 * array position, the same single-sourcing rule Phase 36's fade keys follow). */
export interface Claim {
  readonly id: string;
  readonly kind: ClaimKind;
  readonly source: ClaimSource;
  /** True for physical objects, false for gating regions. Derived from `kind`, stored so a query
   * never has to re-derive it. */
  readonly blocking: boolean;
  readonly aabb: Aabb;
  /** Vertical extent [minY, maxY] in wu. Present on building-class claims (the camera needs it);
   * omitted where the placement is ground-hugging and height is irrelevant. */
  readonly yRange?: readonly [number, number];
  /**
   * Phase 36 dither identity, minted AT REGISTRATION by cameraClipIndex.ts's exported key
   * functions. `null` means "this volume fades through the material-opacity path instead"
   * (named boxes, hero bases). Absent on non-building claims.
   */
  readonly fadeKey?: string | null;
  /**
   * Optional owning group — a parking lot id, a construction site id, a venue id, a park id, a
   * world-edge index. Two claims sharing an owner are SANCTIONED to overlap (a lot's own fence
   * and cars sit inside the lot; a venue's queue blobs sit between its own posts).
   */
  readonly owner?: string;
}

/** A claim without its derived `blocking` flag — what callers pass to `register`. */
export type ClaimInput = Omit<Claim, 'blocking'>;

/** Filter for the query surface. All present fields must match (AND). */
export interface ClaimQuery {
  readonly kinds?: ReadonlySet<ClaimKind>;
  readonly sources?: ReadonlySet<ClaimSource>;
  readonly blocking?: boolean;
  /** Skip claims with this owner — how a lot's own fixtures ignore their own lot rect. */
  readonly excludeOwner?: string;
}

/** Read-only query surface handed to the pure builders (they may look, only composeWorld writes). */
export interface ClaimIndexView {
  /** Every claim whose footprint interior-overlaps `rect` and passes `query`. */
  queryRect(rect: Aabb, query?: ClaimQuery): readonly Claim[];
  /** Every claim whose footprint strictly contains (x, z) and passes `query`. */
  queryPoint(x: number, z: number, query?: ClaimQuery): readonly Claim[];
  /** Cheap existence form of `queryRect` — the placers' reject gate. */
  overlapsAny(rect: Aabb, query?: ClaimQuery): boolean;
  /** Every registered claim, in registration order (deterministic). */
  allClaims(): readonly Claim[];
  /** The matching claims' footprints, in registration order — the materialized rect list that
   * REPLACES the three hand-maintained exclusion compositions (frontage.ts:570, furniture.ts:570,
   * infill.ts:881 as they stood before Phase 40). */
  rects(query?: ClaimQuery): readonly Aabb[];
  size(): number;
}

/** The writable index. Only composeWorld (and the shared context helper it delegates to) holds one. */
export interface ClaimIndex extends ClaimIndexView {
  register(claim: ClaimInput): void;
  registerAll(claims: Iterable<ClaimInput>): void;
}

// --- the store ---------------------------------------------------------------------------------

/** Bucket edge (wu). Two city blocks on the compacted map: big enough that the grid stays small,
 * small enough that a cell holds a handful of claims. Implementation constant (same carve-out as
 * cameraClipIndex.ts's own CELL_SIZE_WU), not a gameplay tunable. */
const CELL_SIZE_WU = 48;

/** Cell-key offset so negative world coords still key uniquely (|coord| up to ~1.5M wu). */
const CELL_KEY_OFFSET = 32768;
const CELL_KEY_STRIDE = 65536;

function cellKey(cx: number, cz: number): number {
  return (cx + CELL_KEY_OFFSET) * CELL_KEY_STRIDE + (cz + CELL_KEY_OFFSET);
}

function matches(claim: Claim, query: ClaimQuery | undefined): boolean {
  if (query === undefined) return true;
  if (query.blocking !== undefined && claim.blocking !== query.blocking) return false;
  if (query.kinds !== undefined && !query.kinds.has(claim.kind)) return false;
  if (query.sources !== undefined && !query.sources.has(claim.source)) return false;
  if (query.excludeOwner !== undefined && claim.owner === query.excludeOwner) return false;
  return true;
}

/**
 * Create an empty claim index. Build-time only; O(1)-ish bucket queries.
 *
 * A claim spanning several cells is listed in each of them; the per-query `visited` generation
 * stamp de-duplicates at read time (the same technique cameraClipIndex.ts's bucket grid uses, for
 * the same reason: clearing a Set per query would cost more than the query).
 */
export function createClaimIndex(): ClaimIndex {
  const claims: Claim[] = [];
  const buckets = new Map<number, number[]>();
  const visited: number[] = [];
  let visitGen = 0;
  const ids = new Set<string>();

  const cellOf = (v: number): number => Math.floor(v / CELL_SIZE_WU);

  const register = (input: ClaimInput): void => {
    if (ids.has(input.id)) {
      throw new Error(`claimIndex: duplicate claim id "${input.id}" (${input.kind}/${input.source})`);
    }
    ids.add(input.id);
    const claim: Claim = { ...input, blocking: isBlockingClaimKind(input.kind) };
    const ordinal = claims.length;
    claims.push(claim);
    visited.push(0);
    const x0 = cellOf(claim.aabb.minX);
    const x1 = cellOf(claim.aabb.maxX);
    const z0 = cellOf(claim.aabb.minZ);
    const z1 = cellOf(claim.aabb.maxZ);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const key = cellKey(cx, cz);
        const bucket = buckets.get(key);
        if (bucket === undefined) buckets.set(key, [ordinal]);
        else bucket.push(ordinal);
      }
    }
  };

  /** Walk every claim ORDINAL whose bucket the rect touches, de-duplicated. `visit` returns false
   * to stop early (the `overlapsAny` fast path). */
  const walk = (rect: Aabb, visit: (ordinal: number) => boolean): void => {
    if (claims.length === 0) return;
    const x0 = cellOf(rect.minX);
    const x1 = cellOf(rect.maxX);
    const z0 = cellOf(rect.minZ);
    const z1 = cellOf(rect.maxZ);
    visitGen++;
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const bucket = buckets.get(cellKey(cx, cz));
        if (bucket === undefined) continue;
        for (const ordinal of bucket) {
          if (visited[ordinal] === visitGen) continue;
          visited[ordinal] = visitGen;
          if (!visit(ordinal)) return;
        }
      }
    }
  };

  /** Bucket order is grid order; sorting the hit ORDINALS restores registration order, which is
   * what makes every query's output deterministic regardless of the cell size. */
  const collect = (rect: Aabb, query: ClaimQuery | undefined, hit: (claim: Claim) => boolean): readonly Claim[] => {
    const ordinals: number[] = [];
    walk(rect, (ordinal) => {
      const claim = claims[ordinal];
      if (matches(claim, query) && hit(claim)) ordinals.push(ordinal);
      return true;
    });
    ordinals.sort((a, b) => a - b);
    return ordinals.map((ordinal) => claims[ordinal]);
  };

  const queryRect = (rect: Aabb, query?: ClaimQuery): readonly Claim[] =>
    collect(rect, query, (claim) => overlaps(rect, claim.aabb));

  const overlapsAny = (rect: Aabb, query?: ClaimQuery): boolean => {
    let hit = false;
    walk(rect, (ordinal) => {
      const claim = claims[ordinal];
      if (matches(claim, query) && overlaps(rect, claim.aabb)) {
        hit = true;
        return false;
      }
      return true;
    });
    return hit;
  };

  return {
    register,
    registerAll(inputs) {
      for (const input of inputs) register(input);
    },
    queryRect,
    queryPoint(x, z, query) {
      // A degenerate rect would fail the interior-overlap predicate against everything, so the
      // point test is its own containment check (strict — a point exactly on a face is outside).
      return collect({ minX: x, maxX: x, minZ: z, maxZ: z }, query, (claim) => {
        const b = claim.aabb;
        return x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ;
      });
    },
    overlapsAny,
    allClaims: () => claims,
    rects(query) {
      const out: Aabb[] = [];
      for (const claim of claims) if (matches(claim, query)) out.push(claim.aabb);
      return out;
    },
    size: () => claims.length,
  };
}

// --- sanctioned overlaps (the invariant sweep's whitelist) --------------------------------------

/**
 * Is a blocking×blocking overlap between these two claims SANCTIONED (by design, not a defect)?
 * The machine-readable form of the plan's whitelist — one place, so the invariant sweep and any
 * future placer read the same rules.
 *
 *   (a) SAME OWNER — a parking lot's fence run and its cars sit inside the lot; a construction
 *       site's dumpster sits inside the site; a venue's queue blobs sit between its own posts;
 *       a venue's props stand against its own claimed facade; a corner's mast + power box stand
 *       together (`furniture:corner` — furniture.ts's documented "intersection-rule furniture
 *       claims but isn't gated" tradeoff: silently dropping a mast breaks lampClock/LightPool,
 *       dropping a power box breaks the every-district-keeps-a-transformer blackout invariant).
 *   (b) THE WORLD-EDGE RING — its visual dressing (fence panels, hoarding, jersey rows) stands on
 *       the barrier boxes it dresses, by construction. Both are 'worldEdge'-sourced.
 *   (c) VENUE DRESSING ON ITS OWN BUILDING — a venue prop/queue against the frontage slot the
 *       venue claimed (same owner: the venueId is the owner on both sides).
 *   (d) THE STREETWALL'S OWN BACKDROP TOWERS — frontage's backdrop pass stands its towers in the
 *       block interior BEHIND the street skin, overlapping the wall it backs by construction
 *       since Phase 23: the wall occludes every tower base from the locked §5.3 camera, and the
 *       skyline read (a shipped, user-visible quality since P23) depends on towers rising from
 *       the block rather than from thin gaps behind it. Rejecting them would thin the skyline by
 *       roughly a third for zero visible gain. Scoped to 'frontage'-sourced pairs only — an
 *       infill-sourced backdrop box DOES gate on the streetwall (and everything else) and stays
 *       a defect if it ever overlaps one.
 *   (e) A CONSTRUCTION SITE'S OWN FAMILY — the loose decor scatterInRect throws inside a site
 *       (cone clusters, road plates, debris) lands among that same site's fixed fixtures (fence
 *       run, dumpster, billboard) by design; the two register under different owners
 *       (`infill:constructionDecor` family vs `infill:construction:{i}` per site), so the shared
 *       prefix is the rule. Cross-site pairs can't occur (decor never leaves its site rect).
 *
 * Everything else is a defect and must be fixed by placement, never by widening this list.
 */
export function isSanctionedOverlap(a: Claim, b: Claim): boolean {
  if (a.owner !== undefined && a.owner === b.owner) return true;
  if (a.source === 'worldEdge' && b.source === 'worldEdge') return true;
  const frontSkin = (c: Claim): boolean =>
    c.source === 'frontage' && (c.kind === 'frontageSlot' || c.kind === 'cornerFill');
  const frontageBackdrop = (c: Claim): boolean => c.source === 'frontage' && c.kind === 'backdropBox';
  if ((frontageBackdrop(a) && frontSkin(b)) || (frontageBackdrop(b) && frontSkin(a))) return true;
  if (
    a.owner !== undefined &&
    b.owner !== undefined &&
    a.owner.startsWith('infill:construction') &&
    b.owner.startsWith('infill:construction')
  ) {
    return true;
  }
  return false;
}

/**
 * May this blocking claim legitimately overlap a STREET RIBBON zone? The directional zone law's
 * predicate (asserted map-wide by overlapInvariant.test.ts): ON_ROAD kinds by taxonomy, plus the
 * lane-closure road PLATES — deliberately on the asphalt ("this plate lies ON the asphalt",
 * infill.ts) but registered as bare 'decor'. The exception is OWNER-scoped, not kind-wide: a
 * kind-wide 'decor' exemption would also sanction laneway clutter standing in a roadway, which
 * is exactly the defect class the law exists to catch.
 */
export function isOnRoadSanctioned(claim: Claim): boolean {
  if (ON_ROAD_CLAIM_KINDS.has(claim.kind)) return true;
  return claim.kind === 'decor' && claim.owner === 'infill:laneClosure';
}

/**
 * The pinned, exhaustive exception list for the ribbon law: claims that DO interior-overlap a
 * street ribbon, are not on-road kinds, and are ACCEPTED as designed/authored geometry. All three
 * families are seed-independent placements, so the ids are stable and the invariant test asserts
 * the observed set EQUALS this one — a new intrusion still fails, and a stale entry (e.g. after a
 * data change) fails too. Grow this list only with a recorded decision, never to silence a red
 * sweep.
 *
 *   • McDonald's at Queen & Spadina — the designed pizza-corner overhang frontage.ts's
 *     CLAIM_RIBBON_TOLERANCE_WU comment documents by name (~0.71 wu past the ribbon, accepted).
 *   • Eaton Centre galleria — the researched real footprint (data/toronto/building-specs.json)
 *     reaches the stylized Dundas/Queen ribbons; data-truth wins over the road grid (P24 law:
 *     never hand-tune researched dims to fit the map).
 *   • Konjiki/Uncle Tetsu queue blobs — cosmetic, colliderless person-blobs whose line spills to
 *     the kerb edge; queues crowding the curb is the intended read, and the blobs are far below
 *     the eye line.
 */
export const RIBBON_OVERLAP_EXCEPTION_IDS: ReadonlySet<string> = new Set<string>([
  'frontage:spadina:n:45', // McDonald's pizza corner at Queen & Spadina (~0.71 wu, designed)
  'named:eaton-centre-galleria:0', // researched footprint reaches Dundas AND Queen ribbons
  'venue-queue-blob:konjiki-elm:1',
  'venue-queue-blob:konjiki-elm:3',
  'venue-queue-blob:konjiki-elm:5',
  'venue-queue-blob:uncle-tetsu:1',
  'venue-queue-blob:uncle-tetsu:3',
  'venue-queue-blob:uncle-tetsu:5',
]);

// --- camera-clip projection ---------------------------------------------------------------------

/**
 * The building-volume selector: every building-class claim as a camera ClipEntry. This is what
 * replaces cameraClipIndex.ts's hand-assembled `buildClipIndexEntries` walk — the volumes the
 * camera clips against are now literally the volumes the arbiter placed, so the two can never
 * drift (the failure mode the old two-walk design risked: a layer added to the world but
 * forgotten in the index's source list).
 *
 * Fade keys are NOT minted here — they are minted at registration by the same exported
 * frontage/infill/backdrop key functions the renderer side calls, and simply carried through.
 * A building claim registered without a key is treated as material-path-faded (null), matching
 * the named/hero convention.
 */
export function buildingClipVolumes(index: ClaimIndexView): ClipEntry[] {
  const out: ClipEntry[] = [];
  for (const claim of index.allClaims()) {
    if (!isBuildingClaimKind(claim.kind)) continue;
    const [minY, maxY] = claim.yRange ?? [0, 0];
    out.push({
      minX: claim.aabb.minX,
      maxX: claim.aabb.maxX,
      minY,
      maxY,
      minZ: claim.aabb.minZ,
      maxZ: claim.aabb.maxZ,
      fadeKey: claim.fadeKey ?? null,
    });
  }
  return out;
}
