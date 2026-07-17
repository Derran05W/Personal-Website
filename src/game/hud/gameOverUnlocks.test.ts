import { describe, expect, it } from 'vitest';
import { gameEvents } from '../state/events';
import { __resetRunUnlocksForTests, getRunUnlockNames, subscribeRunUnlocks } from './gameOverUnlocks';

// __resetRunUnlocksForTests, not gameEvents.clearAllListeners() — this module's own
// runStarted/carUnlocked subscriptions are registered once at import time (see the file's
// header comment); clearing all listeners would permanently silence them for the rest of
// this file, same reasoning as hud/gameOverRunEnd.ts's test file.
function reset(): void {
  __resetRunUnlocksForTests();
}

describe('gameOverUnlocks', () => {
  it('starts empty', () => {
    reset();
    expect(getRunUnlockNames()).toEqual([]);
  });

  it('carUnlocked appends the display name', () => {
    reset();
    gameEvents.emit('carUnlocked', { carId: 'streetRacer' });
    expect(getRunUnlockNames()).toEqual(['Street Racer']);
  });

  it('queues multiple unlocks in crossing order', () => {
    reset();
    gameEvents.emit('carUnlocked', { carId: 'streetRacer' });
    gameEvents.emit('carUnlocked', { carId: 'pickup' });
    expect(getRunUnlockNames()).toEqual(['Street Racer', 'Pickup']);
  });

  it('runStarted resets the queue for the next run', () => {
    reset();
    gameEvents.emit('carUnlocked', { carId: 'streetRacer' });
    expect(getRunUnlockNames()).toEqual(['Street Racer']);

    gameEvents.emit('runStarted', { seed: 1 });
    expect(getRunUnlockNames()).toEqual([]);
  });

  it('returns a stable reference when nothing changed (useSyncExternalStore requirement)', () => {
    reset();
    gameEvents.emit('carUnlocked', { carId: 'pickup' });
    const a = getRunUnlockNames();
    const b = getRunUnlockNames();
    expect(a).toBe(b);
  });

  it('subscribeRunUnlocks notifies on both runStarted and carUnlocked', () => {
    reset();
    let notified = 0;
    const unsubscribe = subscribeRunUnlocks(() => {
      notified++;
    });

    gameEvents.emit('carUnlocked', { carId: 'pickup' });
    expect(notified).toBe(1);

    gameEvents.emit('runStarted', { seed: 1 });
    expect(notified).toBe(2);

    unsubscribe();
    gameEvents.emit('carUnlocked', { carId: 'schoolBus' });
    expect(notified).toBe(2); // unsubscribed — no further notifications
  });
});
