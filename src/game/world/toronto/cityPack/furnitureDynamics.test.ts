// Phase 30 (T2 debt-1) — tests for the Toronto street-furniture launch pool's pure/structural
// surface. The imperative controller (FurniturePropSwapController) needs a live Rapier world/
// rapier namespace to construct — this codebase's established convention is Vitest for PURE
// logic and Playwright/live verification for anything Rapier-dependent (no test file in this
// repo constructs a real Rapier world), so this suite covers:
//   1. ARCHETYPE_MODEL_ID / launchableModelIds() — the archetype<->pack-model wiring is
//      complete and every id is real (getCityPackModel wouldn't throw).
//   2. resolveSwapTarget (world/propDynamics.ts, REUSED verbatim — never forked) correctly
//      gates the THREE new Toronto-only archetypes (trashCan/stopSign/busStop) against their
//      new PROPS.forceThresholds entries — the pre-existing four (hydrant/bench/tree/
//      trafficLight) are already covered generically by propDynamics.test.ts, so this only
//      proves the NEW wiring, not the shared mechanism a second time.
//   3. batchedRegistry.ts's register/get/unregister/clear round-trip (pure Map wrapper).
import { afterEach, describe, expect, it } from 'vitest';
import { getCityPackModel } from '../../../assets/cityPackManifest';
import { PROPS } from '../../../config';
import { resolveSwapTarget } from '../../propDynamics';
import type { EntityEntry } from '../../registry';
import type { ImpactRecord } from '../../../combat/types';
import { ARCHETYPE_MODEL_ID, POWER_BOX_MODEL_ID, launchableModelIds } from './furnitureDynamics';
import {
  clearBatchedFurnitureRegistry,
  getBatchedFurniture,
  registerBatchedFurniture,
  unregisterBatchedFurniture,
  type BatchedFurnitureHandle,
} from './batchedRegistry';

describe('ARCHETYPE_MODEL_ID', () => {
  it('maps exactly the debt-1 launchable archetypes to real, resolvable pack model ids', () => {
    const expected = ['hydrant', 'bench', 'tree', 'trafficLight', 'trashCan', 'stopSign', 'busStop'];
    expect(Object.keys(ARCHETYPE_MODEL_ID).sort()).toEqual([...expected].sort());
    for (const archetype of expected) {
      const modelId = ARCHETYPE_MODEL_ID[archetype as keyof typeof ARCHETYPE_MODEL_ID];
      expect(typeof modelId).toBe('string');
      expect(() => getCityPackModel(modelId as string)).not.toThrow();
    }
  });

  it('every mapped archetype has a configured mass + forceThreshold (resolveSwapTarget can gate it)', () => {
    const masses = PROPS.masses as Partial<Record<string, number>>;
    const thresholds = PROPS.forceThresholds as Partial<Record<string, number>>;
    for (const archetype of Object.keys(ARCHETYPE_MODEL_ID)) {
      expect(masses[archetype]).toBeGreaterThan(0);
      expect(thresholds[archetype]).toBeGreaterThan(0);
    }
  });
});

describe('launchableModelIds', () => {
  it('includes every ARCHETYPE_MODEL_ID value plus power-box, deduplicated', () => {
    const ids = launchableModelIds();
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids).toContain(POWER_BOX_MODEL_ID);
    for (const modelId of Object.values(ARCHETYPE_MODEL_ID)) {
      expect(ids).toContain(modelId);
    }
    // Every id resolves against the real manifest (would throw otherwise).
    for (const id of ids) expect(() => getCityPackModel(id)).not.toThrow();
  });
});

describe('resolveSwapTarget — new Toronto-only archetypes (trashCan/stopSign/busStop)', () => {
  function impact(a: EntityEntry | undefined, forceMag: number): ImpactRecord {
    return { aHandle: 1, bHandle: 2, a, b: undefined, forceMag };
  }

  it.each(['trashCan', 'stopSign', 'busStop'] as const)('%s: swaps at/over its threshold, stays nailed below it', (archetype) => {
    const threshold = (PROPS.forceThresholds as Record<string, number>)[archetype];
    const entry: EntityEntry = { kind: 'propStatic', archetype, instanceId: 3, districtId: 1 };

    const swapped = resolveSwapTarget(impact(entry, threshold));
    expect(swapped).toMatchObject({ handle: 1, archetype, instanceId: 3, districtId: 1 });

    const notSwapped = resolveSwapTarget(impact(entry, threshold - 1));
    expect(notSwapped).toBeNull();
  });
});

describe('batchedRegistry', () => {
  afterEach(() => clearBatchedFurnitureRegistry());

  it('registers, retrieves, and unregisters a handle by model id', () => {
    const handle: BatchedFurnitureHandle = { mesh: {} as BatchedFurnitureHandle['mesh'] };
    expect(getBatchedFurniture('fire-hydrant')).toBeUndefined();

    registerBatchedFurniture('fire-hydrant', handle);
    expect(getBatchedFurniture('fire-hydrant')).toBe(handle);

    unregisterBatchedFurniture('fire-hydrant');
    expect(getBatchedFurniture('fire-hydrant')).toBeUndefined();
  });

  it('a fresh registration under the same key replaces the previous one', () => {
    const first: BatchedFurnitureHandle = { mesh: {} as BatchedFurnitureHandle['mesh'] };
    const second: BatchedFurnitureHandle = { mesh: {} as BatchedFurnitureHandle['mesh'] };
    registerBatchedFurniture('bench', first);
    registerBatchedFurniture('bench', second);
    expect(getBatchedFurniture('bench')).toBe(second);
  });

  it('clearBatchedFurnitureRegistry drops every registration', () => {
    registerBatchedFurniture('tree', { mesh: {} as BatchedFurnitureHandle['mesh'] });
    registerBatchedFurniture('bench', { mesh: {} as BatchedFurnitureHandle['mesh'] });
    clearBatchedFurnitureRegistry();
    expect(getBatchedFurniture('tree')).toBeUndefined();
    expect(getBatchedFurniture('bench')).toBeUndefined();
  });
});
