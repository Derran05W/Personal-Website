// Dev-only top-down 2D minimap (Phase 4 Task 4). Rendered as a plain DOM <canvas> overlay
// OUTSIDE the r3f <Canvas> (same DOM layer as core/devPanel.tsx's <Leva> panel) — a 2D
// canvas context is far cheaper than an r3f scene for a tiny, infrequently-updated debug
// view. Lazy-imported by game/index.tsx behind `import.meta.env.DEV`, the same code-split
// pattern as core/PerfOverlay.tsx / core/devPanel.tsx, so this file never lands in a
// production chunk. The `minimap` leva toggle (core/devToggles.ts) additionally lets a dev
// hide it without unmounting the game; this component owns that check itself so
// game/index.tsx only needs one mount line (see the doc comment there).

import { useEffect, useRef, type CSSProperties } from 'react';
import { WORLD } from '../config';
import { tileCenter } from '../world/types';
import { worldRef } from '../world/worldRef';
import { playerVehicle } from '../vehicles/playerRef';
import { useDevToggle } from '../core/devToggles';
import { TILE_COLORS, worldToMapPx } from './minimapMath';

const MAP_PX = 192;
const REDRAW_INTERVAL_MS = 100; // ~10 Hz — a debug tool, not part of the render loop.
const PLAYER_DOT_RADIUS_PX = 3;
const EDGE_STROKE = 'rgba(255, 255, 255, 0.35)';
const PLAYER_DOT_COLOR = '#ff3b3b';

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

    const draw = () => {
      ctx.clearRect(0, 0, MAP_PX, MAP_PX);

      const world = worldRef.current;
      if (!world) return; // nothing generated yet — leave the frame empty.

      // Tiles: one pixel-block per tile, colored by type.
      const blockPx = MAP_PX / WORLD.tiles;
      for (const tile of world.tiles) {
        const { x: wx, z: wz } = tileCenter(tile.col, tile.row);
        const { x, y } = worldToMapPx(wx, wz, MAP_PX);
        ctx.fillStyle = TILE_COLORS[tile.type];
        ctx.fillRect(x - blockPx / 2, y - blockPx / 2, blockPx, blockPx);
      }

      // Traffic graph edges, thin lines. Looked up by id (not array index) — TrafficNode
      // ids aren't type-guaranteed to equal their array position.
      const nodeById = new Map(world.graph.nodes.map((node) => [node.id, node]));
      ctx.strokeStyle = EDGE_STROKE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const edge of world.graph.edges) {
        const from = nodeById.get(edge.from);
        const to = nodeById.get(edge.to);
        if (!from || !to) continue;
        const a = worldToMapPx(from.x, from.z, MAP_PX);
        const b = worldToMapPx(to.x, to.z, MAP_PX);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();

      // Player dot.
      const pose = playerVehicle.current?.readState().pose;
      if (pose) {
        const { x, y } = worldToMapPx(pose.position.x, pose.position.z, MAP_PX);
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
