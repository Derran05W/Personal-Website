import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// This file exercises GameCanvas.tsx's REAL composition (GameErrorBoundary wrapping
// Suspense wrapping `lazy(() => import('../game'))`) rather than re-testing the
// boundary mechanism in the abstract (see GameErrorBoundary.test.tsx for that) — the
// point here is proving the actual wiring in GameCanvas.tsx works, not just that error
// boundaries work in general. `../game` (the ~2-3 MB three.js/Rapier chunk) is mocked
// so this stays a fast, real-DOM-backend-free shell test; vi.resetModules() + a fresh
// `await import('./GameCanvas')` per test is required because `lazy()` caches its
// promise at module-eval time, so a stale import would carry over a previous test's
// resolved/rejected state.
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('GameCanvas — normal path', () => {
  it('mounts the game once its chunk resolves', async () => {
    vi.doMock('../game', () => ({
      default: () => <div data-testid="mock-game" />,
    }));

    const { default: GameCanvas } = await import('./GameCanvas');
    render(<GameCanvas />);

    expect(await screen.findByTestId('mock-game')).toBeInTheDocument();
    expect(screen.queryByTestId('game-boot-fallback')).not.toBeInTheDocument();
  });
});

describe('GameCanvas — boot failure (site must never white-page)', () => {
  it('shows the friendly fallback when the game chunk throws synchronously on mount (Physics/GL boot throw class)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.doMock('../game', () => ({
      default: () => {
        throw new Error('WebGL context could not be created');
      },
    }));

    const { default: GameCanvas } = await import('./GameCanvas');
    render(<GameCanvas />);

    expect(await screen.findByTestId('game-boot-fallback')).toHaveTextContent(
      /couldn.t start on this browser/,
    );
    expect(screen.queryByTestId('mock-game')).not.toBeInTheDocument();
  });

  it('shows the friendly fallback when the lazy import itself rejects (chunk fetch failure class)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.doMock('../game', () => {
      throw new Error('Failed to fetch dynamically imported module: ../game');
    });

    const { default: GameCanvas } = await import('./GameCanvas');
    render(<GameCanvas />);

    expect(await screen.findByTestId('game-boot-fallback')).toBeInTheDocument();
  });
});
