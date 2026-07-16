// Input system contract (Phase 2). This is the ONLY module other code should import
// from — the game entry (game/index.tsx) wires `useInputSystem()` from here, and the
// vehicle controller (Phase 3+) will read `getDrivingInput()` from here. The actual
// implementation (keymap, state-scoped handlers, pause triggers, lifecycle) lives in
// ./keyboard, kept separate so it can own its module-scope state and be unit-tested
// directly; this file just re-exports the same signatures the stub originally pinned.
export type { DrivingInput } from './keyboard';
export { getDrivingInput, useInputSystem } from './keyboard';
