// DOM overlay for context loss (Phase 18 Task 3). Owns its own visibility — same contract
// as Hud.tsx/GameOver.tsx/GarageOverlay.tsx (null unless there's something to show) — so
// the orchestrator can mount it unconditionally as a sibling of <Canvas>, same DOM layer as
// Hud/GameOver/Minimap. Reads core/contextLoss.ts's store-free flag via useSyncExternalStore
// (same subscribe/getSnapshot shape GameOver.tsx already uses for its own module-scope
// state), so this component needs no zustand subscription of its own.
//
// `pointerEvents: 'none'` matches Hud.tsx/GameOver.tsx's belt-and-suspenders reasoning: the
// site header must never be occludable by a full-screen overlay regardless of stacking
// context. Actual restoration is entirely browser/GPU-driven (the `webglcontextrestored`
// event, handled in contextLoss.ts) — there's nothing for a tap to trigger — so this stays
// informational text, not a button; the task's copy ("tap to restore") describes what the
// user does physically (return to the tab / wait for the GPU), not a click handler here.
import { useSyncExternalStore, type CSSProperties } from 'react';
import { isContextLost, subscribeContextLost } from '../core/contextLoss';

const backdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 30,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(5, 7, 15, 0.75)',
  pointerEvents: 'none',
};

const chipStyle: CSSProperties = {
  background: 'rgba(10, 14, 22, 0.7)',
  border: '1px solid rgba(245, 158, 11, 0.4)',
  borderRadius: 8,
  padding: '0.9rem 1.5rem',
  color: '#f5f5f5',
  fontFamily: 'var(--font-display)',
  fontWeight: 600,
  fontSize: 'clamp(1rem, 2.5vw, 1.25rem)',
  textAlign: 'center',
  textShadow: '0 2px 12px rgba(0, 0, 0, 0.6)',
};

export default function ContextLossOverlay() {
  const lost = useSyncExternalStore(subscribeContextLost, isContextLost);
  if (!lost) return null;

  return (
    <div
      style={backdropStyle}
      role="status"
      aria-live="assertive"
      data-testid="context-loss-overlay"
    >
      <span style={chipStyle}>Graphics context lost — tap to restore</span>
    </div>
  );
}
