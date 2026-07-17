import { lazy, Suspense } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GameErrorBoundary from './GameErrorBoundary';

function ThrowingComponent(): never {
  throw new Error('boot: WebGL context could not be created');
}

function Working() {
  return <div data-testid="working-child">ok</div>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GameErrorBoundary', () => {
  it('renders children normally when nothing throws', () => {
    render(
      <GameErrorBoundary>
        <Working />
      </GameErrorBoundary>,
    );
    expect(screen.getByTestId('working-child')).toBeInTheDocument();
    expect(screen.queryByTestId('game-boot-fallback')).not.toBeInTheDocument();
  });

  it('catches a synchronous render throw (a Physics/GL boot failure class) and shows the fallback', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <GameErrorBoundary>
        <ThrowingComponent />
      </GameErrorBoundary>,
    );

    expect(screen.getByTestId('game-boot-fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('working-child')).not.toBeInTheDocument();
  });

  it('never lets the boot failure take out the rest of the tree — no white page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <div data-testid="site-chrome">
        <header data-testid="fake-header">header</header>
        <GameErrorBoundary>
          <ThrowingComponent />
        </GameErrorBoundary>
      </div>,
    );

    // The boundary is scoped to the game mount only — everything outside it (header,
    // etc.) must still be in the DOM.
    expect(screen.getByTestId('fake-header')).toBeInTheDocument();
    expect(screen.getByTestId('game-boot-fallback')).toBeInTheDocument();
  });

  it('catches a React.lazy chunk-load rejection (async wasm/chunk fetch failure) and shows the fallback', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const LazyBroken = lazy(() =>
      Promise.reject(new Error('Failed to fetch dynamically imported module')),
    );

    render(
      <GameErrorBoundary>
        <Suspense fallback={<div data-testid="loading">loading</div>}>
          <LazyBroken />
        </Suspense>
      </GameErrorBoundary>,
    );

    // A dynamic import always settles asynchronously, even on an immediate rejection —
    // Suspense's fallback shows first, then the boundary takes over once React re-renders
    // with the rejection reason thrown.
    expect(screen.getByTestId('loading')).toBeInTheDocument();
    expect(await screen.findByTestId('game-boot-fallback')).toBeInTheDocument();
  });
});
