import { describe, expect, it } from 'vitest';
import { createRng, type Rng } from './rng';

/** Draw `n` floats from a stream (helper for sequence comparisons). */
function seq(rng: Rng, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(rng.next());
  return out;
}

describe('createRng — determinism', () => {
  it('same seed replays the exact same float sequence', () => {
    expect(seq(createRng(416), 16)).toEqual(seq(createRng(416), 16));
  });

  it('different seeds diverge', () => {
    expect(seq(createRng(416), 16)).not.toEqual(seq(createRng(417), 16));
  });

  it('coerces the seed to unsigned 32-bit (negative seed is stable, not NaN)', () => {
    expect(seq(createRng(-1), 8)).toEqual(seq(createRng(0xffffffff), 8));
    for (const v of seq(createRng(-999), 100)) expect(Number.isFinite(v)).toBe(true);
  });

  it('next() stays in [0, 1)', () => {
    const r = createRng(12345);
    for (let i = 0; i < 5000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('createRng — fork independence', () => {
  it('same (seed, label) forks to the same stream', () => {
    expect(seq(createRng(7).fork('layout'), 12)).toEqual(seq(createRng(7).fork('layout'), 12));
  });

  it('different labels fork to different streams', () => {
    expect(seq(createRng(7).fork('arterials-x'), 12)).not.toEqual(
      seq(createRng(7).fork('arterials-y'), 12),
    );
  });

  it('fork identity is independent of how far the parent has been consumed', () => {
    const early = createRng(99);
    const forkEarly = early.fork('kind:3');

    const late = createRng(99);
    late.next();
    late.next();
    late.next();
    const forkLate = late.fork('kind:3');

    expect(seq(forkEarly, 10)).toEqual(seq(forkLate, 10));
  });

  it('consuming a fork does not advance the parent stream', () => {
    const a = createRng(123);
    a.fork('cosmetic'); // forked but not consumed
    const undisturbed = a.next();

    const b = createRng(123);
    const child = b.fork('cosmetic');
    for (let i = 0; i < 50; i++) child.next(); // consume the child a lot
    const afterChildConsumed = b.next();

    expect(afterChildConsumed).toBe(undisturbed);
  });
});

describe('createRng — int', () => {
  it('stays within [min, maxIncl] and returns integers', () => {
    const r = createRng(555);
    for (let i = 0; i < 5000; i++) {
      const v = r.int(4, 6);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(4);
      expect(v).toBeLessThanOrEqual(6);
    }
  });

  it('reaches both endpoints of the range over enough samples', () => {
    const r = createRng(2024);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) seen.add(r.int(4, 6));
    expect(seen).toEqual(new Set([4, 5, 6]));
  });

  it('a single-value range always returns that value', () => {
    const r = createRng(1);
    for (let i = 0; i < 20; i++) expect(r.int(5, 5)).toBe(5);
  });

  it('throws on an empty range', () => {
    expect(() => createRng(1).int(6, 4)).toThrow(RangeError);
  });
});

describe('createRng — pick', () => {
  it('only ever returns elements of the array', () => {
    const r = createRng(77);
    const items = ['a', 'b', 'c', 'd'] as const;
    for (let i = 0; i < 500; i++) expect(items).toContain(r.pick(items));
  });

  it('throws on an empty array', () => {
    expect(() => createRng(1).pick([])).toThrow(RangeError);
  });
});
