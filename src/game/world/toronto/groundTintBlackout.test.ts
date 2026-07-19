// Tests for Phase 29 T1's district-blackout ground-tint visual (groundTintBlackout.ts) — the
// substitute "district blackouts must read" mechanism for Toronto (no per-archetype emissive
// instance buffer exists to flip, see that module's header). Mirrors
// powergrid/emitters.test.ts's own range-bookkeeping proof (findRangeBookkeepingViolations) but
// for the ground-tint mesh's per-district vertex ranges instead of a legacy InstancedMesh.
import { describe, expect, it } from 'vitest';
import { buildDistricts, TORONTO_DISTRICT_COUNT } from './districts';
import { buildGroundTintRanges, darkenColorRange, totalVertexCount, type GroundTintRange } from './groundTintBlackout';

const districts = buildDistricts();
const ranges = buildGroundTintRanges(districts);

describe('buildGroundTintRanges — powergrid district mapping', () => {
  it('produces exactly one range per district (15 total)', () => {
    expect(ranges.length).toBe(TORONTO_DISTRICT_COUNT);
  });

  it('every district index 0..14 is reachable exactly once', () => {
    const indices = ranges.map((r) => r.districtIndex).sort((a, b) => a - b);
    expect(indices).toEqual([...Array(TORONTO_DISTRICT_COUNT).keys()]);
  });

  it('ranges are contiguous and non-overlapping, tiling the whole vertex buffer', () => {
    // Built by a monotonically-advancing cursor over TORONTO_DISTRICTS config order, so `ranges`
    // is already start-ascending — re-sorting just documents that invariant explicitly.
    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    let expectedStart = 0;
    for (const r of sorted) {
      expect(r.start).toBe(expectedStart);
      expect(r.count).toBeGreaterThanOrEqual(0);
      expectedStart += r.count;
    }
    expect(expectedStart).toBe(totalVertexCount(ranges));
  });

  it('every count is a multiple of 6 (2 triangles per rect, per pushQuad)', () => {
    for (const r of ranges) expect(r.count % 6).toBe(0);
  });

  it('deterministic — rebuilding from the same districts reproduces identical ranges', () => {
    expect(buildGroundTintRanges(buildDistricts())).toEqual(ranges);
  });
});

describe('darkenColorRange', () => {
  it('multiplies only the targeted vertex range, leaving everything else untouched', () => {
    // 3 vertices total (9 floats): darken the middle vertex (range {start:1, count:1}).
    const colors = new Float32Array([1, 1, 1, 0.5, 0.6, 0.7, 1, 1, 1]);
    const range: GroundTintRange = { districtIndex: 0, start: 1, count: 1 };
    darkenColorRange(colors, range, 0.5);
    const expected = [1, 1, 1, 0.25, 0.3, 0.35, 1, 1, 1];
    [...colors].forEach((v, i) => expect(v).toBeCloseTo(expected[i], 5));
  });

  it('a factor of 1 is a no-op', () => {
    const colors = new Float32Array([0.4, 0.5, 0.6]);
    darkenColorRange(colors, { districtIndex: 0, start: 0, count: 1 }, 1);
    [...colors].forEach((v, i) => expect(v).toBeCloseTo([0.4, 0.5, 0.6][i], 5));
  });

  it('clamps to the array bounds instead of throwing on an out-of-range slice', () => {
    const colors = new Float32Array([1, 1, 1]);
    expect(() => darkenColorRange(colors, { districtIndex: 0, start: 0, count: 10 }, 0.5)).not.toThrow();
  });
});
