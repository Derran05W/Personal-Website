// Context-loss handling (Phase 18 Task 3). TDD §15: "WebGL context loss / no WebGL2 ->
// Context-restore handler; static hero fallback." The no-WebGL2 half lives in the shell
// (src/app/webgl.ts); this is the OTHER half — a context that existed and then died mid-
// session (GPU driver reset, tab backgrounding on some mobile browsers, etc.).
//
// Deliberately store-free: the task calls for "a store-free module flag," not a zustand
// field, so a context-loss blip can never trip the store's dev-mode invalid-transition
// throw or get entangled with persistence. This module owns:
//   1. the flag itself (subscribable via useSyncExternalStore from the DOM overlay), and
//   2. the actual DOM wiring (webglcontextlost/webglcontextrestored), factored as a pure
//      `(canvas) -> cleanup` function so it's fully unit-testable without an R3F tree —
//      ContextLossMount.tsx's only job is handing this the real <canvas> element.
import { getGameState } from '../state/store';
import { canTransition } from '../state/machine';

export type ContextLossListener = (lost: boolean) => void;

let lost = false;
const listeners = new Set<ContextLossListener>();

export function isContextLost(): boolean {
  return lost;
}

function setContextLost(next: boolean): void {
  if (lost === next) return;
  lost = next;
  for (const listener of listeners) listener(lost);
}

/** For useSyncExternalStore (ContextLossOverlay.tsx). */
export function subscribeContextLost(listener: ContextLossListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test-only: resets the module-scope flag/listener set between tests. Never called from
 * production code. */
export function __resetContextLossForTests(): void {
  lost = false;
  listeners.clear();
}

/**
 * Wires `webglcontextlost` / `webglcontextrestored` on `canvas`. Returns a cleanup
 * function that removes both listeners (React effect return contract).
 *
 * - `webglcontextlost`: `event.preventDefault()` is the spec-required signal that this
 *   page WANTS the context restored later rather than left permanently dead. Sets the
 *   module flag, then asks to move `PLAYING -> PAUSED` — gated through `canTransition`
 *   (the store's own documented guard) so a loss while GARAGE/GAMEOVER/etc. is a correct
 *   no-op instead of an invalid-transition warning; only an in-progress run actually
 *   pauses.
 * - `webglcontextrestored`: clears the flag. Deliberately does NOT auto-resume — the
 *   product call (task brief) is "the player resumes via the pause menu," so machine
 *   state is left exactly where the loss put it.
 */
export function attachContextLossListeners(canvas: HTMLCanvasElement): () => void {
  function handleContextLost(event: Event): void {
    event.preventDefault();
    setContextLost(true);
    const state = getGameState();
    if (canTransition(state.machine, 'PAUSED')) {
      state.transition('PAUSED');
    }
  }

  function handleContextRestored(): void {
    setContextLost(false);
  }

  canvas.addEventListener('webglcontextlost', handleContextLost, false);
  canvas.addEventListener('webglcontextrestored', handleContextRestored, false);

  return () => {
    canvas.removeEventListener('webglcontextlost', handleContextLost, false);
    canvas.removeEventListener('webglcontextrestored', handleContextRestored, false);
  };
}
