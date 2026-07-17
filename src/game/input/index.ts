// Input system contract (Phase 2; touch merge added Phase 18 Task 1). This is the ONLY
// module other code should import from — the game entry (game/index.tsx) wires
// `useInputSystem()` from here, and the vehicle controller reads `getDrivingInput()` from
// here. The actual implementations (keymap/state-scoped handlers/pause triggers for
// keyboard, pointer bookkeeping/auto-throttle for touch) live in ./keyboard and ./touch,
// kept separate so each can own its module-scope state and be unit-tested directly; this
// file is the merge point.
//
// Merge contract: touch takes priority over keyboard ONLY once it has something to say
// (input/touch.ts's getTouchDrivingInput() returns `null` until touch mode has activated
// this session — coarse-pointer device or first touch-control use — and again whenever
// the machine isn't PLAYING or a scripted-driver override is active). Until then,
// getDrivingInput() is byte-for-byte keyboard.ts's own function — a desktop/no-touch
// session's behavior is completely unchanged by this file's existence.
import { getDrivingInput as getKeyboardDrivingInput, useInputSystem as useKeyboardInputSystem } from './keyboard';
import { getTouchDrivingInput, useTouchInputSystem } from './touch';
import type { DrivingInput } from './keyboard';

export type { DrivingInput } from './keyboard';
export { setDrivingInputOverride } from './keyboard';
export {
  isCoarsePointer,
  isTouchModeActive,
  tapPause,
  touchPointerCancel,
  touchPointerDown,
  touchPointerUp,
  type TouchRole,
} from './touch';

/** Live driving intent, merged across every attached input source. Consumers must treat
 * it as read-only — same contract as keyboard.ts's own getDrivingInput() this wraps. */
export function getDrivingInput(): Readonly<DrivingInput> {
  return getTouchDrivingInput() ?? getKeyboardDrivingInput();
}

/**
 * Mounts every input source for the lifetime of the game tree: keyboard (key listeners,
 * pause triggers, run teardown on unmount — see keyboard.ts) and touch (pointer
 * bookkeeping, coarse-pointer auto-detect — see touch.ts), composed into one hook so
 * game/index.tsx's existing single `useInputSystem()` call keeps working unchanged.
 */
export function useInputSystem(): void {
  useKeyboardInputSystem();
  useTouchInputSystem();
}
