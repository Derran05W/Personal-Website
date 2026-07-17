// Touch controls overlay (Phase 18 Task 1; TDD §5.2 "On-screen ◀ ▶ buttons, auto-throttle
// (Smashy-style)" + CLAUDE.md's locked "Mobile v1: playable-basic — ◀ ▶ + brake,
// auto-throttle, low tier"). Mounted by hud/Hud.tsx as the last real HUD layer (see that
// file's render tree) so it paints above every read-only chip; PauseMenu (also mounted by
// Hud.tsx) paints later still, but the two machine states are mutually exclusive (this
// component only renders while PLAYING, PauseMenu only while PAUSED) so there's no real
// stacking conflict either way.
//
// Layout (task brief: "generous hit targets (min 64px), plus INVISIBLE extension zones
// covering the lower screen halves left/right of center"): the whole lower-left screen
// half is ONE steer pad, split down the middle into a steerLeft zone and a steerRight
// zone (each therefore a quarter of the screen) — the visible ◀ ▶ glyph chips both sit
// together near the bottom-left corner ("big ◀ ▶ buttons bottom-left" per the brief), but
// each zone's actual pointer-accepting area extends across its whole quarter, invisibly.
// The entire lower-right screen half is the BRAKE zone the same way — one zone, its glyph
// chip anchored to the bottom-right corner. Pause is a plain small button with no
// extension zone (not called out in the brief) — top-left, below the fixed site header.
//
// Pointer events, not click (task brief): each zone is a native <button> (still
// focusable/labeled for a11y) but wired via onPointerDown/Up/Cancel, with per-pointer
// bookkeeping delegated to input/touch.ts — see that module for why (multi-touch
// correctness: steer + brake concurrently, out-of-order release, pointercancel).
import { useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useGameStore } from '../../state/store';
import {
  isCoarsePointer,
  tapPause,
  touchPointerCancel,
  touchPointerDown,
  touchPointerUp,
  type TouchRole,
} from '../../input/touch';
import './TouchControls.css';

const rootStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'none',
};

// Lower-left screen half (task brief): one flex row split into two equal quarters, each a
// full-height steer zone. `bottom: 0` + `height: 50%` (not a computed vertical center)
// keeps this simple and exact regardless of safe-area insets — each zone pads its own
// visible glyph chip inward from its own corner instead (see chipStyle below).
const steerPadStyle: CSSProperties = {
  position: 'fixed',
  left: 0,
  bottom: 0,
  width: '50%',
  height: '50%',
  display: 'flex',
  pointerEvents: 'none',
};

const steerZoneStyle: CSSProperties = {
  flex: 1,
  height: '100%',
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'flex-start',
  pointerEvents: 'auto',
};

// Lower-right screen half (task brief): a single BRAKE zone, glyph anchored bottom-right.
const brakeZoneStyle: CSSProperties = {
  position: 'fixed',
  right: 0,
  bottom: 0,
  width: '50%',
  height: '50%',
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'flex-end',
  pointerEvents: 'auto',
};

const pauseBtnStyle: CSSProperties = {
  position: 'fixed',
  // Below the fixed 64px site header + a gap — same HEADER_CLEARANCE reasoning as
  // hud/Hud.tsx's ScoreDisplay (that constant is local to Hud.tsx; duplicated here as a
  // literal rather than adding a cross-file coupling for one number).
  top: 'calc(76px + env(safe-area-inset-top))',
  left: 'calc(16px + env(safe-area-inset-left))',
  pointerEvents: 'auto',
};

const glyphChipStyle: CSSProperties = {
  minWidth: 64,
  minHeight: 64,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '1.75rem',
  color: '#f5f5f5',
  background: 'rgba(10, 14, 22, 0.6)',
  border: '1px solid rgba(245, 158, 11, 0.35)',
  borderRadius: 14,
};

const brakeChipStyle: CSSProperties = {
  minWidth: 84,
  fontSize: '1rem',
  fontWeight: 700,
  letterSpacing: '0.04em',
  background: 'rgba(120, 18, 12, 0.55)',
  borderColor: 'rgba(239, 68, 68, 0.55)',
};

interface ZoneProps {
  role: TouchRole;
  glyph: string;
  label: string;
  testId: string;
  zoneStyle: CSSProperties;
  chipMargin: string;
  chipOverrides?: CSSProperties;
}

function TouchZone({ role, glyph, label, testId, zoneStyle, chipMargin, chipOverrides }: ZoneProps) {
  function onPointerDown(e: ReactPointerEvent<HTMLButtonElement>): void {
    e.preventDefault();
    if (typeof e.currentTarget.setPointerCapture === 'function') {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Some browsers throw for an already-released/invalid pointerId — capture is a
        // nicety (keeps delivering events if the finger slides off), not load-bearing.
      }
    }
    touchPointerDown(e.pointerId, role);
  }

  function onPointerUp(e: ReactPointerEvent<HTMLButtonElement>): void {
    touchPointerUp(e.pointerId);
  }

  function onPointerCancel(e: ReactPointerEvent<HTMLButtonElement>): void {
    touchPointerCancel(e.pointerId);
  }

  function onPointerLeave(e: ReactPointerEvent<HTMLButtonElement>): void {
    // Deliberately a no-op when pointer capture is active — a captured pointer keeps
    // delivering up/cancel to THIS element even after it visually leaves the zone's
    // bounds, so releasing here too would just be redundant. This only matters as a
    // fallback for environments where setPointerCapture silently no-op'd above — better
    // to release there than leave a stuck "held" control.
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) return;
    touchPointerUp(e.pointerId);
  }

  return (
    <button
      type="button"
      className="touch-zone"
      style={zoneStyle}
      aria-label={label}
      data-testid={testId}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
    >
      <span
        className="touch-zone__glyph"
        style={{ ...glyphChipStyle, margin: chipMargin, ...chipOverrides }}
        aria-hidden="true"
      >
        {glyph}
      </span>
    </button>
  );
}

export function TouchControls() {
  const machine = useGameStore((s) => s.machine);
  // One-shot snapshot at mount (mirrors app/deviceCapabilities.ts's "capability changing
  // mid-session deliberately does not retroactively mount/unmount" philosophy) rather than
  // a matchMedia change listener — a device's pointer type doesn't change mid-run in
  // practice, and re-querying matchMedia on every `machine` change would be pure waste.
  const [coarse] = useState(() => isCoarsePointer());

  if (!coarse || machine !== 'PLAYING') return null;

  return (
    <div className="touch-controls" data-testid="touch-controls" style={rootStyle}>
      <div style={steerPadStyle}>
        <TouchZone
          role="steerLeft"
          glyph="◀"
          label="Steer left"
          testId="touch-steer-left"
          zoneStyle={steerZoneStyle}
          chipMargin="0 0 calc(16px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left))"
        />
        <TouchZone
          role="steerRight"
          glyph="▶"
          label="Steer right"
          testId="touch-steer-right"
          zoneStyle={steerZoneStyle}
          chipMargin="0 0 calc(16px + env(safe-area-inset-bottom)) 12px"
        />
      </div>
      <TouchZone
        role="brake"
        glyph="BRAKE"
        label="Brake"
        testId="touch-brake"
        zoneStyle={brakeZoneStyle}
        chipMargin="0 calc(16px + env(safe-area-inset-right)) calc(16px + env(safe-area-inset-bottom)) 0"
        chipOverrides={brakeChipStyle}
      />
      <button
        type="button"
        className="touch-zone touch-pause-btn"
        style={pauseBtnStyle}
        aria-label="Pause"
        data-testid="touch-pause"
        onPointerDown={(e) => {
          e.preventDefault();
          tapPause();
        }}
      >
        <span className="touch-zone__glyph" style={glyphChipStyle} aria-hidden="true">
          ⏸
        </span>
      </button>
    </div>
  );
}
