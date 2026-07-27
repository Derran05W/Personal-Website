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
import {
  cnTowerMapPx,
  streetEndpointsWorld,
  torontoBarrierRingSegmentsPx,
  torontoWaterEdgeSegmentPx,
  torontoWorldToMapPx,
  TORONTO_MINIMAP_STREETS,
} from './torontoMinimapMath';

const MAP_PX = 192;
const REDRAW_INTERVAL_MS = 100; // ~10 Hz — a debug tool, not part of the render loop.
const PLAYER_DOT_RADIUS_PX = 3;
const PLAYER_DOT_COLOR = '#ff3b3b';
// Phase 44: the CN Tower wayfinding icon. P38's camera-debt sweep measured that sight-based
// wayfinding is impossible under the locked rig E (the pod never enters frame from any legal
// on-rig vantage, at any distance) — the minimap carries the role instead. A small warm-white dot
// (distinct from the red player blip) with a short vertical "antenna" tick reads as a tower glyph
// at 192px scale without needing real iconography.
const CN_ICON_COLOR = '#ffd9c4';
const CN_ICON_RADIUS_PX = 2;
const CN_ICON_ANTENNA_HEIGHT_PX = 4;
const CN_ICON_ANTENNA_WIDTH_PX = 1;
// Phase 29 (D6): Toronto street-ribbon stroke — dimmer than the ring (RING_STROKE below) so the
// boundary reads as the primary shape and the grid as secondary detail.
const TORONTO_STREET_STROKE = 'rgba(255, 255, 255, 0.2)';
// Phase 37: the map edge is now a diegetic barrier — a hazard/warning tone (matching the 3D
// scene's hoarding-stripe hazard-orange, worldEdgeGeometry.ts's HOARDING_STRIPE_COLOR) reads as
// "wall", not the old neutral-white "suggested boundary" outline it replaces.
const RING_STROKE = 'rgba(255, 141, 39, 0.9)';
const RING_LINE_WIDTH = 2.5; // heavier than the old EDGE_STROKE (1.5) — a wall, not a suggestion.
// The one open (south) edge: no wall on the lake (locked) — styled in the lake's own blue tone
// (TorontoScene.tsx's WATER_COLOR '#2f6f93'), brightened for contrast against the dark minimap.
const WATER_EDGE_STROKE = 'rgba(79, 172, 214, 0.9)';
const WATER_EDGE_LINE_WIDTH = 2;

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

    // Phase 29 (D6), unconditional since the Phase 32 flip: boundary (Phase 37: the barrier ring
    // + water edge, replacing the old plain polygon outline) + road ribbons + player blip. No
    // district-tint/dark-district/light-pool overlay — that legacy-only reading (tile grid +
    // 16-district grid) was retired with the legacy world (Phase 32 de-import); a
    // Toronto-districtId-aware version of those overlays remains a documented future debt, not
    // wired here (phase-29-notes.md).
    const draw = () => {
      ctx.clearRect(0, 0, MAP_PX, MAP_PX);

      // Phase 37: the barrier ring (hazard tone, heavier line — it's a wall now) drawn as
      // independent segments (the ring is a U, open on the water side — a closed loop would draw
      // a false chord across the lake), plus the one open water edge in the lake's own blue tone.
      ctx.strokeStyle = RING_STROKE;
      ctx.lineWidth = RING_LINE_WIDTH;
      ctx.beginPath();
      for (const seg of torontoBarrierRingSegmentsPx(MAP_PX)) {
        ctx.moveTo(seg.a.x, seg.a.y);
        ctx.lineTo(seg.b.x, seg.b.y);
      }
      ctx.stroke();

      const waterEdge = torontoWaterEdgeSegmentPx(MAP_PX);
      ctx.strokeStyle = WATER_EDGE_STROKE;
      ctx.lineWidth = WATER_EDGE_LINE_WIDTH;
      ctx.beginPath();
      ctx.moveTo(waterEdge.a.x, waterEdge.a.y);
      ctx.lineTo(waterEdge.b.x, waterEdge.b.y);
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

      // Phase 44: the CN Tower wayfinding glyph — a warm-white dot + antenna tick at its true
      // world position, drawn every redraw like every other overlay here (10 Hz, a debug tool).
      const cnPx = cnTowerMapPx(MAP_PX);
      ctx.fillStyle = CN_ICON_COLOR;
      ctx.beginPath();
      ctx.arc(cnPx.x, cnPx.y, CN_ICON_RADIUS_PX, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(
        cnPx.x - CN_ICON_ANTENNA_WIDTH_PX / 2,
        cnPx.y - CN_ICON_RADIUS_PX - CN_ICON_ANTENNA_HEIGHT_PX,
        CN_ICON_ANTENNA_WIDTH_PX,
        CN_ICON_ANTENNA_HEIGHT_PX,
      );

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
