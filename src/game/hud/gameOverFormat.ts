// Pure formatting/derivation helpers for the GAMEOVER screen (hud/GameOver.tsx). Split out
// for the same reason as hud/hudFormat.ts: keeps this unit-testable in plain vitest (no
// React, no DOM) and keeps GameOver.tsx itself component-exports-only for
// react-refresh/only-export-components.

import { PLAYER_CARS } from '../config/vehicles';
import { UNLOCKS } from '../config/unlocks';
import type { PlayerCarId } from '../config/vehicles';

/** Mirrors state/events.ts's `runEnded` payload's `reason` field. */
export type RunEndReason = 'wrecked' | 'busted' | 'quit';

export interface GameOverBanner {
  readonly label: string;
  readonly variant: 'wrecked' | 'busted';
}

/**
 * Maps a runEnded reason to the GAMEOVER screen's banner text + visual variant (backdrop
 * wash color in GameOver.css). Only two named outcomes exist per CLAUDE.md's locked
 * decisions ("BUSTED mechanic: In") and the TDD — a `'quit'` reason (the PAUSED -> GAMEOVER
 * "abort run" edge in state/machine.ts) and a missing/null reason (e.g. this screen reached
 * via a debug `window.__smashy.transition('GAMEOVER')` call with no accompanying `runEnded`
 * event — see this task's verification note) both degrade to the WRECKED visual language
 * rather than inventing a third banner the rest of the game never produces.
 */
export function bannerForReason(reason: RunEndReason | null | undefined): GameOverBanner {
  if (reason === 'busted') return { label: 'BUSTED', variant: 'busted' };
  return { label: 'WRECKED', variant: 'wrecked' };
}

/** Phase 17: what the GAMEOVER screen's unlock-progress line (`gameover-unlocks`)
 * needs — the next not-yet-unlocked car (by ascending threshold) and how many more
 * lifetime points are needed to reach it. */
export interface NextUnlockInfo {
  readonly carName: string;
  readonly remaining: number;
  readonly threshold: number;
}

/**
 * The next locked car (config/unlocks.ts's UNLOCKS, ascending by threshold) and how far
 * `lifetimeScore` is from it, or `null` once every car is unlocked. Pure — driven entirely
 * by config, independent of React/the store; hud/GameOver.tsx feeds it
 * `loadProgress().lifetimeScore`.
 */
export function nextUnlockInfo(lifetimeScore: number): NextUnlockInfo | null {
  const locked = (Object.keys(UNLOCKS) as PlayerCarId[])
    .filter((id) => UNLOCKS[id] > lifetimeScore)
    .sort((a, b) => UNLOCKS[a] - UNLOCKS[b]);
  const nextId = locked[0];
  if (nextId === undefined) return null;
  return {
    carName: PLAYER_CARS[nextId].name,
    remaining: UNLOCKS[nextId] - lifetimeScore,
    threshold: UNLOCKS[nextId],
  };
}
