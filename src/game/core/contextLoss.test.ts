import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGameStore } from '../state/store';
import {
  __resetContextLossForTests,
  attachContextLossListeners,
  isContextLost,
  subscribeContextLost,
} from './contextLoss';

// Same store-reset idiom as state/store.test.ts: snapshot the real store once, restore it
// between tests rather than mocking getGameState/canTransition — the whole point of this
// module is exercising the real transition guard.
const initialState = useGameStore.getState();

beforeEach(() => {
  useGameStore.setState(initialState, true);
  __resetContextLossForTests();
});

afterEach(() => {
  __resetContextLossForTests();
});

function fireLost(canvas: HTMLCanvasElement): Event {
  const event = new Event('webglcontextlost', { cancelable: true });
  canvas.dispatchEvent(event);
  return event;
}

function fireRestored(canvas: HTMLCanvasElement): Event {
  const event = new Event('webglcontextrestored', { cancelable: true });
  canvas.dispatchEvent(event);
  return event;
}

describe('isContextLost', () => {
  it('starts false', () => {
    expect(isContextLost()).toBe(false);
  });
});

describe('attachContextLossListeners', () => {
  it('preventDefault()s the contextlost event (required to allow later restore)', () => {
    const canvas = document.createElement('canvas');
    attachContextLossListeners(canvas);
    const event = new Event('webglcontextlost', { cancelable: true });
    const spy = vi.spyOn(event, 'preventDefault');
    canvas.dispatchEvent(event);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('sets the flag true on contextlost and false again on contextrestored', () => {
    const canvas = document.createElement('canvas');
    attachContextLossListeners(canvas);

    expect(isContextLost()).toBe(false);
    fireLost(canvas);
    expect(isContextLost()).toBe(true);
    fireRestored(canvas);
    expect(isContextLost()).toBe(false);
  });

  it('transitions PLAYING -> PAUSED on contextlost', () => {
    const store = useGameStore.getState();
    store.transition('LOADING');
    store.transition('GARAGE');
    store.transition('PLAYING');

    const canvas = document.createElement('canvas');
    attachContextLossListeners(canvas);
    fireLost(canvas);

    expect(useGameStore.getState().machine).toBe('PAUSED');
  });

  it('does not touch machine state when contextlost fires outside PLAYING (guarded by canTransition)', () => {
    const store = useGameStore.getState();
    store.transition('LOADING');
    store.transition('GARAGE'); // not PLAYING — PAUSED is unreachable from GARAGE

    const canvas = document.createElement('canvas');
    attachContextLossListeners(canvas);
    fireLost(canvas);

    expect(useGameStore.getState().machine).toBe('GARAGE');
    // The flag still flips even though the transition was a no-op — the overlay must
    // show regardless of what state the game happened to be in when the GPU died.
    expect(isContextLost()).toBe(true);
  });

  it('does not auto-resume on contextrestored — stays PAUSED for the pause menu', () => {
    const store = useGameStore.getState();
    store.transition('LOADING');
    store.transition('GARAGE');
    store.transition('PLAYING');

    const canvas = document.createElement('canvas');
    attachContextLossListeners(canvas);
    fireLost(canvas);
    expect(useGameStore.getState().machine).toBe('PAUSED');

    fireRestored(canvas);
    expect(useGameStore.getState().machine).toBe('PAUSED');
    expect(isContextLost()).toBe(false);
  });

  it('the returned cleanup function removes both listeners', () => {
    const canvas = document.createElement('canvas');
    const cleanup = attachContextLossListeners(canvas);
    cleanup();

    fireLost(canvas);
    expect(isContextLost()).toBe(false);
  });
});

describe('subscribeContextLost', () => {
  it('notifies listeners on every real flag change, and not on a no-op set', () => {
    const canvas = document.createElement('canvas');
    attachContextLossListeners(canvas);

    const listener = vi.fn();
    subscribeContextLost(listener);

    fireLost(canvas);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(true);

    // A second contextlost while already lost is a no-op (flag already true) — no
    // duplicate notification.
    fireLost(canvas);
    expect(listener).toHaveBeenCalledTimes(1);

    fireRestored(canvas);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(false);
  });

  it('unsubscribe stops further notifications', () => {
    const canvas = document.createElement('canvas');
    attachContextLossListeners(canvas);

    const listener = vi.fn();
    const unsubscribe = subscribeContextLost(listener);
    unsubscribe();

    fireLost(canvas);
    expect(listener).not.toHaveBeenCalled();
  });
});
