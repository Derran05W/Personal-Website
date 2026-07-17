import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGameStore } from '../../state/store';
import { __resetTouchInputForTests, getTouchDrivingInput } from '../../input/touch';
import { TouchControls } from './TouchControls';

const initialState = useGameStore.getState();

function stubCoarsePointer(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) satisfies MediaQueryList,
  );
}

beforeEach(() => {
  useGameStore.setState(initialState, true);
  __resetTouchInputForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetTouchInputForTests();
});

describe('TouchControls — render gating', () => {
  it('renders nothing on a fine-pointer device even while PLAYING', () => {
    stubCoarsePointer(false);
    useGameStore.setState({ machine: 'PLAYING' });
    render(<TouchControls />);
    expect(screen.queryByTestId('touch-controls')).not.toBeInTheDocument();
  });

  it('renders nothing when matchMedia is unavailable (degrades to fine-pointer)', () => {
    vi.stubGlobal('matchMedia', undefined);
    useGameStore.setState({ machine: 'PLAYING' });
    render(<TouchControls />);
    expect(screen.queryByTestId('touch-controls')).not.toBeInTheDocument();
  });

  it('renders nothing on a coarse-pointer device outside PLAYING (e.g. PAUSED)', () => {
    stubCoarsePointer(true);
    useGameStore.setState({ machine: 'PAUSED' });
    render(<TouchControls />);
    expect(screen.queryByTestId('touch-controls')).not.toBeInTheDocument();
  });

  it('renders nothing on a coarse-pointer device outside PLAYING (e.g. GARAGE)', () => {
    stubCoarsePointer(true);
    useGameStore.setState({ machine: 'GARAGE' });
    render(<TouchControls />);
    expect(screen.queryByTestId('touch-controls')).not.toBeInTheDocument();
  });

  it('renders the full control set on a coarse-pointer device while PLAYING', () => {
    stubCoarsePointer(true);
    useGameStore.setState({ machine: 'PLAYING' });
    render(<TouchControls />);
    expect(screen.getByTestId('touch-controls')).toBeInTheDocument();
    expect(screen.getByTestId('touch-steer-left')).toBeInTheDocument();
    expect(screen.getByTestId('touch-steer-right')).toBeInTheDocument();
    expect(screen.getByTestId('touch-brake')).toBeInTheDocument();
    expect(screen.getByTestId('touch-pause')).toBeInTheDocument();
  });

  it('hides itself again once the machine leaves PLAYING (e.g. pause)', () => {
    stubCoarsePointer(true);
    useGameStore.setState({ machine: 'PLAYING' });
    render(<TouchControls />);
    expect(screen.getByTestId('touch-controls')).toBeInTheDocument();

    act(() => {
      useGameStore.setState({ machine: 'PAUSED' });
    });
    expect(screen.queryByTestId('touch-controls')).not.toBeInTheDocument();
  });
});

describe('TouchControls — pointer interaction feeds input/touch.ts', () => {
  beforeEach(() => {
    stubCoarsePointer(true);
    useGameStore.setState({ machine: 'PLAYING' });
  });

  it('pressing steer-left drives DrivingInput.steer to -1 and back to 0 on release', () => {
    render(<TouchControls />);
    expect(getTouchDrivingInput()).toBeNull(); // touch mode not active until first press

    fireEvent.pointerDown(screen.getByTestId('touch-steer-left'), { pointerId: 1 });
    expect(getTouchDrivingInput()?.steer).toBe(-1);
    expect(getTouchDrivingInput()?.throttle).toBe(1);

    fireEvent.pointerUp(screen.getByTestId('touch-steer-left'), { pointerId: 1 });
    expect(getTouchDrivingInput()?.steer).toBe(0);
  });

  it('pressing steer-right drives DrivingInput.steer to 1', () => {
    render(<TouchControls />);
    fireEvent.pointerDown(screen.getByTestId('touch-steer-right'), { pointerId: 1 });
    expect(getTouchDrivingInput()?.steer).toBe(1);
  });

  it('holding brake zeroes auto-throttle', () => {
    render(<TouchControls />);
    fireEvent.pointerDown(screen.getByTestId('touch-brake'), { pointerId: 2 });
    expect(getTouchDrivingInput()).toEqual({ steer: 0, throttle: 0, brake: 1, handbrake: false });

    fireEvent.pointerUp(screen.getByTestId('touch-brake'), { pointerId: 2 });
    expect(getTouchDrivingInput()?.throttle).toBe(1);
  });

  it('steer + brake concurrently via two different pointers (multi-touch)', () => {
    render(<TouchControls />);
    fireEvent.pointerDown(screen.getByTestId('touch-steer-right'), { pointerId: 1 });
    fireEvent.pointerDown(screen.getByTestId('touch-brake'), { pointerId: 2 });
    expect(getTouchDrivingInput()).toEqual({ steer: 1, throttle: 0, brake: 1, handbrake: false });
  });

  it('pointercancel on steer-right releases it, same as pointerup', () => {
    render(<TouchControls />);
    fireEvent.pointerDown(screen.getByTestId('touch-steer-right'), { pointerId: 3 });
    expect(getTouchDrivingInput()?.steer).toBe(1);

    fireEvent.pointerCancel(screen.getByTestId('touch-steer-right'), { pointerId: 3 });
    expect(getTouchDrivingInput()?.steer).toBe(0);
  });

  it('tapping pause transitions PLAYING -> PAUSED', () => {
    render(<TouchControls />);
    fireEvent.pointerDown(screen.getByTestId('touch-pause'), { pointerId: 9 });
    expect(useGameStore.getState().machine).toBe('PAUSED');
  });
});
