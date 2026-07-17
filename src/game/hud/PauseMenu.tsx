// PAUSED-state pause menu (Phase 17 Task 4). No dedicated pause overlay existed before
// this phase — machine.ts's PAUSED state was only ever reachable via Esc/P (resume) and G
// (garage) key bindings (input/keyboard.ts), with no visible UI beyond hud/Hud.tsx's own
// score/HP chips staying on screen. This is the minimal extension the phase brief called
// for: Resume / Garage / Restart, layered into the ALREADY-mounted Hud tree (rendered by
// Hud.tsx's default export, gated on `machine === 'PAUSED'`) rather than a new top-level
// mount — game/index.tsx is out of this task's file list.
//
// The one interactive surface in the whole hud/* tree: everything else in Hud.tsx sets
// `pointerEvents: 'none'` (so the game/site-header stay click-through), but a pause menu
// necessarily needs real click targets — `pointerEvents: 'auto'` on this backdrop is a
// deliberate, scoped exception (see Hud.tsx's header comment on the pointer-events
// convention).
import type { CSSProperties } from 'react';
import { openGarage, restartRun, resumeRun } from './pauseMenuActions';
import './PauseMenu.css';

const backdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'auto',
  // Above GameOver's 25 (moot — PAUSED and GAMEOVER are mutually exclusive machine
  // states) — kept consistent with "higher-attention overlays paint higher" ordering.
  zIndex: 30,
  background: 'rgba(5, 7, 15, 0.55)',
};

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: '0.75rem',
  minWidth: 'min(280px, 80vw)',
  padding: '1.75rem',
  borderRadius: 12,
  background: 'rgba(10, 14, 22, 0.9)',
  border: '1px solid rgba(245, 158, 11, 0.35)',
  boxShadow: '0 12px 48px rgba(0, 0, 0, 0.5)',
  textAlign: 'center',
  color: '#f5f5f5',
};

const titleStyle: CSSProperties = {
  display: 'block',
  margin: '0 0 0.25rem',
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontSize: 'clamp(1.5rem, 4vw, 2rem)',
  letterSpacing: '0.04em',
};

const btnBaseStyle: CSSProperties = {
  padding: '0.65rem 1.25rem',
  borderRadius: 8,
  border: 'none',
  font: 'inherit',
  fontSize: '1rem',
  fontWeight: 600,
  cursor: 'pointer',
};

const primaryBtnStyle: CSSProperties = {
  ...btnBaseStyle,
  background: 'rgba(245, 158, 11, 0.92)',
  color: '#1a1206',
};

const secondaryBtnStyle: CSSProperties = {
  ...btnBaseStyle,
  background: 'rgba(255, 255, 255, 0.08)',
  color: '#f5f5f5',
};

const hintStyle: CSSProperties = {
  display: 'block',
  marginTop: '0.25rem',
  fontSize: '0.8rem',
  color: 'rgba(245, 245, 245, 0.6)',
};

export function PauseMenu() {
  return (
    <div
      className="pause-menu-backdrop"
      style={backdropStyle}
      data-testid="pause-menu"
      role="dialog"
      aria-modal="true"
      aria-label="Paused"
    >
      <div className="pause-menu-panel" style={panelStyle}>
        <span style={titleStyle}>Paused</span>
        <button
          type="button"
          style={primaryBtnStyle}
          onClick={resumeRun}
          autoFocus
          data-testid="pause-resume"
        >
          Resume
        </button>
        <button type="button" style={secondaryBtnStyle} onClick={openGarage} data-testid="pause-garage">
          Garage
        </button>
        <button type="button" style={secondaryBtnStyle} onClick={restartRun} data-testid="pause-restart">
          Restart
        </button>
        <span style={hintStyle}>Esc / P resume · G garage</span>
      </div>
    </div>
  );
}
