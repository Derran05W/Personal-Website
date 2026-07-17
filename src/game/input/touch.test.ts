import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useGameStore } from '../state/store';
import { setDrivingInputOverride } from './keyboard';
import {
  __resetTouchInputForTests,
  getTouchDrivingInput,
  isCoarsePointer,
  isTouchModeActive,
  tapPause,
  touchPointerCancel,
  touchPointerDown,
  touchPointerUp,
  useTouchInputSystem,
} from './touch';

// Snapshot of the store's state at module-evaluation time — same reset pattern as
// input/keyboard.test.ts, so every test starts from a clean BOOT machine.
const initialState = useGameStore.getState();

function stubCoarsePointer(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) satisfies MediaQueryList,
  );
}

beforeEach(() => {
  localStorage.clear();
  useGameStore.setState(initialState, true);
  __resetTouchInputForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetTouchInputForTests();
});

function goToGarage(): void {
  const store = useGameStore.getState();
  store.transition('LOADING');
  store.transition('GARAGE');
}

function goToPlaying(): void {
  goToGarage();
  useGameStore.getState().transition('PLAYING');
}

const ZERO_TOUCH_INPUT = { steer: 0, throttle: 1, brake: 0, handbrake: false };

describe('isCoarsePointer', () => {
  it('reads matchMedia("(pointer: coarse)")', () => {
    stubCoarsePointer(true);
    expect(isCoarsePointer()).toBe(true);
    stubCoarsePointer(false);
    expect(isCoarsePointer()).toBe(false);
  });

  it('degrades to false when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(isCoarsePointer()).toBe(false);
  });

  it('degrades to false when matchMedia throws', () => {
    vi.stubGlobal('matchMedia', () => {
      throw new Error('unsupported query');
    });
    expect(isCoarsePointer()).toBe(false);
  });
});

describe('touch mode activation', () => {
  it('is inactive by default; getTouchDrivingInput returns null until it activates', () => {
    goToPlaying();
    expect(isTouchModeActive()).toBe(false);
    expect(getTouchDrivingInput()).toBeNull();
  });

  it('touchPointerDown activates touch mode (any control used this session)', () => {
    goToPlaying();
    touchPointerDown(1, 'steerLeft');
    expect(isTouchModeActive()).toBe(true);
  });

  it('a coarse-pointer device auto-activates on attach, before any press', () => {
    stubCoarsePointer(true);
    const { unmount } = renderHook(() => useTouchInputSystem());
    expect(isTouchModeActive()).toBe(true);
    unmount();
  });

  it('a fine-pointer device does NOT auto-activate on attach', () => {
    stubCoarsePointer(false);
    const { unmount } = renderHook(() => useTouchInputSystem());
    expect(isTouchModeActive()).toBe(false);
    unmount();
  });

  it('stays active (sticky) across a PLAYING -> PAUSED -> PLAYING cycle', () => {
    goToPlaying();
    touchPointerDown(1, 'brake');
    useGameStore.getState().transition('PAUSED');
    expect(isTouchModeActive()).toBe(true);
    useGameStore.getState().transition('PLAYING');
    expect(isTouchModeActive()).toBe(true);
  });
});

describe('getTouchDrivingInput — auto-throttle + brake mapping', () => {
  it('once active, throttle is 1 with zero fingers down (Smashy-style always-driving)', () => {
    goToPlaying();
    touchPointerDown(1, 'steerLeft');
    touchPointerUp(1);
    expect(getTouchDrivingInput()).toEqual(ZERO_TOUCH_INPUT);
  });

  it('steerLeft held -> steer -1, throttle stays 1', () => {
    goToPlaying();
    touchPointerDown(1, 'steerLeft');
    expect(getTouchDrivingInput()).toEqual({ steer: -1, throttle: 1, brake: 0, handbrake: false });
  });

  it('steerRight held -> steer 1', () => {
    goToPlaying();
    touchPointerDown(1, 'steerRight');
    expect(getTouchDrivingInput()?.steer).toBe(1);
  });

  it('opposing steer roles held simultaneously cancel to 0 (like keyboard A+D)', () => {
    goToPlaying();
    touchPointerDown(1, 'steerLeft');
    touchPointerDown(2, 'steerRight');
    expect(getTouchDrivingInput()?.steer).toBe(0);
  });

  it('brake held forces throttle to 0 and sets brake 1 (auto-throttle override)', () => {
    goToPlaying();
    touchPointerDown(1, 'brake');
    expect(getTouchDrivingInput()).toEqual({ steer: 0, throttle: 0, brake: 1, handbrake: false });
  });

  it('steer + brake concurrently (two different pointers): both apply', () => {
    goToPlaying();
    touchPointerDown(1, 'steerRight');
    touchPointerDown(2, 'brake');
    expect(getTouchDrivingInput()).toEqual({ steer: 1, throttle: 0, brake: 1, handbrake: false });
  });

  it('handbrake is always false — no touch handbrake control in v1', () => {
    goToPlaying();
    touchPointerDown(1, 'steerLeft');
    expect(getTouchDrivingInput()?.handbrake).toBe(false);
  });

  it('returns null outside PLAYING even once touch mode is active', () => {
    goToPlaying();
    touchPointerDown(1, 'steerLeft');
    useGameStore.getState().transition('PAUSED');
    expect(getTouchDrivingInput()).toBeNull();
  });

  it('returns null while a scripted-driver override is active (chaos bench wins)', () => {
    goToPlaying();
    touchPointerDown(1, 'steerLeft');
    setDrivingInputOverride({ steer: 0.5, throttle: 0.5, brake: 0, handbrake: false });
    expect(getTouchDrivingInput()).toBeNull();
    setDrivingInputOverride(null);
    expect(getTouchDrivingInput()).not.toBeNull();
  });
});

describe('multi-pointer bookkeeping', () => {
  it('two pointers on the same role: releasing one keeps the role held', () => {
    goToPlaying();
    touchPointerDown(1, 'steerLeft');
    touchPointerDown(2, 'steerLeft');
    touchPointerUp(1);
    expect(getTouchDrivingInput()?.steer).toBe(-1);
    touchPointerUp(2);
    expect(getTouchDrivingInput()?.steer).toBe(0);
  });

  it('pointercancel releases exactly like pointerup', () => {
    goToPlaying();
    touchPointerDown(1, 'brake');
    touchPointerCancel(1);
    expect(getTouchDrivingInput()?.brake).toBe(0);
  });

  it('releasing an unknown pointerId is a safe no-op', () => {
    goToPlaying();
    touchPointerDown(1, 'steerLeft');
    expect(() => touchPointerUp(999)).not.toThrow();
    expect(getTouchDrivingInput()?.steer).toBe(-1);
  });

  it('re-claiming a pointerId for a new role overwrites its old role (no double-count)', () => {
    goToPlaying();
    touchPointerDown(1, 'steerLeft');
    touchPointerDown(1, 'steerRight'); // same pointerId, different role (rare but possible)
    expect(getTouchDrivingInput()?.steer).toBe(1);
  });

  it('leaving PLAYING (any cause) releases every held pointer', () => {
    goToPlaying();
    const { unmount } = renderHook(() => useTouchInputSystem());
    touchPointerDown(1, 'steerLeft');
    touchPointerDown(2, 'brake');
    useGameStore.getState().transition('GAMEOVER');
    useGameStore.getState().transition('PLAYING'); // GAMEOVER -> PLAYING: valid retry edge
    expect(getTouchDrivingInput()).toEqual(ZERO_TOUCH_INPUT);
    unmount();
  });

  it('leaving PLAYING clears pointers even without the lifecycle hook mounted (module state only)', () => {
    goToPlaying();
    touchPointerDown(1, 'steerLeft');
    // No useTouchInputSystem mounted: the store subscription that clears pointers never
    // attached, so this documents the (inert-in-practice, since physics pauses outside
    // PLAYING) fallback behavior — getTouchDrivingInput itself still gates on PLAYING.
    useGameStore.getState().transition('PAUSED');
    expect(getTouchDrivingInput()).toBeNull();
  });
});

describe('tapPause', () => {
  it('transitions PLAYING -> PAUSED', () => {
    goToPlaying();
    tapPause();
    expect(useGameStore.getState().machine).toBe('PAUSED');
  });

  it('is a guarded no-op outside PLAYING', () => {
    goToGarage();
    tapPause();
    expect(useGameStore.getState().machine).toBe('GARAGE');
  });
});

describe('lifecycle — StrictMode-safe attach/detach', () => {
  it('attach/detach is idempotent across repeated mount/unmount cycles', () => {
    stubCoarsePointer(true);
    for (let i = 0; i < 3; i++) {
      const { unmount } = renderHook(() => useTouchInputSystem());
      unmount();
    }
    expect(isTouchModeActive()).toBe(true);
  });

  it('a pointer held across an unmount does not leak into a later mount (pointers clear on detach)', () => {
    goToPlaying();
    const first = renderHook(() => useTouchInputSystem());
    touchPointerDown(1, 'steerLeft');
    first.unmount();

    const second = renderHook(() => useTouchInputSystem());
    expect(getTouchDrivingInput()?.steer).toBe(0);
    second.unmount();
  });
});
