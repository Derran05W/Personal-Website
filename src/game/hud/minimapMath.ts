// Pure, canvas-free helpers for the dev minimap (hud/Minimap.tsx). Kept in their own module
// so they're unit-testable in jsdom without touching an actual 2D canvas context (jsdom has
// no canvas backend — see minimapMath.test.ts; Minimap.tsx itself is exercised manually /
// via screenshots, not vitest).
//
// The tile color palette below is debug-only styling that never ships to players (Minimap
// is DEV-gated in game/index.tsx), so it deliberately does NOT live in game/config —
// CLAUDE.md's "all numbers live in game/config" rule governs real gameplay tunables, not
// throwaway dev-tool colors.

import { WORLD } from '../config';
import type { TileType } from '../world/types';

/** Debug palette only — see file doc comment. One entry per TileType (exhaustive by the
 * `Record<TileType, string>` annotation — a new TileType variant fails to compile here
 * until it's given a color). */
export const TILE_COLORS: Record<TileType, string> = {
  road: '#2b2f36',
  building: '#4f6b8f', // steel blue
  park: '#3fae7d',
  parkingLot: '#9aa0a6',
  transformerLot: '#e0c93d',
  landmark: '#e35c5c', // Phase 19 reserved landmark lot (CN Tower / stadium / flatiron)
};

/**
 * World-space (x, z) → minimap pixel (x, y). The map is centered on the origin and spans
 * `WORLD.tiles * WORLD.tileSize` meters per side (world/types.ts's frame convention, locked
 * in Phase 3: +Z is world south). +Z maps to +Y (down the canvas) with no flip needed,
 * since canvas rows already grow downward the same direction — south reads as "down" on the
 * minimap, matching the world.
 */
export function worldToMapPx(x: number, z: number, mapPx: number): { x: number; y: number } {
  const span = WORLD.tiles * WORLD.tileSize;
  const half = span / 2;
  return {
    x: ((x + half) / span) * mapPx,
    y: ((z + half) / span) * mapPx,
  };
}

/**
 * Phase 13 Task 4: pixel-space square for one district's 16×16-tile region (TDD §5.8's
 * blackout unit), for the minimap's dark-district overlay (hud/Minimap.tsx). `districtId`
 * is 0..15 (id = dRow * WORLD.districts + dCol, the same derivation world/types.ts's
 * generator uses to build District.col0/row0 — reproduced here from `WORLD` alone so this
 * helper needs no WorldData/District input, just like `worldToMapPx`). Returns the
 * TOP-LEFT pixel corner (ready for `ctx.fillRect(x, y, size, size)` — no centering offset
 * needed, unlike the per-tile block loop in Minimap.tsx which starts from a tile CENTER)
 * plus the region's side length in pixels. The 16 returned squares tile the map exactly,
 * edge-to-edge, with no gaps or overlap.
 */
export function districtPixelRect(
  districtId: number,
  mapPx: number,
): { x: number; y: number; size: number } {
  const districtTilesPerSide = WORLD.tiles / WORLD.districts;
  const dCol = districtId % WORLD.districts;
  const dRow = Math.floor(districtId / WORLD.districts);

  const span = WORLD.tiles * WORLD.tileSize;
  const half = span / 2;
  const worldX0 = dCol * districtTilesPerSide * WORLD.tileSize - half;
  const worldZ0 = dRow * districtTilesPerSide * WORLD.tileSize - half;

  const { x, y } = worldToMapPx(worldX0, worldZ0, mapPx);
  const size = ((districtTilesPerSide * WORLD.tileSize) / span) * mapPx;
  return { x, y, size };
}
