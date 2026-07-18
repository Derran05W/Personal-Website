// Phase 25.6 (D2/D20 seam #1) — the merged road-paint geometry: ribbons + curbs + centre-line
// dashes (SKIPPED inside intersection boxes) + the sidewalk band along every ribbon edge +
// crosswalk zebra bands at signalized intersections. ONE vertex-coloured BufferGeometry (one draw
// call, +0 over the old ribbon mesh) — the same UNLIT-literal path the P22 roads used. This is
// D20's road-paint seam: dashes/crosswalks are emitted from ROAD_CLASSES + roadGraph's
// `listIntersections` records, keyed the way MegaKit's road-paint decal meshes would one day
// replace the quad emission.
//
// Y-LAYERING (all a hair above the ground slab; higher = paints on top): sidewalk band (below the
// road, so a cross-street's asphalt covers it at intersections) < road ribbon < curb strips <
// crosswalk zebra. mapToWorld is the identity swap, so street map coords ARE world x/z.

import { BufferGeometry, Color, Float32BufferAttribute } from 'three';
import { CROSSWALK, ROAD_CLASSES, ROAD_COLORS, ROAD_EDGE, SIDEWALK } from '../../config/torontoMap';
import { TRAFFIC_LIGHT_FULL_CLASSES } from '../../config/torontoDress';
import type { Intersection } from './roadGraph';
import type { Street } from './streets';

const SIDEWALK_Y = 0.012; // below the road ribbon (0.02) so cross-street asphalt covers it
const ROAD_Y = 0.02;
const PAINT_Y = ROAD_Y + 0.005; // curbs + dashes
const CROSSWALK_Y = ROAD_Y + 0.007; // above the curbs so the zebra reads on the asphalt

const FULL_CLASSES = new Set<string>(TRAFFIC_LIGHT_FULL_CLASSES);

interface Sink {
  readonly positions: number[];
  readonly normals: number[];
  readonly colors: number[];
}

function quad(sink: Sink, hex: string, x0: number, z0: number, x1: number, z1: number, y: number, c: Color): void {
  const { positions, normals, colors } = sink;
  positions.push(x0, y, z0, x0, y, z1, x1, y, z1, x0, y, z0, x1, y, z1, x1, y, z0);
  for (let i = 0; i < 6; i++) normals.push(0, 1, 0);
  c.set(hex);
  for (let i = 0; i < 6; i++) colors.push(c.r, c.g, c.b);
}

/** Along-coords of every crossing on `street` + the cross street's half-width there (the
 * intersection-box half-span along this street). */
function crossingsOn(street: Street, intersections: readonly Intersection[]): { along: number; crossHalf: number }[] {
  return intersections
    .filter((c) => (street.axis === 'ns' ? c.nsId === street.id : c.ewId === street.id))
    .map((c) => ({
      along: street.axis === 'ns' ? c.y : c.x,
      crossHalf: ROAD_CLASSES[street.axis === 'ns' ? c.ewCls : c.nsCls] / 2,
    }));
}

function insideAnyIntersection(along: number, crossings: readonly { along: number; crossHalf: number }[]): boolean {
  return crossings.some((c) => Math.abs(along - c.along) < c.crossHalf);
}

/** Emit a crosswalk zebra band spanning `[spanLo, spanHi]` (perpendicular to travel) at fixed
 * band `[bandLo, bandHi]` (along travel). `axis` = 'x' means the band spans world X (stripes run
 * along Z); 'z' means it spans world Z (stripes run along X). */
function emitCrosswalk(sink: Sink, c: Color, axis: 'x' | 'z', spanLo: number, spanHi: number, bandLo: number, bandHi: number): void {
  const step = CROSSWALK.stripeWidthWu + CROSSWALK.stripeGapWu;
  for (let s = spanLo + CROSSWALK.stripeGapWu; s + CROSSWALK.stripeWidthWu < spanHi; s += step) {
    if (axis === 'x') quad(sink, CROSSWALK.color, s, bandLo, s + CROSSWALK.stripeWidthWu, bandHi, CROSSWALK_Y, c);
    else quad(sink, CROSSWALK.color, bandLo, s, bandHi, s + CROSSWALK.stripeWidthWu, CROSSWALK_Y, c);
  }
}

/**
 * Build the whole road-paint geometry from the street table + intersection records. Deterministic,
 * pure (no three scene state beyond building a geometry).
 */
export function buildRoadGeometry(streets: readonly Street[], intersections: readonly Intersection[]): BufferGeometry {
  const sink: Sink = { positions: [], normals: [], colors: [] };
  const c = new Color();
  const e = ROAD_EDGE.widthWu;
  const d = ROAD_EDGE.dash;
  const sw = SIDEWALK.widthWu;

  for (const street of streets) {
    const r = street.ribbon; // map coords = world x/z
    const isEw = street.axis === 'ew';
    const crossings = crossingsOn(street, intersections);

    // Sidewalk bands along the two OUTER long edges (below the road).
    if (isEw) {
      quad(sink, SIDEWALK.color, r.minX, r.minY - sw, r.maxX, r.minY, SIDEWALK_Y, c);
      quad(sink, SIDEWALK.color, r.minX, r.maxY, r.maxX, r.maxY + sw, SIDEWALK_Y, c);
    } else {
      quad(sink, SIDEWALK.color, r.minX - sw, r.minY, r.minX, r.maxY, SIDEWALK_Y, c);
      quad(sink, SIDEWALK.color, r.maxX, r.minY, r.maxX + sw, r.maxY, SIDEWALK_Y, c);
    }

    // Asphalt ribbon.
    quad(sink, ROAD_COLORS[street.cls], r.minX, r.minY, r.maxX, r.maxY, ROAD_Y, c);

    if (isEw) {
      // Curbs along the north/south edges.
      quad(sink, ROAD_EDGE.color, r.minX, r.minY, r.maxX, r.minY + e, PAINT_Y, c);
      quad(sink, ROAD_EDGE.color, r.minX, r.maxY - e, r.maxX, r.maxY, PAINT_Y, c);
      // Centre-line dashes along X, skipped inside intersection boxes.
      const cz = (r.minY + r.maxY) / 2;
      for (let x = r.minX + d.gapWu; x + d.lengthWu < r.maxX; x += d.lengthWu + d.gapWu) {
        const mid = x + d.lengthWu / 2;
        if (insideAnyIntersection(mid, crossings)) continue;
        quad(sink, d.color, x, cz - d.halfWidthWu, x + d.lengthWu, cz + d.halfWidthWu, PAINT_Y, c);
      }
    } else {
      quad(sink, ROAD_EDGE.color, r.minX, r.minY, r.minX + e, r.maxY, PAINT_Y, c);
      quad(sink, ROAD_EDGE.color, r.maxX - e, r.minY, r.maxX, r.maxY, PAINT_Y, c);
      const cx = (r.minX + r.maxX) / 2;
      for (let z = r.minY + d.gapWu; z + d.lengthWu < r.maxY; z += d.lengthWu + d.gapWu) {
        const mid = z + d.lengthWu / 2;
        if (insideAnyIntersection(mid, crossings)) continue;
        quad(sink, d.color, cx - d.halfWidthWu, z, cx + d.halfWidthWu, z + d.lengthWu, PAINT_Y, c);
      }
    }
  }

  // Crosswalk zebras at signalized intersections (both classes full — spine/artery/major).
  for (const it of intersections) {
    if (!FULL_CLASSES.has(it.nsCls) || !FULL_CLASSES.has(it.ewCls)) continue;
    const nsHalf = ROAD_CLASSES[it.nsCls] / 2; // box half-span along world X
    const ewHalf = ROAD_CLASSES[it.ewCls] / 2; // box half-span along world Z
    const gap = CROSSWALK.setbackWu;
    const band = CROSSWALK.bandWu;
    // North / south of the box: cross the NS street (span world X), band along world Z.
    emitCrosswalk(sink, c, 'x', it.x - nsHalf, it.x + nsHalf, it.y - ewHalf - gap - band, it.y - ewHalf - gap);
    emitCrosswalk(sink, c, 'x', it.x - nsHalf, it.x + nsHalf, it.y + ewHalf + gap, it.y + ewHalf + gap + band);
    // East / west of the box: cross the EW street (span world Z), band along world X.
    emitCrosswalk(sink, c, 'z', it.y - ewHalf, it.y + ewHalf, it.x + nsHalf + gap, it.x + nsHalf + gap + band);
    emitCrosswalk(sink, c, 'z', it.y - ewHalf, it.y + ewHalf, it.x - nsHalf - gap - band, it.x - nsHalf - gap);
  }

  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(sink.positions, 3));
  g.setAttribute('normal', new Float32BufferAttribute(sink.normals, 3));
  g.setAttribute('color', new Float32BufferAttribute(sink.colors, 3));
  g.computeBoundingSphere();
  return g;
}
