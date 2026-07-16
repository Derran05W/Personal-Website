import { describe, expect, it, beforeEach } from 'vitest';
import { Color, InstancedBufferAttribute, InstancedMesh, BufferGeometry, MeshBasicMaterial } from 'three';
import { Matrix4 } from 'three';
import {
  DISTRICT_COUNT,
  sortByDistrict,
  setEmissiveRange,
  setDistrictEmissive,
  setDistrictColor,
  registerArchetypeHandles,
  getArchetypeHandles,
  clearArchetypeRegistry,
  type ArchetypeHandles,
  type DistrictRanges,
  type EmissiveAttribute,
  type InstanceSource,
} from './instancing';

// --- Fixtures -----------------------------------------------------------------------------

/** A source in `districtId`, tagged (encoded in the matrix's X translation) so order can be
 * asserted after sorting. */
function src(districtId: number, tag: number): InstanceSource {
  return { districtId, matrix: new Matrix4().setPosition(tag, 0, 0) };
}

/** Read back a source's tag (its matrix X translation, elements[12]). */
function tagOf(source: InstanceSource): number {
  return source.matrix.elements[12];
}

/** A fake aEmissiveOn attribute that records the exact update ranges asked of it. */
function fakeEmissiveAttr(count: number): EmissiveAttribute & {
  array: Float32Array;
  updateRanges: { start: number; count: number }[];
} {
  const array = new Float32Array(count).fill(1);
  const updateRanges: { start: number; count: number }[] = [];
  return {
    array,
    needsUpdate: false,
    addUpdateRange(start: number, c: number) {
      updateRanges.push({ start, count: c });
    },
    updateRanges,
  };
}

// --- sortByDistrict -----------------------------------------------------------------------

describe('sortByDistrict — grouping + ranges', () => {
  it('produces ranges covering every district, ascending and contiguous', () => {
    const sources = [src(3, 0), src(0, 1), src(3, 2), src(15, 3), src(0, 4)];
    const { ranges } = sortByDistrict(sources);

    expect(ranges).toHaveLength(DISTRICT_COUNT);
    let expectedStart = 0;
    for (let d = 0; d < DISTRICT_COUNT; d++) {
      expect(ranges[d].districtId).toBe(d); // ascending, index === district
      expect(ranges[d].start).toBe(expectedStart); // contiguous, no gaps/overlap
      expect(ranges[d].count).toBeGreaterThanOrEqual(0);
      expectedStart += ranges[d].count;
    }
  });

  it('range counts sum to the source count', () => {
    const sources = [src(1, 0), src(1, 1), src(7, 2), src(7, 3), src(7, 4), src(0, 5)];
    const { sorted, ranges } = sortByDistrict(sources);
    const total = ranges.reduce((sum, r) => sum + r.count, 0);
    expect(total).toBe(sources.length);
    expect(sorted).toHaveLength(sources.length);
  });

  it('each range exactly brackets its district in the sorted array', () => {
    const sources = [src(5, 0), src(2, 1), src(5, 2), src(2, 3), src(11, 4)];
    const { sorted, ranges } = sortByDistrict(sources);
    for (const r of ranges) {
      for (let i = r.start; i < r.start + r.count; i++) {
        expect(sorted[i].districtId).toBe(r.districtId);
      }
    }
  });

  it('is stable — preserves original order within a district', () => {
    // Three sources in district 4, interleaved with others; tags 10,11,12 must stay in order.
    const sources = [src(4, 10), src(1, 99), src(4, 11), src(9, 98), src(4, 12)];
    const { sorted } = sortByDistrict(sources);
    const d4Tags = sorted.filter((s) => s.districtId === 4).map(tagOf);
    expect(d4Tags).toEqual([10, 11, 12]);
  });

  it('is deterministic — same input yields identical ranges', () => {
    const build = () => [src(2, 0), src(8, 1), src(2, 2), src(0, 3), src(8, 4)];
    expect(sortByDistrict(build()).ranges).toEqual(sortByDistrict(build()).ranges);
  });

  it('does not mutate the input array', () => {
    const sources = [src(3, 0), src(0, 1), src(3, 2)];
    const before = [...sources];
    sortByDistrict(sources);
    expect(sources).toEqual(before);
  });

  it('handles empty districts (count 0) and an entirely empty input', () => {
    const { ranges } = sortByDistrict([src(0, 0), src(0, 1)]);
    // Only district 0 is populated; every other district has count 0 but is still present.
    expect(ranges[0].count).toBe(2);
    for (let d = 1; d < DISTRICT_COUNT; d++) expect(ranges[d].count).toBe(0);

    const empty = sortByDistrict([]);
    expect(empty.sorted).toHaveLength(0);
    expect(empty.ranges).toHaveLength(DISTRICT_COUNT);
    expect(empty.ranges.every((r) => r.count === 0 && r.start === 0)).toBe(true);
  });

  it('throws on an out-of-range or non-integer districtId', () => {
    expect(() => sortByDistrict([src(DISTRICT_COUNT, 0)])).toThrow(RangeError);
    expect(() => sortByDistrict([src(-1, 0)])).toThrow(RangeError);
    expect(() => sortByDistrict([src(2.5, 0)])).toThrow(RangeError);
  });
});

// --- setEmissiveRange (index math, mock attribute) ----------------------------------------

describe('setEmissiveRange — index math', () => {
  // District layout for a 6-instance buffer: d0=[0,2), d2=[2,3), d5=[3,6), rest empty.
  const sources = [src(0, 0), src(0, 1), src(2, 2), src(5, 3), src(5, 4), src(5, 5)];
  let ranges: DistrictRanges;
  beforeEach(() => {
    ranges = sortByDistrict(sources).ranges;
  });

  it('flips exactly the target district slice and records its update range', () => {
    const attr = fakeEmissiveAttr(6);
    setEmissiveRange(attr, ranges, 5, 0); // district 5 → dark
    expect(Array.from(attr.array)).toEqual([1, 1, 1, 0, 0, 0]); // only indices 3..5
    expect(attr.updateRanges).toEqual([{ start: 3, count: 3 }]);
    expect(attr.needsUpdate).toBe(true);
  });

  it('flips a different district without touching others', () => {
    const attr = fakeEmissiveAttr(6);
    setEmissiveRange(attr, ranges, 0, 0);
    expect(Array.from(attr.array)).toEqual([0, 0, 1, 1, 1, 1]); // only indices 0..1
    expect(attr.updateRanges).toEqual([{ start: 0, count: 2 }]);
  });

  it('accumulates update ranges across multiple flips (never clears prior ranges)', () => {
    const attr = fakeEmissiveAttr(6);
    setEmissiveRange(attr, ranges, 0, 0);
    setEmissiveRange(attr, ranges, 2, 0);
    expect(Array.from(attr.array)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(attr.updateRanges).toEqual([
      { start: 0, count: 2 },
      { start: 2, count: 1 },
    ]);
  });

  it('can turn a district back on (on = 1)', () => {
    const attr = fakeEmissiveAttr(6);
    setEmissiveRange(attr, ranges, 5, 0);
    setEmissiveRange(attr, ranges, 5, 1);
    expect(Array.from(attr.array)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('is a no-op for an empty district (no writes, no update range)', () => {
    const attr = fakeEmissiveAttr(6);
    setEmissiveRange(attr, ranges, 7, 0); // district 7 is empty
    expect(Array.from(attr.array)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(attr.updateRanges).toEqual([]);
    expect(attr.needsUpdate).toBe(false);
  });
});

// --- Registry-driven setDistrictEmissive / setDistrictColor -------------------------------

/** Build a real (WebGL-free) archetype handle from sources, for registry tests. */
function makeHandles(variantKey: string, sources: InstanceSource[]): ArchetypeHandles {
  const { sorted, ranges } = sortByDistrict(sources);
  const mesh = new InstancedMesh(new BufferGeometry(), new MeshBasicMaterial(), sorted.length);
  for (let i = 0; i < sorted.length; i++) mesh.setMatrixAt(i, sorted[i].matrix);
  const emissiveAttr = new InstancedBufferAttribute(new Float32Array(sorted.length).fill(1), 1);
  return { name: 'buildingSmall', variantKey, mesh, emissiveAttr, ranges };
}

describe('registry — setDistrictEmissive across variant meshes', () => {
  beforeEach(() => clearArchetypeRegistry());

  it('flips the district slice on every variant mesh registered under the archetype', () => {
    const a = makeHandles('a', [src(0, 0), src(3, 1), src(3, 2)]); // sorted d3 = [1,3)
    const b = makeHandles('b', [src(3, 0), src(1, 1)]); // sorted: d1 then d3, so d3 = [1,2)
    registerArchetypeHandles('buildingSmall', a);
    registerArchetypeHandles('buildingSmall', b);
    expect(getArchetypeHandles('buildingSmall')).toHaveLength(2);

    setDistrictEmissive('buildingSmall', 3, 0);
    expect(Array.from(a.emissiveAttr.array)).toEqual([1, 0, 0]);
    expect(Array.from(b.emissiveAttr.array)).toEqual([1, 0]);
    expect(a.emissiveAttr.updateRanges).toEqual([{ start: 1, count: 2 }]);
    expect(b.emissiveAttr.updateRanges).toEqual([{ start: 1, count: 1 }]);
  });

  it('is a no-op for an archetype that was never registered', () => {
    expect(() => setDistrictEmissive('trafficLight', 4, 0)).not.toThrow();
    expect(getArchetypeHandles('trafficLight')).toHaveLength(0);
  });

  it('clearArchetypeRegistry drops all handles', () => {
    registerArchetypeHandles('buildingSmall', makeHandles('a', [src(0, 0)]));
    clearArchetypeRegistry();
    expect(getArchetypeHandles('buildingSmall')).toHaveLength(0);
  });
});

describe('registry — setDistrictColor writes exactly one district slice', () => {
  beforeEach(() => clearArchetypeRegistry());

  it('recolours the district slice and records an itemSize-3 update range', () => {
    const h = makeHandles('a', [src(0, 0), src(2, 1), src(2, 2), src(2, 3)]); // d2 = [1,4)
    registerArchetypeHandles('buildingSmall', h);

    setDistrictColor('buildingSmall', 2, new Color('#ff0000'));
    expect(h.mesh.instanceColor).not.toBeNull();

    // Instances 1..3 are red; instance 0 stays white (default).
    const c = new Color();
    h.mesh.getColorAt(0, c);
    expect(c.getHex()).toBe(0xffffff);
    for (let i = 1; i <= 3; i++) {
      h.mesh.getColorAt(i, c);
      expect(c.getHex()).toBe(0xff0000);
    }
    // Element-unit update range: start 1×3=3, count 3×3=9.
    expect(h.mesh.instanceColor?.updateRanges).toEqual([{ start: 3, count: 9 }]);
  });
});
