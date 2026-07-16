import type { BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { WORLD_GEN } from '../../config';
import { PaletteCell, paletteCellUv } from '../archetypes';
import {
  BUILDING_HEIGHT_BUCKETS,
  buildBuildingVariant,
  buildingHeightBucket,
  buildingVariantKey,
  bucketHeightM,
  type BuildingKind,
} from './buildings';
import { addBox, addPrismFrustum, addQuad, createBuilder, toBufferGeometry, triCount } from './kit';
import {
  buildBench,
  buildFenceSegment,
  buildHydrant,
  buildMailbox,
  buildStreetlight,
  buildTrafficLight,
  buildTransformerBox,
  buildTree,
} from './streetProps';

/** Every builder in this family promises: indexed, all-attributes-present, finite, in-range
 * UVs, index length a multiple of 3, every index a valid vertex reference. One shared check
 * so each builder's test just asserts its own shape/budget on top of this. */
function expectValidGeometry(geo: BufferGeometry): void {
  const position = geo.getAttribute('position');
  const normal = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  const uv2 = geo.getAttribute('uv2');
  expect(geo.index).not.toBeNull();
  const indexCount = geo.index!.count;
  expect(indexCount % 3).toBe(0);
  expect(indexCount).toBeGreaterThan(0);
  const vertexCount = position.count;
  expect(normal.count).toBe(vertexCount);
  expect(uv.count).toBe(vertexCount);
  expect(uv2.count).toBe(vertexCount);
  for (let i = 0; i < indexCount; i++) {
    const idx = geo.index!.getX(i);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(vertexCount);
  }
  for (let i = 0; i < position.array.length; i++) {
    expect(Number.isFinite(position.array[i])).toBe(true);
  }
  for (let i = 0; i < uv.array.length; i++) {
    expect(uv.array[i]).toBeGreaterThanOrEqual(0);
    expect(uv.array[i]).toBeLessThanOrEqual(1);
    expect(uv2.array[i]).toBeGreaterThanOrEqual(0);
    expect(uv2.array[i]).toBeLessThanOrEqual(1);
  }
  // Flat shading: every normal component is finite and the vector is unit-length (within
  // float slop) — catches a bad faceNormal() cross-product silently producing a zero vector.
  for (let i = 0; i < normal.count; i++) {
    const nx = normal.getX(i);
    const ny = normal.getY(i);
    const nz = normal.getZ(i);
    const len = Math.hypot(nx, ny, nz);
    expect(len).toBeGreaterThan(0.99);
    expect(len).toBeLessThan(1.01);
  }
}

describe('kit — addBox winding (axis-aligned faces must point the right way)', () => {
  it('a unit box with all 6 faces has the correct outward normal per face', () => {
    const b = createBuilder();
    const cell = PaletteCell.metal;
    addBox(
      b,
      { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 },
      {
        px: { albedo: cell },
        nx: { albedo: cell },
        py: { albedo: cell },
        ny: { albedo: cell },
        pz: { albedo: cell },
        nz: { albedo: cell },
      },
    );
    expect(triCount(b)).toBe(12); // 6 faces * 2 tris
    const geo = toBufferGeometry(b);
    expectValidGeometry(geo);
    // 4 vertices per face, in face order px,nx,py,ny,pz,nz (kit.ts's addBox order).
    const expected: readonly [number, number, number][] = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    const normal = geo.getAttribute('normal');
    expected.forEach(([ex, ey, ez], face) => {
      const v = face * 4; // first vertex of this face
      expect(normal.getX(v)).toBeCloseTo(ex);
      expect(normal.getY(v)).toBeCloseTo(ey);
      expect(normal.getZ(v)).toBeCloseTo(ez);
    });
  });

  it('omitted faces cost zero triangles', () => {
    const b = createBuilder();
    addBox(b, { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 }, { px: { albedo: PaletteCell.metal } });
    expect(triCount(b)).toBe(2);
  });
});

describe('kit — addPrismFrustum', () => {
  it('a straight prism (topRadius === baseRadius) costs 2 tris per side, no caps', () => {
    const b = createBuilder();
    addPrismFrustum(b, 8, 0, 1, 0.5, 0.5, PaletteCell.metal);
    expect(triCount(b)).toBe(16);
    expectValidGeometry(toBufferGeometry(b));
  });

  it('a true cone (topRadius === 0) costs 1 tri per side (the degenerate-quad optimization)', () => {
    const b = createBuilder();
    addPrismFrustum(b, 8, 0, 1, 0.5, 0, PaletteCell.foliage);
    expect(triCount(b)).toBe(8);
    expectValidGeometry(toBufferGeometry(b));
  });

  it('an inverted cone (baseRadius === 0) also costs 1 tri per side', () => {
    const b = createBuilder();
    addPrismFrustum(b, 6, 0, 1, 0, 0.5, PaletteCell.metal);
    expect(triCount(b)).toBe(6);
    expectValidGeometry(toBufferGeometry(b));
  });

  it('capTop/capBottom each add sides-2 triangles via fan', () => {
    const b = createBuilder();
    addPrismFrustum(b, 6, 0, 1, 0.5, 0.5, PaletteCell.metal, { capTop: true, capBottom: true });
    expect(triCount(b)).toBe(12 + 6 + 6); // sides*2 + 2 fans of `sides` triangles each
  });

  it('offsetX/offsetZ translate the whole prism without changing its triangle count', () => {
    const a = createBuilder();
    addPrismFrustum(a, 6, 0, 1, 0.3, 0, PaletteCell.metal, { offsetX: 2, offsetZ: -3 });
    expect(triCount(a)).toBe(6);
    const geo = toBufferGeometry(a);
    const position = geo.getAttribute('position');
    // Every base-ring vertex (even indices in emission order) should be centered near x=2,z=-3.
    let sx = 0;
    let sz = 0;
    let n = 0;
    for (let i = 0; i < position.count; i++) {
      if (position.getY(i) === 0) {
        sx += position.getX(i);
        sz += position.getZ(i);
        n++;
      }
    }
    expect(sx / n).toBeCloseTo(2, 1);
    expect(sz / n).toBeCloseTo(-3, 1);
  });
});

describe('kit — addQuad uv2 default', () => {
  it('an emissive-less quad samples uv2 at the asphalt cell (guaranteed-dark default)', () => {
    const b = createBuilder();
    addQuad(
      b,
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
      [0, 0, 1],
      PaletteCell.wallA,
    );
    const geo = toBufferGeometry(b);
    const uv2 = geo.getAttribute('uv2');
    const expected = paletteCellUv(PaletteCell.asphalt);
    expect(uv2.getX(0)).toBeCloseTo(expected.u);
    expect(uv2.getY(0)).toBeCloseTo(expected.v);
  });

  it('an explicit emissive cell overrides the default', () => {
    const b = createBuilder();
    addQuad(
      b,
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
      [0, 0, 1],
      PaletteCell.glassCool,
      PaletteCell.windowWarm,
    );
    const geo = toBufferGeometry(b);
    const uv2 = geo.getAttribute('uv2');
    const expected = paletteCellUv(PaletteCell.windowWarm);
    expect(uv2.getX(0)).toBeCloseTo(expected.u);
    expect(uv2.getY(0)).toBeCloseTo(expected.v);
  });
});

describe('buildings — height bucketing contract', () => {
  const kinds: BuildingKind[] = ['small', 'tower'];

  it('buildingHeightBucket always returns 0..BUILDING_HEIGHT_BUCKETS-1, even out of range', () => {
    for (const kind of kinds) {
      const [min, max] = kind === 'tower' ? WORLD_GEN.towerHeightM : WORLD_GEN.smallHeightM;
      expect(buildingHeightBucket(kind, min)).toBe(0);
      expect(buildingHeightBucket(kind, max - 0.001)).toBe(BUILDING_HEIGHT_BUCKETS - 1);
      expect(buildingHeightBucket(kind, min - 100)).toBe(0); // clamped below range
      expect(buildingHeightBucket(kind, max + 100)).toBe(BUILDING_HEIGHT_BUCKETS - 1); // clamped above
    }
  });

  it('bucketHeightM is self-consistent: re-bucketing its own output returns the same bucket', () => {
    for (const kind of kinds) {
      for (let bucket = 0; bucket < BUILDING_HEIGHT_BUCKETS; bucket++) {
        const h = bucketHeightM(kind, bucket);
        expect(buildingHeightBucket(kind, h)).toBe(bucket);
      }
    }
  });

  it('bucketHeightM stays within the kind’s overall WORLD_GEN range', () => {
    for (const kind of kinds) {
      const [min, max] = kind === 'tower' ? WORLD_GEN.towerHeightM : WORLD_GEN.smallHeightM;
      for (let bucket = 0; bucket < BUILDING_HEIGHT_BUCKETS; bucket++) {
        const h = bucketHeightM(kind, bucket);
        expect(h).toBeGreaterThanOrEqual(min);
        expect(h).toBeLessThanOrEqual(max);
      }
    }
  });

  it('buildingVariantKey only changes when kind, footprint, or height BUCKET changes', () => {
    const [min, max] = WORLD_GEN.smallHeightM;
    const span = (max - min) / BUILDING_HEIGHT_BUCKETS;
    const sameBucketA = min + 0.01;
    const sameBucketB = min + span - 0.01;
    expect(buildingVariantKey('small', 1, 1, sameBucketA)).toBe(buildingVariantKey('small', 1, 1, sameBucketB));
    expect(buildingVariantKey('small', 1, 1, min)).not.toBe(buildingVariantKey('small', 1, 2, min));
    expect(buildingVariantKey('small', 1, 1, min)).not.toBe(buildingVariantKey('tower', 1, 1, min));
    expect(buildingVariantKey('small', 1, 1, min)).not.toBe(buildingVariantKey('small', 1, 1, max - 0.01));
  });
});

describe('buildBuildingVariant', () => {
  it('produces valid geometry, origin at ground level, for a small 1x1 low bucket', () => {
    const heightM = bucketHeightM('small', 0);
    const geo = buildBuildingVariant({ wTiles: 1, hTiles: 1, heightM, kind: 'small', windowSeed: 7 });
    expectValidGeometry(geo);
    geo.computeBoundingBox();
    expect(geo.boundingBox!.min.y).toBeCloseTo(0);
    expect(geo.boundingBox!.max.y).toBeCloseTo(heightM);
  });

  it('stays under a sane per-variant triangle ceiling across every occurring bucket/footprint', () => {
    const shapes: readonly [BuildingKind, number, number][] = [
      ['small', 1, 1],
      ['small', 1, 2],
      ['small', 2, 1],
      ['small', 2, 2],
      ['tower', 2, 2],
    ];
    for (const [kind, w, h] of shapes) {
      for (let bucket = 0; bucket < BUILDING_HEIGHT_BUCKETS; bucket++) {
        const heightM = bucketHeightM(kind, bucket);
        const geo = buildBuildingVariant({ wTiles: w, hTiles: h, heightM, kind, windowSeed: bucket });
        expectValidGeometry(geo);
        expect(geo.index!.count / 3).toBeLessThan(500);
      }
    }
  });

  it('is deterministic for a fixed spec (same windowSeed -> identical geometry)', () => {
    const spec = { wTiles: 2, hTiles: 2, heightM: bucketHeightM('tower', 1), kind: 'tower' as const, windowSeed: 42 };
    const a = buildBuildingVariant(spec);
    const bGeo = buildBuildingVariant(spec);
    expect(Array.from(a.getAttribute('position').array)).toEqual(Array.from(bGeo.getAttribute('position').array));
    expect(Array.from(a.getAttribute('uv').array)).toEqual(Array.from(bGeo.getAttribute('uv').array));
  });

  it('a different windowSeed can roll a different wall tone (not asserted equal/unequal — just that both are valid)', () => {
    const spec = (seed: number) => ({ wTiles: 1, hTiles: 1, heightM: bucketHeightM('small', 0), kind: 'small' as const, windowSeed: seed });
    expectValidGeometry(buildBuildingVariant(spec(1)));
    expectValidGeometry(buildBuildingVariant(spec(2)));
  });

  it('a tower is taller (more triangles) than a same-footprint/bucket small building due to the parapet + more floors', () => {
    const smallGeo = buildBuildingVariant({ wTiles: 2, hTiles: 2, heightM: bucketHeightM('small', 2), kind: 'small', windowSeed: 1 });
    const towerGeo = buildBuildingVariant({ wTiles: 2, hTiles: 2, heightM: bucketHeightM('tower', 0), kind: 'tower', windowSeed: 1 });
    expect(towerGeo.index!.count).toBeGreaterThan(smallGeo.index!.count);
  });
});

describe('street props — one canonical geometry each, valid + within budget', () => {
  const builders: readonly [string, () => BufferGeometry, number][] = [
    ['streetlight', buildStreetlight, 80],
    ['trafficLight', buildTrafficLight, 80],
    ['tree', buildTree, 80],
    ['bench', buildBench, 80],
    ['hydrant', buildHydrant, 100],
    ['mailbox', buildMailbox, 80],
    ['fenceSegment', buildFenceSegment, 100],
    ['transformerBox', buildTransformerBox, 120],
  ];

  for (const [name, build, ceiling] of builders) {
    it(`${name}: valid geometry, non-empty, under ${ceiling} triangles, deterministic`, () => {
      const a = build();
      expectValidGeometry(a);
      expect(a.index!.count / 3).toBeLessThan(ceiling);
      const b = build();
      expect(Array.from(a.getAttribute('position').array)).toEqual(Array.from(b.getAttribute('position').array));
    });
  }
});
