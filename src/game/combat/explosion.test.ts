import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CollisionGroup, TANK } from '../config';
import {
  EXPLOSION_QUERY_GROUPS,
  __resetExplosionForTest,
  blastDamage,
  blastFalloff,
  clampImpulseMag,
  dedupeByBody,
  detonate,
  radialLaunchDir,
  type BlastHitRef,
  type DetonateDeps,
} from './explosion';
import { clearRegistry, getEntity, registerEntity } from '../world/registry';
import { getGameState } from '../state/store';

// --- pure math ------------------------------------------------------------------------------

describe('blastFalloff (linear 1 → 0)', () => {
  it('is 1 at the center, 0 at/beyond the edge, linear between', () => {
    expect(blastFalloff(0, 8)).toBe(1);
    expect(blastFalloff(4, 8)).toBeCloseTo(0.5, 9);
    expect(blastFalloff(8, 8)).toBe(0);
    expect(blastFalloff(12, 8)).toBe(0); // clamped, never negative
  });
});

describe('blastDamage (35 → 5 linear, TDD §5.6)', () => {
  it('is dmgCenter at the center and dmgEdge at the edge', () => {
    expect(blastDamage(0, 8, 35, 5)).toBeCloseTo(35, 9);
    expect(blastDamage(8, 8, 35, 5)).toBeCloseTo(5, 9);
    expect(blastDamage(4, 8, 35, 5)).toBeCloseTo(20, 9); // halfway
  });
  it('clamps beyond the edge to dmgEdge', () => {
    expect(blastDamage(20, 8, 35, 5)).toBeCloseTo(5, 9);
  });
});

describe('clampImpulseMag', () => {
  it('scales by falloff', () => {
    expect(clampImpulseMag(20000, 0.5, 1200, 1e9, 1e9)).toBeCloseTo(10000, 6);
  });
  it('caps a light body by maxLaunchSpeed × mass (no rocketing)', () => {
    // 30 kg prop at full falloff: 20000 desired, but 16 m/s × 30 kg = 480 cap.
    expect(clampImpulseMag(20000, 1, 30, 24000, 16)).toBe(480);
  });
  it('applies the absolute ceiling to a very heavy body', () => {
    expect(clampImpulseMag(20000, 1, 100000, 24000, 16)).toBe(20000); // desired < both caps
    expect(clampImpulseMag(50000, 1, 100000, 24000, 16)).toBe(24000); // absolute ceiling
  });
  it('never goes negative', () => {
    expect(clampImpulseMag(20000, -1, 1200, 24000, 16)).toBe(0);
  });
});

describe('dedupeByBody', () => {
  it('keeps one collider per rigid body (first seen), order-preserving', () => {
    const hits: BlastHitRef[] = [
      { colliderHandle: 1, bodyHandle: 100 },
      { colliderHandle: 2, bodyHandle: 100 }, // same body → dropped
      { colliderHandle: 3, bodyHandle: 101 },
    ];
    expect(dedupeByBody(hits)).toEqual([
      { colliderHandle: 1, bodyHandle: 100 },
      { colliderHandle: 3, bodyHandle: 101 },
    ]);
  });
  it('keeps every body-less collider as distinct', () => {
    const hits: BlastHitRef[] = [
      { colliderHandle: 1, bodyHandle: undefined },
      { colliderHandle: 2, bodyHandle: undefined },
    ];
    expect(dedupeByBody(hits)).toHaveLength(2);
  });
});

describe('radialLaunchDir', () => {
  it('is a unit vector pointing outward with an upward kick', () => {
    const d = radialLaunchDir({ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, 0.35);
    expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 9);
    expect(d.x).toBeGreaterThan(0); // outward (+X)
    expect(d.y).toBeGreaterThan(0); // upKick lifts it
  });
  it('launches straight up when the body is at the blast point', () => {
    const d = radialLaunchDir({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }, 0.35);
    expect(d.y).toBeCloseTo(1, 9);
    expect(d.x).toBeCloseTo(0, 9);
    expect(d.z).toBeCloseTo(0, 9);
  });
});

describe('EXPLOSION_QUERY_GROUPS (friendly fire — includes pursuit)', () => {
  it('is membership PROJECTILE, filter includes PURSUIT and excludes building/ground/water', () => {
    const membership = EXPLOSION_QUERY_GROUPS >>> 16;
    const filter = EXPLOSION_QUERY_GROUPS & 0xffff;
    expect(membership).toBe(CollisionGroup.PROJECTILE);
    for (const g of ['PLAYER', 'PURSUIT', 'CIVILIAN', 'PROP_STATIC', 'PROP_DYNAMIC'] as const) {
      expect(filter & CollisionGroup[g]).not.toBe(0);
    }
    // No point launching indestructible fixed geometry / itself.
    expect(filter & CollisionGroup.BUILDING).toBe(0);
    expect(filter & CollisionGroup.GROUND).toBe(0);
    expect(filter & CollisionGroup.WATER).toBe(0);
    expect(filter & CollisionGroup.PROJECTILE).toBe(0);
  });
});

// --- detonate integration (mock Rapier world; real registry + store) ------------------------

type Vec = { x: number; y: number; z: number };

interface MockBody {
  pos: Vec;
  dynamic: boolean;
  massKg: number;
  wakeCount: number;
  impulses: Vec[];
  torques: Vec[];
  translation(): Vec;
  isDynamic(): boolean;
  mass(): number;
  wakeUp(): void;
  applyImpulse(v: Vec, wake: boolean): void;
  applyTorqueImpulse(v: Vec, wake: boolean): void;
}

function mockBody(pos: Vec, dynamic: boolean, massKg: number): MockBody {
  return {
    pos,
    dynamic,
    massKg,
    wakeCount: 0,
    impulses: [],
    torques: [],
    translation: () => pos,
    isDynamic: () => dynamic,
    mass: () => massKg,
    wakeUp() {
      this.wakeCount++;
    },
    applyImpulse(v) {
      this.impulses.push(v);
    },
    applyTorqueImpulse(v) {
      this.torques.push(v);
    },
  };
}

interface MockCollider {
  handle: number;
  body: MockBody | null;
  parent(): MockBody | null;
  translation(): Vec;
}

function mockCollider(handle: number, body: MockBody | null): MockCollider {
  return { handle, body, parent: () => body, translation: () => body?.pos ?? { x: 0, y: 0, z: 0 } };
}

function mockDeps(colliders: MockCollider[]): DetonateDeps {
  const world = {
    intersectionsWithShape: (
      _p: Vec,
      _r: unknown,
      _s: unknown,
      cb: (c: MockCollider) => boolean,
    ) => {
      for (const c of colliders) cb(c);
    },
  };
  const rapier = { Ball: class {} }; // constructor arg (radius) is ignored by the mock
  return { world, rapier } as unknown as DetonateDeps;
}

describe('detonate — friendly fire, dedupe, impulse, no player helicopter', () => {
  beforeEach(() => {
    clearRegistry();
    __resetExplosionForTest();
    getGameState().setPlayerHp(100);
  });
  afterEach(() => {
    clearRegistry();
  });

  it('damages the player AND a pursuit unit (no faction filter), dedupes per body, and never spins the player', () => {
    const point = { x: 0, y: 0, z: 0 };

    // Player at the center (dist 0 → 35 dmg).
    const playerBody = mockBody({ x: 0, y: 0, z: 0 }, true, 1200);
    registerEntity(10, { kind: 'player', districtId: -1 });

    // Pursuit (police) at dist 4 (half radius → 20 dmg), with TWO colliders on the SAME body —
    // the blast must hit it exactly once (dedupe by body).
    const copBody = mockBody({ x: 4, y: 0, z: 0 }, true, 1200);
    registerEntity(20, { kind: 'pursuit', districtId: -1, hp: 200, unitKind: 'police' });

    const deps = mockDeps([
      mockCollider(10, playerBody),
      mockCollider(20, copBody),
      mockCollider(21, copBody), // duplicate collider, same body → deduped away
    ]);

    detonate(deps, point);

    // Friendly fire: BOTH took damage.
    expect(getGameState().playerHp).toBeCloseTo(100 - 35, 6);
    expect(getEntity(20)?.hp).toBeCloseTo(200 - 20, 6); // once, not 40 (dedupe worked)

    // Both dynamic bodies were woken + launched.
    expect(playerBody.wakeCount).toBeGreaterThan(0);
    expect(copBody.wakeCount).toBeGreaterThan(0);
    expect(playerBody.impulses).toHaveLength(1);
    expect(copBody.impulses).toHaveLength(1);

    // The player gets ZERO angular impulse (never helicopters); the cop gets a tumble torque.
    expect(playerBody.torques).toHaveLength(0);
    expect(copBody.torques).toHaveLength(1);

    // Every applied impulse is finite (no NaN launch).
    for (const imp of [...playerBody.impulses, ...copBody.impulses]) {
      expect(Number.isFinite(imp.x) && Number.isFinite(imp.y) && Number.isFinite(imp.z)).toBe(true);
    }
  });

  it('skips damage/impulse on a KINEMATIC body but a hp entity still takes damage', () => {
    const point = { x: 0, y: 0, z: 0 };
    // A kinematic civilian (dynamic=false) with hp: damage lands, no impulse.
    const civBody = mockBody({ x: 2, y: 0, z: 0 }, false, 1200);
    registerEntity(30, { kind: 'civilian', districtId: -1, hp: 50 });
    const deps = mockDeps([mockCollider(30, civBody)]);

    detonate(deps, point);

    expect(getEntity(30)?.hp).toBeLessThan(50); // took blast damage
    expect(civBody.impulses).toHaveLength(0); // kinematic → no impulse
    expect(civBody.wakeCount).toBe(0);
  });

  it('uses the configured blast radius/damage constants', () => {
    // Guard against config drift silently changing the tested behavior.
    expect(TANK.blast.radius).toBe(8);
    expect(TANK.blast.dmgCenter).toBe(35);
    expect(TANK.blast.dmgEdge).toBe(5);
  });
});
