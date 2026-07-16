// Game state machine. TDD §6: `BOOT → LOADING → GARAGE → PLAYING ⇄ PAUSED → GAMEOVER →
// (GARAGE | PLAYING)`. This is the single source of truth for which transitions are
// legal — the store (store.ts) is the only thing allowed to call assertTransition, and
// nothing else in the codebase should mutate `machine` directly.
export type GameState = 'BOOT' | 'LOADING' | 'GARAGE' | 'PLAYING' | 'PAUSED' | 'GAMEOVER';

// Explicit adjacency list, not a computed/derived table — the TDD's arrow diagram maps
// 1:1 onto this object so the two stay trivially comparable during review.
//
//  BOOT     -> LOADING            (asset/chunk load kicks off)
//  LOADING  -> GARAGE              (assets ready, player picks a car)
//  GARAGE   -> PLAYING             (run starts)
//  PLAYING  -> PAUSED, GAMEOVER    (Esc/P/blur/tab-hide, or WRECKED/BUSTED)
//  PAUSED   -> PLAYING, GARAGE, GAMEOVER
//             (resume; pause menu's "Garage" option; abort run from pause)
//  GAMEOVER -> GARAGE, PLAYING     (score screen's `G` garage / `R` retry)
export const TRANSITIONS: Record<GameState, readonly GameState[]> = {
  BOOT: ['LOADING'],
  LOADING: ['GARAGE'],
  GARAGE: ['PLAYING'],
  PLAYING: ['PAUSED', 'GAMEOVER'],
  PAUSED: ['PLAYING', 'GARAGE', 'GAMEOVER'],
  GAMEOVER: ['GARAGE', 'PLAYING'],
};

export function canTransition(from: GameState, to: GameState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Validates a state transition against {@link TRANSITIONS}.
 *
 * Contract: an invalid transition is a programmer error, not a runtime condition to
 * degrade gracefully around — so in dev (`import.meta.env.DEV`) it throws, loudly and
 * immediately, at the call site. In prod it must never crash a live run over a state
 * bug, so it downgrades to `console.warn` and no-ops (the caller is expected to check
 * the return path / leave state untouched — see store.ts's `transition` action).
 */
export function assertTransition(from: GameState, to: GameState): void {
  if (canTransition(from, to)) return;

  const message = `Invalid game state transition: ${from} -> ${to}`;
  if (import.meta.env.DEV) {
    throw new Error(message);
  }
  console.warn(message);
}
