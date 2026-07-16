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
    <div
      className="game-canvas-container"
      role="img"
      aria-label="3D driving game canvas — not yet loaded"
    >
      {/* No real loading UI yet (nothing to show while the stub loads) — Phase 2 adds
          a drei useProgress bar per the TDD's load sequence (§4.3). */}
      <Suspense fallback={null}>
        <Game />
      </Suspense>
    </div>
  );
}
