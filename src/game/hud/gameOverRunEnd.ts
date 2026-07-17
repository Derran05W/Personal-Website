// Module-scope `runEnded` capture for hud/GameOver.tsx (Phase 9 Task 4). Split out of the
// component file — react-refresh's `only-export-components` rule (eslint.config.js's
// reactRefresh.configs.vite) flags a component file that also exports plain
// functions/constants, same reasoning as hud/hudFormat.ts's split from hud/Hud.tsx.
//
// Reason tracking (WRECKED vs BUSTED banner): combat/runLoop.ts (Phase 9 Task 3, a
// concurrent sibling task) emits `runEnded` at the moment a run ends, some time BEFORE — or
// in the same tick as — the PLAYING/PAUSED -> GAMEOVER transition that makes GameOver.tsx
// start rendering. Subscribing inside a component-scoped effect would race that ordering
// (the event may already have fired by the time the component mounts and its effect runs).
// The listener below is registered once at MODULE-evaluation time instead — as soon as
// game/index.tsx's import graph loads this module, long before any real run can end — so by
// the time GAMEOVER is ever reached, the payload is already captured. Same timing guarantee
// as core/debugBridge.ts's civHit/civWrecked running totals.
import { gameEvents } from '../state/events';
import type { RunEndReason } from './gameOverFormat';

export interface RunEndInfo {
  readonly score: number;
  readonly reason: RunEndReason;
}

let lastRunEnd: RunEndInfo | null = null;
const listeners = new Set<() => void>();

gameEvents.on('runEnded', ({ score, reason }) => {
  lastRunEnd = { score, reason };
  for (const listener of Array.from(listeners)) listener();
});

/** useSyncExternalStore subscribe function. */
export function subscribeRunEnd(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** useSyncExternalStore snapshot getter. */
export function getLastRunEnd(): RunEndInfo | null {
  return lastRunEnd;
}

/** Test-only reset: module-scope state persists across `it()` blocks in the same test
 * file/process otherwise, letting one test's emitted `runEnded` leak into the next's
 * assertions. Not imported by any production code path. */
export function __resetLastRunEndForTests(): void {
  lastRunEnd = null;
}
