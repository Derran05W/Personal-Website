import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gameEvents } from './events';
import {
  PROGRESS_STORAGE_KEY,
  initProgressPersistence,
  loadProgress,
  recordLastSeed,
  recordRunEnd,
  resetProgress,
  setDarkCityUnlocked,
} from './persistence';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  gameEvents.clearAllListeners();
  vi.restoreAllMocks();
});

describe('loadProgress', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadProgress()).toEqual({ v: 1, bestScore: 0, lifetimeScore: 0 });
  });

  it('round-trips a previously-written envelope', () => {
    recordRunEnd(120);
    expect(loadProgress()).toEqual({
      v: 1,
      bestScore: 120,
      lifetimeScore: 120,
      unlockedCarIds: ['rustySedan'],
    });
  });

  it('falls back to defaults on unparseable JSON', () => {
    localStorage.setItem(PROGRESS_STORAGE_KEY, '{not valid json');
    expect(loadProgress()).toEqual({ v: 1, bestScore: 0, lifetimeScore: 0 });
  });

  it('falls back to defaults on well-formed but wrong-shaped JSON', () => {
    localStorage.setItem(
      PROGRESS_STORAGE_KEY,
      JSON.stringify({ v: 1, bestScore: 'nope', lifetimeScore: 5 }),
    );
    expect(loadProgress()).toEqual({ v: 1, bestScore: 0, lifetimeScore: 0 });
  });

  it('falls back to defaults on a schema version mismatch', () => {
    localStorage.setItem(
      PROGRESS_STORAGE_KEY,
      JSON.stringify({ v: 2, bestScore: 999, lifetimeScore: 999 }),
    );
    expect(loadProgress()).toEqual({ v: 1, bestScore: 0, lifetimeScore: 0 });
  });

  it('degrades to defaults when localStorage.getItem throws (private-mode)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked');
    });

    expect(() => loadProgress()).not.toThrow();
    expect(loadProgress()).toEqual({ v: 1, bestScore: 0, lifetimeScore: 0 });
  });
});

describe('recordRunEnd', () => {
  it('sets bestScore and lifetimeScore on the first run', () => {
    expect(recordRunEnd(50)).toEqual({
      v: 1,
      bestScore: 50,
      lifetimeScore: 50,
      unlockedCarIds: ['rustySedan'],
    });
  });

  it('bestScore takes the max across runs; lifetimeScore always accumulates', () => {
    recordRunEnd(50);
    expect(recordRunEnd(30)).toEqual({
      v: 1,
      bestScore: 50,
      lifetimeScore: 80,
      unlockedCarIds: ['rustySedan'],
    });
    expect(recordRunEnd(200)).toEqual({
      v: 1,
      bestScore: 200,
      lifetimeScore: 280,
      unlockedCarIds: ['rustySedan'],
    });
  });

  it('writes through to localStorage', () => {
    recordRunEnd(75);
    expect(JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY) ?? 'null')).toEqual({
      v: 1,
      bestScore: 75,
      lifetimeScore: 75,
      unlockedCarIds: ['rustySedan'],
    });
  });

  it('degrades silently when localStorage.setItem throws (quota exhaustion / private mode)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded');
    });

    let result: ReturnType<typeof recordRunEnd> | undefined;
    expect(() => {
      result = recordRunEnd(999);
    }).not.toThrow();
    // The computed envelope is still returned in-memory even though the write failed —
    // 999 also crosses the streetRacer threshold (500), so both ids show up here.
    expect(result).toEqual({
      v: 1,
      bestScore: 999,
      lifetimeScore: 999,
      unlockedCarIds: ['rustySedan', 'streetRacer'],
    });
    // ...but nothing actually landed in storage: a fresh read (getItem isn't mocked) sees
    // no persisted progress at all.
    expect(loadProgress()).toEqual({ v: 1, bestScore: 0, lifetimeScore: 0 });
  });
});

describe('darkCityUnlocked (Phase 13 — optional, version-safe v1 extension)', () => {
  it('is absent (undefined) on a fresh envelope — no extra key added by default', () => {
    const progress = loadProgress();
    expect(progress).toEqual({ v: 1, bestScore: 0, lifetimeScore: 0 });
    expect(progress.darkCityUnlocked).toBeUndefined();
  });

  it('setDarkCityUnlocked sets the flag and writes through, leaving score fields untouched', () => {
    recordRunEnd(30); // bestScore/lifetimeScore = 30 before any DARK CITY
    const result = setDarkCityUnlocked();
    expect(result).toEqual({
      v: 1,
      bestScore: 30,
      lifetimeScore: 30,
      unlockedCarIds: ['rustySedan'],
      darkCityUnlocked: true,
    });
    expect(loadProgress()).toEqual({
      v: 1,
      bestScore: 30,
      lifetimeScore: 30,
      unlockedCarIds: ['rustySedan'],
      darkCityUnlocked: true,
    });
  });

  it('is idempotent — a second call does not re-write or change the envelope', () => {
    setDarkCityUnlocked();
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const result = setDarkCityUnlocked();
    expect(result).toEqual({ v: 1, bestScore: 0, lifetimeScore: 0, darkCityUnlocked: true });
    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it('recordRunEnd (a later run ending) preserves an already-set darkCityUnlocked flag', () => {
    setDarkCityUnlocked(); // e.g. tripped mid-run, before this run's own runEnded fires
    const result = recordRunEnd(50);
    expect(result).toEqual({
      v: 1,
      bestScore: 50,
      lifetimeScore: 50,
      unlockedCarIds: ['rustySedan'],
      darkCityUnlocked: true,
    });
    expect(loadProgress()).toEqual({
      v: 1,
      bestScore: 50,
      lifetimeScore: 50,
      unlockedCarIds: ['rustySedan'],
      darkCityUnlocked: true,
    });
  });

  it('recordRunEnd on an envelope that never unlocked it keeps round-tripping with no extra key', () => {
    recordRunEnd(20);
    expect(loadProgress()).toEqual({
      v: 1,
      bestScore: 20,
      lifetimeScore: 20,
      unlockedCarIds: ['rustySedan'],
    });
    expect(loadProgress().darkCityUnlocked).toBeUndefined();
  });

  it('loadProgress accepts a stored envelope missing the key (pre-Phase-13 shape)', () => {
    localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify({ v: 1, bestScore: 10, lifetimeScore: 10 }));
    expect(loadProgress()).toEqual({ v: 1, bestScore: 10, lifetimeScore: 10 });
  });

  it('loadProgress accepts a stored envelope with darkCityUnlocked: true', () => {
    localStorage.setItem(
      PROGRESS_STORAGE_KEY,
      JSON.stringify({ v: 1, bestScore: 5, lifetimeScore: 5, darkCityUnlocked: true }),
    );
    expect(loadProgress()).toEqual({ v: 1, bestScore: 5, lifetimeScore: 5, darkCityUnlocked: true });
  });

  it('loadProgress rejects a stored envelope with a wrong-typed darkCityUnlocked (falls back to defaults)', () => {
    localStorage.setItem(
      PROGRESS_STORAGE_KEY,
      JSON.stringify({ v: 1, bestScore: 5, lifetimeScore: 5, darkCityUnlocked: 'yes' }),
    );
    expect(loadProgress()).toEqual({ v: 1, bestScore: 0, lifetimeScore: 0 });
  });

  it('degrades silently when localStorage.setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded');
    });
    expect(() => setDarkCityUnlocked()).not.toThrow();
  });
});

describe('resetProgress', () => {
  it('clears the stored envelope', () => {
    recordRunEnd(40);
    resetProgress();
    expect(loadProgress()).toEqual({ v: 1, bestScore: 0, lifetimeScore: 0 });
  });

  it('does not throw if localStorage.removeItem throws', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('blocked');
    });
    expect(() => resetProgress()).not.toThrow();
  });
});

describe('initProgressPersistence', () => {
  it('writes progress when runEnded fires', () => {
    const unsubscribe = initProgressPersistence();

    gameEvents.emit('runEnded', { score: 65, reason: 'wrecked' });

    expect(loadProgress()).toEqual({
      v: 1,
      bestScore: 65,
      lifetimeScore: 65,
      unlockedCarIds: ['rustySedan'],
    });
    unsubscribe();
  });

  it('accumulates across multiple runEnded emissions', () => {
    const unsubscribe = initProgressPersistence();

    gameEvents.emit('runEnded', { score: 10, reason: 'busted' });
    gameEvents.emit('runEnded', { score: 40, reason: 'quit' });

    expect(loadProgress()).toEqual({
      v: 1,
      bestScore: 40,
      lifetimeScore: 50,
      unlockedCarIds: ['rustySedan'],
    });
    unsubscribe();
  });

  it('the returned unsubscribe stops further writes', () => {
    const unsubscribe = initProgressPersistence();
    unsubscribe();

    gameEvents.emit('runEnded', { score: 999, reason: 'wrecked' });
    gameEvents.emit('runStarted', { seed: 4242 });

    expect(loadProgress()).toEqual({ v: 1, bestScore: 0, lifetimeScore: 0 });
  });

  it('writes lastSeed when runStarted fires', () => {
    const unsubscribe = initProgressPersistence();

    gameEvents.emit('runStarted', { seed: 777 });

    expect(loadProgress().lastSeed).toBe(777);
    unsubscribe();
  });
});

describe('recordLastSeed (Phase 17)', () => {
  it('writes lastSeed and leaves every other field untouched', () => {
    recordRunEnd(50);
    const result = recordLastSeed(4242);
    expect(result).toEqual({
      v: 1,
      bestScore: 50,
      lifetimeScore: 50,
      unlockedCarIds: ['rustySedan'],
      lastSeed: 4242,
    });
    expect(loadProgress().lastSeed).toBe(4242);
  });

  it('a later reroll overwrites the previous seed', () => {
    recordLastSeed(1);
    recordLastSeed(2);
    expect(loadProgress().lastSeed).toBe(2);
  });

  it('degrades silently when localStorage.setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded');
    });
    expect(() => recordLastSeed(99)).not.toThrow();
  });
});

describe('unlockedCarIds + carUnlocked (Phase 17)', () => {
  it('rustySedan is unlocked from a fresh envelope (threshold 0), with no runs played', () => {
    expect(recordRunEnd(0).unlockedCarIds).toEqual(['rustySedan']);
  });

  it('does not emit carUnlocked for rustySedan (already "crossed" before any run)', () => {
    const handler = vi.fn();
    gameEvents.on('carUnlocked', handler);
    recordRunEnd(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it('crossing a threshold in one run emits carUnlocked exactly once, with the right id', () => {
    const handler = vi.fn();
    gameEvents.on('carUnlocked', handler);

    const result = recordRunEnd(500); // lifetimeScore 0 -> 500: crosses streetRacer

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ carId: 'streetRacer' });
    expect(result.unlockedCarIds).toEqual(['rustySedan', 'streetRacer']);
  });

  it('a multi-threshold jump emits carUnlocked once per NEWLY crossed id, ascending', () => {
    const handler = vi.fn();
    gameEvents.on('carUnlocked', handler);

    // 0 -> 1500 crosses both streetRacer (500) and pickup (1500) in one run.
    const result = recordRunEnd(1500);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, { carId: 'streetRacer' });
    expect(handler).toHaveBeenNthCalledWith(2, { carId: 'pickup' });
    expect(result.unlockedCarIds).toEqual(['rustySedan', 'streetRacer', 'pickup']);
  });

  it('is idempotent — an already-unlocked car never re-fires carUnlocked on a later run', () => {
    recordRunEnd(500); // unlocks streetRacer
    const handler = vi.fn();
    gameEvents.on('carUnlocked', handler);

    recordRunEnd(10); // lifetimeScore 500 -> 510: no new threshold crossed

    expect(handler).not.toHaveBeenCalled();
  });

  it('unlockedCarIds is monotonic across runs — stays unlocked even split across many small runs', () => {
    for (let i = 0; i < 10; i++) recordRunEnd(60); // 10 x 60 = 600 total, crosses streetRacer (500)
    expect(loadProgress().unlockedCarIds).toEqual(['rustySedan', 'streetRacer']);
  });

  it('loadProgress drops unknown ids from a stored unlockedCarIds array', () => {
    localStorage.setItem(
      PROGRESS_STORAGE_KEY,
      JSON.stringify({
        v: 1,
        bestScore: 10,
        lifetimeScore: 10,
        unlockedCarIds: ['rustySedan', 'someRemovedCar', 'pickup'],
      }),
    );
    expect(loadProgress().unlockedCarIds).toEqual(['rustySedan', 'pickup']);
  });

  it('loadProgress rejects a present-but-wrong-typed unlockedCarIds (falls back to defaults)', () => {
    localStorage.setItem(
      PROGRESS_STORAGE_KEY,
      JSON.stringify({ v: 1, bestScore: 10, lifetimeScore: 10, unlockedCarIds: 'nope' }),
    );
    expect(loadProgress()).toEqual({ v: 1, bestScore: 0, lifetimeScore: 0 });
  });

  it('a stale-but-valid envelope missing unlockedCarIds/lastSeed migrates cleanly (no throw, sane defaults)', () => {
    // Simulates a pre-Phase-17 envelope written by an older build.
    localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify({ v: 1, bestScore: 200, lifetimeScore: 600 }));
    const progress = loadProgress();
    expect(progress.bestScore).toBe(200);
    expect(progress.lifetimeScore).toBe(600);
    expect(progress.unlockedCarIds).toBeUndefined();
    expect(progress.lastSeed).toBeUndefined();

    // The next run still correctly derives + persists unlocks from the migrated score.
    const result = recordRunEnd(0);
    expect(result.unlockedCarIds).toEqual(['rustySedan', 'streetRacer']); // 600 already clears both
  });

  it('a genuinely corrupt envelope resets safely to defaults, not a throw', () => {
    localStorage.setItem(PROGRESS_STORAGE_KEY, '{not valid json at all');
    expect(() => loadProgress()).not.toThrow();
    expect(loadProgress()).toEqual({ v: 1, bestScore: 0, lifetimeScore: 0 });
  });
});
