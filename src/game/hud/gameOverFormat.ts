// Pure formatting/derivation helpers for the GAMEOVER screen (hud/GameOver.tsx). Split out
// for the same reason as hud/hudFormat.ts: keeps this unit-testable in plain vitest (no
// React, no DOM) and keeps GameOver.tsx itself component-exports-only for
// react-refresh/only-export-components.

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
