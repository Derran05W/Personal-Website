import { afterEach, describe, expect, it } from 'vitest';
import { gameEvents } from '../../state/events';
import { __resetNewBadgesForTests, clearNewBadge, isNewBadge } from './newBadge';

afterEach(() => {
  __resetNewBadgesForTests();
});

describe('newBadge', () => {
  it('is false for a car that has never been unlocked this session', () => {
    expect(isNewBadge('pickup')).toBe(false);
  });

  it('carUnlocked marks the car as NEW', () => {
    gameEvents.emit('carUnlocked', { carId: 'pickup' });
    expect(isNewBadge('pickup')).toBe(true);
  });

  it('clearNewBadge turns it off, and only for that car', () => {
    gameEvents.emit('carUnlocked', { carId: 'pickup' });
    gameEvents.emit('carUnlocked', { carId: 'schoolBus' });

    clearNewBadge('pickup');

    expect(isNewBadge('pickup')).toBe(false);
    expect(isNewBadge('schoolBus')).toBe(true);
  });

  it('clearing an id that was never marked is a harmless no-op', () => {
    expect(() => clearNewBadge('redRocket')).not.toThrow();
    expect(isNewBadge('redRocket')).toBe(false);
  });
});
