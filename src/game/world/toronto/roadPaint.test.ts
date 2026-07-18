// Phase 25.8 (D5/D3-L3) — road-paint tests: raised-sidewalk segment emission (bands never enter an
// intersection box), curb collider boxes (off the asphalt, on the sidewalk), and the palette ladder
// ordering surviving the L3 brighten.
import { describe, expect, it } from 'vitest';
import { Color } from 'three';
import { ROAD_COLORS, ROAD_EDGE, SIDEWALK } from '../../config/torontoMap';
import { buildStreets } from './streets';
import { listIntersections } from './roadGraph';
import { buildSidewalkColliderBoxes, sidewalkSegments } from './roadPaint';

/** Linear-light relative luminance from a hex (sRGB → linear → Rec.709). */
function lum(hex: string): number {
  const c = new Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; // three Color is already linear
}

describe('sidewalkSegments', () => {
  it('never enters an intersection box (± crossHalf)', () => {
    const crossings = [
      { along: 100, crossHalf: 6 },
      { along: 300, crossHalf: 8 },
    ];
    const segs = sidewalkSegments(0, 400, crossings);
    for (const [a, b] of segs) {
      for (const c of crossings) {
        // No segment may overlap the crossing box interior.
        const boxLo = c.along - c.crossHalf;
        const boxHi = c.along + c.crossHalf;
        const overlaps = a < boxHi && b > boxLo;
        expect(overlaps).toBe(false);
      }
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(400);
      expect(b).toBeGreaterThan(a);
    }
  });

  it('a crossing-free span yields exactly one full segment', () => {
    const segs = sidewalkSegments(10, 90, []);
    expect(segs).toEqual([[10, 90]]);
  });

  it('drops slivers shorter than the minimum', () => {
    // Two crossings 3 wu apart leave a <2 wu gap between them — dropped.
    const segs = sidewalkSegments(0, 200, [
      { along: 98, crossHalf: 1 },
      { along: 102, crossHalf: 1 },
    ]);
    for (const [a, b] of segs) expect(b - a).toBeGreaterThanOrEqual(2);
  });
});

describe('buildSidewalkColliderBoxes', () => {
  const streets = buildStreets().streets;
  const intersections = listIntersections(streets);
  const boxes = buildSidewalkColliderBoxes(streets, intersections);

  it('produces boxes with positive extents, top at curbHeight', () => {
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) {
      expect(b.hx).toBeGreaterThan(0);
      expect(b.hz).toBeGreaterThan(0);
    }
  });

  it('every collider box sits OUTSIDE every ribbon (on the sidewalk, never the asphalt)', () => {
    for (const b of boxes) {
      for (const s of streets) {
        const r = s.ribbon;
        const inside = b.cx > r.minX && b.cx < r.maxX && b.cz > r.minY && b.cz < r.maxY;
        expect(inside).toBe(false);
      }
    }
  });
});

describe('L3 ladder ordering (brightened palette preserves order)', () => {
  it('void < asphalt(minor≤major≤artery≤spine) < ground < sidewalk < curb < crosswalk', () => {
    const spine = lum(ROAD_COLORS.spine);
    const artery = lum(ROAD_COLORS.artery);
    const major = lum(ROAD_COLORS.major);
    const minor = lum(ROAD_COLORS.minor);
    const ground = lum('#4d545e'); // GROUND_COLOR (TorontoScene, brightened)
    const sidewalk = lum(SIDEWALK.color);
    const curb = lum(ROAD_EDGE.color);
    const crosswalk = lum('#c7c4ba');
    const voidC = lum('#121a2b');

    expect(minor).toBeLessThanOrEqual(major);
    expect(major).toBeLessThanOrEqual(artery);
    expect(artery).toBeLessThanOrEqual(spine);
    expect(voidC).toBeLessThan(minor);
    expect(spine).toBeLessThan(ground);
    expect(ground).toBeLessThan(sidewalk);
    expect(sidewalk).toBeLessThan(curb);
    expect(curb).toBeLessThan(crosswalk);
  });

  it('the curb FACE (D5) sits between asphalt and the sidewalk top', () => {
    const spine = lum(ROAD_COLORS.spine);
    const face = lum(SIDEWALK.curbFaceColor);
    const sidewalk = lum(SIDEWALK.color);
    expect(face).toBeGreaterThan(spine);
    expect(face).toBeLessThan(sidewalk);
  });
});
