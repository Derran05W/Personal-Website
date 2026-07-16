// Keyboard input system implementation (Phase 2 Task D). Owns:
//   - the live DrivingInput record (module-scope hot data, read every physics tick —
//     see the "never in the zustand store" rule at the top of state/store.ts).
//   - state-scoped keymap handling (TDD §5.2) and pause triggers (TDD §9).
//   - the useInputSystem() lifecycle hook, mounted once by the game entry point
//     (game/index.tsx, owned by a parallel task).
//
// src/game/input/index.ts is the public contract; it just re-exports this module's
// surface so downstream imports (`from '../input'` / `from './input'`) keep working
// unchanged regardless of how the implementation is organized in here.
import { useEffect } from 'react';
import { getGameState, useGameStore, type GameStoreState } from '../state/store';

/** Driving intent read by the vehicle controller every physics step (Phase 3+).
 * Module-scope hot data — deliberately NOT in the zustand store (see state/store.ts). */
export interface DrivingInput {
  /** -1 (full left) .. 1 (full right) */
  steer: number;
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  handbrake: boolean;
}

const drivingInput: DrivingInput = { steer: 0, throttle: 0, brake: 0, handbrake: false };

function zeroDrivingInput(): void {
  drivingInput.steer = 0;
  drivingInput.throttle = 0;
  drivingInput.brake = 0;
  drivingInput.handbrake = false;
}

/** Live driving intent. Consumers must treat it as read-only. */
export function getDrivingInput(): Readonly<DrivingInput> {
  return drivingInput;
}

// --- Keymap (TDD §5.2) ---------------------------------------------------------------
// Keyed by KeyboardEvent.code (physical key position), not `.key` — keeps the mapping
// correct under Shift/AltGr/non-QWERTY layouts and makes case irrelevant.
const THROTTLE_CODES: ReadonlySet<string> = new Set(['KeyW', 'ArrowUp']);
const BRAKE_CODES: ReadonlySet<string> = new Set(['KeyS', 'ArrowDown']);
const STEER_LEFT_CODES: ReadonlySet<string> = new Set(['KeyA', 'ArrowLeft']);
const STEER_RIGHT_CODES: ReadonlySet<string> = new Set(['KeyD', 'ArrowRight']);
const HANDBRAKE_CODES: ReadonlySet<string> = new Set(['Space']);
const DRIVING_CODES: ReadonlySet<string> = new Set([
  ...THROTTLE_CODES,
  ...BRAKE_CODES,
  ...STEER_LEFT_CODES,
  ...STEER_RIGHT_CODES,
  ...HANDBRAKE_CODES,
]);

const PAUSE_CODES: ReadonlySet<string> = new Set(['Escape', 'KeyP']);
const RESTART_CODE = 'KeyR';
const GARAGE_CODE = 'KeyG';
const MUTE_CODE = 'KeyM';

// --- Held-key tracking -----------------------------------------------------------------
// Serves two purposes: (1) computing steer/throttle/brake from which of the opposing
// direction keys are currently down (A+D held together cancels to 0; releasing one
// while the other is still held snaps back to it, not to 0); (2) guarding every toggle
// action (pause/mute/restart/garage) against OS keydown-repeat re-firing the action on
// every repeat tick — a toggle only fires on the up-to-down edge of a physical press.
const pressedKeys = new Set<string>();

function isCodePressed(codes: ReadonlySet<string>): boolean {
  for (const code of codes) {
    if (pressedKeys.has(code)) return true;
  }
  return false;
}

function recomputeDrivingInput(): void {
  const left = isCodePressed(STEER_LEFT_CODES);
  const right = isCodePressed(STEER_RIGHT_CODES);
  drivingInput.steer = (right ? 1 : 0) - (left ? 1 : 0);
  drivingInput.throttle = isCodePressed(THROTTLE_CODES) ? 1 : 0;
  drivingInput.brake = isCodePressed(BRAKE_CODES) ? 1 : 0;
  drivingInput.handbrake = isCodePressed(HANDBRAKE_CODES);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
}

/** Fires `action` once per physical press (guards OS keydown-repeat via pressedKeys)
 * and prevents the key's default browser behavior (scroll, etc.) — safe to call
 * unconditionally since callers only reach this for a key their state has already
 * decided to consume. */
function consumeToggle(event: KeyboardEvent, code: string, action: () => void): void {
  event.preventDefault();
  if (pressedKeys.has(code)) return;
  pressedKeys.add(code);
  action();
}

// --- Key handlers, state-scoped (TDD §4.2, §5.2) ----------------------------------------
// One keydown/keyup pair lives for the whole mounted lifetime of the game (see
// attachInputSystem/detachInputSystem below) rather than being attached/detached per
// machine state — that keeps listener churn out of the hot path and, critically, means
// the header's own tab order is never disturbed by state transitions. Each handler
// consults the *current* machine state and only acts on keys mapped for that state;
// everything else passes through untouched (no preventDefault, no pressedKeys entry) —
// this is what keeps the site header fully keyboard-usable at all times.
function handleKeyDown(event: KeyboardEvent): void {
  if (isEditableTarget(event.target)) return;

  const code = event.code;
  const machine = getGameState().machine;

  switch (machine) {
    case 'PLAYING':
      if (DRIVING_CODES.has(code)) {
        event.preventDefault();
        pressedKeys.add(code);
        recomputeDrivingInput();
      } else if (PAUSE_CODES.has(code)) {
        consumeToggle(event, code, () => getGameState().transition('PAUSED'));
      } else if (code === MUTE_CODE) {
        consumeToggle(event, code, () => getGameState().toggleMuted());
      }
      return;

    case 'PAUSED':
      if (PAUSE_CODES.has(code)) {
        consumeToggle(event, code, () => getGameState().transition('PLAYING'));
      } else if (code === GARAGE_CODE) {
        consumeToggle(event, code, () => getGameState().transition('GARAGE'));
      } else if (code === MUTE_CODE) {
        consumeToggle(event, code, () => getGameState().toggleMuted());
      }
      return;

    case 'GAMEOVER':
      if (code === RESTART_CODE) {
        consumeToggle(event, code, () => getGameState().transition('PLAYING'));
      } else if (code === GARAGE_CODE) {
        consumeToggle(event, code, () => getGameState().transition('GARAGE'));
      } else if (code === MUTE_CODE) {
        consumeToggle(event, code, () => getGameState().toggleMuted());
      }
      return;

    case 'BOOT':
    case 'LOADING':
    case 'GARAGE':
      // Only mute is live pre-run / in the garage; every other key is left completely
      // alone so e.g. Tab still moves through the header normally.
      if (code === MUTE_CODE) {
        consumeToggle(event, code, () => getGameState().toggleMuted());
      }
      return;
  }
}

function handleKeyUp(event: KeyboardEvent): void {
  const code = event.code;
  if (!pressedKeys.has(code)) return;
  pressedKeys.delete(code);
  if (DRIVING_CODES.has(code)) {
    recomputeDrivingInput();
  }
}

// --- Pause triggers (TDD §9): tab hidden, window blur -----------------------------------
function handleBlur(): void {
  if (getGameState().machine === 'PLAYING') {
    getGameState().transition('PAUSED');
  }
}

function handleVisibilityChange(): void {
  if (document.hidden && getGameState().machine === 'PLAYING') {
    getGameState().transition('PAUSED');
  }
}

// --- Leaving PLAYING zeroes driving input, from *any* cause ------------------------------
// Not just our own Esc/P handler: WRECKED/BUSTED transitions to GAMEOVER are driven by
// other systems (physics/damage resolvers) calling store.transition() directly, and
// blur/visibilitychange above also route through transition(). Subscribing to the store
// itself (rather than duplicating "zero on leaving PLAYING" at every call site) is the
// one place guaranteed to see every PLAYING -> * transition regardless of cause.
//
// Only the driving-code entries are cleared from pressedKeys here, not the whole set:
// clearing toggle codes too would let a still-held Esc/P's OS keydown-repeat re-fire
// immediately after the very transition it just caused (PLAYING -> PAUSED, key repeats,
// pressedKeys no longer has it -> PAUSED branch fires -> back to PLAYING -> ...).
// Driving codes have no such self-reference problem, and clearing them here — rather
// than waiting for a keyup that may never arrive (e.g. focus lost on blur) — is exactly
// what prevents stuck throttle after resume.
function handleStoreChange(state: GameStoreState, prevState: GameStoreState): void {
  if (prevState.machine === 'PLAYING' && state.machine !== 'PLAYING') {
    zeroDrivingInput();
    for (const code of DRIVING_CODES) pressedKeys.delete(code);
  }
}

// --- Lifecycle ----------------------------------------------------------------------------
let unsubscribeStore: (() => void) | null = null;
let attached = false;

function attachInputSystem(): void {
  if (attached) return;
  attached = true;
  pressedKeys.clear();
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  window.addEventListener('blur', handleBlur);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  unsubscribeStore = useGameStore.subscribe(handleStoreChange);
}

function detachInputSystem(): void {
  if (!attached) return;
  attached = false;
  window.removeEventListener('keydown', handleKeyDown);
  window.removeEventListener('keyup', handleKeyUp);
  window.removeEventListener('blur', handleBlur);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  unsubscribeStore?.();
  unsubscribeStore = null;
  pressedKeys.clear();
  zeroDrivingInput();
}

/**
 * Mounts the keyboard input system for the lifetime of the game tree: key listeners
 * scoped per machine state (driving keys only in PLAYING), pause triggers
 * (Esc/P, tab-hidden, window blur), and run teardown (store hardReset) on unmount —
 * i.e. on route change away from Home. StrictMode-safe: attachInputSystem/
 * detachInputSystem are idempotent and symmetric, so the dev double
 * mount -> cleanup -> mount cycle attaches exactly once per mount and leaves no
 * listeners behind after the final unmount.
 */
export function useInputSystem(): void {
  useEffect(() => {
    attachInputSystem();
    return () => {
      detachInputSystem();
      // Route change away from Home / unmount ends the run (TDD §4.2). hardReset()
      // bypasses the transition table (BOOT has no predecessor edge) by design — see
      // store.ts. Safe to call even mid-boot; the game entry's boot effect is guarded
      // and simply re-runs.
      getGameState().hardReset();
    };
  }, []);
}
