import { lazy, Suspense } from 'react';
import './GameCanvas.css';

// The lazy-loading seam: this is the ONLY module under src/app/ that imports from
// src/game/. Everything else in src/app/ stays game-agnostic so the shell chunk never
// pulls in game code — Vite/Rollup code-splits this dynamic import into its own chunk,
// which is the core acceptance criterion for this phase (verified via `pnpm build`
// output). Phase 2 replaces src/game/index.tsx's contents with the real <Canvas> +
// providers; this wrapper and its container styling shouldn't need to change then.
const Game = lazy(() => import('../game'));

export default function GameCanvas() {
  return (
    <div className="game-canvas-container" role="img" aria-label="3D driving game canvas">
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
    </div>
  );
}
