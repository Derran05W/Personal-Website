import type { ReactNode } from 'react';
import './SkylineHero.css';

interface SkylineHeroProps {
  heading: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Shared full-viewport "blue hour skyline" page treatment. Presentational only — no
 * game imports, no route-specific behavior — so it's safe to reuse from both a plain
 * route (NotFound.tsx) and a component mounted deep inside the game's lazy seam
 * (GameBootFallback.tsx, rendered by GameErrorBoundary). See SkylineHero.css for why
 * this doesn't just reuse Home.css's `.home__hero`. */
export default function SkylineHero({ heading, children, className }: SkylineHeroProps) {
  const sectionClassName = className ? `skyline-hero ${className}` : 'skyline-hero';
  return (
    <section className={sectionClassName}>
      <div className="skyline-hero__skyline" aria-hidden="true" />
      <div className="skyline-hero__content">
        <h1 className="skyline-hero__heading">{heading}</h1>
        {children}
      </div>
    </section>
  );
}
