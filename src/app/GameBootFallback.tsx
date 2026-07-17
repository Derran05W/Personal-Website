import SkylineHero from './SkylineHero';
import './GameBootFallback.css';

/** Rendered by GameErrorBoundary when the lazy game chunk fails to boot (chunk-fetch
 * rejection, or a synchronous throw during the game's own render/mount — e.g. a WebGL
 * context that can't be created, or a Rapier/WASM init failure surfaced via
 * suspend-react's Suspense-integrated throw). Deliberately self-contained: it renders
 * its own full "skyline hero," matching Home.tsx's WebGL-unsupported fallback in
 * spirit (TDD §9/§15's "static hero fallback"), rather than assuming Home's own hero
 * is still visible — this must work even if the crash happens after Home's hero has
 * already faded out post-`smashy:game-ready`. */
export default function GameBootFallback() {
  return (
    <SkylineHero heading="Smashy the 6ix" className="game-boot-fallback">
      <p className="game-boot-fallback__message" data-testid="game-boot-fallback">
        The 3D game couldn&rsquo;t start on this browser — the portfolio and résumé links
        in the header above still work fine.
      </p>
    </SkylineHero>
  );
}
