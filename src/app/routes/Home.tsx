import { useEffect, useState } from 'react';
import GameCanvas from '../GameCanvas';
import './Home.css';

// Plain window CustomEvent, not a game import: src/app/ may only reach src/game/ through
// the lazy seam in GameCanvas.tsx. game/index.tsx dispatches this once its state machine
// reaches GARAGE (see its bootstrap effect) — the shell listens via DOM APIs only.
const GAME_READY_EVENT = 'smashy:game-ready';

export default function Home() {
  // Fades the hero out once the game signals it's ready to drive (see effect below).
  const [gameLive, setGameLive] = useState(false);

  useEffect(() => {
    const handleGameReady = () => setGameLive(true);
    window.addEventListener(GAME_READY_EVENT, handleGameReady);
    return () => window.removeEventListener(GAME_READY_EVENT, handleGameReady);
  }, []);

  return (
    <div className="home">
      {/* Fixed, full-viewport, z-index 0 — sits behind the hero. Renders the Phase 3 test
          scene once its chunk loads; the hero above fades out (className toggle below)
          once game/index.tsx reports it has reached GARAGE. */}
      <GameCanvas />

      <section
        className={gameLive ? 'home__hero home__hero--hidden' : 'home__hero'}
        aria-hidden={gameLive}
      >
        <div className="home__skyline" aria-hidden="true" />
        <div className="home__hero-content">
          <h1 className="home__title">Smashy the 6ix</h1>
          <p className="home__tagline">
            A low-poly 3D driving game is coming to this page. Until then, the header
            above links to the portfolio and résumé.
          </p>
        </div>
      </section>
    </div>
  );
}
