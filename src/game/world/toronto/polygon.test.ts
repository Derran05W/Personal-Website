// TDD-first: authored from TORONTO-MAP-SPEC-v2.md §1 (the "thermometer" polygon) BEFORE
// polygon.ts existed. The vertex list, area decomposition, containment and camera-clamp
// behaviours are all spec-pinned. Integration cases import TORONTO_PROJECTION to prove the
// Yonge spine lands inside the shape.
import { describe, expect, it } from 'vitest';
import { TORONTO_PROJECTION } from './projection';
import {
  CAMERA_CLAMP_PADDING_WU,
  PLAYABLE_POLYGON,
  clampToPolygon,
  distanceToBoundary,
  isSimplePolygon,
  pointInPolygon,
  polygonArea,
  type MapVertex,
} from './polygon';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EXPECTED_VERTICES: ReadonlyArray<readonly [number, number]> = [
  [1100, 0],
  [1900, 0],
  [1900, 1170],
  [1800, 1170],
  [1800, 1830],
  [2400, 1830],
  [2400, 4100],
  [0, 4100],
  [0, 1830],
  [1200, 1830],
  [1200, 1170],
  [1100, 1170],
];

describe('PLAYABLE_POLYGON — spec §1 transcription guard', () => {
  it('matches the 12 spec vertices verbatim (clockwise, y-down)', () => {
    expect(PLAYABLE_POLYGON.map((v) => [v.x, v.y])).toEqual(
      EXPECTED_VERTICES.map(([x, y]) => [x, y]),
    );
  });

  it('is a simple, fully axis-aligned polygon', () => {
    expect(isSimplePolygon(PLAYABLE_POLYGON)).toBe(true);
    for (let i = 0; i < PLAYABLE_POLYGON.length; i++) {
      const a = PLAYABLE_POLYGON[i];
      const b = PLAYABLE_POLYGON[(i + 1) % PLAYABLE_POLYGON.length];
      // every edge shares exactly one axis coordinate (horizontal XOR vertical)
      expect((a.x === b.x) !== (a.y === b.y)).toBe(true);
    }
  });
});

describe('polygonArea — capsule + corridor + downtown block', () => {
  it('equals 6,780,000 wu² exactly (positive for the given winding)', () => {
    // 800×1170 (capsule) + 600×660 (fold corridor) + 2400×2270 (downtown block)
    expect(polygonArea(PLAYABLE_POLYGON)).toBe(6_780_000);
    expect(800 * 1170 + 600 * 660 + 2400 * 2270).toBe(6_780_000);
  });
});

describe('pointInPolygon — ray cast, boundary-inclusive', () => {
  it('classifies the spec fixtures', () => {
    expect(pointInPolygon({ x: 1200, y: 2800 }, PLAYABLE_POLYGON)).toBe(true); // downtown centre
    expect(pointInPolygon({ x: 1500, y: 1500 }, PLAYABLE_POLYGON)).toBe(true); // fold corridor
    expect(pointInPolygon({ x: 900, y: 1500 }, PLAYABLE_POLYGON)).toBe(false); // west of corridor
    expect(pointInPolygon({ x: 2000, y: 1000 }, PLAYABLE_POLYGON)).toBe(false); // east of capsule
    expect(pointInPolygon({ x: 1200, y: 4200 }, PLAYABLE_POLYGON)).toBe(false); // south of water
  });

  it('integrates with the projection: every on-map Yonge anchor lands inside', () => {
    const onMap: ReadonlyArray<readonly [number, number]> = [
      [43.7814, -79.4158], // finch
      [43.7686, -79.4125], // north york centre
      [43.7614, -79.4108], // sheppard
      [43.7061, -79.3983], // eglinton
      [43.6878, -79.3936], // st clair
      [43.6708, -79.3856], // bloor
      [43.6606, -79.3828], // college
      [43.6564, -79.3808], // dundas
      [43.6528, -79.3794], // queen
      [43.6489, -79.3778], // king
      [43.647, -79.3773], // front
      [43.6415, -79.377], // queens quay
    ];
    for (const [lat, lon] of onMap) {
      const p = TORONTO_PROJECTION.project({ lat, lon });
      expect(pointInPolygon(p, PLAYABLE_POLYGON)).toBe(true);
    }
    // yonge-steeles is off the capsule top (y < 0) → outside.
    const steeles = TORONTO_PROJECTION.project({ lat: 43.796, lon: -79.422 });
    expect(pointInPolygon(steeles, PLAYABLE_POLYGON)).toBe(false);
  });
});

describe('clampToPolygon — nearest point ≥ padding inside', () => {
  const PAD = CAMERA_CLAMP_PADDING_WU;

  it('exports the spec padding constant', () => {
    expect(CAMERA_CLAMP_PADDING_WU).toBe(80);
  });

  it('pulls outside points to at least padding inside', () => {
    const outside: ReadonlyArray<MapVertex> = [
      { x: 900, y: 1500 },
      { x: 2000, y: 1000 },
      { x: 1200, y: 4200 },
      { x: -300, y: 2500 },
      { x: 2700, y: 3000 },
    ];
    for (const p of outside) {
      const c = clampToPolygon(p, PAD);
      expect(pointInPolygon(c, PLAYABLE_POLYGON)).toBe(true);
      expect(distanceToBoundary(c, PLAYABLE_POLYGON)).toBeGreaterThanOrEqual(PAD - 1e-6);
    }
  });

  it('leaves deep-inside points untouched', () => {
    const deep = { x: 1200, y: 2800 };
    expect(clampToPolygon(deep, PAD)).toEqual(deep);
  });

  it('clamps a concave-notch point into the corridor, not through a wall', () => {
    // (1150,1500) sits in the void west of the 600-wu fold corridor (corridor is x∈[1200,1800]).
    const c = clampToPolygon({ x: 1150, y: 1500 }, PAD);
    expect(pointInPolygon(c, PLAYABLE_POLYGON)).toBe(true);
    expect(c.x).toBeGreaterThanOrEqual(1200 + PAD - 1e-6); // inside the corridor, past its wall
    expect(distanceToBoundary(c, PLAYABLE_POLYGON)).toBeGreaterThanOrEqual(PAD - 1e-6);
  });

  it('is idempotent over ≥50 seeded fuzz points', () => {
    const rand = mulberry32(0x0ff5e7);
    let count = 0;
    for (let i = 0; i < 60; i++) {
      const p = { x: -200 + 2800 * rand(), y: -200 + 4500 * rand() };
      const once = clampToPolygon(p, PAD);
      const twice = clampToPolygon(once, PAD);
      expect(twice.x).toBeCloseTo(once.x, 6);
      expect(twice.y).toBeCloseTo(once.y, 6);
      expect(distanceToBoundary(once, PLAYABLE_POLYGON)).toBeGreaterThanOrEqual(PAD - 1e-6);
      count++;
    }
    expect(count).toBeGreaterThanOrEqual(50);
  });
});
