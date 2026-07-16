// Instanced-archetype assembly (Phase 5 integration, orchestrator-authored; pure data —
// the component that mounts these sets is world/CityArchetypes.tsx). Bridges the three
// Task layers — geometry builders (world/geometry/*), deterministic placements
// (world/propPlacements.ts), and the district-grouped instancing/palette layer
// (world/instancing.ts).
//
// THE INVARIANT THIS FILE EXISTS TO GUARD: instance order is sorted-by-district exactly
// once, here, and everything downstream shares it. `ArchetypeInstanceSet.sources` is the
// SORTED array, and `placements`/`buildings` are kept parallel to it — so an entity
// registry entry's `instanceId` (Phase 6 swaps), a blackout range index (Phase 13), and
// the visual instance in the mesh all agree by construction. Colliders must be built from
// THESE arrays, never from raw derivePlacements()/world.buildings order.

import { Color, Matrix4, Quaternion, Vector3, type BufferGeometry } from 'three';
import type { ArchetypeName } from './archetypes';
import type { BuildingFootprint, WorldData } from './types';
import { WORLD } from '../config';
import { createRng } from './rng';
import { derivePlacements, type PropPlacement } from './propPlacements';
import { sortByDistrict, type DistrictRanges, type InstanceSource } from './instancing';
import {
  buildBench,
  buildBuildingVariant,
  buildFenceSegment,
  buildHydrant,
  buildMailbox,
  buildParkedCar,
  buildStreetlight,
  buildTrafficLight,
  buildTransformerBox,
  buildTree,
  bucketHeightM,
  buildingHeightBucket,
  buildingVariantKey,
} from './geometry';

// Phase 6 Task 4: parked cars roll a per-instance tint from this small muted palette via the
// InstanceSource.color path (world/instancing.ts's instanceColor multiply over the palette
// albedo) — the ONE canonical parkedCar geometry (liveryRed body, geometry/parkedCar.ts)
// reads as a lot full of visually distinct cars with no extra draw calls or geometry
// variants. Deliberately muted/desaturated (not the palette's own liveryRed/liveryWhite
// cells) so tinted instances still read as "a car", not a colour clash against the body's
// baked-in albedo.
const PARKED_CAR_TINTS: readonly Color[] = [
  new Color('#7a2f2f'), // muted brick red
  new Color('#39424c'), // slate blue-grey
  new Color('#8a8f94'), // dull silver
  new Color('#2f3b2f'), // muted olive
  new Color('#4a3626'), // rust brown
  new Color('#dcded9'), // off-white
];

const HALF_MAP_M = (WORLD.tiles * WORLD.tileSize) / 2;

/** World-space center of a footprint spanning w×h tiles anchored at (col,row). (Moved from
 * CityScape's placeholder era — collider placement reuses it via this export.) */
export function footprintCenter(
  col: number,
  row: number,
  w: number,
  h: number,
): { x: number; z: number } {
  return {
    x: (col + w / 2) * WORLD.tileSize - HALF_MAP_M,
    z: (row + h / 2) * WORLD.tileSize - HALF_MAP_M,
  };
}

/** One buildable archetype variant: everything needed to create its InstancedMesh and its
 * colliders, with `sources`/`placements`/`buildings` PARALLEL and district-sorted. */
export interface ArchetypeInstanceSet {
  readonly archetype: ArchetypeName;
  readonly variantKey: string;
  /** Deferred so the component owns BufferGeometry lifecycle (build → dispose). */
  readonly buildGeometry: () => BufferGeometry;
  /** District-sorted instance sources (matrix = translation ∘ yaw; geometry carries size). */
  readonly sources: readonly InstanceSource[];
  /** [start,count] per district over `sources` — the blackout/debug-tint bookkeeping. */
  readonly ranges: DistrictRanges;
  /** Street-prop sets: placement records parallel to `sources`. Empty for buildings. */
  readonly placements: readonly PropPlacement[];
  /** Building sets: footprints parallel to `sources`. Empty for street props. */
  readonly buildings: readonly BuildingFootprint[];
}

// Street-prop archetypes all share this shape: parameterless canonical geometry, one
// placement per instance.
const PROP_BUILDERS: ReadonlyArray<[ArchetypeName, () => BufferGeometry]> = [
  ['streetlight', buildStreetlight],
  ['trafficLight', buildTrafficLight],
  ['tree', buildTree],
  ['bench', buildBench],
  ['hydrant', buildHydrant],
  ['mailbox', buildMailbox],
  ['fenceSegment', buildFenceSegment],
  ['transformerBox', buildTransformerBox],
  ['parkedCar', buildParkedCar],
];

type TaggedSource = InstanceSource & {
  placement?: PropPlacement;
  building?: BuildingFootprint;
};

const _pos = new Vector3();
const _quat = new Quaternion();
const _scale = new Vector3(1, 1, 1);
const Y_AXIS = new Vector3(0, 1, 0);

function composeMatrix(x: number, z: number, rotationY: number): Matrix4 {
  _pos.set(x, 0, z);
  _quat.setFromAxisAngle(Y_AXIS, rotationY);
  return new Matrix4().compose(_pos, _quat, _scale);
}

/**
 * Assemble every archetype's sorted instance set for one world. Pure and deterministic —
 * calling it twice for the same world yields identical order (sortByDistrict is stable),
 * which is what lets renderer and colliders be built from separate calls in a pinch,
 * though CityScape memoizes one result and passes it to both.
 */
export function buildCityInstanceSets(world: WorldData): ArchetypeInstanceSet[] {
  const sets: ArchetypeInstanceSet[] = [];
  const placements = derivePlacements(world);

  // Street props: bucket placements per archetype, tag sources with their placement so the
  // district sort carries the pairing (sortByDistrict preserves object identity).
  const byArchetype = new Map<ArchetypeName, PropPlacement[]>();
  for (const p of placements) {
    const list = byArchetype.get(p.archetype);
    if (list) list.push(p);
    else byArchetype.set(p.archetype, [p]);
  }
  // Parked-car tints: one dedicated rng stream, forked off the world seed (never the
  // 'props' placement stream — this is a pure rendering roll, not a layout one), consumed
  // in placement-list order so a given seed always paints the same lot the same way.
  const carTintRng = createRng(world.seed).fork('parkedCarTint');
  for (const [archetype, build] of PROP_BUILDERS) {
    const list = byArchetype.get(archetype);
    if (!list || list.length === 0) continue;
    const tagged: TaggedSource[] = list.map((placement) => ({
      districtId: placement.districtId,
      matrix: composeMatrix(placement.x, placement.z, placement.rotationY),
      placement,
      ...(archetype === 'parkedCar' ? { color: carTintRng.pick(PARKED_CAR_TINTS) } : {}),
    }));
    const { sorted, ranges } = sortByDistrict(tagged);
    sets.push({
      archetype,
      variantKey: archetype, // single canonical variant per street prop
      buildGeometry: build,
      sources: sorted,
      ranges,
      placements: (sorted as TaggedSource[]).map((s) => s.placement as PropPlacement),
      buildings: [],
    });
  }

  // Buildings: group by discrete variant (footprint shape × height bucket — the geometry
  // sibling's bucketing contract), one InstancedMesh per variant. Wall tone varies per
  // variant via a seed-derived windowSeed; heights render as the bucket height.
  const byVariant = new Map<string, BuildingFootprint[]>();
  for (const b of world.buildings) {
    const key = buildingVariantKey(b.kind, b.w, b.h, b.heightM);
    const list = byVariant.get(key);
    if (list) list.push(b);
    else byVariant.set(key, [b]);
  }
  // Deterministic variant order (Map preserves insertion order, which follows
  // world.buildings order — deterministic per seed, but sort keys anyway so unrelated
  // generator reorderings can't shuffle draw order).
  const variantKeys = [...byVariant.keys()].sort();
  for (const key of variantKeys) {
    const list = byVariant.get(key) as BuildingFootprint[];
    const sample = list[0];
    const archetype: ArchetypeName = sample.kind === 'tower' ? 'buildingTower' : 'buildingSmall';
    const spec = {
      wTiles: sample.w,
      hTiles: sample.h,
      heightM: bucketHeightM(sample.kind, buildingHeightBucket(sample.kind, sample.heightM)),
      kind: sample.kind,
      windowSeed: createRng(world.seed).fork(`bwall:${key}`).int(0, 2 ** 31 - 1),
    };
    const tagged: TaggedSource[] = list.map((building) => {
      const { x, z } = footprintCenter(building.col, building.row, building.w, building.h);
      return { districtId: building.districtId, matrix: composeMatrix(x, z, 0), building };
    });
    const { sorted, ranges } = sortByDistrict(tagged);
    sets.push({
      archetype,
      variantKey: key,
      buildGeometry: () => buildBuildingVariant(spec),
      sources: sorted,
      ranges,
      placements: [],
      buildings: (sorted as TaggedSource[]).map((s) => s.building as BuildingFootprint),
    });
  }

  return sets;
}
