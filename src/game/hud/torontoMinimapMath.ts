// Pure, canvas-free helpers for the Toronto-aware dev minimap (hud/Minimap.tsx). Mirrors
// minimapMath.ts's split (jsdom has no canvas backend, so the drawing itself is exercised
// manually/via screenshots, not vitest — only the coordinate math lives here, testable in
// isolation) but reads Toronto's polygon/street data instead of the legacy WORLD.tiles grid.
//
// Kept OUT of minimapMath.ts on purpose: that module is the legacy minimap's own math and stays
// untouched (CLAUDE.md's "legacy byte-safety" spirit) — this is an ADDITIVE sibling, not a
// generalization of it.

import { PLAYABLE_POLYGON } from '../world/toronto/polygon';
import { buildStreets, type Street } from '../world/toronto/streets';

// Polygon bounding box, computed once (PLAYABLE_POLYGON is a module-level constant — pure,
// deterministic, never changes at runtime).
const XS = PLAYABLE_POLYGON.map((v) => v.x);
const YS = PLAYABLE_POLYGON.map((v) => v.y);
const MIN_X = Math.min(...XS);
const MAX_X = Math.max(...XS);
const MIN_Y = Math.min(...YS);
const MAX_Y = Math.max(...YS);
const SPAN_X = MAX_X - MIN_X;
const SPAN_Y = MAX_Y - MIN_Y;

/** The street table, built once (pure/deterministic — TorontoScene.tsx builds the same table
 * the same way). Re-exported so Minimap.tsx doesn't need its own world/toronto/streets import
 * just to draw ribbons. */
export const TORONTO_MINIMAP_STREETS: readonly Street[] = buildStreets().streets;

/**
 * World-space (x, z) -> minimap pixel (x, y). Unlike the legacy worldToMapPx (a single square
 * span), Toronto's polygon is NOT square (~2400 x ~4100 wu) — this fits the LARGER of the two
 * spans to `mapPx` and letterboxes the other axis, centered, so the whole polygon is always
 * visible without distortion. Map space is the identity swap (map x = world x, map y = world z)
 * per projection.ts's convention, matching every other Toronto minimap/scene consumer.
 */
export function torontoWorldToMapPx(x: number, z: number, mapPx: number): { x: number; y: number } {
  const scale = mapPx / Math.max(SPAN_X, SPAN_Y);
  const offsetX = (mapPx - SPAN_X * scale) / 2;
  const offsetY = (mapPx - SPAN_Y * scale) / 2;
  return {
    x: (x - MIN_X) * scale + offsetX,
    y: (z - MIN_Y) * scale + offsetY,
  };
}

/** The playable polygon's vertices, in minimap-pixel space, ready for a closed ctx.lineTo loop. */
export function torontoPolygonPx(mapPx: number): readonly { x: number; y: number }[] {
  return PLAYABLE_POLYGON.map((v) => torontoWorldToMapPx(v.x, v.y, mapPx));
}

/** One street's two endpoints in WORLD space (its map-space centerline/span, which — per the
 * identity swap above — already ARE world x/z). */
export function streetEndpointsWorld(street: Street): {
  readonly a: { readonly x: number; readonly z: number };
  readonly b: { readonly x: number; readonly z: number };
} {
  if (street.axis === 'ns') {
    return { a: { x: street.centerline, z: street.span[0] }, b: { x: street.centerline, z: street.span[1] } };
  }
  return { a: { x: street.span[0], z: street.centerline }, b: { x: street.span[1], z: street.centerline } };
}
