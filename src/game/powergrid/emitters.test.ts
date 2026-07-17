import { afterEach, describe, expect, it } from 'vitest';
import { BufferGeometry, InstancedBufferAttribute, InstancedMesh, MeshBasicMaterial } from 'three';
import { POWER_GRID, RENDERING } from '../config';
import { EMISSIVE_ARCHETYPES, type ArchetypeName } from '../world/archetypes';
import {
  DISTRICT_COUNT,
  clearArchetypeRegistry,
  getArchetypeHandles,
  registerArchetypeHandles,
  type ArchetypeHandles,
  type DistrictRange,
  type DistrictRanges,
} from '../world/instancing';
import { createRng } from '../world/rng';
import {
  FlickerRunner,
  __resetEmissiveArchetypesForTest,
  activeFlickerCount,
  applyDistrictEmissiveScale,
  applyKensingtonBoost,
  blackoutDistrict,
  buildFlickerSchedule,
  clearFlickers,
  emissiveArchetypeNames,
  findRangeBookkeepingViolations,
  isDistrictDark,
  isDistrictFlickering,
  registerEmissiveArchetype,
  relightDistrict,
  setDistrictDark,
  tickFlickers,
  type EmissiveWriteFn,
  type FlickerSchedule,
} from './emitters';

const ARCH_COUNT = EMISSIVE_ARCHETYPES.length;

/** A recording write stand-in: captures every emissive flip in call order. */
function recorder(): { fn: EmissiveWriteFn; calls: { archetype: ArchetypeName; districtId: number; on: 0 | 1 }[] } {
  const calls: { archetype: ArchetypeName; districtId: number; on: 0 | 1 }[] = [];
  return { calls, fn: (archetype, districtId, on) => calls.push({ archetype, districtId, on }) };
}

/** Last recorded emissive state per archetype index (undefined if never written). */
function lastStateByArchetype(calls: { archetype: ArchetypeName; on: 0 | 1 }[]): (0 | 1 | undefined)[] {
  const out: (0 | 1 | undefined)[] = new Array(ARCH_COUNT).fill(undefined);
  for (const c of calls) out[EMISSIVE_ARCHETYPES.indexOf(c.archetype)] = c.on;
  return out;
}

/** Drive a schedule to completion in one big tick and return the recorder calls. */
function runToCompletion(schedule: FlickerSchedule): {
  runner: FlickerRunner;
  calls: { archetype: ArchetypeName; districtId: number; on: 0 | 1 }[];
} {
  const rec = recorder();
  const runner = new FlickerRunner(rec.fn);
  runner.start(schedule);
  runner.tick(schedule.durationSec + 1); // overshoot: fire everything + finalize
  return { runner, calls: rec.calls };
}

afterEach(() => {
  clearFlickers();
  clearArchetypeRegistry();
  __resetEmissiveArchetypesForTest();
});

// --- buildFlickerSchedule -----------------------------------------------------------------

describe('buildFlickerSchedule — pulse schedule', () => {
  it('is deterministic: same (seed, district) yields an identical schedule', () => {
    const a = buildFlickerSchedule(9, createRng(416).fork('blackout-9'));
    const b = buildFlickerSchedule(9, createRng(416).fork('blackout-9'));
    expect(b).toEqual(a);
  });

  it('differs by district (independent seeded substreams)', () => {
    const nine = buildFlickerSchedule(9, createRng(416).fork('blackout-9'));
    const ten = buildFlickerSchedule(10, createRng(416).fork('blackout-10'));
    // Same envelope contract, but the pulse/stagger draws diverge.
    expect(ten.writes).not.toEqual(nine.writes);
  });

  it('rolls 2–3 dark pulses ⇒ odd toggle count ⇒ starts lit, ends dark', () => {
    for (let seed = 0; seed < 60; seed++) {
      const s = buildFlickerSchedule(seed % DISTRICT_COUNT, createRng(seed).fork('blackout'));
      expect(s.pulseCount).toBeGreaterThanOrEqual(2);
      expect(s.pulseCount).toBeLessThanOrEqual(3);
      const togglesPerArch = s.pulseCount * 2 + 1;
      expect(s.writes).toHaveLength(togglesPerArch * ARCH_COUNT);
    }
  });

  it('lays writes in ascending time within the flicker envelope', () => {
    const s = buildFlickerSchedule(4, createRng(999).fork('blackout-4'));
    for (let k = 1; k < s.writes.length; k++) {
      expect(s.writes[k].timeSec).toBeGreaterThanOrEqual(s.writes[k - 1].timeSec);
    }
    // Everything happens within ~flickerSec (+ the small per-archetype stagger tail).
    expect(s.writes[s.writes.length - 1].timeSec).toBeLessThanOrEqual(s.durationSec + 1e-9);
    expect(s.durationSec).toBeGreaterThanOrEqual(POWER_GRID.flickerSec);
    expect(s.durationSec).toBeLessThan(POWER_GRID.flickerSec + 0.1);
  });

  it("every archetype's LAST scheduled state is OFF (permanent blackout by construction)", () => {
    for (let seed = 0; seed < 40; seed++) {
      const s = buildFlickerSchedule(seed % DISTRICT_COUNT, createRng(seed).fork('b'));
      for (let i = 0; i < ARCH_COUNT; i++) {
        const last = [...s.writes].reverse().find((w) => w.archetypeIndex === i);
        expect(last?.on).toBe(0);
      }
    }
  });
});

// --- stagger offsets ----------------------------------------------------------------------

describe('buildFlickerSchedule — per-archetype stagger', () => {
  it('assigns each archetype a distinct 40–80 ms offset (analog, not lockstep)', () => {
    const s = buildFlickerSchedule(2, createRng(7).fork('blackout-2'));
    expect(s.staggerSec).toHaveLength(ARCH_COUNT);
    for (const off of s.staggerSec) {
      expect(off).toBeGreaterThanOrEqual(0.04);
      expect(off).toBeLessThanOrEqual(0.08);
    }
    // Not all identical — the district doesn't flip in perfect sync.
    const spread = Math.max(...s.staggerSec) - Math.min(...s.staggerSec);
    expect(spread).toBeGreaterThan(0);
  });

  it('writes reflect the stagger: per-toggle time = base + staggerSec[archetype]', () => {
    const s = buildFlickerSchedule(5, createRng(123).fork('blackout-5'));
    // Recover each archetype's own toggle times (ascending) and subtract its stagger — the
    // resulting "base" times must be identical across archetypes.
    const bases: number[][] = [];
    for (let i = 0; i < ARCH_COUNT; i++) {
      const times = s.writes
        .filter((w) => w.archetypeIndex === i)
        .map((w) => w.timeSec)
        .sort((a, b) => a - b);
      bases.push(times.map((t) => t - s.staggerSec[i]));
    }
    for (let i = 1; i < ARCH_COUNT; i++) {
      expect(bases[i]).toHaveLength(bases[0].length);
      for (let k = 0; k < bases[0].length; k++) {
        expect(bases[i][k]).toBeCloseTo(bases[0][k], 9);
      }
    }
  });
});

// --- sequencer: final state, tick accumulation --------------------------------------------

describe('FlickerRunner — sequencing', () => {
  it('ends every district permanently OFF regardless of pulse parity', () => {
    // Sweep seeds so BOTH pulseCount 2 and 3 are exercised.
    const seen = new Set<number>();
    for (let seed = 0; seed < 40; seed++) {
      const d = seed % DISTRICT_COUNT;
      const schedule = buildFlickerSchedule(d, createRng(seed).fork('b'));
      seen.add(schedule.pulseCount);
      const { runner, calls } = runToCompletion(schedule);
      expect(lastStateByArchetype(calls).every((on) => on === 0)).toBe(true);
      expect(runner.isDark(d)).toBe(true);
      expect(runner.isFlickering(d)).toBe(false);
    }
    expect(seen).toEqual(new Set([2, 3])); // both parities were covered
  });

  it('finalize appends an authoritative full-district OFF batch', () => {
    const schedule = buildFlickerSchedule(1, createRng(3).fork('blackout-1'));
    const { calls } = runToCompletion(schedule);
    // Writes = the scheduled toggles + one OFF per archetype from finalize.
    expect(calls).toHaveLength(schedule.writes.length + ARCH_COUNT);
    const tail = calls.slice(-ARCH_COUNT);
    expect(tail.every((c) => c.on === 0)).toBe(true);
    expect(new Set(tail.map((c) => c.archetype))).toEqual(new Set(EMISSIVE_ARCHETYPES));
  });

  it('accumulates fixed steps: a write fires exactly when cumulative elapsed reaches its time', () => {
    const schedule = buildFlickerSchedule(6, createRng(55).fork('blackout-6'));
    const rec = recorder();
    const runner = new FlickerRunner(rec.fn);
    runner.start(schedule);

    const step = 1 / 60;
    let elapsed = 0;
    // Stop one step short of completion so finalize's extra batch doesn't skew the count.
    while (elapsed + step < schedule.durationSec) {
      runner.tick(step);
      elapsed += step;
      const expected = schedule.writes.filter((w) => w.timeSec <= elapsed + 1e-9).length;
      expect(rec.calls).toHaveLength(expected);
      expect(runner.isFlickering(6)).toBe(true); // not yet finalized
    }
    // Finish it off.
    runner.tick(step * 2);
    expect(runner.isFlickering(6)).toBe(false);
    expect(runner.isDark(6)).toBe(true);
  });

  it('is idempotent: re-starting a flickering or dark district is a no-op', () => {
    const schedule = buildFlickerSchedule(8, createRng(2).fork('blackout-8'));
    const runner = new FlickerRunner(recorder().fn);
    expect(runner.start(schedule)).toBe(true);
    expect(runner.start(schedule)).toBe(false); // already flickering
    runner.tick(schedule.durationSec + 1);
    expect(runner.start(schedule)).toBe(false); // now permanently dark
    expect(runner.activeCount()).toBe(0);
  });

  it('cancel stops a flicker and clears its bookkeeping', () => {
    const schedule = buildFlickerSchedule(0, createRng(1).fork('blackout-0'));
    const runner = new FlickerRunner(recorder().fn);
    runner.start(schedule);
    expect(runner.isFlickering(0)).toBe(true);
    runner.cancel(0);
    expect(runner.isFlickering(0)).toBe(false);
    expect(runner.isDark(0)).toBe(false);
    expect(runner.start(schedule)).toBe(true); // cancel re-opens it
  });
});

// --- module API (singleton) ---------------------------------------------------------------

describe('module API — blackout / dark / relight / tick', () => {
  it('blackoutDistrict starts a flicker; tickFlickers settles it dark', () => {
    blackoutDistrict(9);
    expect(isDistrictFlickering(9)).toBe(true);
    expect(activeFlickerCount()).toBe(1);

    // Same seeded schedule as the run — overshoot its duration.
    const schedule = buildFlickerSchedule(9, createRng(416).fork('blackout-9'));
    tickFlickers(schedule.durationSec + 1);
    expect(isDistrictFlickering(9)).toBe(false);
    expect(isDistrictDark(9)).toBe(true);

    blackoutDistrict(9); // permanent — a re-trigger is ignored
    expect(isDistrictFlickering(9)).toBe(false);
  });

  it('blackoutDistrict is idempotent while mid-flicker', () => {
    blackoutDistrict(3);
    blackoutDistrict(3);
    expect(activeFlickerCount()).toBe(1);
  });

  it('setDistrictDark forces permanent dark instantly (no flicker)', () => {
    setDistrictDark(5);
    expect(isDistrictFlickering(5)).toBe(false);
    expect(isDistrictDark(5)).toBe(true);
  });

  it('relightDistrict cancels a flicker and un-darks (debug)', () => {
    blackoutDistrict(7);
    expect(isDistrictFlickering(7)).toBe(true);
    relightDistrict(7);
    expect(isDistrictFlickering(7)).toBe(false);
    expect(isDistrictDark(7)).toBe(false);
    // Re-blackout is allowed after a relight.
    blackoutDistrict(7);
    expect(isDistrictFlickering(7)).toBe(true);
  });

  it('rejects out-of-range districts', () => {
    expect(() => blackoutDistrict(-1)).toThrow(RangeError);
    expect(() => blackoutDistrict(DISTRICT_COUNT)).toThrow(RangeError);
    expect(() => setDistrictDark(2.5)).toThrow(RangeError);
  });
});

// --- range bookkeeping guard --------------------------------------------------------------

function makeRanges(counts: number[]): DistrictRanges {
  const ranges: DistrictRange[] = [];
  let start = 0;
  for (let d = 0; d < DISTRICT_COUNT; d++) {
    const count = counts[d] ?? 0;
    ranges.push({ districtId: d, start, count });
    start += count;
  }
  return ranges;
}

function makeHandles(
  name: ArchetypeName,
  variantKey: string,
  counts: number[],
  meshCount: number,
): ArchetypeHandles {
  const mesh = new InstancedMesh(new BufferGeometry(), new MeshBasicMaterial(), meshCount);
  const emissiveAttr = new InstancedBufferAttribute(new Float32Array(Math.max(meshCount, 1)), 1);
  return { name, variantKey, mesh, emissiveAttr, ranges: makeRanges(counts) };
}

describe('findRangeBookkeepingViolations — Σ ranges === mesh count', () => {
  it('reports nothing when every emissive archetype tiles its buffer', () => {
    const counts = [4, 0, 2, 1]; // districts 0..3 populated; rest 0
    const sum = counts.reduce((a, b) => a + b, 0);
    registerArchetypeHandles('buildingSmall', makeHandles('buildingSmall', 'small', counts, sum));
    registerArchetypeHandles('streetlight', makeHandles('streetlight', 'default', [1, 1], 2));
    expect(findRangeBookkeepingViolations()).toEqual([]);
  });

  it('flags an archetype whose ranges do not sum to its instance count', () => {
    const counts = [4, 0, 2, 1]; // sums to 7 …
    registerArchetypeHandles('buildingTower', makeHandles('buildingTower', 'tall', counts, 8)); // … but mesh has 8
    const violations = findRangeBookkeepingViolations();
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      archetype: 'buildingTower',
      variantKey: 'tall',
      rangeSum: 7,
      meshCount: 8,
    });
  });

  it('checks every variant mesh registered under one archetype', () => {
    registerArchetypeHandles('buildingSmall', makeHandles('buildingSmall', 'v1', [3], 3)); // ok
    registerArchetypeHandles('buildingSmall', makeHandles('buildingSmall', 'v2', [3], 5)); // bad
    const violations = findRangeBookkeepingViolations();
    expect(violations).toHaveLength(1);
    expect(violations[0].variantKey).toBe('v2');
  });

  it('ignores non-emissive archetypes', () => {
    // A non-emissive archetype (tree) with a broken sum must NOT be flagged — blackouts only
    // ever touch EMISSIVE_ARCHETYPES.
    registerArchetypeHandles('tree', makeHandles('tree', 'default', [2], 9));
    expect(findRangeBookkeepingViolations()).toEqual([]);
  });
});

// --- Phase 19: extra emissive archetypes (market string-light seam) + Kensington boost -----

describe('extra emissive archetypes (Phase 19 market seam)', () => {
  it('emissiveArchetypeNames defaults to exactly EMISSIVE_ARCHETYPES (same ref, zero-alloc)', () => {
    expect(emissiveArchetypeNames()).toBe(EMISSIVE_ARCHETYPES);
  });

  it('registers extras after the core set, dedup + idempotent', () => {
    registerEmissiveArchetype('tree'); // stand-in for a future market string-light archetype
    registerEmissiveArchetype('tree'); // idempotent
    registerEmissiveArchetype('streetlight'); // a core name → never duplicated
    const names = emissiveArchetypeNames();
    expect(names.slice(0, EMISSIVE_ARCHETYPES.length)).toEqual([...EMISSIVE_ARCHETYPES]);
    expect(names.filter((n) => n === 'tree')).toHaveLength(1);
    expect(names.filter((n) => n === 'streetlight')).toHaveLength(1);
  });

  it('the permanent-OFF batch (finalize) darkens registered extras too — the money clip', () => {
    registerEmissiveArchetype('tree');
    const schedule = buildFlickerSchedule(2, createRng(11).fork('blackout-2'));
    const { calls } = runToCompletion(schedule);
    const names = emissiveArchetypeNames();
    // finalize writes one authoritative OFF per participant (core + extras).
    const tail = calls.slice(-names.length);
    expect(tail.every((c) => c.on === 0)).toBe(true);
    expect(new Set(tail.map((c) => c.archetype))).toEqual(new Set(names));
    // …but the extra was never part of the (core-only, deterministic) flicker schedule.
    expect(schedule.writes.some((w) => EMISSIVE_ARCHETYPES[w.archetypeIndex] === 'tree')).toBe(false);
  });

  it('findRangeBookkeepingViolations now covers registered extras', () => {
    registerEmissiveArchetype('tree');
    // 'tree' ranges (sum 3) don't tile its mesh (5) → flagged, because it's now a participant.
    registerArchetypeHandles('tree', makeHandles('tree', 'default', [3], 5));
    expect(findRangeBookkeepingViolations().some((v) => v.archetype === 'tree')).toBe(true);
  });
});

describe('Kensington emissive boost (Phase 19)', () => {
  it('applyKensingtonBoost scales exactly the district slice by the configured factor', () => {
    // buildingSmall handles: d0 ×2, d1 ×3, d2 ×1 → sorted d1 slice = [2,5).
    registerArchetypeHandles('buildingSmall', makeHandles('buildingSmall', 'v', [2, 3, 1], 6));
    applyKensingtonBoost(1);
    const [h] = getArchetypeHandles('buildingSmall');
    // makeHandles fills the emissive buffer with 0; the boost writes the scale into d1's slice.
    // Round-trip the config value through float32 (the buffer is a Float32Array).
    const boost = Math.fround(RENDERING.kensingtonEmissiveScale);
    expect(Array.from(h.emissiveAttr.array)).toEqual([0, 0, boost, boost, boost, 0]);
  });

  it('applyDistrictEmissiveScale validates the district id', () => {
    expect(() => applyDistrictEmissiveScale(-1, 1.4)).toThrow(RangeError);
    expect(() => applyDistrictEmissiveScale(DISTRICT_COUNT, 1.4)).toThrow(RangeError);
  });
});
