// Plain action functions for hud/PauseMenu.tsx's three buttons. Split out of the
// component file for the same react-refresh only-export-components reason as every other
// hud/* format/action module (gameOverFormat.ts, gameOverRunEnd.ts, garage/garageFormat.ts).
import { gameEvents } from '../state/events';
import { canTransition } from '../state/machine';
import { getGameState } from '../state/store';

/** PAUSED -> PLAYING. A guarded no-op outside PAUSED (double-click / stray keypress race). */
export function resumeRun(): void {
  const state = getGameState();
  if (canTransition(state.machine, 'PLAYING')) state.transition('PLAYING');
}

/** PAUSED -> GARAGE — the pause menu's "Garage" option (machine.ts's documented edge). */
export function openGarage(): void {
  const state = getGameState();
  if (canTransition(state.machine, 'GARAGE')) state.transition('GARAGE');
}

/**
 * "Restart": abort the current run (PAUSED -> GAMEOVER, machine.ts's documented "abort
 * run from pause" edge) with `reason: 'quit'` — folding the partial run's score into
 * lifetimeScore/unlocks exactly like any other run ending (state/persistence.ts's
 * `runEnded` subscriber) — then IMMEDIATELY retries (GAMEOVER -> PLAYING). That second
 * transition is the exact edge combat/runLoop.ts's `handleMachineChange` already treats as
 * "retry same seed": ITS OWN store subscription calls `runReset()` + `beginRun()` in
 * response, unmodified — this function never reaches into runLoop directly.
 *
 * Both transitions run synchronously inside one click handler, so React 18+'s automatic
 * event-handler batching coalesces them into a single re-render that lands directly on
 * 'PLAYING': hud/GameOver.tsx (gated on `machine === 'GAMEOVER'`) never actually paints,
 * and game/index.tsx's `<Physics paused={machine !== 'PLAYING'}>` never sees an
 * intermediate unpaused-then-paused flicker either — from the player's perspective this
 * reads as an instant restart, not a trip through the game-over screen.
 *
 * A guarded no-op outside PAUSED.
 */
export function restartRun(): void {
  const state = getGameState();
  if (!canTransition(state.machine, 'GAMEOVER')) return;
  const score = state.score;
  state.transition('GAMEOVER');
  gameEvents.emit('runEnded', { score, reason: 'quit' });
  const afterAbort = getGameState();
  if (canTransition(afterAbort.machine, 'PLAYING')) {
    afterAbort.transition('PLAYING');
  }
}
