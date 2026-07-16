import { describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { PROPS } from '../config';
import type { EntityEntry } from './registry';
import type { ImpactRecord } from '../combat/types';
import {
  computeLaunchImpulse,
  isExpired,
  matrixToTransform,
  resolveSwapTarget,
  selectEvictionIndex,
  type EvictionCandidate,
} from './propDynamics';

// --- Fixtures -----------------------------------------------------------------------------

function propEntry(overrides: Partial<EntityEntry> = {}): EntityEntry {
  return {
    kind: 'propStatic',
    archetype: 'streetlight',
    instanceId: 7,
    districtId: 3,
    ...overrides,
  };
}

function impact(a: EntityEntry | undefined, forceMag: number, point?: ImpactRecord['point']): ImpactRecord {
  return { aHandle: 42, bHandle: 99, a, b: undefined, forceMag, point };
}

// --- resolveSwapTarget: the threshold + kind gate -----------------------------------------

describe('resolveSwapTarget', () => {
  const threshold = PROPS.forceThresholds.streetlight; // 600 N

  it('swaps a propStatic at/over its per-archetype threshold', () => {
    const target = resolveSwapTarget(impact(propEntry(), threshold));
    expect(target).not.toBeNull();
    expect(target).toMatchObject({ handle: 42, archetype: 'streetlight', instanceId: 7, districtId: 3 });
  });

  it('leaves a prop nailed down below threshold (love-tap)', () => {
    expect(resolveSwapTarget(impact(propEntry(), threshold - 1))).toBeNull();
  });

  it('never swaps a transformer (HP-based, damage-resolver domain)', () => {
    expect(resolveSwapTarget(impact(propEntry({ kind: 'transformer' }), 1e6))).toBeNull();
  });

  it('ignores non-prop contacts (e.g. building/ground)', () => {
    expect(resolveSwapTarget(impact(propEntry({ kind: 'building' }), 1e6))).toBeNull();
    expect(resolveSwapTarget(impact(undefined, 1e6))).toBeNull();
  });

  it('ignores archetypes with no configured threshold (e.g. transformerBox)', () => {
    expect(resolveSwapTarget(impact(propEntry({ archetype: 'transformerBox' }), 1e6))).toBeNull();
  });

  it('resolves the static side when it is the b-handle', () => {
    const record: ImpactRecord = {
      aHandle: 1,
      bHandle: 2,
      a: { kind: 'propDynamic', archetype: 'bench', instanceId: 0, districtId: 0 },
      b: propEntry({ archetype: 'mailbox' }),
      forceMag: 1e6,
    };
    const target = resolveSwapTarget(record);
    expect(target).toMatchObject({ handle: 2, archetype: 'mailbox' });
  });
});

// --- computeLaunchImpulse ------------------------------------------------------------------

describe('computeLaunchImpulse', () => {
  it('launches away from the impact point with an upward kick', () => {
    const force = 1000; // under launchForceCap
    const impulse = computeLaunchImpulse({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, force);
    const mag = force * PROPS.launchImpulseScale;
    expect(impulse.x).toBeCloseTo(mag, 5); // unit +X direction
    expect(impulse.y).toBeCloseTo(PROPS.launchUpKick * mag, 5);
    expect(impulse.z).toBeCloseTo(0, 5);
  });

  it('clamps force to launchForceCap', () => {
    const impulse = computeLaunchImpulse({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 0 }, 1e9);
    const mag = PROPS.launchForceCap * PROPS.launchImpulseScale;
    expect(impulse.z).toBeCloseTo(mag, 5);
  });

  it('collapses to a pure upward kick when direction is degenerate', () => {
    const force = 500;
    const impulse = computeLaunchImpulse({ x: 2, y: 3, z: 4 }, { x: 2, y: 3, z: 4 }, force);
    expect(impulse.x).toBe(0);
    expect(impulse.z).toBe(0);
    expect(impulse.y).toBeCloseTo(PROPS.launchUpKick * force * PROPS.launchImpulseScale, 5);
  });
});

// --- selectEvictionIndex: oldest sleeping, else oldest ------------------------------------

describe('selectEvictionIndex', () => {
  it('evicts the oldest SLEEPING slot when any are sleeping', () => {
    const slots: EvictionCandidate[] = [
      { seq: 5, sleeping: false },
      { seq: 2, sleeping: true },
      { seq: 8, sleeping: true },
    ];
    expect(selectEvictionIndex(slots)).toBe(1); // seq 2, sleeping
  });

  it('prefers a sleeping slot even when a younger one, over an older awake slot', () => {
    const slots: EvictionCandidate[] = [
      { seq: 1, sleeping: false }, // oldest, but awake
      { seq: 9, sleeping: true }, // younger, sleeping
    ];
    expect(selectEvictionIndex(slots)).toBe(1);
  });

  it('falls back to the globally oldest when none are sleeping', () => {
    const slots: EvictionCandidate[] = [
      { seq: 5, sleeping: false },
      { seq: 2, sleeping: false },
      { seq: 8, sleeping: false },
    ];
    expect(selectEvictionIndex(slots)).toBe(1); // seq 2
  });
});

// --- isExpired -----------------------------------------------------------------------------

describe('isExpired', () => {
  it('expires exactly at the despawn window', () => {
    expect(isExpired(0, PROPS.despawnAfterSec, PROPS.despawnAfterSec)).toBe(true);
  });
  it('is not expired just before', () => {
    expect(isExpired(0, PROPS.despawnAfterSec - 0.001, PROPS.despawnAfterSec)).toBe(false);
  });
});

// --- matrixToTransform: transform capture from an instance matrix -------------------------

describe('matrixToTransform', () => {
  it('recovers the position and yaw baked into an instance matrix', () => {
    const pos = new Vector3(12, 0, -34);
    const quat = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 3);
    const m = new Matrix4().compose(pos, quat, new Vector3(1, 1, 1));

    const out = matrixToTransform(m, new Vector3(), new Quaternion(), new Vector3());
    expect(out.position.x).toBeCloseTo(12, 5);
    expect(out.position.y).toBeCloseTo(0, 5);
    expect(out.position.z).toBeCloseTo(-34, 5);
    // Quaternion recovered up to sign; compare via dot magnitude ~ 1.
    const dot = out.quaternion.x * quat.x + out.quaternion.y * quat.y + out.quaternion.z * quat.z + out.quaternion.w * quat.w;
    expect(Math.abs(dot)).toBeCloseTo(1, 5);
  });
});
