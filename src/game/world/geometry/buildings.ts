// Building geometry: a chunky box with a window grid on all 4 walls (TDD §8.1, §5.8's
// "every streetlight, traffic light, and building-window emissive group" — this module is
// the building half of that inventory). One canonical shape is built per DISCRETE VARIANT
// (kind, footprint w×h tiles, height bucket) — see buildingVariantKey below — and reused via
// InstancedMesh for every building in the city that shares that variant.
//
// Height bucketing (the "~6-10 total building geometries" budget from the phase-05 plan):
// WORLD_GEN.smallHeightM / towerHeightM are ranges a building's INDIVIDUAL heightM is rolled
// from (generate.ts, cosmetic rng stream) — that per-building value is NOT what gets
// rendered any more. Instead each kind's range is split into BUILDING_HEIGHT_BUCKETS (3)
// equal spans, and every building renders at its bucket's representative (midpoint) height.
// buildingHeightBucket()/bucketHeightM()/buildingVariantKey() are the three pieces of that
// contract — the instancing consumer (Task 1) calls buildingHeightBucket + bucketHeightM to
// get the height to actually pass into buildBuildingVariant()'s spec, and
// buildingVariantKey() to decide which cached geometry a given building instance belongs to.
// All three derive from the SAME WORLD_GEN range/BUILDING_HEIGHT_BUCKETS split, so they can
// never disagree. Document per CLAUDE.md: this makes WORLD_GEN.smallHeightM/towerHeightM
// express a bucket SPREAD now, not a continuously-rendered range.

import { BufferGeometry } from 'three';
import { PROP_DIMS, WORLD, WORLD_GEN } from '../../config';
import { PaletteCell } from '../archetypes';
import { createRng } from '../rng';
import { addBox, addQuad, createBuilder, toBufferGeometry, type GeometryBuilder } from './kit';

export type BuildingKind = 'small' | 'tower';

export interface BuildingVariantSpec {
  /** Footprint width in tiles (local X extent = wTiles * WORLD.tileSize). */
  readonly wTiles: number;
  /** Footprint depth in tiles (local Z extent = hTiles * WORLD.tileSize). */
  readonly hTiles: number;
  /** Rendered wall height in metres — pass the BUCKET height (bucketHeightM), not a raw
   * per-building rolled value; see the file header. */
  readonly heightM: number;
  readonly kind: BuildingKind;
  /** Deterministic roll driving the single wall tone for this variant (see wallCellOf). */
  readonly windowSeed: number;
}

const DIMS = PROP_DIMS.building;
const WALL_CELLS = [
  PaletteCell.wallA,
  PaletteCell.wallB,
  PaletteCell.wallC,
  PaletteCell.wallD,
  PaletteCell.wallE,
  PaletteCell.wallF,
] as const;

export const BUILDING_HEIGHT_BUCKETS: number = DIMS.heightBuckets;

function heightRangeOf(kind: BuildingKind): readonly [number, number] {
  return kind === 'tower' ? WORLD_GEN.towerHeightM : WORLD_GEN.smallHeightM;
}

/** 0..BUILDING_HEIGHT_BUCKETS-1 bucket index for a raw (per-building) heightM roll. */
export function buildingHeightBucket(kind: BuildingKind, heightM: number): number {
  const [min, max] = heightRangeOf(kind);
  const span = (max - min) / BUILDING_HEIGHT_BUCKETS;
  const idx = Math.floor((heightM - min) / span);
  return Math.min(BUILDING_HEIGHT_BUCKETS - 1, Math.max(0, idx));
}

/** The representative height every building in `bucket` actually renders at (its
 * sub-range's midpoint, rounded to cm). */
export function bucketHeightM(kind: BuildingKind, bucket: number): number {
  const [min, max] = heightRangeOf(kind);
  const span = (max - min) / BUILDING_HEIGHT_BUCKETS;
  return Math.round((min + span * (bucket + 0.5)) * 100) / 100;
}

/**
 * Stable cache key for the instancing sibling: one InstancedMesh-variant geometry per
 * distinct key. Footprint w/h are used as-is (WORLD_GEN.footprintSizes only ever produces
 * 1x1/1x2/2x1/2x2 for 'small' and a fixed 2x2 for 'tower', so this stays a small, bounded
 * set); only height is bucketed. `heightM` here is the raw per-building roll — this function
 * buckets it internally, so callers never need to call buildingHeightBucket themselves just
 * to build the key.
 */
export function buildingVariantKey(
  kind: BuildingKind,
  wTiles: number,
  hTiles: number,
  heightM: number,
): string {
  return `${kind}:${wTiles}x${hTiles}:b${buildingHeightBucket(kind, heightM)}`;
}

/** One deterministic wall tone for the whole building, rolled from windowSeed — TDD §8.1's
 * single-palette-texture look calls for flat, non-gradiented walls; per-instance colour
 * tint (Task 1's instanceColor attribute) layers additional variety on top of this without
 * needing more geometry variants. */
function wallCellOf(windowSeed: number): number {
  return createRng(windowSeed).fork('wall').pick(WALL_CELLS);
}

/** Round a target grid density to at least 1 — small buckets never produce a windowless
 * wall, oversized ones never divide by zero. */
function gridCount(available: number, spacing: number): number {
  return Math.max(1, Math.round(available / spacing));
}

/** Append one wall's window grid, all 4 walls sharing the same emissive cell (windowWarm)
 * — see the file header: whether a given building instance glows is a per-instance
 * attribute set elsewhere, never baked into the geometry. */
function addWindows(b: GeometryBuilder, width: number, depth: number, height: number): void {
  const halfW = width / 2;
  const halfD = depth / 2;
  const ww = DIMS.windowWidthM / 2;
  const wh = DIMS.windowHeightM / 2;
  const inset = DIMS.windowInsetM;
  const availH = height - DIMS.windowBottomMarginM - DIMS.windowTopMarginM;
  const rows = gridCount(availH, DIMS.floorHeightM);
  const colsNS = gridCount(depth - 2 * DIMS.windowSideMarginM, DIMS.windowColSpacingM); // px/nx walls (span = depth)
  const colsEW = gridCount(width - 2 * DIMS.windowSideMarginM, DIMS.windowColSpacingM); // pz/nz walls (span = width)
  const availNS = depth - 2 * DIMS.windowSideMarginM;
  const availEW = width - 2 * DIMS.windowSideMarginM;

  for (let row = 0; row < rows; row++) {
    const y = DIMS.windowBottomMarginM + ((row + 0.5) / rows) * availH;

    for (let col = 0; col < colsNS; col++) {
      const t = -availNS / 2 + ((col + 0.5) / colsNS) * availNS;
      const xp = halfW + inset;
      addQuad(
        b,
        [
          [xp, y - wh, t + ww],
          [xp, y - wh, t - ww],
          [xp, y + wh, t - ww],
          [xp, y + wh, t + ww],
        ],
        [1, 0, 0],
        PaletteCell.glassCool,
        PaletteCell.windowWarm,
      );
      const xn = -halfW - inset;
      addQuad(
        b,
        [
          [xn, y - wh, t - ww],
          [xn, y - wh, t + ww],
          [xn, y + wh, t + ww],
          [xn, y + wh, t - ww],
        ],
        [-1, 0, 0],
        PaletteCell.glassCool,
        PaletteCell.windowWarm,
      );
    }

    for (let col = 0; col < colsEW; col++) {
      const t = -availEW / 2 + ((col + 0.5) / colsEW) * availEW;
      const zp = halfD + inset;
      addQuad(
        b,
        [
          [t - ww, y - wh, zp],
          [t + ww, y - wh, zp],
          [t + ww, y + wh, zp],
          [t - ww, y + wh, zp],
        ],
        [0, 0, 1],
        PaletteCell.glassCool,
        PaletteCell.windowWarm,
      );
      const zn = -halfD - inset;
      addQuad(
        b,
        [
          [t + ww, y - wh, zn],
          [t - ww, y - wh, zn],
          [t - ww, y + wh, zn],
          [t + ww, y + wh, zn],
        ],
        [0, 0, -1],
        PaletteCell.glassCool,
        PaletteCell.windowWarm,
      );
    }
  }
}

/**
 * Build one building variant's geometry (see the file header for the bucketing contract).
 * Origin at ground level (y=0), footprint centered on local (0,0) in XZ — matches the
 * instancing consumer positioning instances at each footprint's world-space center.
 */
export function buildBuildingVariant(spec: BuildingVariantSpec): BufferGeometry {
  const b = createBuilder();
  const width = spec.wTiles * WORLD.tileSize;
  const depth = spec.hTiles * WORLD.tileSize;
  const height = spec.heightM;
  const halfW = width / 2;
  const halfD = depth / 2;
  const wall = wallCellOf(spec.windowSeed);
  const isTower = spec.kind === 'tower';
  const roofY = isTower ? height + DIMS.parapetHeightM : height;

  // Shell: walls only — the floor is never visible (buried) and the roof is a separate
  // flat cap below (towers cap above the parapet instead).
  addBox(
    b,
    { minX: -halfW, maxX: halfW, minY: 0, maxY: height, minZ: -halfD, maxZ: halfD },
    {
      px: { albedo: wall },
      nx: { albedo: wall },
      pz: { albedo: wall },
      nz: { albedo: wall },
    },
  );

  addWindows(b, width, depth, height);

  if (isTower) {
    // Parapet lip: same footprint, stacked straight up from the wall top to the roofline.
    addBox(
      b,
      { minX: -halfW, maxX: halfW, minY: height, maxY: roofY, minZ: -halfD, maxZ: halfD },
      {
        px: { albedo: PaletteCell.roof },
        nx: { albedo: PaletteCell.roof },
        pz: { albedo: PaletteCell.roof },
        nz: { albedo: PaletteCell.roof },
      },
    );
  }

  addQuad(
    b,
    [
      [-halfW, roofY, -halfD],
      [-halfW, roofY, halfD],
      [halfW, roofY, halfD],
      [halfW, roofY, -halfD],
    ],
    [0, 1, 0],
    PaletteCell.roof,
  );

  return toBufferGeometry(b);
}
