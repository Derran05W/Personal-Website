import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameEventEmitter, gameEvents } from './events';

describe('GameEventEmitter', () => {
  let emitter: GameEventEmitter;

  beforeEach(() => {
    emitter = new GameEventEmitter();
  });

  it('delivers a typed payload to a subscribed handler', () => {
    const handler = vi.fn();
    emitter.on('heatChanged', handler);

    emitter.emit('heatChanged', { heat: 15, delta: 15 });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ heat: 15, delta: 15 });
  });

  it('delivers to multiple subscribers on the same event', () => {
    const a = vi.fn();
    const b = vi.fn();
    emitter.on('busted', a);
    emitter.on('busted', b);

    emitter.emit('busted', {});

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('emitting an event with no subscribers is a no-op', () => {
    expect(() => emitter.emit('darkCity', {})).not.toThrow();
  });

  it('on() returns an unsubscribe function that stops delivery', () => {
    const handler = vi.fn();
    const unsubscribe = emitter.on('civHit', handler);

    unsubscribe();
    emitter.emit('civHit', {});

    expect(handler).not.toHaveBeenCalled();
  });

  it('off() stops delivery to that specific handler only', () => {
    const a = vi.fn();
    const b = vi.fn();
    emitter.on('civWrecked', a);
    emitter.on('civWrecked', b);

    emitter.off('civWrecked', a);
    emitter.emit('civWrecked', {});

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('a throwing handler does not prevent other handlers from running', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const throwing = vi.fn(() => {
      throw new Error('boom');
    });
    const next = vi.fn();
    emitter.on('playerWrecked', throwing);
    emitter.on('playerWrecked', next);

    expect(() => emitter.emit('playerWrecked', {})).not.toThrow();

    expect(throwing).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    consoleErrorSpy.mockRestore();
  });

  it('clearAllListeners removes every subscriber for every event', () => {
    const heatHandler = vi.fn();
    const tierHandler = vi.fn();
    emitter.on('heatChanged', heatHandler);
    emitter.on('tierChanged', tierHandler);

    emitter.clearAllListeners();
    emitter.emit('heatChanged', { heat: 1, delta: 1 });
    emitter.emit('tierChanged', { tier: 1, prevTier: 0 });

    expect(heatHandler).not.toHaveBeenCalled();
    expect(tierHandler).not.toHaveBeenCalled();
  });

  it('payload round-trips exactly (typed, non-mutated) through emit', () => {
    const received: { unitKind: string }[] = [];
    emitter.on('unitWrecked', (payload) => received.push(payload));

    emitter.emit('unitWrecked', { unitKind: 'policeSedan' });

    expect(received).toEqual([{ unitKind: 'policeSedan' }]);
  });
});

describe('gameEvents (module-level singleton)', () => {
  afterEach(() => {
    gameEvents.clearAllListeners();
  });

  it('is shared across imports of the module', () => {
    const handler = vi.fn();
    gameEvents.on('runStarted', handler);

    gameEvents.emit('runStarted', { seed: 42 });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ seed: 42 });
  });
});
