import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createElement, StrictMode, type ReactNode } from 'react';
import { getDrivingInput, useInputSystem } from './index';
import { useGameStore } from '../state/store';

// Snapshot of the store's state at module-evaluation time — same reset pattern as
// state/store.test.ts, so every test starts from a clean BOOT machine with default
// settings regardless of what a previous test mutated.
const initialState = useGameStore.getState();

beforeEach(() => {
  localStorage.clear();
  useGameStore.setState(initialState, true);
});

afterEach(() => {
  vi.restoreAllMocks();
  // Defensive: undo any visibilitychange simulation even if a test failed mid-way.
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  // Global cleanup() from src/vitest-setup.ts unmounts every renderHook() result after
  // each test, which runs useInputSystem's effect cleanup (detach + hardReset) — that's
  // what keeps window/document listeners from leaking between tests in this file.
});

function strictWrapper({ children }: { children: ReactNode }) {
  return createElement(StrictMode, null, children);
}

function mountInputSystem() {
  return renderHook(() => useInputSystem());
}

function goToGarage(): void {
  const store = useGameStore.getState();
  store.transition('LOADING');
  store.transition('GARAGE');
}

function goToPlaying(): void {
  goToGarage();
  useGameStore.getState().transition('PLAYING');
}

function keydown(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
}

function keyup(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
}

const ZERO_INPUT = { steer: 0, throttle: 0, brake: 0, handbrake: false };

describe('driving input — only live while PLAYING', () => {
  it('WASD drives throttle/brake/steer', () => {
    goToPlaying();
    mountInputSystem();

    keydown('KeyW');
    expect(getDrivingInput().throttle).toBe(1);
    keyup('KeyW');
    expect(getDrivingInput().throttle).toBe(0);

    keydown('KeyS');
    expect(getDrivingInput().brake).toBe(1);
    keyup('KeyS');
    expect(getDrivingInput().brake).toBe(0);

    keydown('KeyD');
    expect(getDrivingInput().steer).toBe(1);
    keyup('KeyD');
    expect(getDrivingInput().steer).toBe(0);

    keydown('KeyA');
    expect(getDrivingInput().steer).toBe(-1);
    keyup('KeyA');
    expect(getDrivingInput().steer).toBe(0);
  });

  it('arrow keys mirror WASD', () => {
    goToPlaying();
    mountInputSystem();

    keydown('ArrowUp');
    expect(getDrivingInput().throttle).toBe(1);
    keydown('ArrowRight');
    expect(getDrivingInput().steer).toBe(1);
    keyup('ArrowUp');
    keyup('ArrowRight');
    expect(getDrivingInput()).toEqual(ZERO_INPUT);
  });

  it('Space sets and releases the handbrake', () => {
    goToPlaying();
    mountInputSystem();

    keydown('Space');
    expect(getDrivingInput().handbrake).toBe(true);
    keyup('Space');
    expect(getDrivingInput().handbrake).toBe(false);
  });

  it('opposing steer keys cancel to 0, and releasing one snaps back to the other', () => {
    goToPlaying();
    mountInputSystem();

    keydown('KeyA');
    expect(getDrivingInput().steer).toBe(-1);
    keydown('KeyD');
    expect(getDrivingInput().steer).toBe(0);
    keyup('KeyD');
    expect(getDrivingInput().steer).toBe(-1);
    keyup('KeyA');
    expect(getDrivingInput().steer).toBe(0);
  });

  it('driving keys do nothing outside PLAYING (e.g. GARAGE)', () => {
    goToGarage();
    mountInputSystem();

    keydown('KeyW');
    keydown('KeyD');
    keydown('Space');
    expect(getDrivingInput()).toEqual(ZERO_INPUT);
  });

  it('ignores driving keys when focus is in an editable element', () => {
    goToPlaying();
    mountInputSystem();

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true, cancelable: true }),
    );
    expect(getDrivingInput().throttle).toBe(0);
    document.body.removeChild(input);
  });

  it('leaving PLAYING via our own pause key zeroes all driving input', () => {
    goToPlaying();
    mountInputSystem();

    keydown('KeyW');
    keydown('KeyD');
    expect(getDrivingInput().throttle).toBe(1);
    expect(getDrivingInput().steer).toBe(1);

    keydown('Escape');
    expect(useGameStore.getState().machine).toBe('PAUSED');
    expect(getDrivingInput()).toEqual(ZERO_INPUT);
  });

  it('leaving PLAYING via an externally-driven transition also zeroes driving input', () => {
    goToPlaying();
    mountInputSystem();

    keydown('KeyW');
    expect(getDrivingInput().throttle).toBe(1);

    // Simulates e.g. a WRECKED/BUSTED transition fired by the damage resolver, not by
    // our own key handler.
    useGameStore.getState().transition('GAMEOVER');
    expect(getDrivingInput()).toEqual(ZERO_INPUT);
  });
});

describe('pause / mute / restart / garage toggles', () => {
  it('Esc toggles PLAYING <-> PAUSED', () => {
    goToPlaying();
    mountInputSystem();

    keydown('Escape');
    expect(useGameStore.getState().machine).toBe('PAUSED');
    keyup('Escape');
    keydown('Escape');
    expect(useGameStore.getState().machine).toBe('PLAYING');
  });

  it('P toggles PLAYING <-> PAUSED too', () => {
    goToPlaying();
    mountInputSystem();

    keydown('KeyP');
    expect(useGameStore.getState().machine).toBe('PAUSED');
    keyup('KeyP');
    keydown('KeyP');
    expect(useGameStore.getState().machine).toBe('PLAYING');
  });

  it('OS keydown-repeat does not re-fire a toggle without an intervening keyup', () => {
    goToPlaying();
    mountInputSystem();

    keydown('Escape');
    expect(useGameStore.getState().machine).toBe('PAUSED');
    keydown('Escape'); // simulated repeat: no keyup in between
    expect(useGameStore.getState().machine).toBe('PAUSED');
  });

  it('R retries from GAMEOVER -> PLAYING', () => {
    goToPlaying();
    mountInputSystem();
    useGameStore.getState().transition('GAMEOVER');

    keydown('KeyR');
    expect(useGameStore.getState().machine).toBe('PLAYING');
  });

  it('R does nothing outside GAMEOVER', () => {
    goToPlaying();
    mountInputSystem();

    keydown('KeyR');
    expect(useGameStore.getState().machine).toBe('PLAYING');
  });

  it('G returns to GARAGE from GAMEOVER', () => {
    goToPlaying();
    mountInputSystem();
    useGameStore.getState().transition('GAMEOVER');

    keydown('KeyG');
    expect(useGameStore.getState().machine).toBe('GARAGE');
  });

  it('G returns to GARAGE from PAUSED', () => {
    goToPlaying();
    mountInputSystem();
    keydown('Escape');
    keyup('Escape');

    keydown('KeyG');
    expect(useGameStore.getState().machine).toBe('GARAGE');
  });

  it('M toggles muted while PLAYING', () => {
    goToPlaying();
    mountInputSystem();
    expect(useGameStore.getState().settings.muted).toBe(false);

    keydown('KeyM');
    expect(useGameStore.getState().settings.muted).toBe(true);
    keyup('KeyM');
    keydown('KeyM');
    expect(useGameStore.getState().settings.muted).toBe(false);
  });

  it('M toggles muted while PAUSED', () => {
    goToPlaying();
    mountInputSystem();
    keydown('Escape');
    keyup('Escape');

    keydown('KeyM');
    expect(useGameStore.getState().settings.muted).toBe(true);
  });

  it('M toggles muted in states where nothing else is live (e.g. GARAGE)', () => {
    goToGarage();
    mountInputSystem();

    keydown('KeyM');
    expect(useGameStore.getState().settings.muted).toBe(true);
    // and no other key does anything in GARAGE
    keydown('KeyG');
    expect(useGameStore.getState().machine).toBe('GARAGE');
  });
});

describe('blur / visibilitychange pause triggers', () => {
  it('window blur pauses from PLAYING', () => {
    goToPlaying();
    mountInputSystem();

    window.dispatchEvent(new Event('blur'));
    expect(useGameStore.getState().machine).toBe('PAUSED');
  });

  it('window blur from a non-PLAYING state (GARAGE) is a no-op and does not throw', () => {
    goToGarage();
    mountInputSystem();

    expect(() => window.dispatchEvent(new Event('blur'))).not.toThrow();
    expect(useGameStore.getState().machine).toBe('GARAGE');
  });

  it('visibilitychange(hidden) pauses from PLAYING', () => {
    goToPlaying();
    mountInputSystem();

    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(useGameStore.getState().machine).toBe('PAUSED');
  });

  it('visibilitychange(hidden) from a non-PLAYING state (GARAGE) is a no-op and does not throw', () => {
    goToGarage();
    mountInputSystem();

    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    expect(() => document.dispatchEvent(new Event('visibilitychange'))).not.toThrow();
    expect(useGameStore.getState().machine).toBe('GARAGE');
  });
});

describe('listener lifecycle — StrictMode-safe, no leaks', () => {
  function countCallsWithFirstArg(spy: { mock: { calls: unknown[][] } }, value: string): number {
    return spy.mock.calls.filter((call) => call[0] === value).length;
  }

  it('attach/detach stay symmetric across repeated StrictMode mount/unmount cycles (Home -> Portfolio -> Home churn)', () => {
    const windowAdd = vi.spyOn(window, 'addEventListener');
    const windowRemove = vi.spyOn(window, 'removeEventListener');
    const docAdd = vi.spyOn(document, 'addEventListener');
    const docRemove = vi.spyOn(document, 'removeEventListener');

    for (let i = 0; i < 3; i++) {
      const { unmount } = renderHook(() => useInputSystem(), { wrapper: strictWrapper });
      unmount();
    }

    for (const type of ['keydown', 'keyup', 'blur']) {
      const adds = countCallsWithFirstArg(windowAdd, type);
      const removes = countCallsWithFirstArg(windowRemove, type);
      expect(removes).toBe(adds);
      expect(adds).toBeGreaterThan(0);
    }

    const docAdds = countCallsWithFirstArg(docAdd, 'visibilitychange');
    const docRemoves = countCallsWithFirstArg(docRemove, 'visibilitychange');
    expect(docRemoves).toBe(docAdds);
    expect(docAdds).toBeGreaterThan(0);
  });

  it('after the final unmount, a keydown changes nothing', () => {
    const { unmount } = renderHook(() => useInputSystem());
    unmount();

    goToPlaying();
    keydown('KeyW');
    expect(getDrivingInput().throttle).toBe(0);

    keydown('Escape');
    expect(useGameStore.getState().machine).toBe('PLAYING'); // unchanged: no listener caught it
  });

  it('unmount runs hardReset, resetting the machine to BOOT', () => {
    goToPlaying();
    const { unmount } = mountInputSystem();
    unmount();
    expect(useGameStore.getState().machine).toBe('BOOT');
  });
});
