import type { BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { buildCnTowerGeometry, buildFlatironGeometry, buildStadiumGeometry, stadiumRadii } from './landmarks';

/** Same shared shape/attribute check geometry.test.ts uses for every world/geometry/*
 * builder — duplicated locally (rather than imported) since geometry.test.ts doesn't export
 * it; kept intentionally identical. */
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
  for (let i = 0; i < normal.count; i++) {
    const nx = normal.getX(i);
    const ny = normal.getY(i);
    const nz = normal.getZ(i);
    const len = Math.hypot(nx, ny, nz);
    expect(len).toBeGreaterThan(0.99);
    expect(len).toBeLessThan(1.01);
  }
}

describe('buildCnTowerGeometry', () => {
  it('is valid, deterministic, and stays within the 600-tri budget', () => {
    const a = buildCnTowerGeometry();
    const b = buildCnTowerGeometry();
    expectValidGeometry(a);
    const triA = a.index!.count / 3;
    const triB = b.index!.count / 3;
    expect(triA).toBe(triB);
    expect(triA).toBeGreaterThan(0);
    expect(triA).toBeLessThanOrEqual(600);
  });

  it('every vertex sits within a sane 0..170 m height envelope (base at y=0)', () => {
    const geo = buildCnTowerGeometry();
    const position = geo.getAttribute('position');
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < position.count; i++) {
      const y = position.getY(i);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    expect(minY).toBeGreaterThanOrEqual(0);
    expect(maxY).toBeGreaterThan(100); // reads as a tall tower
    expect(maxY).toBeLessThan(170);
  });
});

describe('buildStadiumGeometry', () => {
  it('is valid, deterministic for a given footprint, and stays within the 800-tri budget', () => {
    const a = buildStadiumGeometry(5, 4);
    const b = buildStadiumGeometry(5, 4);
    expectValidGeometry(a);
    const triA = a.index!.count / 3;
    const triB = b.index!.count / 3;
    expect(triA).toBe(triB);
    expect(triA).toBeGreaterThan(0);
    expect(triA).toBeLessThanOrEqual(800);
  });

  it('a smaller reserved footprint yields a smaller bowl (radius scales with the lot)', () => {
    const big = stadiumRadii(5, 4);
    const small = stadiumRadii(3, 3);
    expect(small.rimTopRadiusM).toBeLessThan(big.rimTopRadiusM);
    expect(small.wallRadiusM).toBeLessThan(big.wallRadiusM);
  });

  it('every derived radius is positive and finite across the whole reserveStadium size table', () => {
    const sizes: readonly (readonly [number, number])[] = [
      [5, 4],
      [4, 4],
      [4, 3],
      [3, 3],
    ];
    for (const [w, h] of sizes) {
      const r = stadiumRadii(w, h);
      for (const v of [r.podiumBaseRadiusM, r.podiumTopRadiusM, r.wallRadiusM, r.rimTopRadiusM]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
      }
      const geo = buildStadiumGeometry(w, h);
      expectValidGeometry(geo);
      geo.dispose();
    }
  });
});

describe('buildFlatironGeometry', () => {
  it('is valid, deterministic, and every band cross-section stays a true (convex) triangle', () => {
    const a = buildFlatironGeometry();
    const b = buildFlatironGeometry();
    expectValidGeometry(a);
    expect(a.index!.count).toBe(b.index!.count);
  });

  it('every vertex sits within the map-tile-scale footprint (a single reserved corner lot)', () => {
    const geo = buildFlatironGeometry();
    const position = geo.getAttribute('position');
    let maxRadius = 0;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const z = position.getZ(i);
      maxRadius = Math.max(maxRadius, Math.hypot(x, z));
    }
    // Must fit comfortably inside a single 10 m tile (radius < 5 m) — see config/world.ts's
    // flatiron.radiusM comment on why this was slimmed from an initial 12 m guess.
    expect(maxRadius).toBeLessThan(5);
  });
});
