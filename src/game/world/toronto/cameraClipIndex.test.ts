// Phase 33 camera lab — the camera clip index: what goes IN it (Phase 40: the placement arbiter's
// building-class CLAIMS, projected by claimIndex.buildingClipVolumes) and what comes OUT of it
// (point + segment queries, including the bucket grid's obligation to count a multi-cell box
// exactly once).
//
// Phase 40 replaced this module's own `ClipIndexSources`/`buildClipIndexEntries` walk with that
// projection, so the source-construction tests below now exercise the CLAIM SELECTOR instead. Every
// query-behaviour test is unchanged (the runtime half is Phase-36-pinned and was not touched).
import { afterEach, describe, expect, it } from 'vitest';
import {
  INFILL_BUILDING_ID_PREFIX,
  backdropFadeKey,
  clearClipIndex,
  eyeInsideAny,
  frontageFadeKey,
  getClipIndexBoxes,
  getClipIndexSize,
  infillFadeKey,
  pointInsideAny,
  segmentHitCount,
  segmentHitFadeKeys,
  setClipIndex,
  type ClipAabb,
  type ClipEntry,
} from './cameraClipIndex';
import { aabbAround, buildingClipVolumes, createClaimIndex, type ClaimInput } from './claimIndex';
import { composeWorld } from './composeWorld';

/** A unit-ish box centred at (x, z) with the map's ground-anchored convention. */
function boxAt(x: number, z: number, hx = 5, hy = 10, hz = 5): ClipAabb {
  return { minX: x - hx, maxX: x + hx, minY: 0, maxY: 2 * hy, minZ: z - hz, maxZ: z + hz };
}

/** Project a handful of claims through the selector the scene uses. */
function volumesOf(...claims: readonly ClaimInput[]): readonly ClipEntry[] {
  const index = createClaimIndex();
  index.registerAll(claims);
  return buildingClipVolumes(index);
}

/** A ground-anchored building claim, the shape composeWorld registers frontage/back-lot items as. */
function groundedClaim(
  id: string,
  kind: ClaimInput['kind'],
  x: number,
  z: number,
  hx: number,
  hy: number,
  hz: number,
  fadeKey: string | null,
): ClaimInput {
  return { id, kind, source: 'frontage', aabb: aabbAround(x, z, hx, hz), yRange: [0, 2 * hy], fadeKey };
}

afterEach(() => {
  clearClipIndex();
});

describe('buildingClipVolumes — claims → volumes (Phase 40 source)', () => {
  it('a ground-anchored building claim spans y ∈ [0, 2·hy] (the collider convention)', () => {
    const [box] = volumesOf(groundedClaim('a', 'frontageSlot', 100, 200, 4, 9, 3, 'frontage:a'));
    expect(box).toEqual({ minX: 96, maxX: 104, minY: 0, maxY: 18, minZ: 197, maxZ: 203, fadeKey: 'frontage:a' });
  });

  it('a centred backdrop box uses x/z + the same floor-at-zero rule', () => {
    const [box] = volumesOf(groundedClaim('b', 'backdropBox', -50, 25, 6, 12, 8, 'backdrop:1'));
    expect(box).toEqual({ minX: -56, maxX: -44, minY: 0, maxY: 24, minZ: 17, maxZ: 33, fadeKey: 'backdrop:1' });
  });

  it('a named-building claim carries a null fade key (it rides the material-opacity fader)', () => {
    const [box] = volumesOf({
      id: 'named:td:0',
      kind: 'namedBuilding',
      source: 'named',
      aabb: aabbAround(10, 20, 2, 4),
      yRange: [0, 60],
      fadeKey: null,
    });
    expect(box).toEqual({ minX: 8, maxX: 12, minY: 0, maxY: 60, minZ: 16, maxZ: 24, fadeKey: null });
  });

  it('keeps only BUILDING-class claims (cars/fences/furniture/decor are not volumes a camera clips)', () => {
    const boxes = volumesOf(
      groundedClaim('keep', 'backlotBuilding', 0, 0, 5, 8, 5, 'infill:backlot:x'),
      { id: 'car', kind: 'lotCar', source: 'infill', aabb: aabbAround(20, 0, 1, 2) },
      { id: 'fence', kind: 'lotFixture', source: 'infill', aabb: aabbAround(40, 0, 3, 0.2) },
      { id: 'tree', kind: 'furniture', source: 'furniture', aabb: aabbAround(60, 0, 0.25, 0.25) },
      { id: 'cone', kind: 'cone', source: 'infill', aabb: aabbAround(80, 0, 0.3, 0.3) },
      { id: 'greenhouse', kind: 'scatterProp', source: 'infill', aabb: aabbAround(100, 0, 2, 3) },
      { id: 'ribbon', kind: 'streetRibbon', source: 'streets', aabb: aabbAround(120, 0, 5, 5) },
    );
    expect(boxes).toHaveLength(1);
    expect(boxes[0].maxX).toBe(5);
  });

  it('emits every building class, in registration order', () => {
    const boxes = volumesOf(
      groundedClaim('s', 'frontageSlot', 0, 0, 1, 1, 1, 'frontage:s'),
      groundedClaim('c', 'cornerFill', 10, 0, 1, 1, 1, 'frontage:c'),
      groundedClaim('bd', 'backdropBox', 20, 0, 1, 1, 1, 'backdrop:2'),
      groundedClaim('bl', 'backlotBuilding', 30, 0, 1, 1, 1, 'infill:bl'),
      { id: 'n', kind: 'namedBuilding', source: 'named', aabb: aabbAround(40, 0, 1, 1), yRange: [0, 2], fadeKey: null },
    );
    expect(boxes).toHaveLength(5);
    expect(boxes.map((b) => b.minX)).toEqual([-1, 9, 19, 29, 39]);
  });

  it('DRIFT GUARD: the real infill layout still ids its back-lot buildings with the filtered prefix', () => {
    const infill = composeWorld(416).infill;
    const backlot = infill.fixed.filter((f) => f.id.startsWith(INFILL_BUILDING_ID_PREFIX));
    // The RENDERER side (cityPack/fadeKeys.ts) still filters on this prefix, so a rename in
    // infill.ts fails loudly here instead of silently un-fading every back-lot building.
    expect(backlot.length).toBeGreaterThan(0);
    expect(backlot.length).toBeLessThan(infill.fixed.length);
  });
});

describe('clip index lifecycle', () => {
  it('starts empty and answers everything negatively', () => {
    clearClipIndex();
    expect(getClipIndexSize()).toBe(0);
    expect(eyeInsideAny(0, 0, 0)).toBe(false);
    expect(segmentHitCount(0, 0, 0, 100, 0, 100)).toBe(0);
  });

  it('setClipIndex replaces (never appends) and exposes its size + boxes', () => {
    setClipIndex([boxAt(0, 0), boxAt(100, 0)]);
    expect(getClipIndexSize()).toBe(2);
    setClipIndex([boxAt(0, 0)]);
    expect(getClipIndexSize()).toBe(1);
    expect(getClipIndexBoxes()[0].minX).toBe(-5);
  });

  it('clearClipIndex empties it', () => {
    setClipIndex([boxAt(0, 0)]);
    clearClipIndex();
    expect(getClipIndexSize()).toBe(0);
  });
});

describe('point queries (eye inside / near plane)', () => {
  it('reports a point strictly inside', () => {
    setClipIndex([boxAt(0, 0)]);
    expect(eyeInsideAny(0, 5, 0)).toBe(true);
  });

  it('reports a point outside on every axis', () => {
    setClipIndex([boxAt(0, 0)]); // x,z ∈ ±5, y ∈ [0,20]
    expect(eyeInsideAny(6, 5, 0)).toBe(false);
    expect(eyeInsideAny(0, 5, -6)).toBe(false);
    expect(eyeInsideAny(0, 21, 0)).toBe(false);
    expect(eyeInsideAny(0, -1, 0)).toBe(false);
  });

  it('treats the boundary as inside (a lens flush with a facade already failed)', () => {
    setClipIndex([boxAt(0, 0)]);
    expect(eyeInsideAny(5, 20, 5)).toBe(true);
    expect(eyeInsideAny(5.0001, 20, 5)).toBe(false);
  });

  it('honours a margin, inflating every face', () => {
    setClipIndex([boxAt(0, 0)]);
    expect(pointInsideAny(7, 5, 0)).toBe(false);
    expect(pointInsideAny(7, 5, 0, 2)).toBe(true);
    expect(pointInsideAny(0, 22, 0, 2)).toBe(true);
  });

  it('finds boxes far apart in world space (bucket-grid addressing)', () => {
    setClipIndex([boxAt(0, 0), boxAt(1200, 2600)]);
    expect(eyeInsideAny(1200, 3, 2600)).toBe(true);
    expect(eyeInsideAny(600, 3, 1300)).toBe(false);
  });
});

describe('segmentHitCount', () => {
  it('counts a single box the segment passes through', () => {
    setClipIndex([boxAt(0, 0)]);
    expect(segmentHitCount(-40, 5, 0, 40, 5, 0)).toBe(1);
  });

  it('counts every box on a line through several', () => {
    setClipIndex([boxAt(0, 0), boxAt(20, 0), boxAt(40, 0)]);
    expect(segmentHitCount(-20, 5, 0, 60, 5, 0)).toBe(3);
  });

  it('is 0 when the segment misses everything', () => {
    setClipIndex([boxAt(0, 0), boxAt(20, 0)]);
    expect(segmentHitCount(-40, 5, 30, 40, 5, 30)).toBe(0);
  });

  it('is 0 when the segment stops short of the box (t is clamped to [0,1])', () => {
    setClipIndex([boxAt(0, 0)]);
    expect(segmentHitCount(-40, 5, 0, -20, 5, 0)).toBe(0);
    expect(segmentHitCount(-40, 5, 0, -5, 5, 0)).toBe(1); // just reaches the face
  });

  it('counts a box spanning many grid cells exactly ONCE', () => {
    // 400 wu wide — far bigger than the bucket edge, so it lands in many cells.
    setClipIndex([{ minX: -200, maxX: 200, minY: 0, maxY: 40, minZ: -200, maxZ: 200 }]);
    expect(segmentHitCount(-400, 10, -400, 400, 10, 400)).toBe(1);
  });

  it('handles an axis-parallel (zero-direction) segment without NaN leakage', () => {
    setClipIndex([boxAt(0, 0)]);
    // Straight down the +Y axis at the box's centre → hits; the same descent 30 wu away → misses.
    expect(segmentHitCount(0, 60, 0, 0, 5, 0)).toBe(1);
    expect(segmentHitCount(30, 60, 0, 30, 5, 0)).toBe(0);
  });

  it('vertical clearance matters: a segment above the roofline misses', () => {
    setClipIndex([boxAt(0, 0)]); // roof at y = 20
    expect(segmentHitCount(-40, 25, 0, 40, 25, 0)).toBe(0);
    expect(segmentHitCount(-40, 19, 0, 40, 19, 0)).toBe(1);
  });

  it('repeated queries stay independent (the de-duplication stamp resets per query)', () => {
    setClipIndex([boxAt(0, 0), boxAt(20, 0)]);
    expect(segmentHitCount(-20, 5, 0, 60, 5, 0)).toBe(2);
    expect(segmentHitCount(-20, 5, 0, 60, 5, 0)).toBe(2);
    expect(segmentHitCount(-20, 5, 40, 60, 5, 40)).toBe(0);
    expect(segmentHitCount(-20, 5, 0, 60, 5, 0)).toBe(2);
  });
});

// --- Phase 36: fade keys + the targeting query --------------------------------------------------

describe('fade-key derivation (single-sourced: the index and the mesh side both call these)', () => {
  it('frontage/corner-fill keys come from the stable slotId, namespaced', () => {
    expect(frontageFadeKey({ slotId: 'yonge:p:138' })).toBe('frontage:yonge:p:138');
    expect(frontageFadeKey({ slotId: 'corner:yongexking:pn' })).toBe('frontage:corner:yongexking:pn');
  });

  it('infill keys come from the generator id, namespaced (so it cannot collide with a slotId)', () => {
    expect(infillFadeKey({ id: 'backlot:king:hi:3' })).toBe('infill:backlot:king:hi:3');
    expect(infillFadeKey({ id: 'backlot:king:hi:3' })).not.toBe(frontageFadeKey({ slotId: 'backlot:king:hi:3' }));
  });

  it('backdrop keys are centre-XZ derived — order-independent and stable to cm', () => {
    expect(backdropFadeKey({ x: 1500.004, z: -22.5 })).toBe('backdrop:150000:-2250');
    // The property that matters: the SAME box yields the same key on either walk, and two boxes at
    // different centres never share one.
    expect(backdropFadeKey({ x: 1500, z: 10 })).toBe(backdropFadeKey({ x: 1500, z: 10 }));
    expect(backdropFadeKey({ x: 1500, z: 10 })).not.toBe(backdropFadeKey({ x: 1500, z: 10.5 }));
  });
});

describe('buildingClipVolumes — who is dither-fadeable', () => {
  it('frontage slots carry their slotId key; a building claim registered without one carries null', () => {
    const entries = volumesOf(
      groundedClaim('a', 'frontageSlot', 10, 20, 1, 1, 1, frontageFadeKey({ slotId: 'king:p:4' })),
      { id: 'b', kind: 'frontageSlot', source: 'frontage', aabb: aabbAround(30, 20, 1, 1), yRange: [0, 2] },
    );
    expect(entries.map((e) => e.fadeKey)).toEqual(['frontage:king:p:4', null]);
  });

  it('back-lot infill buildings carry their id key', () => {
    const entries = volumesOf(
      groundedClaim('a', 'backlotBuilding', 0, 0, 5, 8, 5, infillFadeKey({ id: `${INFILL_BUILDING_ID_PREFIX}king:hi:3` })),
    );
    expect(entries.map((e) => e.fadeKey)).toEqual([`infill:${INFILL_BUILDING_ID_PREFIX}king:hi:3`]);
  });

  it('backdrop boxes carry a backdrop key; NAMED boxes carry null (legacy material fader)', () => {
    const entries = volumesOf(
      groundedClaim('a', 'backdropBox', -50, 25, 6, 12, 8, backdropFadeKey({ x: -50, z: 25 })),
      { id: 'n', kind: 'namedBuilding', source: 'named', aabb: aabbAround(10, 20, 2, 4), yRange: [0, 60], fadeKey: null },
    );
    expect(entries.map((e) => e.fadeKey)).toEqual([backdropFadeKey({ x: -50, z: 25 }), null]);
  });

  it('DRIFT GUARD: every fade key on the REAL composed world is unique (no two volumes share a writer)', () => {
    const world = composeWorld(416);
    const keys = world.clipVolumes.map((e) => e.fadeKey).filter((k): k is string => k !== null);
    expect(new Set(keys).size).toBe(keys.length);
    // Only the named boxes are un-keyed; every batched class IS fadeable.
    const named = world.named.placements.reduce((n, p) => n + p.boxes.length, 0);
    expect(world.clipVolumes.length - keys.length).toBe(named);
  });
});

describe('segmentHitFadeKeys', () => {
  /** A keyed box, so a test can assert which volumes a segment claimed. */
  function keyed(key: string | null, x: number, z: number, hx = 5, hy = 10, hz = 5): ClipEntry {
    return { ...boxAt(x, z, hx, hy, hz), fadeKey: key };
  }

  it('collects the keys of every keyed box the segment passes through', () => {
    setClipIndex([keyed('a', 0, 0), keyed('b', 20, 0), keyed('c', 0, 40)]);
    const out = new Set<string>();
    expect(segmentHitFadeKeys(-20, 5, 0, 60, 5, 0, out)).toBe(2);
    expect([...out].sort()).toEqual(['a', 'b']);
  });

  it('skips null-key volumes (named/hero ride the material-opacity fader instead)', () => {
    setClipIndex([keyed(null, 0, 0), keyed('b', 20, 0)]);
    const out = new Set<string>();
    expect(segmentHitFadeKeys(-20, 5, 0, 60, 5, 0, out)).toBe(1);
    expect([...out]).toEqual(['b']);
  });

  it('treats a key-less (pre-Phase-36) box as not fadeable rather than throwing', () => {
    setClipIndex([boxAt(0, 0)]);
    const out = new Set<string>();
    expect(segmentHitFadeKeys(-20, 5, 0, 60, 5, 0, out)).toBe(0);
    expect(out.size).toBe(0);
  });

  it('UNIONS across calls and reports only what each call newly added (the 5-segment pass)', () => {
    setClipIndex([keyed('a', 0, 0), keyed('b', 20, 0)]);
    const out = new Set<string>();
    expect(segmentHitFadeKeys(-20, 5, 0, 10, 5, 0, out)).toBe(1); // 'a'
    expect(segmentHitFadeKeys(-20, 5, 0, 60, 5, 0, out)).toBe(1); // 'a' already there, adds 'b'
    expect([...out].sort()).toEqual(['a', 'b']);
  });

  it('counts a box spanning many grid cells once, and leaves an empty index alone', () => {
    setClipIndex([{ minX: -200, maxX: 200, minY: 0, maxY: 40, minZ: -200, maxZ: 200, fadeKey: 'big' }]);
    const out = new Set<string>();
    expect(segmentHitFadeKeys(-400, 10, -400, 400, 10, 400, out)).toBe(1);
    clearClipIndex();
    out.clear();
    expect(segmentHitFadeKeys(-400, 10, -400, 400, 10, 400, out)).toBe(0);
  });

  it('agrees with a brute-force scan over randomized boxes and segments (seeded)', () => {
    // Tiny deterministic LCG — no rng import, so this test can never drift with the world seed.
    let s = 20260726;
    const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const span = (lo: number, hi: number): number => lo + rnd() * (hi - lo);

    const entries: ClipEntry[] = [];
    for (let i = 0; i < 120; i++) {
      const x = span(-300, 300);
      const z = span(-300, 300);
      const hx = span(2, 30);
      const hy = span(2, 25);
      const hz = span(2, 30);
      // A third of the population is null-keyed (named/hero-like) — the brute force must agree
      // about those being invisible to this query too.
      entries.push({ ...boxAt(x, z, hx, hy, hz), fadeKey: i % 3 === 0 ? null : `k${i}` });
    }
    setClipIndex(entries);

    /** Reference: unaccelerated slab test over the whole list. */
    const bruteKeys = (
      x0: number,
      y0: number,
      z0: number,
      x1: number,
      y1: number,
      z1: number,
    ): Set<string> => {
      const hit = new Set<string>();
      for (const b of entries) {
        if (b.fadeKey === null) continue;
        let tMin = 0;
        let tMax = 1;
        let ok = true;
        const axes: [number, number, number, number][] = [
          [b.minX, b.maxX, x0, x1 - x0],
          [b.minY, b.maxY, y0, y1 - y0],
          [b.minZ, b.maxZ, z0, z1 - z0],
        ];
        for (const [lo, hi, o, d] of axes) {
          if (d === 0) {
            if (o < lo || o > hi) {
              ok = false;
              break;
            }
            continue;
          }
          let t1 = (lo - o) / d;
          let t2 = (hi - o) / d;
          if (t1 > t2) [t1, t2] = [t2, t1];
          if (t1 > tMin) tMin = t1;
          if (t2 < tMax) tMax = t2;
          if (tMin > tMax) {
            ok = false;
            break;
          }
        }
        if (ok) hit.add(b.fadeKey);
      }
      return hit;
    };

    const out = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const x0 = span(-350, 350);
      const y0 = span(0, 60);
      const z0 = span(-350, 350);
      const x1 = x0 + span(-120, 120);
      const y1 = span(0, 60);
      const z1 = z0 + span(-120, 120);
      out.clear();
      segmentHitFadeKeys(x0, y0, z0, x1, y1, z1, out);
      expect([...out].sort()).toEqual([...bruteKeys(x0, y0, z0, x1, y1, z1)].sort());
    }
  });

  it('does not disturb segmentHitCount running alongside it (shared visited stamp)', () => {
    setClipIndex([keyed('a', 0, 0), keyed(null, 20, 0)]);
    const out = new Set<string>();
    expect(segmentHitCount(-20, 5, 0, 60, 5, 0)).toBe(2);
    expect(segmentHitFadeKeys(-20, 5, 0, 60, 5, 0, out)).toBe(1);
    expect(segmentHitCount(-20, 5, 0, 60, 5, 0)).toBe(2);
  });
});
