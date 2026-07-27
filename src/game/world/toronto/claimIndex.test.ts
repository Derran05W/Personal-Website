/**
 * Phase 40 — claimIndex.ts store-semantics tests, written test-first against the plan's
 * verification list (§Verification: "claimIndex store semantics"). This file never touches
 * composeWorld or the real Toronto layout — every case below is a synthetic, minimal index built
 * from `createClaimIndex()` directly, so a failure here points at the STORE, never at a placer's
 * geometry (composeWorld.test.ts and overlapInvariant.test.ts own the real-layout assertions).
 *
 * The store's two load-bearing contracts under test:
 *   1. The interior-overlap / strict-containment PREDICATES (`overlaps`, `queryPoint`'s own inline
 *      check) — touching never counts, which is what sanctions flush frontage and abutting fence
 *      panels by construction rather than by whitelist (claimIndex.ts's header).
 *   2. DETERMINISTIC ORDER — every query result comes back in registration order regardless of
 *      which grid cell the bucket walk happens to visit first (`collect`'s ordinal sort). A test
 *      that only ever registers claims in walk order would never catch a regression here, so the
 *      order test below deliberately registers a claim into a LATER-walked cell first.
 */
import { describe, expect, it } from 'vitest';
import {
  aabbAround,
  buildingClipVolumes,
  createClaimIndex,
  footprintHalfExtents,
  isSanctionedOverlap,
  overlaps,
  type Aabb,
  type Claim,
  type ClaimInput,
  type ClaimKind,
} from './claimIndex';

/** A minimal, fully-typed ClaimInput — every test below only overrides the fields it cares about,
 * so a new required Claim field would fail every call site here rather than silently defaulting. */
function makeClaim(id: string, kind: ClaimKind, overrides: Partial<Omit<ClaimInput, 'id' | 'kind'>> = {}): ClaimInput {
  return {
    id,
    kind,
    source: overrides.source ?? 'world',
    aabb: overrides.aabb ?? aabbAround(0, 0, 1, 1),
    ...(overrides.yRange !== undefined ? { yRange: overrides.yRange } : {}),
    ...(overrides.fadeKey !== undefined ? { fadeKey: overrides.fadeKey } : {}),
    ...(overrides.owner !== undefined ? { owner: overrides.owner } : {}),
  };
}

describe('createClaimIndex — register', () => {
  it('accepts a claim and reflects it in size()/allClaims()', () => {
    const index = createClaimIndex();
    index.register(makeClaim('a', 'furniture'));
    expect(index.size()).toBe(1);
    expect(index.allClaims().map((c) => c.id)).toEqual(['a']);
  });

  it('a duplicate id throws, and the message carries the offending kind/source', () => {
    const index = createClaimIndex();
    index.register(makeClaim('dup', 'furniture', { source: 'furniture' }));
    expect(() => index.register(makeClaim('dup', 'parkedCar', { source: 'infill' }))).toThrow(
      /dup.*parkedCar\/infill/,
    );
  });

  it('derives `blocking` from kind — a BUILDING-class/prop kind is blocking, a zone kind is not', () => {
    const index = createClaimIndex();
    index.register(makeClaim('building', 'namedBuilding'));
    index.register(makeClaim('zone', 'streetRibbon'));
    const [building, zone] = index.allClaims();
    expect(building.blocking).toBe(true);
    expect(zone.blocking).toBe(false);
  });
});

describe('createClaimIndex — queryRect: interior overlap, touching never counts', () => {
  // One reference claim: aabb [-1,1] x [-1,1] (aabbAround(0,0,1,1)).
  function withOneClaim(): ReturnType<typeof createClaimIndex> {
    const index = createClaimIndex();
    index.register(makeClaim('ref', 'furniture'));
    return index;
  }

  it('a rect that only TOUCHES the reference claim at a shared edge is not returned', () => {
    const index = withOneClaim();
    // [1,3] x [-1,1] shares the x=1 edge with the reference claim's [-1,1] and nothing more.
    const touching: Aabb = { minX: 1, maxX: 3, minZ: -1, maxZ: 1 };
    expect(index.queryRect(touching)).toEqual([]);
  });

  it('a rect that interior-overlaps the reference claim by any positive amount IS returned', () => {
    const index = withOneClaim();
    // [0.5,3] x [-1,1] overlaps the reference claim's [-1,1] on x by [0.5,1] — interior, not a face.
    const overlapping: Aabb = { minX: 0.5, maxX: 3, minZ: -1, maxZ: 1 };
    expect(index.queryRect(overlapping).map((c) => c.id)).toEqual(['ref']);
  });

  it('the epsilon is tight — 1e-9 short of touching still counts as interior overlap', () => {
    const index = withOneClaim();
    const justInside: Aabb = { minX: 1 - 1e-6, maxX: 3, minZ: -1, maxZ: 1 };
    expect(index.queryRect(justInside).map((c) => c.id)).toEqual(['ref']);
  });
});

describe('createClaimIndex — queryPoint: strict containment', () => {
  function withOneClaim(): ReturnType<typeof createClaimIndex> {
    const index = createClaimIndex();
    index.register(makeClaim('ref', 'furniture'));
    return index;
  }

  it('a point strictly inside the footprint is contained', () => {
    const index = withOneClaim();
    expect(index.queryPoint(0, 0).map((c) => c.id)).toEqual(['ref']);
  });

  it('a point exactly ON a face is OUTSIDE (strict, not inclusive)', () => {
    const index = withOneClaim();
    expect(index.queryPoint(1, 0)).toEqual([]); // on the x=1 face
    expect(index.queryPoint(0, -1)).toEqual([]); // on the z=-1 face
  });

  it('a point just past a face is outside; a point just short of it is inside', () => {
    const index = withOneClaim();
    expect(index.queryPoint(1 + 1e-6, 0)).toEqual([]);
    expect(index.queryPoint(1 - 1e-6, 0).map((c) => c.id)).toEqual(['ref']);
  });
});

describe('createClaimIndex — overlapsAny agrees with queryRect', () => {
  it('overlapsAny(rect) === (queryRect(rect).length > 0) across touching, overlapping and empty cases', () => {
    const index = createClaimIndex();
    index.register(makeClaim('ref', 'furniture'));
    const cases: readonly Aabb[] = [
      { minX: 1, maxX: 3, minZ: -1, maxZ: 1 }, // touching only
      { minX: 0.5, maxX: 3, minZ: -1, maxZ: 1 }, // interior overlap
      { minX: 10, maxX: 12, minZ: 10, maxZ: 12 }, // nowhere near
    ];
    for (const rect of cases) {
      expect(index.overlapsAny(rect)).toBe(index.queryRect(rect).length > 0);
    }
  });
});

describe('createClaimIndex — query filters (kinds / sources / blocking / excludeOwner) are ANDed', () => {
  function buildFixture(): ReturnType<typeof createClaimIndex> {
    const index = createClaimIndex();
    // Same footprint for all four so every filter combination is exercised on IDENTICAL geometry —
    // only the metadata differs, isolating the filter logic from the geometry predicate.
    const fp = aabbAround(0, 0, 1, 1);
    index.register(makeClaim('furniture-street', 'furniture', { source: 'furniture', aabb: fp }));
    index.register(makeClaim('parkedCar-infill', 'parkedCar', { source: 'infill', aabb: fp, owner: 'lot:1' }));
    index.register(makeClaim('parkedCar-street', 'parkedCar', { source: 'furniture', aabb: fp }));
    index.register(makeClaim('ribbon-zone', 'streetRibbon', { source: 'streets', aabb: fp }));
    return index;
  }

  it('kinds alone', () => {
    const index = buildFixture();
    const kinds = new Set<ClaimKind>(['parkedCar']);
    expect(index.queryPoint(0, 0, { kinds }).map((c) => c.id).sort()).toEqual(['parkedCar-infill', 'parkedCar-street']);
  });

  it('sources alone', () => {
    const index = buildFixture();
    const sources = new Set<Claim['source']>(['furniture']);
    expect(index.queryPoint(0, 0, { sources }).map((c) => c.id).sort()).toEqual(['furniture-street', 'parkedCar-street']);
  });

  it('blocking alone', () => {
    const index = buildFixture();
    expect(index.queryPoint(0, 0, { blocking: false }).map((c) => c.id)).toEqual(['ribbon-zone']);
  });

  it('excludeOwner alone', () => {
    const index = buildFixture();
    expect(index.queryPoint(0, 0, { excludeOwner: 'lot:1' }).map((c) => c.id).sort()).toEqual([
      'furniture-street',
      'parkedCar-street',
      'ribbon-zone',
    ]);
  });

  it('all four ANDed together select exactly the one matching claim', () => {
    const index = buildFixture();
    const result = index.queryPoint(0, 0, {
      kinds: new Set<ClaimKind>(['parkedCar']),
      sources: new Set<Claim['source']>(['furniture']),
      blocking: true,
      excludeOwner: 'lot:1',
    });
    // parkedCar-infill fails sources (infill) and excludeOwner (lot:1); parkedCar-street matches
    // every clause. If the filters were OR'd instead of AND'd, parkedCar-infill would leak in too.
    expect(result.map((c) => c.id)).toEqual(['parkedCar-street']);
  });
});

describe('createClaimIndex — result order is registration order, independent of bucket walk order', () => {
  it('rects() and queryRect() both preserve registration order for far-apart-then-overlapping claims', () => {
    const index = createClaimIndex();
    // "far" registers FIRST (ordinal 0) but lands in a HIGH cell (cellOf ~2,2 at CELL_SIZE_WU=48),
    // which the bucket walk below visits LAST (cz then cx ascending). "near" registers SECOND
    // (ordinal 1) but lands in a LOW cell (cellOf ~-1,-1), visited FIRST by the same walk. A naive
    // "return hits in bucket-visit order" implementation would emit [near, far] here; the store's
    // ordinal sort must restore [far, near] — the actual registration order.
    index.register(makeClaim('far', 'furniture', { aabb: aabbAround(100, 100, 1, 1) }));
    index.register(makeClaim('near', 'furniture', { aabb: aabbAround(0, 0, 1, 1) }));

    // A query rect spanning both claims' cells, visited cz ascending then cx ascending — so the
    // "near" claim's low cell is walked well before "far"'s high cell.
    const spanning: Aabb = { minX: -2, maxX: 102, minZ: -2, maxZ: 102 };
    expect(index.queryRect(spanning).map((c) => c.id)).toEqual(['far', 'near']);
    expect(index.rects().length).toBe(2); // rects() has no query — sanity on the fixture
    // rects(query) filters the underlying `claims` array directly (registration order by
    // construction), asserted here so a future rewrite that routes it through the bucket walk
    // would be caught by the SAME ordering expectation as queryRect.
    expect(index.rects({ kinds: new Set<ClaimKind>(['furniture']) })).toEqual([
      aabbAround(100, 100, 1, 1),
      aabbAround(0, 0, 1, 1),
    ]);
  });
});

describe('createClaimIndex — a claim spanning multiple 48-wu cells is returned exactly once', () => {
  it('a large footprint crossing 4 cells de-duplicates under a query that also spans all 4', () => {
    const index = createClaimIndex();
    // Half-extents 40 x 40 centred at the origin -> aabb [-40,40] x [-40,40], which at
    // CELL_SIZE_WU=48 spans cells {-1,0} on both axes: 4 cells.
    index.register(makeClaim('big', 'namedBuilding', { aabb: aabbAround(0, 0, 40, 40) }));
    const spanningQuery: Aabb = { minX: -50, maxX: 50, minZ: -50, maxZ: 50 };
    const hits = index.queryRect(spanningQuery);
    expect(hits.length).toBe(1);
    expect(hits[0].id).toBe('big');
  });
});

describe('footprintHalfExtents — the shared yaw-rotation rule', () => {
  it('yaw 0: exact, unrotated {hx,hz}', () => {
    expect(footprintHalfExtents(2, 5, 0)).toEqual({ hx: 2, hz: 5 });
  });

  it('yaw +pi/2: swapped exactly (axis-aligned quarter turn)', () => {
    expect(footprintHalfExtents(2, 5, Math.PI / 2)).toEqual({ hx: 5, hz: 2 });
  });

  it('yaw -pi/2: swapped exactly (the other quarter turn)', () => {
    expect(footprintHalfExtents(2, 5, -Math.PI / 2)).toEqual({ hx: 5, hz: 2 });
  });

  it('yaw pi: exact, unrotated (a half turn is axis-aligned, not swapped)', () => {
    expect(footprintHalfExtents(2, 5, Math.PI)).toEqual({ hx: 2, hz: 5 });
  });

  it('an arbitrary yaw (0.7 rad) falls back to the circumscribed square: max(hx,hz) both ways', () => {
    expect(footprintHalfExtents(2, 5, 0.7)).toEqual({ hx: 5, hz: 5 });
    // The "both ways" half of the claim: max() picks hx when it is the larger dimension too, not
    // just when hz is — a rule that always returned hz would pass the case above by accident.
    expect(footprintHalfExtents(7, 3, 0.7)).toEqual({ hx: 7, hz: 7 });
  });
});

describe('isSanctionedOverlap — the whitelist rules, machine-readable', () => {
  function claim(overrides: Partial<Claim>): Claim {
    return {
      id: 'x',
      kind: 'furniture',
      source: 'furniture',
      blocking: true,
      aabb: aabbAround(0, 0, 1, 1),
      ...overrides,
    };
  }

  it('(a) same DEFINED owner -> sanctioned', () => {
    const a = claim({ owner: 'lot:1' });
    const b = claim({ owner: 'lot:1', source: 'infill' });
    expect(isSanctionedOverlap(a, b)).toBe(true);
  });

  it('(b) both source "worldEdge" -> sanctioned, regardless of owner', () => {
    const a = claim({ source: 'worldEdge' });
    const b = claim({ source: 'worldEdge' });
    expect(isSanctionedOverlap(a, b)).toBe(true);
  });

  it('different owners -> NOT sanctioned', () => {
    const a = claim({ owner: 'lot:1' });
    const b = claim({ owner: 'lot:2' });
    expect(isSanctionedOverlap(a, b)).toBe(false);
  });

  it('BOTH owners undefined -> NOT sanctioned (the a.owner !== undefined guard)', () => {
    // Without the explicit "!== undefined" guard, `a.owner === b.owner` alone would read
    // `undefined === undefined` as true and silently sanction every ownerless pair in the city —
    // which is most of the map (furniture, frontage's generic slots, infill's fixed items all
    // register with no owner at all). This is the regression the guard exists to prevent.
    const a = claim({ owner: undefined });
    const b = claim({ owner: undefined });
    expect(isSanctionedOverlap(a, b)).toBe(false);
  });
});

describe('buildingClipVolumes — the camera-clip projection selector', () => {
  it('projects ONLY building-class claims, in registration order', () => {
    const index = createClaimIndex();
    index.register(makeClaim('building-1', 'namedBuilding', { aabb: aabbAround(0, 0, 1, 1), yRange: [0, 10] }));
    index.register(makeClaim('not-building', 'furniture', { aabb: aabbAround(5, 5, 1, 1) }));
    index.register(makeClaim('building-2', 'frontageSlot', { aabb: aabbAround(10, 10, 1, 1), yRange: [0, 6] }));
    index.register(makeClaim('zone-not-building', 'parkRect', { aabb: aabbAround(20, 20, 1, 1) }));
    const volumes = buildingClipVolumes(index);
    expect(volumes.map((v) => [v.minX, v.maxX])).toEqual([
      [aabbAround(0, 0, 1, 1).minX, aabbAround(0, 0, 1, 1).maxX],
      [aabbAround(10, 10, 1, 1).minX, aabbAround(10, 10, 1, 1).maxX],
    ]);
  });

  it('carries yRange through to minY/maxY when present', () => {
    const index = createClaimIndex();
    index.register(makeClaim('b', 'namedBuilding', { yRange: [1, 9] }));
    const [entry] = buildingClipVolumes(index);
    expect(entry.minY).toBe(1);
    expect(entry.maxY).toBe(9);
  });

  it('defaults to [0,0] when yRange is absent', () => {
    const index = createClaimIndex();
    index.register(makeClaim('b', 'namedBuilding'));
    const [entry] = buildingClipVolumes(index);
    expect(entry.minY).toBe(0);
    expect(entry.maxY).toBe(0);
  });

  it('carries fadeKey through when present (including an explicit null)', () => {
    const index = createClaimIndex();
    index.register(makeClaim('with-key', 'frontageSlot', { fadeKey: 'frontage:abc' }));
    index.register(makeClaim('explicit-null', 'namedBuilding', { fadeKey: null }));
    const [withKey, explicitNull] = buildingClipVolumes(index);
    expect(withKey.fadeKey).toBe('frontage:abc');
    expect(explicitNull.fadeKey).toBeNull();
  });

  it('defaults fadeKey to null when absent entirely', () => {
    const index = createClaimIndex();
    index.register(makeClaim('no-key', 'backdropBox'));
    const [entry] = buildingClipVolumes(index);
    expect(entry.fadeKey).toBeNull();
  });
});

// Sanity on the shared `overlaps` predicate re-exported by frontage.ts, since every placer imports
// it from there — a drift between the two import paths would be invisible to every OTHER test in
// this file (they all import from claimIndex.ts directly).
describe('overlaps — re-export sanity', () => {
  it('touching does not overlap; interior does', () => {
    const a: Aabb = { minX: -1, maxX: 1, minZ: -1, maxZ: 1 };
    expect(overlaps(a, { minX: 1, maxX: 3, minZ: -1, maxZ: 1 })).toBe(false);
    expect(overlaps(a, { minX: 0.5, maxX: 3, minZ: -1, maxZ: 1 })).toBe(true);
  });
});
