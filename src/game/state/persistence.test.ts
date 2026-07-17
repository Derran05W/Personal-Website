import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gameEvents } from './events';
import {
  PROGRESS_STORAGE_KEY,
  initProgressPersistence,
  loadProgress,
  recordRunEnd,
  resetProgress,
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
    expect(loadProgress()).toEqual({ v: 1, bestScore: 120, lifetimeScore: 120 });
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
    expect(recordRunEnd(50)).toEqual({ v: 1, bestScore: 50, lifetimeScore: 50 });
  });

  it('bestScore takes the max across runs; lifetimeScore always accumulates', () => {
    recordRunEnd(50);
    expect(recordRunEnd(30)).toEqual({ v: 1, bestScore: 50, lifetimeScore: 80 });
    expect(recordRunEnd(200)).toEqual({ v: 1, bestScore: 200, lifetimeScore: 280 });
  });

  it('writes through to localStorage', () => {
    recordRunEnd(75);
    expect(JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY) ?? 'null')).toEqual({
      v: 1,
      bestScore: 75,
      lifetimeScore: 75,
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
    // The computed envelope is still returned in-memory even though the write failed.
    expect(result).toEqual({ v: 1, bestScore: 999, lifetimeScore: 999 });
    // ...but nothing actually landed in storage: a fresh read (getItem isn't mocked) sees
    // no persisted progress at all.
    expect(loadProgress()).toEqual({ v: 1, bestScore: 0, lifetimeScore: 0 });
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

    expect(loadProgress()).toEqual({ v: 1, bestScore: 65, lifetimeScore: 65 });
    unsubscribe();
  });

  it('accumulates across multiple runEnded emissions', () => {
    const unsubscribe = initProgressPersistence();

    gameEvents.emit('runEnded', { score: 10, reason: 'busted' });
    gameEvents.emit('runEnded', { score: 40, reason: 'quit' });

    expect(loadProgress()).toEqual({ v: 1, bestScore: 40, lifetimeScore: 50 });
    unsubscribe();
  });

  it('the returned unsubscribe stops further writes', () => {
    const unsubscribe = initProgressPersistence();
    unsubscribe();

    gameEvents.emit('runEnded', { score: 999, reason: 'wrecked' });

    expect(loadProgress()).toEqual({ v: 1, bestScore: 0, lifetimeScore: 0 });
  });
});
