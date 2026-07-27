// Phase 40 — the painted crosswalk BAND rects, as data.
//
// Extracted so there is exactly one derivation of "where does a zebra band sit". Two consumers
// need the same answer and used to have only one of them:
//   • world/toronto/roadPaint.ts — EMITS the stripes inside each band (it owned this math).
//   • world/toronto/worldContext.ts — registers each band as a `crosswalkBand` ZONE claim so the
//     placement arbiter can keep lane-closure cones and road plates off a live crossing (Phase
//     40's gap 4; before this, lane closures took no gate lists at all).
//
// It lives in its own module rather than in roadPaint.ts because roadPaint.ts imports `three` to
// build its BufferGeometry, and the pure world layer (frontage/infill/furniture/composeWorld and
// their tests) must not pull the renderer in. Pure TS, no three/react, no rng — a closed-form
// function of the intersection records + the SAME config table roadPaint.ts reads.

import { CROSSWALK, ROAD_CLASSES } from '../../config/torontoMap';
import { TRAFFIC_LIGHT_FULL_CLASSES } from '../../config/torontoDress';
import type { Aabb } from './claimIndex';
import type { Intersection } from './roadGraph';

const FULL_CLASSES = new Set<string>(TRAFFIC_LIGHT_FULL_CLASSES);

/** Which approach of an intersection a band paints. Map convention: −Z = north, +Z = south. */
export type CrosswalkSide = 'north' | 'south' | 'east' | 'west';

/** One painted zebra band. `stripeAxis` is the world axis the band SPANS (stripes are laid across
 * it): 'x' for the north/south bands (crossing the NS street), 'z' for the east/west ones. */
export interface CrosswalkBand extends Aabb {
  readonly intersectionIndex: number;
  readonly side: CrosswalkSide;
  readonly stripeAxis: 'x' | 'z';
}

/** True where BOTH crossing streets are "full" classes — the signalization rule that decides
 * which intersections get zebras at all (the same predicate roadPaint.ts applied inline). */
export function isSignalized(it: Intersection): boolean {
  return FULL_CLASSES.has(it.nsCls) && FULL_CLASSES.has(it.ewCls);
}

/**
 * The four zebra bands of one signalized intersection, in the same order roadPaint.ts emits them
 * (north, south, east, west). Returns [] for an unsignalized crossing.
 */
export function crosswalkBandsAt(it: Intersection, intersectionIndex: number): readonly CrosswalkBand[] {
  if (!isSignalized(it)) return [];
  const nsHalf = ROAD_CLASSES[it.nsCls] / 2; // box half-span along world X
  const ewHalf = ROAD_CLASSES[it.ewCls] / 2; // box half-span along world Z
  const gap = CROSSWALK.setbackWu;
  const band = CROSSWALK.bandWu;
  const spanX: readonly [number, number] = [it.x - nsHalf, it.x + nsHalf];
  const spanZ: readonly [number, number] = [it.y - ewHalf, it.y + ewHalf];
  return [
    {
      intersectionIndex,
      side: 'north',
      stripeAxis: 'x',
      minX: spanX[0],
      maxX: spanX[1],
      minZ: it.y - ewHalf - gap - band,
      maxZ: it.y - ewHalf - gap,
    },
    {
      intersectionIndex,
      side: 'south',
      stripeAxis: 'x',
      minX: spanX[0],
      maxX: spanX[1],
      minZ: it.y + ewHalf + gap,
      maxZ: it.y + ewHalf + gap + band,
    },
    {
      intersectionIndex,
      side: 'east',
      stripeAxis: 'z',
      minX: it.x + nsHalf + gap,
      maxX: it.x + nsHalf + gap + band,
      minZ: spanZ[0],
      maxZ: spanZ[1],
    },
    {
      intersectionIndex,
      side: 'west',
      stripeAxis: 'z',
      minX: it.x - nsHalf - gap - band,
      maxX: it.x - nsHalf - gap,
      minZ: spanZ[0],
      maxZ: spanZ[1],
    },
  ];
}

/** Every painted band on the map, intersection-major then north/south/east/west. */
export function crosswalkBands(intersections: readonly Intersection[]): readonly CrosswalkBand[] {
  const out: CrosswalkBand[] = [];
  intersections.forEach((it, index) => out.push(...crosswalkBandsAt(it, index)));
  return out;
}
