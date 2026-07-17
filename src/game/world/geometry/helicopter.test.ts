// Geometry-validity + budget test for the ambient helicopter (Phase 14 Task 2). Mirrors
// geometry.test.ts's expectValidGeometry contract (indexed, all-attributes-present, finite,
// in-range UVs, unit normals) but lives in its own file rather than editing the shared
// geometry.test.ts, since this task's ground rules scope it to ai/HeliMesh.tsx +
// world/geometry/helicopter.ts (+ barrel) only, and other Phase 14 tasks touch that shared
// test file's neighbourhood concurrently.

import type { BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { buildHeliBody, buildHeliRotorBlade, HELI_BODY, HELI_ROTOR } from './helicopter';

/** Same contract as geometry.test.ts's local helper — kept in sync by hand (small + stable). */
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
  for (let i = 0; i < normal.count; i++) {
    const nx = normal.getX(i);
    const ny = normal.getY(i);
    const nz = normal.getZ(i);
    const len = Math.hypot(nx, ny, nz);
    expect(len).toBeGreaterThan(0.99);
    expect(len).toBeLessThan(1.01);
  }
}

describe('buildHeliBody', () => {
  it('produces valid geometry', () => {
    expectValidGeometry(buildHeliBody());
  });

  it('is deterministic (no randomness — same call, same buffers)', () => {
    const a = buildHeliBody();
    const b = buildHeliBody();
    expect(Array.from(a.getAttribute('position').array)).toEqual(Array.from(b.getAttribute('position').array));
  });

  it('stays under budget on its own (leaves headroom for the rotor primitive)', () => {
    const tris = buildHeliBody().index!.count / 3;
    expect(tris).toBeLessThan(120);
  });

  it('the mast reaches exactly HELI_BODY.rotorHubY (so the separately-instanced rotor sits flush)', () => {
    // Sanity check on the shared constant rather than the geometry itself: HeliMesh.tsx
    // positions the rotor at this same Y, so a future edit to one without the other would be
    // a visible seam, not a type error.
    expect(HELI_BODY.rotorHubY).toBeCloseTo(HELI_BODY.hull.hh + 0.75, 5);
  });
});

describe('buildHeliRotorBlade', () => {
  it('produces valid geometry', () => {
    expectValidGeometry(buildHeliRotorBlade());
  });

  it('is a cheap primitive (two thin crossed plates, top/bottom faces only)', () => {
    const tris = buildHeliRotorBlade().index!.count / 3;
    expect(tris).toBe(8); // 2 boxes * 2 faces (py/ny) * 2 tris/face
  });

  it('spans the full documented rotor diameter symmetrically about the hub', () => {
    const geo = buildHeliRotorBlade();
    const position = geo.getAttribute('position');
    let maxAbsX = 0;
    let maxAbsZ = 0;
    for (let i = 0; i < position.count; i++) {
      maxAbsX = Math.max(maxAbsX, Math.abs(position.getX(i)));
      maxAbsZ = Math.max(maxAbsZ, Math.abs(position.getZ(i)));
    }
    expect(maxAbsX).toBeCloseTo(HELI_ROTOR.radiusM, 5);
    expect(maxAbsZ).toBeCloseTo(HELI_ROTOR.radiusM, 5);
  });
});

describe('helicopter geometry family — combined draw-call budget', () => {
  it('body + rotor primitive together stay comfortably under the ≤150 tri/heli target', () => {
    const bodyTris = buildHeliBody().index!.count / 3;
    const rotorTris = buildHeliRotorBlade().index!.count / 3;
    expect(bodyTris + rotorTris).toBeLessThanOrEqual(150);
  });
});
