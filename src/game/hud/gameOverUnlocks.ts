// Module-scope tracking of which cars were unlocked (config/unlocks.ts thresholds) during
// the CURRENT run, for hud/GameOver.tsx's "UNLOCKED: <name>" toast. Split out of the
// component file for the same react-refresh only-export-components reason as
// gameOverFormat.ts/gameOverRunEnd.ts.
//
// Timing hazard this sidesteps: state/persistence.ts's `recordRunEnd` (which is what
// actually emits `carUnlocked`) only runs from `initProgressPersistence`'s `runEnded`
// subscriber, which is registered in a MOUNT EFFECT (game/index.tsx) — so it always fires
// LATER, in `runEnded`'s handler order, than any listener registered at plain
// module-evaluation time (like this one, or hud/gameOverRunEnd.ts's). A naive "snapshot
// the unlock batch when runEnded fires" listener here would therefore run BEFORE
// recordRunEnd has emitted anything for THIS run, and would show the PREVIOUS run's
// unlocks a run late.
//
// The fix: don't key off `runEnded` at all. `runStarted` (state/events.ts, fired once per
// run by combat/runLoop.ts's beginRun, strictly BEFORE any gameplay — and therefore
// strictly before that run's own eventual `runEnded`/`carUnlocked`) resets the tracked
// list for the run that's just beginning. Every `carUnlocked` for a given run necessarily
// arrives strictly AFTER that run's `runStarted` and strictly BEFORE the next one, so
// accumulating between resets always yields exactly "this run's" unlocks, independent of
// any runEnded handler ordering.
import { gameEvents } from '../state/events';
import { PLAYER_CARS } from '../config/vehicles';

let currentRunUnlockNames: readonly string[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of Array.from(listeners)) listener();
}

gameEvents.on('runStarted', () => {
  currentRunUnlockNames = [];
  notify();
});

gameEvents.on('carUnlocked', ({ carId }) => {
  currentRunUnlockNames = [...currentRunUnlockNames, PLAYER_CARS[carId].name];
  notify();
});

/** useSyncExternalStore subscribe function. */
export function subscribeRunUnlocks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * useSyncExternalStore snapshot getter: display names, in the order each threshold was
 * crossed THIS run. Returns the SAME array reference until the next reset/append (required
 * for useSyncExternalStore — a fresh array on every call would loop React's render).
 */
export function getRunUnlockNames(): readonly string[] {
  return currentRunUnlockNames;
}

/** Test-only reset — mirrors hud/gameOverRunEnd.ts's __resetLastRunEndForTests. Not
 * imported by any production code path. */
export function __resetRunUnlocksForTests(): void {
  currentRunUnlockNames = [];
}
