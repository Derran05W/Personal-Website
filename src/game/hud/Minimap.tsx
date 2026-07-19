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
import { isDistrictDark, getLightPoolPositions } from '../core/debugBridge';
import { TILE_COLORS, districtPixelRect, worldToMapPx } from './minimapMath';
import { streetEndpointsWorld, torontoPolygonPx, torontoWorldToMapPx, TORONTO_MINIMAP_STREETS } from './torontoMinimapMath';

const MAP_PX = 192;
const REDRAW_INTERVAL_MS = 100; // ~10 Hz — a debug tool, not part of the render loop.
const PLAYER_DOT_RADIUS_PX = 3;
const EDGE_STROKE = 'rgba(255, 255, 255, 0.35)';
const PLAYER_DOT_COLOR = '#ff3b3b';
// Phase 13 Task 4: dark-district overlay + light-pool viz dots. DISTRICT_COUNT mirrors
// world/instancing.ts's derivation (WORLD.districts squared) without importing that
// (three.js-heavy) module into this tiny DOM-canvas component.
const DISTRICT_COUNT = WORLD.districts * WORLD.districts;
// Deliberately more opaque/darker than any TILE_COLORS entry so a dark district reads as
// visibly "dead" at a glance, not just a slightly muddier version of its lit tiles.
const DISTRICT_DARK_FILL = 'rgba(4, 6, 10, 0.72)';
const LIGHT_POOL_DOT_COLOR = '#ffd166';
const LIGHT_POOL_DOT_RADIUS_PX = 2;
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
  const lightPoolVizOn = useDevToggle('lightPoolViz');
  // Phase 29 (D6): Toronto-aware minimap source — polygon extent + road ribbons + player blip,
  // replacing the legacy tile-grid read while the torontoMap toggle is on. District tints/
  // dark-district overlay/light-pool viz stay legacy-only this phase (see drawToronto's doc
  // comment) — an honest scope cut, not an oversight.
  const torontoOn = useDevToggle('torontoMap');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!visible) return; // hidden: no canvas is mounted below, nothing to draw/poll.
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;

    const drawLegacy = () => {
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

      // Phase 13 Task 4: dark-district overlay — one flat alpha square per dark district
      // over its 16x16-tile region (minimapMath.districtPixelRect), drawn on top of that
      // district's tiles so it reads as visibly dead at a glance. Read at this same 10 Hz
      // tick from core/debugBridge.ts's isDistrictDark — see that module's doc comment for
      // what it stands in for pre-integration (Tasks 1-2's real powergrid/grid.ts).
      for (let d = 0; d < DISTRICT_COUNT; d++) {
        if (!isDistrictDark(d)) continue;
        const { x, y, size } = districtPixelRect(d, MAP_PX);
        ctx.fillStyle = DISTRICT_DARK_FILL;
        ctx.fillRect(x, y, size, size);
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

      // Phase 13 Task 4: light-pool viz, opt-in (core/devToggles.ts's `lightPoolViz`,
      // default off) — small dots at the pooled dynamic lights' world positions, chosen
      // over an in-scene marker set as the cheaper/clearer option (see that toggle's doc
      // comment). Reads core/debugBridge.ts's getLightPoolPositions, a stub returning []
      // until powergrid/lightPool.ts (Task 3, concurrent this wave) lands and exposes real
      // pool positions.
      if (lightPoolVizOn) {
        ctx.fillStyle = LIGHT_POOL_DOT_COLOR;
        for (const p of getLightPoolPositions()) {
          const { x, y } = worldToMapPx(p.x, p.z, MAP_PX);
          ctx.beginPath();
          ctx.arc(x, y, LIGHT_POOL_DOT_RADIUS_PX, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };

    // Phase 29 (D6): the Toronto source — polygon outline + road ribbons + player blip. No
    // world/tile grid exists to read (Toronto has no WorldData), and no district-tint/dark-
    // district/light-pool overlay this phase (honest scope cut, flagged in phase-29-notes.md —
    // the dark-district read would need its own Toronto-districtId-aware wiring; district COUNT
    // already differs, 15 vs the legacy 16 DISTRICT_COUNT this file's dark-overlay loop uses).
    const drawToronto = () => {
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

    const draw = () => {
      ctx.clearRect(0, 0, MAP_PX, MAP_PX);
      if (torontoOn) drawToronto();
      else drawLegacy();
    };

    draw();
    const id = setInterval(draw, REDRAW_INTERVAL_MS);
    return () => clearInterval(id);
  }, [visible, lightPoolVizOn, torontoOn]);

  if (!visible) return null;

  return (
    <div style={containerStyle}>
      <canvas ref={canvasRef} width={MAP_PX} height={MAP_PX} style={canvasStyle} />
    </div>
  );
}
