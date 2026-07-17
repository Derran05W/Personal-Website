// Toronto landmark geometry (Phase 19 Task 2; TDD §13). Three standalone, one-off objects —
// never instanced, never blackout-linked (world/landmarks/*.tsx mounts each directly as a
// plain <mesh>, not through world/cityInstances.ts's district-instancing pipeline). Same
// "addBox/addPrismFrustum composition language" as every other world/geometry/*.ts builder
// (world/geometry/helicopter.ts's file header) — the only new idea here is a SEPARATE,
// fog:false material (world/landmarks/landmarkMaterial.ts) instead of the shared palette
// singleton, because these three need to read at any distance across the 640 m map, which
// conflicts with the shared material's blue-hour distance fog. See that file's header for the
// full rationale, and CnTower.tsx for why the antenna beacon is a SEPARATE small mesh rather
// than baked-in emissive geometry.

import { BufferGeometry } from 'three';
import { PROP_DIMS, WORLD } from '../../config';
import { PaletteCell } from '../archetypes';
import { addPrismFrustum, createBuilder, toBufferGeometry } from './kit';

// --- CN Tower ---------------------------------------------------------------------------------
// Base -> shaft -> pod (flare out, flare back in) -> upper shaft -> antenna mast, all straight
// low-poly frustums stacked with matching radii at every seam (buildings.ts's "the floor is
// never visible" spirit extended to every buried/continuous join here — no caps needed except
// the antenna's true top tip). ~160 m tall total (CN_TOWER_TOTAL_HEIGHT_M below), <=600 tris.
const CN_TOWER_DIMS = PROP_DIMS.cnTower;

/** Total tower height (m), base to antenna tip — CnTower.tsx positions the separate beacon
 * mesh here, and worldCollidersLogic-style consumers can derive "does this Y reach the pod"
 * from it without re-deriving the stack sum. */
export const CN_TOWER_TOTAL_HEIGHT_M: number =
  CN_TOWER_DIMS.baseHeightM +
  CN_TOWER_DIMS.shaftHeightM +
  CN_TOWER_DIMS.podLowerHeightM +
  CN_TOWER_DIMS.podUpperHeightM +
  CN_TOWER_DIMS.upperShaftHeightM +
  CN_TOWER_DIMS.antennaHeightM;

export function buildCnTowerGeometry(): BufferGeometry {
  const d = CN_TOWER_DIMS;
  const b = createBuilder();
  const shaftCell = PaletteCell.wallF;
  const podCell = PaletteCell.metal;
  const mastCell = PaletteCell.metalDark;

  let y = 0;
  addPrismFrustum(b, d.baseSides, y, y + d.baseHeightM, d.baseRadiusM, d.baseTopRadiusM, shaftCell);
  y += d.baseHeightM;
  addPrismFrustum(b, d.shaftSides, y, y + d.shaftHeightM, d.baseTopRadiusM, d.shaftTopRadiusM, shaftCell);
  y += d.shaftHeightM;
  addPrismFrustum(b, d.podSides, y, y + d.podLowerHeightM, d.shaftTopRadiusM, d.podRadiusM, podCell);
  y += d.podLowerHeightM;
  addPrismFrustum(b, d.podSides, y, y + d.podUpperHeightM, d.podRadiusM, d.shaftTopRadiusM, podCell);
  y += d.podUpperHeightM;
  addPrismFrustum(b, d.upperShaftSides, y, y + d.upperShaftHeightM, d.shaftTopRadiusM, d.upperShaftTopRadiusM, shaftCell);
  y += d.upperShaftHeightM;
  addPrismFrustum(b, d.antennaSides, y, y + d.antennaHeightM, d.upperShaftTopRadiusM, d.antennaTopRadiusM, mastCell, {
    capTop: true, // the one genuinely open end (the mast tip)
  });

  return toBufferGeometry(b);
}

// --- Stadium -----------------------------------------------------------------------------------
// A squat, hollow bowl shell: stepped podium skirt -> straight outer wall -> flared rim (capped
// from above so an elevated view never sees through the open interior). ~21 m tall, <=800 tris.
//
// PARAMETRIC by the reserved lot's footprint (wTiles x hTiles) — unlike every other builder in
// this family, the stadium's exact tile footprint varies by seed (world/landmarks.ts's
// reserveStadium tries 5x4 down to 3x3), so a fixed radius would either overflow a small lot or
// look toylike on a big one. stadiumRadii() is the single source of truth both this builder and
// world/landmarks/landmarksColliders.ts's stadiumColliderSegments derive from, so the visual
// shell and its collider ring can never disagree (mirrors buildings.ts's bucketHeightM contract).
export interface StadiumRadii {
  readonly podiumBaseRadiusM: number;
  readonly podiumTopRadiusM: number;
  readonly wallRadiusM: number;
  readonly rimTopRadiusM: number;
}

export function stadiumRadii(wTiles: number, hTiles: number): StadiumRadii {
  const d = PROP_DIMS.stadium;
  const outerRadiusM = ((Math.min(wTiles, hTiles) * WORLD.tileSize) / 2) * d.outerRadiusFillFraction;
  const wallRadiusM = outerRadiusM * d.wallRadiusRatio;
  return {
    podiumBaseRadiusM: outerRadiusM * d.podiumBaseRadiusRatio,
    podiumTopRadiusM: wallRadiusM,
    wallRadiusM,
    rimTopRadiusM: outerRadiusM,
  };
}

export function buildStadiumGeometry(wTiles: number, hTiles: number): BufferGeometry {
  const d = PROP_DIMS.stadium;
  const r = stadiumRadii(wTiles, hTiles);
  const b = createBuilder();
  const wallCell = PaletteCell.wallB;
  const rimCell = PaletteCell.roof;

  let y = 0;
  addPrismFrustum(b, d.sides, y, y + d.podiumHeightM, r.podiumBaseRadiusM, r.podiumTopRadiusM, wallCell);
  y += d.podiumHeightM;
  addPrismFrustum(b, d.sides, y, y + d.wallHeightM, r.podiumTopRadiusM, r.wallRadiusM, wallCell);
  y += d.wallHeightM;
  addPrismFrustum(b, d.sides, y, y + d.rimHeightM, r.wallRadiusM, r.rimTopRadiusM, rimCell, { capTop: true });

  return toBufferGeometry(b);
}

// --- Flatiron ------------------------------------------------------------------------------------
// A true triangular wedge: a 3-sided "cylinder" (addPrismFrustum sides=3 — convex by
// construction), stacked in alternating wall/window-tone straight bands (a coarse
// window-BAND read rather than buildings.ts's full per-floor window grid, since the shared
// palette material's per-instance emissive plumbing isn't available to this standalone,
// fog:false-material landmark — see landmarkMaterial.ts), capped with a small parapet.
export function buildFlatironGeometry(): BufferGeometry {
  const d = PROP_DIMS.flatiron;
  const b = createBuilder();
  const bandHeight = d.heightM / d.bandCount;
  const bandCells: readonly number[] = [PaletteCell.wallE, PaletteCell.glassCool];

  let y = 0;
  for (let i = 0; i < d.bandCount; i++) {
    const cell = bandCells[i % bandCells.length];
    addPrismFrustum(b, 3, y, y + bandHeight, d.radiusM, d.radiusM, cell);
    y += bandHeight;
  }
  addPrismFrustum(b, 3, y, y + d.parapetHeightM, d.radiusM, d.radiusM, PaletteCell.roof, { capTop: true });

  return toBufferGeometry(b);
}
