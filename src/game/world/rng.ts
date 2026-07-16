// Seeded pseudo-random number generator for deterministic world generation.
//
// Determinism is a HARD requirement: the same seed must produce the same city on every
// machine, because the seed is shown on the score screen and shared/reproduced (TDD §5.4).
// So this is mulberry32 — a tiny, well-distributed generator — driven purely by 32-bit
// integer ops (`Math.imul`, `>>> 0`, `^`, `>>>`). There is no `Math.random`, no 64-bit
// math, and no float arithmetic other than the single final divide by 2^32, so every
// platform walks the exact same sequence.
//
// Streams are FORK-ABLE. generate() splits independent substreams for LAYOUT (road/block
// structure) and COSMETIC (heights, later colours) rolls: because they are separate
// streams, adding a cosmetic roll in a future phase can never shift the layout of an
// existing seed. `fork(label)` derives a child stream from (this stream's base seed,
// label) — deterministic, and independent of how far either stream has been consumed
// (the split is by seed, not by shared mutable state).

/** A deterministic random stream. Cheap to create and to fork. */
export interface Rng {
  /** Next float in [0, 1). Advances the stream. */
  next(): number;
  /** Uniform integer in [min, maxIncl] (both inclusive). Advances the stream. */
  int(min: number, maxIncl: number): number;
  /** Uniformly pick one element of a non-empty array. Advances the stream. */
  pick<T>(items: readonly T[]): T;
  /**
   * Derive an independent child stream from this stream's base seed and `label`. Two
   * different labels give unrelated streams; the same label always gives the same one.
   * Consuming the child never advances this (parent) stream, and consuming this stream
   * never advances the child — the split is purely by seed.
   */
  fork(label: string): Rng;
}

/** FNV-1a 32-bit string hash — turns a fork label into a seed contribution. */
function hashLabel(label: string): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  return h >>> 0;
}

/** Mix two 32-bit seeds into one well-distributed 32-bit seed (splitmix32 finalizer). */
function mixSeeds(a: number, b: number): number {
  let x = (a + 0x9e3779b9) >>> 0;
  x = (x ^ b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * Create a deterministic stream from a 32-bit integer seed. `next()` is mulberry32. The
 * seed is coerced to an unsigned 32-bit integer and remembered as the stream's immutable
 * identity, so `fork()` is stable no matter how much `next()` has already been called.
 */
export function createRng(seed: number): Rng {
  const baseSeed = seed >>> 0; // immutable fork identity
  let state = baseSeed; // mutable, advanced by next()

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int(min: number, maxIncl: number): number {
      if (maxIncl < min) throw new RangeError(`int(${min}, ${maxIncl}): empty range`);
      return min + Math.floor(next() * (maxIncl - min + 1));
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new RangeError('pick(): empty array');
      return items[Math.floor(next() * items.length)];
    },
    fork(label: string): Rng {
      return createRng(mixSeeds(baseSeed, hashLabel(label)));
    },
  };
}
