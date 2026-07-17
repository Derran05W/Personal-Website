import { lazy, Suspense } from 'react';
import GameErrorBoundary from './GameErrorBoundary';
import './GameCanvas.css';

// The lazy-loading seam: this is the ONLY module under src/app/ that imports from
// src/game/. Everything else in src/app/ stays game-agnostic so the shell chunk never
// pulls in game code — Vite/Rollup code-splits this dynamic import into its own chunk,
// which is the core acceptance criterion for this phase (verified via `pnpm build`
// output). Phase 2 replaces src/game/index.tsx's contents with the real <Canvas> +
// providers; this wrapper and its container styling shouldn't need to change then.
const Game = lazy(() => import('../game'));

export default function GameCanvas() {
  // role="region" (NOT "img" — Phase 20 QA FILED-2): role="img" prunes descendants from
  // the accessibility tree, which hid the garage/pause/game-over CONTROLS from assistive
  // tech. The region exposes them; the visual canvas itself carries the img role + label
  // (set in game/index.tsx's onCreated on the real <canvas>).
  return (
    <div className="game-canvas-container" role="region" aria-label="3D driving game">
      {/* GameErrorBoundary (Phase 20 Task 2) sits OUTSIDE the Suspense boundary so it
          also catches a rejected `import()` — React.lazy re-throws that rejection
          synchronously on the next render of the thing it wraps, which happens inside
          this Suspense's subtree, not inside GameErrorBoundary's own render. Site must
          never white-page (TDD §9/§15) even if the game chunk fails to fetch or boot. */}
      <GameErrorBoundary>
        {/* Shell-side fallback covers the chunk fetch itself (a dynamic import has no
            progress events, so the bar is indeterminate). Asset-level progress (drei
            useProgress, TDD §4.3) renders inside the game chunk once it's mounted.
            This fallback must stay free of game imports — it ships in the shell chunk. */}
        <Suspense
          fallback={
            <div className="game-loading" role="status" data-testid="game-chunk-loading">
              <span className="visually-hidden">Loading game…</span>
              <div className="game-loading__bar" aria-hidden="true" />
            </div>
          }
        >
          <Game />
        </Suspense>
      </GameErrorBoundary>
    </div>
  );
}
