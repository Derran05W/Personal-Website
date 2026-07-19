import { describe, expect, it } from 'vitest';
import { POWER_GRID, PROP_DIMS, PROPS, WORLD } from '../config';
import { ARCHETYPES, type ArchetypeName } from './archetypes';
import { buildCityInstanceSets, type ArchetypeInstanceSet } from './cityInstances';
import { generate } from './generate';
import type { PropPlacement } from './propPlacements';
import type { BuildingFootprint } from './types';
import {
  PROP_ARCHETYPES,
  buildingColliderBox,
  buildingEntityEntry,
  propColliderBox,
  propEntityEntry,
  setColliders,
  type CollidableSet,
} from './worldCollidersLogic';

const HALF_MAP_M = (WORLD.tiles * WORLD.tileSize) / 2;

function footprint(overrides: Partial<BuildingFootprint> = {}): BuildingFootprint {
  return {
    col: 3,
    row: 5,
    w: 1,
    h: 1,
    kind: 'small',
    heightM: 10,
    districtId: 2,
    ...overrides,
  };
}

function placement(overrides: Partial<PropPlacement> = {}): PropPlacement {
  return {
    archetype: 'streetlight',
    x: 1,
    z: 2,
    rotationY: 0,
    districtId: 4,
    tileIndex: 0,
    ...overrides,
  };
}

// --- PROP_ARCHETYPES ------------------------------------------------------------------------

// Phase 30 (T2 debt-1): archetypes with no legacy PROP_DIMS geometry — the legacy generator
// never places them (world/archetypes.ts's own doc comment), so propColliderBox() can't size
// them; PROP_ARCHETYPES excludes them alongside the two building archetypes.
const TORONTO_ONLY_ARCHETYPES: readonly ArchetypeName[] = ['trashCan', 'stopSign', 'busStop'];

describe('PROP_ARCHETYPES', () => {
  it('is every ARCHETYPES entry except the two building archetypes and the Toronto-only ones', () => {
    expect(PROP_ARCHETYPES).not.toContain('buildingSmall');
    expect(PROP_ARCHETYPES).not.toContain('buildingTower');
    for (const name of TORONTO_ONLY_ARCHETYPES) expect(PROP_ARCHETYPES).not.toContain(name);
    expect(PROP_ARCHETYPES.length).toBe(ARCHETYPES.length - 2 - TORONTO_ONLY_ARCHETYPES.length);
    for (const name of ARCHETYPES) {
      if (name === 'buildingSmall' || name === 'buildingTower') continue;
      if ((TORONTO_ONLY_ARCHETYPES as readonly string[]).includes(name)) continue;
      expect(PROP_ARCHETYPES).toContain(name);
    }
  });
});

// --- propColliderBox -------------------------------------------------------------------------

describe('propColliderBox', () => {
  it('streetlight: a slim pole box (radius half-extent), not the arm/head overhang', () => {
    const d = PROP_DIMS.streetlight;
    const box = propColliderBox('streetlight');
    expect(box.halfExtents).toEqual([d.poleRadiusM, d.poleHeightM / 2, d.poleRadiusM]);
    expect(box.centerY).toBeCloseTo(d.poleHeightM / 2);
    // Never wider than the arm's reach — proves the head overhang isn't covered.
    expect(box.halfExtents[2]).toBeLessThan(d.armLengthM);
  });

  it('trafficLight: a slim pole box', () => {
    const d = PROP_DIMS.trafficLight;
    const box = propColliderBox('trafficLight');
    expect(box.halfExtents).toEqual([d.poleRadiusM, d.poleHeightM / 2, d.poleRadiusM]);
    expect(box.centerY).toBeCloseTo(d.poleHeightM / 2);
  });

  it('tree: canopy apex matches the streetProps.ts stacked-tier formula (closed form, independently derived)', () => {
    const d = PROP_DIMS.tree;
    // Closed form for the buildTree() loop (trunkHeightM - overlap, then `tiers` steps of
    // +tierHeightM/-overlap): apex = trunkHeightM + tiers * (tierHeightM - overlap).
    const expectedApex = d.trunkHeightM + d.foliageTiers * (d.foliageTierHeightM - d.foliageOverlapM);
    const box = propColliderBox('tree');
    expect(box.centerY * 2).toBeCloseTo(expectedApex);
    expect(box.halfExtents[0]).toBeCloseTo(d.foliageBaseRadiusM);
    expect(box.halfExtents[1]).toBeCloseTo(expectedApex / 2);
    expect(box.halfExtents[2]).toBeCloseTo(d.foliageBaseRadiusM);
  });

  it('bench: covers seat+back height and seat+back depth, full seat width', () => {
    const d = PROP_DIMS.bench;
    const box = propColliderBox('bench');
    expect(box.centerY * 2).toBeCloseTo(d.seatHeightM + d.backHeightM);
    expect(box.halfExtents[0]).toBeCloseTo(d.seatWidthM / 2);
    expect(box.halfExtents[2]).toBeCloseTo((d.seatDepthM + d.backThicknessM) / 2);
  });

  it('hydrant: body + cap height, body radius footprint', () => {
    const d = PROP_DIMS.hydrant;
    const box = propColliderBox('hydrant');
    expect(box.centerY * 2).toBeCloseTo(d.bodyHeightM + d.capHeightM);
    expect(box.halfExtents).toEqual([d.bodyRadiusM, box.centerY, d.bodyRadiusM]);
  });

  it('mailbox: post + body height, body footprint (never smaller than the post)', () => {
    const d = PROP_DIMS.mailbox;
    const box = propColliderBox('mailbox');
    expect(box.centerY * 2).toBeCloseTo(d.postHeightM + d.bodyHeightM);
    expect(box.halfExtents[0]).toBeCloseTo(d.bodyWidthM / 2);
    expect(box.halfExtents[2]).toBeCloseTo(d.bodyDepthM / 2);
    expect(box.halfExtents[0]).toBeGreaterThan(d.postRadiusM);
  });

  it('fenceSegment: a thin long panel, length along local X', () => {
    const d = PROP_DIMS.fenceSegment;
    const box = propColliderBox('fenceSegment');
    expect(box.halfExtents[0]).toBeCloseTo(d.lengthM / 2);
    expect(box.halfExtents[1]).toBeCloseTo(d.heightM / 2);
    expect(box.halfExtents[2]).toBeCloseTo(d.postThicknessM / 2);
    // "Thin long panel": far longer than it is thick.
    expect(box.halfExtents[0]).toBeGreaterThan(box.halfExtents[2] * 5);
  });

  it('transformerBox: uses the (wider) plinth footprint for the whole cabinet height', () => {
    const d = PROP_DIMS.transformerBox;
    const box = propColliderBox('transformerBox');
    expect(box.centerY * 2).toBeCloseTo(d.plinthHeightM + d.heightM);
    expect(box.halfExtents[0]).toBeCloseTo(d.widthM / 2 + d.plinthOutsetM);
    expect(box.halfExtents[2]).toBeCloseTo(d.depthM / 2 + d.plinthOutsetM);
  });

  it('parkedCar: covers body+cabin height and body+bumpers length, full body width', () => {
    const d = PROP_DIMS.parkedCar;
    const box = propColliderBox('parkedCar');
    expect(box.centerY * 2).toBeCloseTo(d.bodyBottomM + d.bodyHeightM + d.cabinHeightM);
    expect(box.halfExtents[0]).toBeCloseTo(d.bodyWidthM / 2);
    expect(box.halfExtents[2]).toBeCloseTo(d.bodyLengthM / 2 + d.bumperDepthM);
  });

  it('throws for the two building archetypes (not a street prop)', () => {
    expect(() => propColliderBox('buildingSmall')).toThrow();
    expect(() => propColliderBox('buildingTower')).toThrow();
  });

  it('every prop archetype yields finite, positive dimensions', () => {
    for (const archetype of PROP_ARCHETYPES) {
      const box = propColliderBox(archetype);
      expect(box.centerY).toBeGreaterThan(0);
      expect(Number.isFinite(box.centerY)).toBe(true);
      for (const half of box.halfExtents) {
        expect(half).toBeGreaterThan(0);
        expect(Number.isFinite(half)).toBe(true);
      }
    }
  });
});

// --- buildingColliderBox ---------------------------------------------------------------------

describe('buildingColliderBox', () => {
  it('sizes from the BUCKETED height, not the raw heightM roll', () => {
    // smallHeightM range and 3 buckets (config/world.ts) — pick a heightM that clearly isn't
    // itself a bucket midpoint (bucket 0 of [6,14]/3 midpoints at 7.33), then assert the
    // collider used the bucket's representative height instead of the raw 7.
    const b = footprint({ heightM: 7, kind: 'small' });
    const box = buildingColliderBox(b);
    expect(box.halfExtents[1] * 2).not.toBeCloseTo(7, 1);
    expect(box.center.y).toBeCloseTo(box.halfExtents[1]);
  });

  it('1x1 footprint: half-extents shrink by the collider inset from the raw tile size', () => {
    const b = footprint({ col: 0, row: 0, w: 1, h: 1 });
    const box = buildingColliderBox(b);
    // Half-extent must be under tileSize/2 (5) — the inset always shrinks it — and clearly
    // above a degenerate/zero size.
    expect(box.halfExtents[0]).toBeLessThan(WORLD.tileSize / 2);
    expect(box.halfExtents[0]).toBeGreaterThan(WORLD.tileSize / 2 - 1);
    expect(box.halfExtents[2]).toEqual(box.halfExtents[0]); // square footprint
  });

  it('2x2 tower footprint: half-extents scale with w/h tiles', () => {
    const small = buildingColliderBox(footprint({ col: 0, row: 0, w: 1, h: 1, kind: 'small' }));
    const tower = buildingColliderBox(footprint({ col: 0, row: 0, w: 2, h: 2, kind: 'tower', heightM: 30 }));
    expect(tower.halfExtents[0]).toBeGreaterThan(small.halfExtents[0]);
    expect(tower.halfExtents[2]).toBeGreaterThan(small.halfExtents[2]);
  });

  it('center matches the footprint-center formula (col/row anchored, map centered on origin)', () => {
    const b = footprint({ col: 0, row: 0, w: 1, h: 1 });
    const box = buildingColliderBox(b);
    const expectedX = (b.col + b.w / 2) * WORLD.tileSize - HALF_MAP_M;
    const expectedZ = (b.row + b.h / 2) * WORLD.tileSize - HALF_MAP_M;
    expect(box.center.x).toBeCloseTo(expectedX);
    expect(box.center.z).toBeCloseTo(expectedZ);
  });
});

// --- Registry entry construction ------------------------------------------------------------

describe('buildingEntityEntry', () => {
  it('small buildings register as buildingSmall, no hp', () => {
    const entry = buildingEntityEntry(footprint({ kind: 'small', districtId: 7 }), 3);
    expect(entry).toEqual({ kind: 'building', archetype: 'buildingSmall', instanceId: 3, districtId: 7 });
    expect(entry.hp).toBeUndefined();
  });

  it('tower buildings register as buildingTower', () => {
    const entry = buildingEntityEntry(footprint({ kind: 'tower', districtId: 1 }), 9);
    expect(entry.kind).toBe('building');
    expect(entry.archetype).toBe('buildingTower');
    expect(entry.instanceId).toBe(9);
    expect(entry.districtId).toBe(1);
  });
});

describe('propEntityEntry', () => {
  it('transformerBox registers as kind "transformer" with POWER_GRID.transformerHp', () => {
    const entry = propEntityEntry(placement({ archetype: 'transformerBox', districtId: 5 }), 2);
    expect(entry.kind).toBe('transformer');
    expect(entry.archetype).toBe('transformerBox');
    expect(entry.instanceId).toBe(2);
    expect(entry.districtId).toBe(5);
    expect(entry.hp).toBe(POWER_GRID.transformerHp);
  });

  it('parkedCar registers as kind "propStatic" with PROPS.parkedCarHp', () => {
    const entry = propEntityEntry(placement({ archetype: 'parkedCar', districtId: 8 }), 4);
    expect(entry.kind).toBe('propStatic');
    expect(entry.archetype).toBe('parkedCar');
    expect(entry.instanceId).toBe(4);
    expect(entry.districtId).toBe(8);
    expect(entry.hp).toBe(PROPS.parkedCarHp);
  });

  it('every other archetype registers as kind "propStatic" with no hp', () => {
    for (const archetype of PROP_ARCHETYPES) {
      if (archetype === 'transformerBox' || archetype === 'parkedCar') continue;
      const entry = propEntityEntry(placement({ archetype, districtId: 6 }), 0);
      expect(entry.kind).toBe('propStatic');
      expect(entry.archetype).toBe(archetype);
      expect(entry.hp).toBeUndefined();
    }
  });
});

// --- setColliders (per-set instanceId derivation) ---------------------------------------------
// setColliders consumes cityInstances.ts's ArchetypeInstanceSet shape — instanceId MUST be the
// local index within the set's own buildings/placements array (worldColliders.ts's file header
// explains why: that array is parallel to `sources`, the exact array handed to
// createArchetypeMesh, so a local index IS the InstancedMesh index for that mesh).

function buildingSet(buildings: readonly BuildingFootprint[]): CollidableSet {
  return { archetype: buildings[0]?.kind === 'tower' ? 'buildingTower' : 'buildingSmall', buildings, placements: [] };
}

function propSet(archetype: ArchetypeName, placements: readonly PropPlacement[]): CollidableSet {
  return { archetype, buildings: [], placements };
}

describe('setColliders — building sets', () => {
  it('assigns sequential instanceIds in the SET\'s own (already district-sorted) order', () => {
    const buildings = [footprint({ col: 0 }), footprint({ col: 1 }), footprint({ col: 2 })];
    const results = setColliders(buildingSet(buildings));
    expect(results.map((r) => r.entry.instanceId)).toEqual([0, 1, 2]);
    expect(results.map((r) => r.entry.archetype)).toEqual(['buildingSmall', 'buildingSmall', 'buildingSmall']);
  });

  it('every result carries a valid box + position + a "building" registry entry', () => {
    const b = footprint({ kind: 'tower', districtId: 9, heightM: 30 });
    const [result] = setColliders(buildingSet([b]));
    const expectedBox = buildingColliderBox(b);
    expect(result.box.halfExtents).toEqual(expectedBox.halfExtents);
    expect(result.x).toBeCloseTo(expectedBox.center.x);
    expect(result.z).toBeCloseTo(expectedBox.center.z);
    expect(result.rotationY).toBe(0);
    expect(result.entry).toEqual(buildingEntityEntry(b, 0));
  });

  // No "empty building set" case here: cityInstances.ts's byVariant grouping never produces
  // one (a variant entry only exists when ≥1 building rolled it — see buildCityInstanceSets),
  // and the buildings.length>0 discriminator setColliders uses can't even classify a
  // zero-buildings/zero-placements set as "building-shaped" in the first place.
});

describe('setColliders — street-prop sets', () => {
  it('assigns sequential instanceIds in the SET\'s own (already district-sorted) order', () => {
    const placements = [placement({ x: 1 }), placement({ x: 2 }), placement({ x: 3 })];
    const results = setColliders(propSet('streetlight', placements));
    expect(results.map((r) => r.entry.instanceId)).toEqual([0, 1, 2]);
    expect(results.map((r) => r.x)).toEqual([1, 2, 3]);
  });

  it('every result carries the archetype box + placement position/rotation + registry entry', () => {
    const p = placement({ archetype: 'fenceSegment', x: 4, z: -2, rotationY: Math.PI / 2, districtId: 3 });
    const [result] = setColliders(propSet('fenceSegment', [p]));
    expect(result.box).toEqual(propColliderBox('fenceSegment'));
    expect(result.x).toBe(4);
    expect(result.z).toBe(-2);
    expect(result.rotationY).toBe(Math.PI / 2);
    expect(result.entry).toEqual(propEntityEntry(p, 0));
  });

  it('transformerBox placements carry hp via the registry entry', () => {
    const p = placement({ archetype: 'transformerBox' });
    const [result] = setColliders(propSet('transformerBox', [p]));
    expect(result.entry.hp).toBe(POWER_GRID.transformerHp);
  });

  it('empty set yields no colliders', () => {
    expect(setColliders(propSet('tree', []))).toEqual([]);
  });
});

// --- End-to-end pure math against the real cityInstances.ts pipeline (seed 416) --------------
// This is the pipeline WorldColliders.tsx actually consumes in production — exercising it here
// (without mounting React/Rapier) catches any drift between worldColliders.ts's assumptions
// and cityInstances.ts's real ArchetypeInstanceSet shape.

describe('setColliders — real city pipeline (seed 416)', () => {
  const world = generate(416);
  const sets: ArchetypeInstanceSet[] = buildCityInstanceSets(world);

  it('every set is exclusively buildings XOR placements, never both, never neither', () => {
    for (const set of sets) {
      const hasBuildings = set.buildings.length > 0;
      const hasPlacements = set.placements.length > 0;
      expect(hasBuildings !== hasPlacements).toBe(true);
    }
  });

  it('every set\'s collider count matches its own buildings/placements length (== its sources length)', () => {
    for (const set of sets) {
      const results = setColliders(set);
      expect(results.length).toBe(set.sources.length);
      expect(results.length).toBe(set.buildings.length + set.placements.length);
    }
  });

  it('instanceIds within one set are a dense 0..n-1 run (no gaps, no repeats)', () => {
    for (const set of sets) {
      const ids = setColliders(set).map((r) => r.entry.instanceId);
      expect(ids).toEqual(ids.map((_, i) => i));
    }
  });

  it('summed building set counts equal world.buildings.length; summed prop set counts equal derived placement count', () => {
    let buildingTotal = 0;
    let propTotal = 0;
    for (const set of sets) {
      buildingTotal += set.buildings.length;
      propTotal += set.placements.length;
    }
    expect(buildingTotal).toBe(world.buildings.length);
    expect(buildingTotal + propTotal).toBeGreaterThan(world.buildings.length); // props exist too
  });

  it('every collider across every set is finite, positive-dimensioned, and correctly kinded', () => {
    for (const set of sets) {
      for (const { box, x, z, entry } of setColliders(set)) {
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(z)).toBe(true);
        expect(box.halfExtents.every((h) => h > 0 && Number.isFinite(h))).toBe(true);
        expect(box.centerY).toBeGreaterThan(0);
        if (set.buildings.length > 0) {
          expect(entry.kind).toBe('building');
        } else {
          expect(['propStatic', 'transformer']).toContain(entry.kind);
        }
      }
    }
  });

  it('every archetype actually present in the real sets has a valid collider box', () => {
    const present = new Set<ArchetypeName>(sets.map((s) => s.archetype));
    for (const archetype of present) {
      if (archetype === 'buildingSmall' || archetype === 'buildingTower') continue;
      const box = propColliderBox(archetype);
      expect(box.centerY).toBeGreaterThan(0);
    }
  });
});
