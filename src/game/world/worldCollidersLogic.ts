// Pure logic backing WorldColliders.tsx (Phase 5 Task 4; CLAUDE.md's entity-registry
// pattern, TDD §7 collision groups): collider box sizing per archetype, registry entry
// construction, and per-set collider placement (which determines instanceId — see the
// "Per-set collider placement" section below). Split out of the .tsx file because it exports
// several non-component values (react-refresh/only-export-components) — worldColliders.test.ts
// exercises everything here directly, with no React/Rapier mounting required.
//
// Input is cityInstances.ts's ArchetypeInstanceSet[] (buildings + street props, already
// district-sorted) — this module owns no generation/placement/sorting logic of its own.

import { POWER_GRID, PROP_DIMS, PROPS, WORLD } from '../config';
import { ARCHETYPES, type ArchetypeName } from './archetypes';
import type { ArchetypeInstanceSet } from './cityInstances';
import { footprintCenter } from './cityInstances';
import { buildingHeightBucket, bucketHeightM } from './geometry/buildings';
import type { PropPlacement } from './propPlacements';
import type { EntityEntry } from './registry';
import type { BuildingFootprint } from './types';

// Shrinks each building collider a little inside its tile bounds (Task 4 brief: "full
// footprint box (w·tileSize − small inset ...)"). The rendered building geometry itself
// fills its footprint tile(s) exactly with no gap (world/geometry/buildings.ts), so this is
// purely a physics-side clearance: keeps two adjacent footprints' colliders from ever
// touching across a shared tile edge (floating-point-exact-flush boxes are a classic Rapier
// jitter/tunneling footgun), without shrinking the box enough to visibly detach from its mesh.
const BUILDING_COLLIDER_INSET_M = 0.6;

// Mutable tuples (not readonly): passed straight through to CuboidCollider's `args` prop,
// which is typed as a plain (mutable) 3-tuple — a `readonly` tuple here would need a spread
// at every call site to satisfy that prop's type.
export interface ColliderBox {
  readonly halfExtents: [number, number, number];
  /** Local vertical center — ground (footprint base) is y=0. */
  readonly centerY: number;
}

/**
 * Full footprint box for one building, sized from its BUCKETED render height (Task 2's
 * bucketHeightM/buildingHeightBucket contract) rather than its raw per-building heightM roll,
 * so the collider always matches the variant that actually gets rendered — never the
 * intermediate value the seed happened to draw.
 */
export function buildingColliderBox(
  building: BuildingFootprint,
): { readonly halfExtents: [number, number, number]; readonly center: { x: number; y: number; z: number } } {
  const bucket = buildingHeightBucket(building.kind, building.heightM);
  const heightM = bucketHeightM(building.kind, bucket);
  const { x, z } = footprintCenter(building.col, building.row, building.w, building.h);
  const halfExtents: [number, number, number] = [
    (building.w * WORLD.tileSize - BUILDING_COLLIDER_INSET_M * 2) / 2,
    heightM / 2,
    (building.h * WORLD.tileSize - BUILDING_COLLIDER_INSET_M * 2) / 2,
  ];
  return { halfExtents, center: { x, y: heightM / 2, z } };
}

// --- Street-prop archetypes ------------------------------------------------------------------
// Every ARCHETYPES entry except the two building archetypes (which propPlacements.ts never
// emits — buildings come from world.buildings, not placements).
export const PROP_ARCHETYPES: readonly ArchetypeName[] = ARCHETYPES.filter(
  (name) => name !== 'buildingSmall' && name !== 'buildingTower',
);

// Tree canopy apex height, derived by replaying world/geometry/streetProps.ts's buildTree()
// tier loop (trunk → overlapping stacked cones) without building any geometry — this module
// needs only the resulting scalar. Computed once at module scope since PROP_DIMS is a frozen
// `as const` (never changes at runtime).
const TREE_CANOPY_TOP_M = (() => {
  const d = PROP_DIMS.tree;
  let y1 = d.trunkHeightM;
  let y0 = d.trunkHeightM - d.foliageOverlapM;
  for (let tier = 0; tier < d.foliageTiers; tier++) {
    y1 = y0 + d.foliageTierHeightM;
    y0 = y1 - d.foliageOverlapM;
  }
  return y1;
})();

/**
 * Collider box for one street-prop archetype, in the prop's own local frame (ground at y=0,
 * matching every world/geometry/streetProps.ts builder's origin convention) — every instance
 * of an archetype shares one canonical geometry (streetProps.ts's file header), so one box
 * per archetype name is exact, not per-placement.
 *
 * Sizing intent per the Task 4 brief: a SLIM box for streetlight/trafficLight (the pole
 * only — deliberately never covers the arm+head overhang, so a car can clip under/beside the
 * head but not the pole itself), a CHUNKY box for tree/bench/hydrant/mailbox/transformerBox
 * (full footprint + height, small approximations noted inline), and a thin long panel for
 * fenceSegment (rotated per-placement by the caller, not baked in here since rotation is a
 * per-instance value).
 */
export function propColliderBox(archetype: ArchetypeName): ColliderBox {
  switch (archetype) {
    case 'streetlight': {
      const d = PROP_DIMS.streetlight;
      return { halfExtents: [d.poleRadiusM, d.poleHeightM / 2, d.poleRadiusM], centerY: d.poleHeightM / 2 };
    }
    case 'trafficLight': {
      const d = PROP_DIMS.trafficLight;
      return { halfExtents: [d.poleRadiusM, d.poleHeightM / 2, d.poleRadiusM], centerY: d.poleHeightM / 2 };
    }
    case 'tree': {
      const d = PROP_DIMS.tree;
      return {
        halfExtents: [d.foliageBaseRadiusM, TREE_CANOPY_TOP_M / 2, d.foliageBaseRadiusM],
        centerY: TREE_CANOPY_TOP_M / 2,
      };
    }
    case 'bench': {
      const d = PROP_DIMS.bench;
      const topM = d.seatHeightM + d.backHeightM;
      // Approximation: the real backrest sits entirely behind the seat's own depth (a small
      // asymmetric ~backThicknessM/2 offset toward -Z), which this box ignores in favour of a
      // depth-padded, Z-centered box — half of 0.06 m is gameplay-irrelevant, and staying
      // Z-centered means no extra rotated-offset math is needed alongside `rotationY` below.
      return {
        halfExtents: [d.seatWidthM / 2, topM / 2, (d.seatDepthM + d.backThicknessM) / 2],
        centerY: topM / 2,
      };
    }
    case 'hydrant': {
      const d = PROP_DIMS.hydrant;
      const topM = d.bodyHeightM + d.capHeightM;
      return { halfExtents: [d.bodyRadiusM, topM / 2, d.bodyRadiusM], centerY: topM / 2 };
    }
    case 'mailbox': {
      const d = PROP_DIMS.mailbox;
      // Slightly generous vs. the exact geometry (streetProps.ts overlaps the body 0.05 m
      // into the post) — post+body height without that offset is a safe, simple over-cover.
      const topM = d.postHeightM + d.bodyHeightM;
      return { halfExtents: [d.bodyWidthM / 2, topM / 2, d.bodyDepthM / 2], centerY: topM / 2 };
    }
    case 'fenceSegment': {
      const d = PROP_DIMS.fenceSegment;
      return {
        halfExtents: [d.lengthM / 2, d.heightM / 2, d.postThicknessM / 2],
        centerY: d.heightM / 2,
      };
    }
    case 'transformerBox': {
      const d = PROP_DIMS.transformerBox;
      const topM = d.plinthHeightM + d.heightM;
      // Uses the plinth's (wider) footprint for the whole box height — a small over-cover
      // above the plinth where the cabinet is actually narrower, chosen so the collider never
      // under-covers the geometry; harmless (and arguably desirable) for a Phase-6-destructible
      // prop.
      return {
        halfExtents: [d.widthM / 2 + d.plinthOutsetM, topM / 2, d.depthM / 2 + d.plinthOutsetM],
        centerY: topM / 2,
      };
    }
    case 'parkedCar': {
      const d = PROP_DIMS.parkedCar;
      // Full car height (body + cabin, ground clearance included) and full car length
      // (body + both bumpers) — a slightly generous over-cover of the actual geometry
      // (rounds the cabin's narrower width up to the full body width), same "never
      // under-cover a destructible prop" spirit as transformerBox above.
      const topM = d.bodyBottomM + d.bodyHeightM + d.cabinHeightM;
      const halfLengthM = d.bodyLengthM / 2 + d.bumperDepthM;
      return { halfExtents: [d.bodyWidthM / 2, topM / 2, halfLengthM], centerY: topM / 2 };
    }
    // --- Phase 19 Task 2: market + alley props (small, light, knockable) -------------------
    case 'awning': {
      const d = PROP_DIMS.awning;
      return { halfExtents: [d.canopyWidthM / 2, d.poleHeightM / 2, d.canopyDepthM / 2], centerY: d.poleHeightM / 2 };
    }
    case 'crate': {
      const d = PROP_DIMS.crate;
      return { halfExtents: [d.widthM / 2, d.heightM / 2, d.depthM / 2], centerY: d.heightM / 2 };
    }
    case 'produceStand': {
      const d = PROP_DIMS.produceStand;
      const topM = d.tableHeightM + d.produceSizeM;
      return { halfExtents: [d.tableWidthM / 2, topM / 2, d.tableDepthM / 2], centerY: topM / 2 };
    }
    case 'garbageCanTipped': {
      const d = PROP_DIMS.garbageCanTipped;
      // Lying on its side: the collider's "height" is the tube's diameter, its "length" runs
      // along X (world/geometry/streetProps.ts's addHorizontalTube axis) — over-covers the
      // lid/spill slightly, same "never under-cover" spirit as every other prop box here.
      const topM = d.bodyRadiusM * 2;
      const halfLengthM = d.bodyLengthM / 2 + d.lidRadiusM;
      return { halfExtents: [halfLengthM, topM / 2, d.bodyRadiusM], centerY: topM / 2 };
    }
    case 'raccoon': {
      const d = PROP_DIMS.raccoon;
      const topM = d.legHeightM + d.bodyHeightM;
      return { halfExtents: [d.bodyWidthM / 2, topM / 2, d.bodyLengthM / 2 + d.headSizeM], centerY: topM / 2 };
    }
    case 'buildingSmall':
    case 'buildingTower':
      throw new Error(`propColliderBox: ${archetype} is a building archetype, not a street prop`);
  }
}

// --- Registry entry construction ------------------------------------------------------------

export function buildingEntityEntry(building: BuildingFootprint, instanceId: number): EntityEntry {
  return {
    kind: 'building',
    archetype: building.kind === 'tower' ? 'buildingTower' : 'buildingSmall',
    instanceId,
    districtId: building.districtId,
  };
}

export function propEntityEntry(placement: PropPlacement, instanceId: number): EntityEntry {
  const isTransformer = placement.archetype === 'transformerBox';
  const isParkedCar = placement.archetype === 'parkedCar';
  return {
    kind: isTransformer ? 'transformer' : 'propStatic',
    archetype: placement.archetype,
    instanceId,
    districtId: placement.districtId,
    ...(isTransformer ? { hp: POWER_GRID.transformerHp } : {}),
    ...(isParkedCar ? { hp: PROPS.parkedCarHp } : {}),
  };
}

// --- Per-set collider placement (determines instanceId) --------------------------------------
// Consumes cityInstances.ts's ArchetypeInstanceSet, NOT raw derivePlacements()/world.buildings
// order — that file's header is explicit: "instance order is sorted-by-district exactly once,
// here, and everything downstream shares it... Colliders must be built from THESE arrays,
// never from raw derivePlacements()/world.buildings order." ONE ArchetypeInstanceSet = ONE
// InstancedMesh (world/CityArchetypes.tsx mounts exactly one mesh per set), so a LOCAL index
// within a set's own `buildings`/`placements` array — which is parallel to `sources`, the
// array actually handed to createArchetypeMesh — is exactly "index into the archetype's
// InstancedMesh" (registry.ts's instanceId doc) for THAT mesh.
//
// Known limitation, inherited from registry.ts's shape (not introduced here — registry.ts is
// a sealed seam for this task): several sets can share one archetype NAME (buildings fan out
// into multiple footprint/height-bucket VARIANT sets, all named 'buildingSmall' or
// 'buildingTower' — see cityInstances.ts's byVariant grouping), so a building's instanceId is
// only unique WITHIN its own variant set, not globally per archetype name — EntityEntry has no
// variantKey field to disambiguate further. Harmless today: buildings are indestructible
// fixed colliders in v1 (CLAUDE.md locked decision), so nothing reverse-indexes a SPECIFIC
// building instance from its collider handle yet. Street-prop archetypes never hit this:
// cityInstances.ts builds exactly one set per prop archetype ("single canonical variant per
// street prop"), so their instanceIds ARE globally unique per archetype name.

export interface ColliderPlacement {
  readonly entry: EntityEntry;
  readonly box: ColliderBox;
  readonly x: number;
  readonly z: number;
  readonly rotationY: number;
}

/** The subset of ArchetypeInstanceSet this module actually needs — decouples the pure
 * helpers below from `sources`/`ranges`/`buildGeometry`/`variantKey`, so tests can build
 * minimal fixtures instead of a full set. */
export type CollidableSet = Pick<ArchetypeInstanceSet, 'archetype' | 'buildings' | 'placements'>;

function buildingSetColliders(set: CollidableSet): ColliderPlacement[] {
  return set.buildings.map((building, instanceId) => {
    const { halfExtents, center } = buildingColliderBox(building);
    return {
      entry: buildingEntityEntry(building, instanceId),
      box: { halfExtents, centerY: center.y },
      x: center.x,
      z: center.z,
      rotationY: 0,
    };
  });
}

function propSetColliders(set: CollidableSet): ColliderPlacement[] {
  const box = propColliderBox(set.archetype);
  return set.placements.map((placement, instanceId) => ({
    entry: propEntityEntry(placement, instanceId),
    box,
    x: placement.x,
    z: placement.z,
    rotationY: placement.rotationY,
  }));
}

/** Every collider for one ArchetypeInstanceSet (a building variant OR a street-prop
 * archetype — cityInstances.ts guarantees exactly one of `buildings`/`placements` is
 * non-empty per set, never both, never neither). */
export function setColliders(set: CollidableSet): ColliderPlacement[] {
  return set.buildings.length > 0 ? buildingSetColliders(set) : propSetColliders(set);
}
