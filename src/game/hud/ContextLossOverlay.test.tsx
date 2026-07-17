import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ContextLossOverlay from './ContextLossOverlay';
import { __resetContextLossForTests, attachContextLossListeners } from '../core/contextLoss';

// Exercises the overlay's OWN rendering contract (visible iff core/contextLoss.ts's flag
// is true) against the real pure state module — contextLoss.test.ts already covers the
// module's transition/listener guarantees in isolation, so this stays focused on "does the
// component read that flag correctly and re-render on change."
describe('ContextLossOverlay', () => {
  beforeEach(() => {
    __resetContextLossForTests();
  });

  afterEach(() => {
    __resetContextLossForTests();
  });

  it('renders nothing while the context is not lost', () => {
    render(<ContextLossOverlay />);
    expect(screen.queryByTestId('context-loss-overlay')).not.toBeInTheDocument();
  });

  it('shows the overlay once the context is lost, and hides it again once restored', () => {
    const canvas = document.createElement('canvas');
    const cleanup = attachContextLossListeners(canvas);
    render(<ContextLossOverlay />);

    act(() => {
      canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    });
    expect(screen.getByTestId('context-loss-overlay')).toHaveTextContent(
      'Graphics context lost — tap to restore',
    );

    act(() => {
      canvas.dispatchEvent(new Event('webglcontextrestored', { cancelable: true }));
    });
    expect(screen.queryByTestId('context-loss-overlay')).not.toBeInTheDocument();

    cleanup();
  });
});
