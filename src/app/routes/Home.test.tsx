import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Home from './Home';
import { __resetWebGL2CacheForTests } from '../webgl';

// GameCanvas.tsx is the app's one lazy seam into the ~2-3 MB game chunk (three.js,
// Rapier WASM, ...) — mounting the real thing here would drag all of that into a jsdom
// test with no real WebGL backend. Stubbing the seam keeps this a true shell-level test:
// it only proves Home.tsx's own gating decision (mount vs. withhold), not what's inside
// the game chunk.
vi.mock('../GameCanvas', () => ({
  default: () => <div data-testid="mock-game-canvas" />,
}));

function stubWebGL2(available: boolean): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    (() => (available ? {} : null)) as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
}

function stubCapabilities({
  coarsePointer = false,
  reducedMotion = false,
}: { coarsePointer?: boolean; reducedMotion?: boolean } = {}): void {
  window.matchMedia = ((query: string) => ({
    matches:
      (query === '(pointer: coarse)' && coarsePointer) ||
      (query === '(prefers-reduced-motion: reduce)' && reducedMotion),
  })) as unknown as typeof window.matchMedia;
}

function renderHome() {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Home />
    </MemoryRouter>,
  );
}

function getHeroSection(): HTMLElement {
  const hero = screen.getByText('Smashy the 6ix').closest('section');
  if (!hero) throw new Error('hero <section> not found');
  return hero as HTMLElement;
}

afterEach(() => {
  __resetWebGL2CacheForTests();
  // @ts-expect-error reverting to the unimplemented jsdom baseline
  delete window.matchMedia;
  vi.restoreAllMocks();
});

describe('Home — WebGL2 gate', () => {
  it('never mounts the game and shows the friendly fallback line when WebGL2 is unavailable', () => {
    stubWebGL2(false);
    stubCapabilities();
    renderHome();

    expect(screen.queryByTestId('mock-game-canvas')).not.toBeInTheDocument();
    expect(screen.getByTestId('home-webgl-fallback')).toHaveTextContent(
      "This browser can't run the 3D game",
    );
    // Never a Play card either — there's nothing to play.
    expect(screen.queryByTestId('home-play-card')).not.toBeInTheDocument();
  });

  it('stays unsupported even on a coarse-pointer / reduced-motion device', () => {
    stubWebGL2(false);
    stubCapabilities({ coarsePointer: true, reducedMotion: true });
    renderHome();

    expect(screen.queryByTestId('mock-game-canvas')).not.toBeInTheDocument();
    expect(screen.getByTestId('home-webgl-fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('home-play-card')).not.toBeInTheDocument();
  });

  it('leaves the static hero visible (shell intact) rather than hiding it', () => {
    stubWebGL2(false);
    stubCapabilities();
    renderHome();

    const hero = getHeroSection();
    expect(hero).not.toHaveClass('home__hero--hidden');
    expect(hero).toHaveAttribute('aria-hidden', 'false');
  });
});

describe('Home — Play-card gating matrix', () => {
  it('desktop (fine pointer, motion ok) mounts the game immediately, no Play card', () => {
    stubWebGL2(true);
    stubCapabilities({ coarsePointer: false, reducedMotion: false });
    renderHome();

    expect(screen.getByTestId('mock-game-canvas')).toBeInTheDocument();
    expect(screen.queryByTestId('home-play-card')).not.toBeInTheDocument();
  });

  it('coarse pointer (mobile) withholds the game and shows a Play card', () => {
    stubWebGL2(true);
    stubCapabilities({ coarsePointer: true, reducedMotion: false });
    renderHome();

    expect(screen.queryByTestId('mock-game-canvas')).not.toBeInTheDocument();
    expect(screen.getByTestId('home-play-card')).toBeInTheDocument();
  });

  it('prefers-reduced-motion (desktop, fine pointer) withholds the game and shows a Play card', () => {
    stubWebGL2(true);
    stubCapabilities({ coarsePointer: false, reducedMotion: true });
    renderHome();

    expect(screen.queryByTestId('mock-game-canvas')).not.toBeInTheDocument();
    expect(screen.getByTestId('home-play-card')).toBeInTheDocument();
  });

  it('coarse pointer AND reduced motion together still just withhold + show one Play card', () => {
    stubWebGL2(true);
    stubCapabilities({ coarsePointer: true, reducedMotion: true });
    renderHome();

    expect(screen.queryByTestId('mock-game-canvas')).not.toBeInTheDocument();
    expect(screen.getByTestId('home-play-card')).toBeInTheDocument();
  });

  it('tapping the Play card mounts the game and removes the card', () => {
    stubWebGL2(true);
    stubCapabilities({ coarsePointer: true });
    renderHome();

    fireEvent.click(screen.getByTestId('home-play-card'));

    expect(screen.getByTestId('mock-game-canvas')).toBeInTheDocument();
    expect(screen.queryByTestId('home-play-card')).not.toBeInTheDocument();
  });
});

describe('Home — hero reveal (smashy:game-ready)', () => {
  it('hides the hero once the game signals ready, on the desktop auto-start path', () => {
    stubWebGL2(true);
    stubCapabilities();
    renderHome();

    expect(getHeroSection()).not.toHaveClass('home__hero--hidden');

    act(() => {
      window.dispatchEvent(new CustomEvent('smashy:game-ready'));
    });

    expect(getHeroSection()).toHaveClass('home__hero--hidden');
  });

  it('hides the hero once the game signals ready, on the tap-to-start path', () => {
    stubWebGL2(true);
    stubCapabilities({ coarsePointer: true });
    renderHome();

    fireEvent.click(screen.getByTestId('home-play-card'));
    expect(getHeroSection()).not.toHaveClass('home__hero--hidden');

    act(() => {
      window.dispatchEvent(new CustomEvent('smashy:game-ready'));
    });

    expect(getHeroSection()).toHaveClass('home__hero--hidden');
  });

  it('never fires the hero reveal on WebGL2-unsupported (no listener attached, no game to signal it)', () => {
    stubWebGL2(false);
    stubCapabilities();
    renderHome();

    act(() => {
      window.dispatchEvent(new CustomEvent('smashy:game-ready'));
    });

    expect(getHeroSection()).not.toHaveClass('home__hero--hidden');
  });
});
