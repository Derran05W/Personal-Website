// Touch input system (Phase 18 Task 1). Owns the same DrivingInput aggregation contract
// as keyboard.ts's live keyboard state (see that file's header) but sourced from the
// on-screen touch UI (hud/touch/TouchControls.tsx) instead of physical key events:
//   - per-pointer bookkeeping for the three touch roles (steer left/right, brake) so
//     concurrent multi-touch (e.g. steering with one thumb while braking with the other)
//     resolves correctly through out-of-order release and pointercancel.
//   - "touch mode" activation (TDD §5.2 mobile controls row + CLAUDE.md's locked "Mobile
//     v1: playable-basic — ◀ ▶ + brake, auto-throttle"): once active, throttle is driven
//     automatically (1 unless the brake role is held) — the player only steers/brakes,
//     never presses a gas control.
//   - the useTouchInputSystem() lifecycle hook, composed into the shared useInputSystem()
//     export (input/index.ts) alongside keyboard's — mounted once by the game entry point,
//     same as keyboard.ts.
//
// input/index.ts is still the ONLY module other code should import from; this file (like
// keyboard.ts) is an implementation detail merged there.
import { useEffect } from 'react';
import { getGameState, useGameStore, type GameStoreState } from '../state/store';
import { canTransition } from '../state/machine';
import { TOUCH } from '../config';
import { hasDrivingInputOverride, type DrivingInput } from './keyboard';

/** Which on-screen control a currently-down touch pointer owns. */
export type TouchRole = 'steerLeft' | 'steerRight' | 'brake';

// --- Coarse-pointer detection ------------------------------------------------------------
// A small local copy of the same matchMedia-safe-read pattern as app/deviceCapabilities.ts
// (game/ deliberately never imports from app/ — see CLAUDE.md's directory layout note that
// app/ never imports game/; this keeps the dependency one-way by not reaching back either).
// Shared by this module's own touch-mode auto-activation below AND the UI's render gate
// (hud/touch/TouchControls.tsx), so there is exactly one query string to keep in sync.
const COARSE_POINTER_QUERY = '(pointer: coarse)';

export function isCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(COARSE_POINTER_QUERY).matches;
  } catch {
    // A handful of embedded/test environments implement matchMedia but throw on certain
    // query strings — treat "can't tell" as not-coarse, the safer default (keeps desktop
    // keyboard flow unaffected rather than spuriously gating on an unreadable signal).
    return false;
  }
}

// --- Per-pointer bookkeeping ---------------------------------------------------------------
// Keyed by PointerEvent.pointerId (not role) so two fingers landing on the SAME role (e.g.
// both tap steer-left) don't fight over a single boolean, and releasing one pointer never
// clobbers another still-down pointer's role — mirrors keyboard.ts's pressedKeys Set, just
// keyed per-touch instead of per-key since touch has no OS keydown-repeat to piggyback on.
const activePointers = new Map<number, TouchRole>();

function isRoleHeld(role: TouchRole): boolean {
  for (const r of activePointers.values()) {
    if (r === role) return true;
  }
  return false;
}

function releaseAllPointers(): void {
  activePointers.clear();
}

// --- Touch-mode activation ------------------------------------------------------------------
// Sticky for the whole mounted lifetime once true (never resets back to false) — mirrors
// keyboard.ts's pressedKeys persisting across PLAYING entries/exits within one mount; a
// device that's shown itself to be touch-capable stays in auto-throttle mode for the rest
// of the session. Two triggers (task brief): a coarse-pointer device (checked at attach —
// see attachTouchInputSystem below), or the first real use of any touch control
// (touchPointerDown below) — whichever comes first.
let touchModeActive = false;

/** True once touch mode has activated this session (coarse-pointer device detected at
 * mount, or the player has used any touch control at least once). Exported for the UI and
 * for tests — the on-screen controls themselves gate on {@link isCoarsePointer} directly
 * (a static device-capability read), not this (a stateful "have we gone auto-throttle
 * yet" flag) — the two are deliberately different questions. */
export function isTouchModeActive(): boolean {
  return touchModeActive;
}

// --- Pointer lifecycle, called by hud/touch/TouchControls.tsx's pointer handlers -----------
/** A touch control's pointerdown: claims `pointerId` for `role` and activates touch mode
 * (idempotent — a session that's already active just stays active). */
export function touchPointerDown(pointerId: number, role: TouchRole): void {
  activePointers.set(pointerId, role);
  touchModeActive = true;
}

/** A touch control's pointerup/pointerleave: releases `pointerId`, whatever role it held.
 * Safe to call for an unknown/already-released pointerId (no-op). */
export function touchPointerUp(pointerId: number): void {
  activePointers.delete(pointerId);
}

/** pointercancel (task brief: "pointercancel handled") — the OS/browser interrupting a
 * touch (e.g. a notification pull-down) mid-press. Same release as touchPointerUp; kept as
 * a distinctly-named alias so call sites read as "this was a cancel", not a normal up. */
export const touchPointerCancel = touchPointerUp;

/** The on-screen ⏸ button's tap handler: PLAYING -> PAUSED. Guarded (mirrors
 * hud/pauseMenuActions.ts's resumeRun/openGarage pattern) against a stray tap racing a
 * machine change — the button only renders while PLAYING anyway (TouchControls' own
 * render gate), so this is belt-and-suspenders, not load-bearing. */
export function tapPause(): void {
  const state = getGameState();
  if (canTransition(state.machine, 'PAUSED')) state.transition('PAUSED');
}

// --- DrivingInput contribution ---------------------------------------------------------------
/**
 * The touch-derived DrivingInput, or `null` when touch has nothing to contribute — touch
 * mode has never activated this session, the machine isn't PLAYING, or a scripted-driver
 * override is active (ai/chaosBench.ts via input/keyboard.ts's setDrivingInputOverride).
 * `null` tells input/index.ts's merge to fall through to keyboard.ts's own
 * getDrivingInput() unchanged — exactly a desktop/no-touch session's existing behavior.
 *
 * Once touch mode IS active, this is authoritative and unconditional — not merely "while a
 * button happens to be held": auto-throttle (task brief) means throttle is 1 on EVERY read
 * unless the brake role is currently held, even with zero fingers down (Smashy-style
 * always-driving forward; the player only steers/brakes). Steer is full-lock binary (±1),
 * scaled by TOUCH.touchSteerRateScale and clamped back to [-1, 1] (a future >1 tuning value
 * must not overshoot the vehicle controller's expected input range). Handbrake has no touch
 * control in v1 (CLAUDE.md's "playable-basic": ◀ ▶ + brake only) — always false here.
 */
export function getTouchDrivingInput(): DrivingInput | null {
  if (!touchModeActive) return null;
  if (getGameState().machine !== 'PLAYING') return null;
  if (hasDrivingInputOverride()) return null;

  const left = isRoleHeld('steerLeft');
  const right = isRoleHeld('steerRight');
  const brakeHeld = isRoleHeld('brake');
  const rawSteer = (right ? 1 : 0) - (left ? 1 : 0);
  const steer = Math.max(-1, Math.min(1, rawSteer * TOUCH.touchSteerRateScale));

  return {
    steer,
    throttle: brakeHeld ? 0 : 1,
    brake: brakeHeld ? 1 : 0,
    handbrake: false,
  };
}

// --- Leaving PLAYING releases any still-down pointers, from *any* cause --------------------
// Same reasoning as keyboard.ts's handleStoreChange: WRECKED/BUSTED can flip the machine
// out of PLAYING from a system that isn't this one (damage resolver, blur, etc.), and a
// TouchControls button can also disappear out from under a still-down finger (the
// component's own PLAYING-only render gate unmounts it without ever delivering a
// pointerup/pointercancel for that finger) — without this, a stale "brake held" (or
// steer-left/right) would linger in `activePointers` forever, doing nothing today (physics
// is paused outside PLAYING — game/index.tsx's `<Physics paused={machine !== 'PLAYING'}>`)
// but wrong the instant the run resumes. `touchModeActive` is deliberately NOT reset here
// (see its own doc comment — it's sticky for the whole session, not per-PLAYING-window).
function handleStoreChange(state: GameStoreState, prevState: GameStoreState): void {
  if (prevState.machine === 'PLAYING' && state.machine !== 'PLAYING') {
    releaseAllPointers();
  }
}

// --- Lifecycle --------------------------------------------------------------------------------
let unsubscribeStore: (() => void) | null = null;
let attached = false;

function attachTouchInputSystem(): void {
  if (attached) return;
  attached = true;
  activePointers.clear();
  if (isCoarsePointer()) touchModeActive = true;
  unsubscribeStore = useGameStore.subscribe(handleStoreChange);
}

function detachTouchInputSystem(): void {
  if (!attached) return;
  attached = false;
  unsubscribeStore?.();
  unsubscribeStore = null;
  activePointers.clear();
  // touchModeActive intentionally survives detach — see its doc comment. A StrictMode dev
  // double mount->cleanup->mount cycle, or a route-away/back remount, shouldn't "forget"
  // that this session already proved itself touch-capable.
}

/**
 * Mounts the touch input system for the lifetime of the game tree, composed into
 * input/index.ts's exported useInputSystem() alongside keyboard's own hook. Idempotent/
 * symmetric attach-detach, same StrictMode-safety contract as keyboard.ts's version.
 * Deliberately does NOT call hardReset() on unmount — keyboard.ts's hook already owns that
 * single call for the combined input system; a second call would just be redundant.
 */
export function useTouchInputSystem(): void {
  useEffect(() => {
    attachTouchInputSystem();
    return () => {
      detachTouchInputSystem();
    };
  }, []);
}

/** Test-only full reset of this module's singleton state (mirrors the codebase's other
 * `__reset*ForTests` helpers, e.g. hud/gameOverRunEnd.ts's). Vitest-only; never imported by
 * production code. */
export function __resetTouchInputForTests(): void {
  activePointers.clear();
  touchModeActive = false;
  unsubscribeStore?.();
  unsubscribeStore = null;
  attached = false;
}
