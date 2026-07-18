import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGameStore } from '../state/store';
import { gameEvents } from '../state/events';
import { TUNNEL_OVERLAY, LINE_1_STATIONS_SOUTHBOUND } from '../config/tunnel';
import TunnelOverlay from './TunnelOverlay';

const initialState = useGameStore.getState();

beforeEach(() => {
  useGameStore.setState(initialState, true);
});

afterEach(() => {
  gameEvents.clearAllListeners();
  vi.useRealTimers();
});

function stationNames(): (string | null)[] {
  return Array.from(
    screen.getByTestId('tunnel-overlay-stations').querySelectorAll('li'),
  ).map((li) => li.textContent);
}

describe('TunnelOverlay — mount contract', () => {
  it('renders null until a tunnelTransit event arrives', () => {
    render(<TunnelOverlay />);
    expect(screen.queryByTestId('tunnel-overlay')).not.toBeInTheDocument();
  });

  it('renders the overlay on tunnelTransit, aria-hidden and inert to pointer events', () => {
    render(<TunnelOverlay />);

    act(() => {
      gameEvents.emit('tunnelTransit', { direction: 'northbound' });
    });

    const overlay = screen.getByTestId('tunnel-overlay');
    expect(overlay).toHaveAttribute('aria-hidden', 'true');
    expect(overlay).toHaveClass('tunnel-overlay--active');
  });
});

describe('TunnelOverlay — station order per direction', () => {
  it('southbound shows the spec §2 list in its given (Sheppard -> Bloor) order', () => {
    render(<TunnelOverlay />);

    act(() => {
      gameEvents.emit('tunnelTransit', { direction: 'southbound' });
    });

    expect(stationNames()).toEqual([...LINE_1_STATIONS_SOUTHBOUND]);
  });

  it('northbound shows the list reversed (Bloor -> Sheppard)', () => {
    render(<TunnelOverlay />);

    act(() => {
      gameEvents.emit('tunnelTransit', { direction: 'northbound' });
    });

    expect(stationNames()).toEqual([...LINE_1_STATIONS_SOUTHBOUND].reverse());
  });

  it('exposes the fired direction on the root element', () => {
    render(<TunnelOverlay />);

    act(() => {
      gameEvents.emit('tunnelTransit', { direction: 'southbound' });
    });

    expect(screen.getByTestId('tunnel-overlay')).toHaveAttribute('data-direction', 'southbound');
  });
});

describe('TunnelOverlay — auto-dismiss timing', () => {
  it('starts fading (--leaving) at durationMs - fadeOutMs, and fully unmounts at durationMs', () => {
    vi.useFakeTimers();
    render(<TunnelOverlay />);

    act(() => {
      gameEvents.emit('tunnelTransit', { direction: 'northbound' });
    });
    expect(screen.getByTestId('tunnel-overlay')).toHaveClass('tunnel-overlay--active');

    act(() => {
      vi.advanceTimersByTime(TUNNEL_OVERLAY.durationMs - TUNNEL_OVERLAY.fadeOutMs - 1);
    });
    expect(screen.getByTestId('tunnel-overlay')).toHaveClass('tunnel-overlay--active');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId('tunnel-overlay')).toHaveClass('tunnel-overlay--leaving');

    act(() => {
      vi.advanceTimersByTime(TUNNEL_OVERLAY.fadeOutMs - 1);
    });
    expect(screen.getByTestId('tunnel-overlay')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByTestId('tunnel-overlay')).not.toBeInTheDocument();
  });

  it('a second tunnelTransit before the first dismisses restarts the window (clears the old timers)', () => {
    vi.useFakeTimers();
    render(<TunnelOverlay />);

    act(() => {
      gameEvents.emit('tunnelTransit', { direction: 'northbound' });
    });
    act(() => {
      vi.advanceTimersByTime(TUNNEL_OVERLAY.durationMs - 50);
    });
    expect(screen.getByTestId('tunnel-overlay')).toBeInTheDocument();

    act(() => {
      gameEvents.emit('tunnelTransit', { direction: 'southbound' }); // re-triggers mid-overlay
    });
    // Old timers must not fire and tear this down early.
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(screen.getByTestId('tunnel-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('tunnel-overlay')).toHaveAttribute('data-direction', 'southbound');
    expect(screen.getByTestId('tunnel-overlay')).toHaveClass('tunnel-overlay--active');

    act(() => {
      vi.advanceTimersByTime(TUNNEL_OVERLAY.durationMs);
    });
    expect(screen.queryByTestId('tunnel-overlay')).not.toBeInTheDocument();
  });
});

describe('TunnelOverlay — reduced motion', () => {
  it('renders the plain station list (no --static class) by default', () => {
    render(<TunnelOverlay />);

    act(() => {
      gameEvents.emit('tunnelTransit', { direction: 'northbound' });
    });

    expect(screen.getByTestId('tunnel-overlay-stations')).not.toHaveClass(
      'tunnel-overlay__stations--static',
    );
  });

  it('applies the static (no-scroll) class when settings.reducedShake is on', () => {
    useGameStore.setState((s) => ({ settings: { ...s.settings, reducedShake: true } }));
    render(<TunnelOverlay />);

    act(() => {
      gameEvents.emit('tunnelTransit', { direction: 'northbound' });
    });

    expect(screen.getByTestId('tunnel-overlay-stations')).toHaveClass(
      'tunnel-overlay__stations--static',
    );
    // Reduced motion still shows every station — same content, just no sweep.
    expect(stationNames()).toEqual([...LINE_1_STATIONS_SOUTHBOUND].reverse());
  });
});
