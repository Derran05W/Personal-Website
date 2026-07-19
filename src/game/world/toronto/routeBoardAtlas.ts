// Phase 31 (Part-8 D3, T1) — the transit route-number board: a small, nearest-neighbour,
// wordmark-free CanvasTexture ("97 YONGE") mounted on every bus/streetcar (CLAUDE.md brand rule:
// only a plain route number + short name, never a logo or TTC wordmark). Same shared-atlas +
// UV-row-remap idiom as world/toronto/cityPack/VenueDressLayer.tsx's makeVenueBandAtlas /
// buildVenueBandGeometry, simplified: one row per DISTINCT route id (not per venue), and the quad
// is a plain three.js PlaneGeometry (no custom yaw-generalized winding needed — the board is a
// child of each vehicle's own transform, so it inherits the vehicle's yaw for free).

import { CanvasTexture, NearestFilter, PlaneGeometry, SRGBColorSpace, type BufferGeometry } from 'three';
import { ROUTE_BOARD, TTC_LIVERY } from '../../config/torontoTransit';

const ROW_H_PX = 64;
const ATLAS_W_PX = 256;

export interface RouteBoardEntry {
  readonly id: string;
  readonly label: string;
}

export interface RouteBoardAtlas {
  readonly texture: CanvasTexture;
  readonly rowIndex: ReadonlyMap<string, number>;
  readonly rowCount: number;
}

/** Builds ONE shared canvas atlas: one row per DISTINCT route id in `entries` (order of first
 * appearance), each row a flat background + the route number (large) + short name (small),
 * NearestFilter/no-mipmaps (CLAUDE.md pixel-art-style decal convention). Safe in a non-DOM test
 * environment (jsdom has no real 2d context — same guard makeVenueBandAtlas/logoAtlas use). */
export function buildRouteBoardAtlas(entries: readonly RouteBoardEntry[]): RouteBoardAtlas {
  const distinct: RouteBoardEntry[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    distinct.push(e);
  }
  const rowCount = Math.max(1, distinct.length);
  const rowIndex = new Map<string, number>();
  distinct.forEach((e, row) => rowIndex.set(e.id, row));

  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W_PX;
  canvas.height = rowCount * ROW_H_PX;
  const tex = new CanvasTexture(canvas);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = SRGBColorSpace;

  const ctx = canvas.getContext('2d');
  if (ctx) {
    distinct.forEach((e, row) => {
      const y = row * ROW_H_PX;
      ctx.fillStyle = TTC_LIVERY.boardBackgroundHex;
      ctx.fillRect(0, y, ATLAS_W_PX, ROW_H_PX);
      ctx.fillStyle = TTC_LIVERY.boardNumberHex;
      ctx.font = 'bold 30px "Arial Narrow", Arial, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(e.id, 8, y + ROW_H_PX / 2 + 1);
      ctx.fillStyle = TTC_LIVERY.boardNameHex;
      ctx.font = 'bold 16px "Arial Narrow", Arial, sans-serif';
      const nameOnly = e.label.slice(e.id.length).trim();
      ctx.fillText(nameOnly, 68, y + ROW_H_PX / 2 + 1);
    });
  }
  tex.needsUpdate = true;
  return { texture: tex, rowIndex, rowCount };
}

/** A route-board plane geometry (a plain PlaneGeometry, UV V-remapped to `row` of `rowCount`) —
 * ONE geometry per DISTINCT route, shared across every vehicle slot that shows that route (same
 * "one baked geometry, many meshes" pattern as ParkedVehicles.tsx).
 *
 * LIVE-VERIFICATION FIX (Phase 31, Part-8 T1): a board rotated to face the vehicle's OWN yaw (a
 * "windshield sign") reads fine from some headings but goes near edge-on/foreshorted from others
 * under the LOCKED fixed camera bearing (yaw 45°/pitch 50°, CLAUDE.md "Renderer decisions" —
 * "exactly two faces of every box are ever visible; author decals on those two faces only", a box
 * face convention that does NOT hold for a face that rotates with a moving object's own heading).
 * Rotated flat (-90° about X, normal +Y) instead — a rooftop board read from above, ALWAYS
 * face-on to the elevated fixed camera regardless of which way the vehicle is driving. The
 * caller (TransitRouteBoards) never applies the vehicle's yaw to this mesh, only its position. */
export function buildRouteBoardGeometry(row: number, rowCount: number): BufferGeometry {
  const g = new PlaneGeometry(ROUTE_BOARD.widthWu, ROUTE_BOARD.heightWu);
  g.rotateX(-Math.PI / 2);
  const uv = g.getAttribute('uv');
  const v0 = 1 - (row + 1) / rowCount;
  const v1 = 1 - row / rowCount;
  for (let i = 0; i < uv.count; i++) {
    // PlaneGeometry's own UVs are 0 (bottom) / 1 (top) — remap each to this row's V slice.
    uv.setY(i, uv.getY(i) > 0.5 ? v1 : v0);
  }
  uv.needsUpdate = true;
  return g;
}
