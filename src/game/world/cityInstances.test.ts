import { describe, expect, it } from 'vitest';
import { generate } from './generate';
import { buildCityInstanceSets, keepEvenlySpaced } from './cityInstances';

describe('keepEvenlySpaced (Phase 18 tri-trim)', () => {
  const list = Array.from({ length: 100 }, (_, i) => i);

  it('keeps everything for fraction >= 1 (returns a copy, not the same ref)', () => {
    const out = keepEvenlySpaced(list, 1);
    expect(out).toEqual(list);
    expect(out).not.toBe(list);
    expect(keepEvenlySpaced(list, 1.5)).toEqual(list);
  });

  it('keeps nothing for fraction <= 0', () => {
    expect(keepEvenlySpaced(list, 0)).toEqual([]);
    expect(keepEvenlySpaced(list, -1)).toEqual([]);
  });

  it('keeps exactly floor(n * fraction) items', () => {
    expect(keepEvenlySpaced(list, 0.6)).toHaveLength(60);
    expect(keepEvenlySpaced(list, 0.4)).toHaveLength(40);
    expect(keepEvenlySpaced(list, 0.5)).toHaveLength(50);
  });

  it('spreads the kept items evenly (no clustering) and is deterministic', () => {
    const a = keepEvenlySpaced(list, 0.5);
    const b = keepEvenlySpaced(list, 0.5);
    expect(a).toEqual(b); // deterministic
    // Even spread: consecutive kept indices are ~1/fraction apart, never all bunched at one end.
    expect(a[0]).toBeLessThan(5);
    expect(a[a.length - 1]).toBeGreaterThan(90);
  });
});

describe('buildCityInstanceSets parked-car thinning', () => {
  const world = generate(416);

  function parkedCarCount(opts?: { parkedCarKeepFraction?: number }): number {
    const set = buildCityInstanceSets(world, opts).find((s) => s.archetype === 'parkedCar');
    return set?.sources.length ?? 0;
  }

  it('defaults to keeping every parked car (byte-compatible with the no-opts call)', () => {
    expect(parkedCarCount()).toBe(parkedCarCount({ parkedCarKeepFraction: 1 }));
    expect(parkedCarCount()).toBeGreaterThan(0);
  });

  it('thins the parked-car pool to the fraction on lower tiers', () => {
    const full = parkedCarCount();
    expect(parkedCarCount({ parkedCarKeepFraction: 0.6 })).toBe(Math.floor(full * 0.6));
    expect(parkedCarCount({ parkedCarKeepFraction: 0.4 })).toBe(Math.floor(full * 0.4));
  });

  it('keeps mesh sources and collider placements parallel after thinning (they can never disagree)', () => {
    const set = buildCityInstanceSets(world, { parkedCarKeepFraction: 0.6 }).find(
      (s) => s.archetype === 'parkedCar',
    );
    expect(set).toBeDefined();
    // sources (InstancedMesh instances) and placements (collider seed) are built parallel.
    expect(set!.placements.length).toBe(set!.sources.length);
  });

  it('leaves other archetypes untouched when parked cars are thinned', () => {
    const full = buildCityInstanceSets(world);
    const thin = buildCityInstanceSets(world, { parkedCarKeepFraction: 0.4 });
    const countOf = (sets: ReturnType<typeof buildCityInstanceSets>, a: string): number =>
      sets.filter((s) => s.archetype === a).reduce((n, s) => n + s.sources.length, 0);
    for (const arch of ['tree', 'streetlight', 'buildingSmall', 'buildingTower'] as const) {
      expect(countOf(thin, arch)).toBe(countOf(full, arch));
    }
  });
});
