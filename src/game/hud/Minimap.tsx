// Dev-only top-down 2D minimap (Phase 4 Task 4). Rendered as a plain DOM <canvas> overlay
// OUTSIDE the r3f <Canvas> (same DOM layer as core/devPanel.tsx's <Leva> panel) — a 2D
// canvas context is far cheaper than an r3f scene for a tiny, infrequently-updated debug
// view. Lazy-imported by game/index.tsx behind `import.meta.env.DEV`, the same code-split
// pattern as core/PerfOverlay.tsx / core/devPanel.tsx, so this file never lands in a
// production chunk. The `minimap` leva toggle (core/devToggles.ts) additionally lets a dev
// hide it without unmounting the game; this component owns that check itself so
// game/index.tsx only needs one mount line (see the doc comment there).

import { useEffect, useRef, type CSSProperties } from 'react';
import { playerVehicle } from '../vehicles/playerRef';
import { useDevToggle } from '../core/devToggles';
import { streetEndpointsWorld, torontoPolygonPx, torontoWorldToMapPx, TORONTO_MINIMAP_STREETS } from './torontoMinimapMath';

const MAP_PX = 192;
const REDRAW_INTERVAL_MS = 100; // ~10 Hz — a debug tool, not part of the render loop.
const PLAYER_DOT_RADIUS_PX = 3;
const EDGE_STROKE = 'rgba(255, 255, 255, 0.35)';
const PLAYER_DOT_COLOR = '#ff3b3b';
// Phase 29 (D6): Toronto street-ribbon stroke — dimmer than the polygon outline (EDGE_STROKE)
// so the boundary reads as the primary shape and the grid as secondary detail.
const TORONTO_STREET_STROKE = 'rgba(255, 255, 255, 0.2)';

// Fixed bottom-left. Header is a fixed 64px bar at the TOP (z-index 50, app/Header.css);
// there is no site footer, so bottom-left is clear real estate — the 12px inset just keeps
// it off the viewport edge. z-index 40 sits below the header/Leva panel but above the game
// canvas (z-index 0, app/GameCanvas.css) and the hero overlay (z-index 1, Home.css).
const containerStyle: CSSProperties = {
  position: 'fixed',
  left: 12,
  bottom: 12,
  width: MAP_PX,
  height: MAP_PX,
  background: 'rgba(10, 14, 22, 0.55)',
  border: '1px solid rgba(255, 255, 255, 0.2)',
  borderRadius: 4,
  pointerEvents: 'none',
  zIndex: 40,
};

const canvasStyle: CSSProperties = { width: '100%', height: '100%', display: 'block' };

export default function Minimap() {
  const visible = useDevToggle('minimap');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!visible) return; // hidden: no canvas is mounted below, nothing to draw/poll.
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;

    // Phase 29 (D6), unconditional since the Phase 32 flip: polygon outline + road ribbons +
    // player blip. No district-tint/dark-district/light-pool overlay — that legacy-only reading
    // (tile grid + 16-district grid) was retired with the legacy world (Phase 32 de-import); a
    // Toronto-districtId-aware version of those overlays remains a documented future debt, not
    // wired here (phase-29-notes.md).
    const draw = () => {
      ctx.clearRect(0, 0, MAP_PX, MAP_PX);

      const polyPx = torontoPolygonPx(MAP_PX);
      ctx.strokeStyle = EDGE_STROKE;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      polyPx.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();

      ctx.strokeStyle = TORONTO_STREET_STROKE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const street of TORONTO_MINIMAP_STREETS) {
        const { a, b } = streetEndpointsWorld(street);
        const aPx = torontoWorldToMapPx(a.x, a.z, MAP_PX);
        const bPx = torontoWorldToMapPx(b.x, b.z, MAP_PX);
        ctx.moveTo(aPx.x, aPx.y);
        ctx.lineTo(bPx.x, bPx.y);
      }
      ctx.stroke();

      const pose = playerVehicle.current?.readState().pose;
      if (pose) {
        const { x, y } = torontoWorldToMapPx(pose.position.x, pose.position.z, MAP_PX);
        ctx.fillStyle = PLAYER_DOT_COLOR;
        ctx.beginPath();
        ctx.arc(x, y, PLAYER_DOT_RADIUS_PX, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    draw();
    const id = setInterval(draw, REDRAW_INTERVAL_MS);
    return () => clearInterval(id);
  }, [visible]);

  if (!visible) return null;

  return (
    <div style={containerStyle}>
      <canvas ref={canvasRef} width={MAP_PX} height={MAP_PX} style={canvasStyle} />
    </div>
  );
}
