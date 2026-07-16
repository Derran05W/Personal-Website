import GameCanvas from '../GameCanvas';
import './Home.css';

export default function Home() {
  return (
    <div className="home">
      {/* Fixed, full-viewport, z-index 0 — sits behind the hero. Renders nothing yet
          (src/game/index.tsx is a Phase 2 stub), so the gradient below is what's
          actually visible for now. */}
      <GameCanvas />

      <section className="home__hero">
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
