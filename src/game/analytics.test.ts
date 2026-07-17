import { afterEach, describe, expect, it, vi } from 'vitest';
import { gameEvents } from './state/events';

const track = vi.fn();
vi.mock('@vercel/analytics', () => ({ track }));

// initGameAnalytics is imported dynamically per-test (after the mock above is set up)
// so vi.mock's hoisting always wins — matches this repo's other event-wiring test
// files' pattern of importing the module under test after registering fakes.
async function loadInitGameAnalytics() {
  const mod = await import('./analytics');
  return mod.initGameAnalytics;
}

afterEach(() => {
  track.mockClear();
  vi.restoreAllMocks();
});

describe('initGameAnalytics', () => {
  it('fires game_start on runStarted', async () => {
    const initGameAnalytics = await loadInitGameAnalytics();
    const teardown = initGameAnalytics();

    gameEvents.emit('runStarted', { seed: 1 });

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('game_start');
    teardown();
  });

  it('fires wrecked on runEnded{reason: "wrecked"}', async () => {
    const initGameAnalytics = await loadInitGameAnalytics();
    const teardown = initGameAnalytics();

    gameEvents.emit('runEnded', { score: 10, reason: 'wrecked' });

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('wrecked');
    teardown();
  });

  it('fires busted on runEnded{reason: "busted"}', async () => {
    const initGameAnalytics = await loadInitGameAnalytics();
    const teardown = initGameAnalytics();

    gameEvents.emit('runEnded', { score: 10, reason: 'busted' });

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('busted');
    teardown();
  });

  it('does NOT track runEnded{reason: "quit"} — not one of the named custom events', async () => {
    const initGameAnalytics = await loadInitGameAnalytics();
    const teardown = initGameAnalytics();

    gameEvents.emit('runEnded', { score: 0, reason: 'quit' });

    expect(track).not.toHaveBeenCalled();
    teardown();
  });

  it('fires dark_city on darkCity', async () => {
    const initGameAnalytics = await loadInitGameAnalytics();
    const teardown = initGameAnalytics();

    gameEvents.emit('darkCity', {});

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('dark_city');
    teardown();
  });

  it('teardown unsubscribes all three listeners', async () => {
    const initGameAnalytics = await loadInitGameAnalytics();
    const teardown = initGameAnalytics();
    teardown();

    gameEvents.emit('runStarted', { seed: 1 });
    gameEvents.emit('runEnded', { score: 0, reason: 'wrecked' });
    gameEvents.emit('darkCity', {});

    expect(track).not.toHaveBeenCalled();
  });

  it('carries no PII / payload data — every track() call is name-only', async () => {
    const initGameAnalytics = await loadInitGameAnalytics();
    const teardown = initGameAnalytics();

    gameEvents.emit('runStarted', { seed: 12345 });
    gameEvents.emit('runEnded', { score: 999, reason: 'wrecked' });
    gameEvents.emit('darkCity', {});

    for (const call of track.mock.calls) {
      expect(call).toHaveLength(1); // name only, no properties object
    }
    teardown();
  });
});
