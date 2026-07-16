import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetContactsForTest,
  dispatchContactForce,
  dispatchImpact,
  getImpactCount,
  onImpact,
} from './contacts';
import type { ImpactRecord } from './types';
import { clearRegistry, registerEntity, type EntityEntry } from '../world/registry';

// The spine resolves handles through the REAL registry (a plain Map) rather than a mock —
// registerEntity/clearRegistry give us exact control over which handles have identities, and
// exercising the real lookup is the point of the test.
const PLAYER: EntityEntry = { kind: 'player', districtId: -1 };
const STREETLIGHT: EntityEntry = { kind: 'propStatic', archetype: 'streetlight', instanceId: 7, districtId: 3 };

beforeEach(() => {
  clearRegistry();
  __resetContactsForTest();
});

afterEach(() => {
  clearRegistry();
  __resetContactsForTest();
});

describe('onImpact subscription', () => {
  it('delivers dispatched records to a subscriber and returns a working unsubscribe', () => {
    const seen: ImpactRecord[] = [];
    const unsubscribe = onImpact((r) => seen.push(r));

    dispatchImpact(1, 2, 500);
    expect(seen).toHaveLength(1);

    unsubscribe();
    dispatchImpact(1, 2, 500);
    expect(seen).toHaveLength(1); // no further delivery after unsubscribe
  });

  it('notifies every registered handler', () => {
    const a = vi.fn();
    const b = vi.fn();
    onImpact(a);
    onImpact(b);

    dispatchImpact(1, 2, 100);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('isolates a throwing handler so siblings still run (and dispatch never throws)', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const survivor = vi.fn();
    onImpact(() => {
      throw new Error('boom');
    });
    onImpact(survivor);

    expect(() => dispatchImpact(1, 2, 100)).not.toThrow();
    expect(survivor).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('dispatchImpact registry resolution', () => {
  it('attaches both registry identities when both handles are registered', () => {
    registerEntity(10, PLAYER);
    registerEntity(20, STREETLIGHT);
    let record: ImpactRecord | undefined;
    onImpact((r) => (record = r));

    dispatchImpact(10, 20, 750);

    expect(record).toBeDefined();
    expect(record?.aHandle).toBe(10);
    expect(record?.bHandle).toBe(20);
    expect(record?.a).toBe(PLAYER);
    expect(record?.b).toBe(STREETLIGHT);
    expect(record?.forceMag).toBe(750);
  });

  it('still dispatches when a handle has no registry entry (undefined passthrough)', () => {
    registerEntity(10, PLAYER);
    let record: ImpactRecord | undefined;
    onImpact((r) => (record = r));

    // Handle 99 is unregistered (e.g. the ground, or a not-yet-registered collider).
    dispatchImpact(10, 99, 300);

    expect(record).toBeDefined();
    expect(record?.a).toBe(PLAYER);
    expect(record?.b).toBeUndefined();
  });

  it('is policy-free: the spine applies NO force threshold, delivering tiny and huge alike', () => {
    const seen: number[] = [];
    onImpact((r) => seen.push(r.forceMag));

    dispatchImpact(1, 2, 0.001); // a love-tap
    dispatchImpact(1, 2, 999_999); // a full-speed plow

    expect(seen).toEqual([0.001, 999_999]);
  });

  it('carries an optional contact point through, and omits it when not supplied', () => {
    const seen: ImpactRecord[] = [];
    onImpact((r) => seen.push(r));

    dispatchImpact(1, 2, 100, { x: 1, y: 2, z: 3 });
    dispatchImpact(1, 2, 100);

    expect(seen[0].point).toEqual({ x: 1, y: 2, z: 3 });
    expect(seen[1].point).toBeUndefined();
  });
});

describe('dispatchContactForce adapter', () => {
  it('maps target/other collider handles and totalForceMagnitude into a dispatch', () => {
    registerEntity(10, PLAYER);
    registerEntity(20, STREETLIGHT);
    let record: ImpactRecord | undefined;
    onImpact((r) => (record = r));

    // Minimal stand-in for @react-three/rapier's ContactForcePayload — only the fields the
    // adapter reads. `target` is the player (the body whose callback fired), `other` the hit.
    const payload = {
      target: { collider: { handle: 10 } },
      other: { collider: { handle: 20 } },
      totalForceMagnitude: 1234,
    } as unknown as Parameters<typeof dispatchContactForce>[0];

    dispatchContactForce(payload);

    expect(record?.aHandle).toBe(10);
    expect(record?.bHandle).toBe(20);
    expect(record?.a).toBe(PLAYER);
    expect(record?.b).toBe(STREETLIGHT);
    expect(record?.forceMag).toBe(1234);
    expect(record?.point).toBeUndefined(); // Rapier's ContactForceEvent has no point
  });
});

describe('getImpactCount (DEV diagnostic)', () => {
  it('counts each dispatched record (import.meta.env.DEV is truthy under vitest)', () => {
    expect(getImpactCount()).toBe(0);
    dispatchImpact(1, 2, 100);
    dispatchImpact(1, 2, 100);
    expect(getImpactCount()).toBe(2);
  });
});
