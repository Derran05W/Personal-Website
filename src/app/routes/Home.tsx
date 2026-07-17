import { useEffect, useState } from 'react';
import GameCanvas from '../GameCanvas';
import { detectWebGL2 } from '../webgl';
import { readDeviceCapabilities } from '../deviceCapabilities';
import { resolveGameGate } from '../gameGate';
import './Home.css';

// Plain window CustomEvent, not a game import: src/app/ may only reach src/game/ through
// the lazy seam in GameCanvas.tsx. game/index.tsx dispatches this once its state machine
// reaches GARAGE (see its bootstrap effect) — the shell listens via DOM APIs only.
const GAME_READY_EVENT = 'smashy:game-ready';

export default function Home() {
  // Fades the hero out once the game signals it's ready to drive (see effect below).
  const [gameLive, setGameLive] = useState(false);

  // Graceful-degradation gate (Phase 18 Task 3, TDD §9/§15): computed once, synchronously,
  // on first render — support/pointer/motion-preference can't change mid-session in a way
  // this gate needs to react to (see gameGate.ts's doc comment). Lazy initializers keep
  // the (cheap but real) canvas probe + matchMedia reads out of every re-render.
  const [gate] = useState(() =>
    resolveGameGate({
      webgl2Available: detectWebGL2(),
      ...readDeviceCapabilities(),
    }),
  );
  // 'auto-start' mounts the game chunk immediately, matching the pre-Phase-18 behavior
  // exactly. 'play-card' and 'unsupported' both start false: the former flips to true on
  // an explicit tap (below), the latter never flips — GameCanvas must never mount without
  // WebGL2, no matter what else happens on the page.
  const [started, setStarted] = useState(() => gate === 'auto-start');

  useEffect(() => {
    if (!started) return undefined;
    const handleGameReady = () => setGameLive(true);
    window.addEventListener(GAME_READY_EVENT, handleGameReady);
    return () => window.removeEventListener(GAME_READY_EVENT, handleGameReady);
  }, [started]);

  const showPlayCard = gate === 'play-card' && !started;

  return (
    <div className="home">
      {/* Fixed, full-viewport, z-index 0 — sits behind the hero. Renders the Phase 3 test
          scene once its chunk loads; the hero above fades out (className toggle below)
          once game/index.tsx reports it has reached GARAGE. Withheld entirely until
          `started` flips true, so a coarse-pointer/reduced-motion/no-WebGL2 visitor never
          triggers the ~2-3 MB game chunk fetch. */}
      {started ? <GameCanvas /> : null}

      <section
        className={gameLive ? 'home__hero home__hero--hidden' : 'home__hero'}
        aria-hidden={gameLive}
      >
        <div className="home__skyline" aria-hidden="true" />
        <div className="home__hero-content">
          <h1 className="home__title">Smashy the 6ix</h1>
          {gate === 'unsupported' ? (
            <p className="home__tagline" data-testid="home-webgl-fallback">
              This browser can't run the 3D game — the portfolio lives above.
            </p>
          ) : (
            <p className="home__tagline">
              A low-poly 3D driving game is coming to this page. Until then, the header
              above links to the portfolio and résumé.
            </p>
          )}
          {showPlayCard ? (
            <button
              type="button"
              className="home__play-btn"
              onClick={() => setStarted(true)}
              data-testid="home-play-card"
            >
              <span aria-hidden="true">▶</span> Play
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
