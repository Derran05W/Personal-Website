// GARAGE start overlay. Rendered by index.tsx only while machine === 'GARAGE': the whole
// overlay IS the click target (a single full-bleed <button>, not a small button floating
// on a backdrop), so "click anywhere to start" is literally true. Enter-key support comes
// free from the button being a real, autoFocused <button> (native keyboard activation) —
// no global key listener needed, and it doesn't fight input/keyboard.ts's state-scoped
// keymap (GARAGE has no driving/pause keys bound).
import type { CSSProperties } from 'react';
import { getGameState } from './state/store';
import { canTransition } from './state/machine';
import './GarageOverlay.css';

const overlayStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.75rem',
  padding: '1.5rem',
  border: 'none',
  background: 'rgba(5, 7, 15, 0.45)',
  color: '#f5f5f5',
  font: 'inherit',
  cursor: 'pointer',
  textAlign: 'center',
};

// <span display:block> rather than <p>/<div>: guaranteed-valid phrasing content inside
// a <button> under every HTML content model, old and new alike — no need to rely on the
// newer flow-content-in-button relaxation.
const titleStyle: CSSProperties = {
  display: 'block',
  margin: 0,
  fontSize: 'clamp(1.75rem, 5vw, 2.75rem)',
  fontWeight: 700,
  letterSpacing: '0.02em',
  textShadow: '0 2px 20px rgba(0, 0, 0, 0.6)',
};

const ctaStyle: CSSProperties = {
  display: 'block',
  margin: 0,
  padding: '0.6rem 1.4rem',
  borderRadius: '999px',
  background: 'rgba(245, 158, 11, 0.9)',
  color: '#1a1206',
  fontSize: 'clamp(0.95rem, 2vw, 1.1rem)',
  fontWeight: 600,
};

const hintStyle: CSSProperties = {
  display: 'block',
  margin: 0,
  fontSize: '0.85rem',
  color: 'rgba(245, 245, 245, 0.75)',
};

function handleStart(): void {
  // Guard against StrictMode's double-invoked effects / a double-fired click both
  // landing here after the machine has already moved on — canTransition makes the
  // repeat a no-op instead of hitting the store's dev-mode invalid-transition throw.
  const state = getGameState();
  if (canTransition(state.machine, 'PLAYING')) state.transition('PLAYING');
}

export function GarageOverlay() {
  return (
    <button
      type="button"
      className="garage-overlay"
      onClick={handleStart}
      autoFocus
      style={overlayStyle}
      data-testid="garage-start-overlay"
    >
      <span style={titleStyle}>Ready to drive</span>
      <span style={ctaStyle}>Click or press Enter to start driving</span>
      <span style={hintStyle}>WASD / arrows drive · Space handbrake · Esc pause</span>
    </button>
  );
}
