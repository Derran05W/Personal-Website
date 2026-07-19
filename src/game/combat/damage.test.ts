import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BufferGeometry,
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
} from 'three';
import {
  applyImpact,
  computeDamage,
  initDamageSystem,
  massFactorOf,
  playerMassFactor,
  ramDamageMultiplier,
  resetSparkThrottle,
  type DamageConfig,
} from './damage';
import { ENEMY_UNITS, PLAYER_CARS } from '../config/vehicles';
import { dispatchImpact, __resetContactsForTest } from './contacts';
import type { ImpactRecord } from './types';
import { clearRegistry, registerEntity, type EntityEntry } from '../world/registry';
import {
  clearArchetypeRegistry,
  registerArchetypeHandles,
  type ArchetypeHandles,
} from '../world/instancing';
import { DAMAGE } from '../config/damage';
import { gameEvents } from '../state/events';
import { getGameState, useGameStore } from '../state/store';
import { getShakeTrauma, resetShake } from '../fx/cameraRig';
import { drainFxBursts, resetFxFeed } from '../fx/particleFeed';
import { CAMERA } from '../config/camera';

// --- fixtures --------------------------------------------------------------------------------

const PLAYER: EntityEntry = { kind: 'player', districtId: -1 };

function transformer(hp: number, districtId = 2, instanceId = 0): EntityEntry {
  return { kind: 'transformer', archetype: 'transformerBox', instanceId, districtId, hp };
}

function parkedCar(hp: number, instanceId = 3, districtId = 5): EntityEntry {
  return { kind: 'propStatic', archetype: 'parkedCar', instanceId, districtId, hp };
}

/** A pursuit unit registry entry (Phase 10) — police/armored/swat, carrying its unitKind. */
function pursuitUnit(unitKind: 'police' | 'armored' | 'swat', hp = 999): EntityEntry {
  return { kind: 'pursuit', districtId: -1, hp, unitKind };
}

/** A hp-LESS static prop (mailbox etc.) — the swap-emits-propDestroyed side per the file
 * header's contract; this resolver must never touch it. */
function hpLessProp(): EntityEntry {
  return { kind: 'propStatic', archetype: 'mailbox', instanceId: 1, districtId: 0 };
}

function impact(
  a: EntityEntry | undefined,
  b: EntityEntry | undefined,
  forceMag: number,
  point?: { x: number; y: number; z: number },
): ImpactRecord {
  return { aHandle: 1, bHandle: 2, a, b, forceMag, point };
}

/** Builds a one-instance InstancedMesh and registers it under 'transformerBox' so
 * handleTransformerDeath's setColorAt/getArchetypeHandles path has something real to hit. */
function buildTransformerMesh(): ArchetypeHandles {
  const geometry = new BufferGeometry();
  const material = new MeshBasicMaterial();
  const mesh = new InstancedMesh(geometry, material, 1);
  const emissiveAttr = new InstancedBufferAttribute(new Float32Array(1).fill(1), 1);
  const handles: ArchetypeHandles = {
    name: 'transformerBox',
    variantKey: 'default',
    mesh,
    emissiveAttr,
    ranges: [{ districtId: 0, start: 0, count: 1 }],
  };
  registerArchetypeHandles('transformerBox', handles);
  return handles;
}

const initialStoreState = useGameStore.getState();

beforeEach(() => {
  clearRegistry();
  clearArchetypeRegistry();
  __resetContactsForTest();
  useGameStore.setState(initialStoreState, true);
  resetShake();
  resetFxFeed();
  resetSparkThrottle();
});

afterEach(() => {
  clearRegistry();
  clearArchetypeRegistry();
  __resetContactsForTest();
  gameEvents.clearAllListeners();
  resetShake();
  resetFxFeed();
  resetSparkThrottle();
});

// --- computeDamage (pure core) ---------------------------------------------------------------

describe('computeDamage', () => {
  const cfg: DamageConfig = { collisionK: 2, minImpactSpeed: 4, forceToSpeedProxy: 100 };

  it('scales linearly with the force-derived speed proxy and the mass factor', () => {
    // forceMag 1000 / forceToSpeedProxy 100 = speed proxy 10; 10 >= minImpactSpeed(4).
    // damage = collisionK(2) * 10 * massFactor(1.5) = 30.
    expect(computeDamage(1000, 1.5, cfg)).toBeCloseTo(30, 10);
  });

  it('is thresholded: below minImpactSpeed (proxy) deals zero damage (love-taps free)', () => {
    // forceMag 300 / 100 = proxy 3, below minImpactSpeed 4.
    expect(computeDamage(300, 1, cfg)).toBe(0);
  });

  it('the threshold is a strict "<": just below the cutoff is free, AT the cutoff deals damage', () => {
    expect(computeDamage(399, 1, cfg)).toBe(0); // proxy 3.99, strictly below minImpactSpeed(4)
    expect(computeDamage(400, 1, cfg)).toBeGreaterThan(0); // proxy exactly 4, not "< 4"
  });

  it('zero/negative forceMag deals no damage', () => {
    expect(computeDamage(0, 5, cfg)).toBe(0);
    expect(computeDamage(-500, 5, cfg)).toBe(0);
  });

  it('zero/negative otherMassFactor deals no damage', () => {
    expect(computeDamage(1000, 0, cfg)).toBe(0);
    expect(computeDamage(1000, -1, cfg)).toBe(0);
  });

  it('a heavier "other" side deals proportionally more damage', () => {
    const light = computeDamage(1000, 0.5, cfg);
    const heavy = computeDamage(1000, 2, cfg);
    expect(heavy).toBeCloseTo(light * 4, 10);
  });

  it('defaults cfg to the live DAMAGE config when omitted', () => {
    // Just needs to run without throwing and stay consistent with an explicit-cfg call.
    expect(computeDamage(100000, 1)).toBe(computeDamage(100000, 1, DAMAGE));
  });
});

// --- massFactorOf ------------------------------------------------------------------------------

describe('massFactorOf', () => {
  it('the player resolves to the SELECTED car\'s massFactor — default rustySedan = 1 (the reference mass)', () => {
    // beforeEach resets the store to its initial state (selectedCarId 'rustySedan', massFactor 1.0),
    // so the pre-Phase-17 "player is always 1" behaviour holds byte-for-byte for the default car.
    expect(massFactorOf(PLAYER)).toBe(1);
  });

  it('a known archetype resolves to mass / referenceMassKg', () => {
    // transformerBox: 400kg / referenceMassKg.
    expect(massFactorOf(transformer(30))).toBeCloseTo(400 / DAMAGE.referenceMassKg, 10);
    expect(massFactorOf(parkedCar(40))).toBeCloseTo(1200 / DAMAGE.referenceMassKg, 10);
  });

  it('an unlisted archetype, undefined entry, or archetype-less entry defaults to 1', () => {
    expect(massFactorOf(undefined)).toBe(1);
    expect(massFactorOf({ kind: 'building', districtId: 0 })).toBe(1);
    expect(massFactorOf({ kind: 'ground', districtId: -1 })).toBe(1);
  });

  // --- Phase 10: pursuit-unit mass factors (armored/swat) --------------------------------------

  it('a pursuit entry with a unitKind resolves DIRECTLY to ENEMY_UNITS[unitKind].massFactor (not divided by referenceMassKg again)', () => {
    expect(massFactorOf(pursuitUnit('police'))).toBe(ENEMY_UNITS.police.massFactor);
    expect(massFactorOf(pursuitUnit('armored'))).toBe(ENEMY_UNITS.armored.massFactor);
    expect(massFactorOf(pursuitUnit('swat'))).toBe(ENEMY_UNITS.swat.massFactor);
  });

  it('armored/swat are heavier than police (1.6x / 1.8x vs 1.0x)', () => {
    expect(massFactorOf(pursuitUnit('armored'))).toBeGreaterThan(massFactorOf(pursuitUnit('police')));
    expect(massFactorOf(pursuitUnit('swat'))).toBeGreaterThan(massFactorOf(pursuitUnit('armored')));
  });

  it('a pursuit entry with no unitKind (should not happen in practice) falls back to 1, not a crash', () => {
    expect(massFactorOf({ kind: 'pursuit', districtId: -1, hp: 40 })).toBe(1);
  });
});

// --- Phase 17: selected-car mass threading (both directions) ----------------------------------

describe('playerMassFactor / selected-car damage scaling (Phase 17)', () => {
  it('playerMassFactor() and massFactorOf(player) track the selected car', () => {
    getGameState().setSelectedCar('schoolBus');
    expect(playerMassFactor()).toBe(PLAYER_CARS.schoolBus.massFactor); // 2.6
    expect(massFactorOf(PLAYER)).toBe(PLAYER_CARS.schoolBus.massFactor);

    getGameState().setSelectedCar('streetRacer');
    expect(playerMassFactor()).toBe(PLAYER_CARS.streetRacer.massFactor); // 0.8
    expect(massFactorOf(PLAYER)).toBe(PLAYER_CARS.streetRacer.massFactor);

    getGameState().setSelectedCar('rustySedan');
    expect(massFactorOf(PLAYER)).toBe(1); // the reference car
  });

  // Direction 1: damage OTHERS take from a PLAYER ram scales with the selected car's massFactor.
  it('a heavier player car deals proportionally MORE damage to what it rams (bus 2.6x > sedan 1x > racer 0.8x)', () => {
    // Force chosen so even the bus's scaled damage (1.2 × 10 × 2.6 = 31.2) stays under
    // DAMAGE.maxSingleHit (60) — otherwise the cap would clip the ratio (found live: at a
    // higher force the bus clipped to 60 and bus/sedan read 2.0 instead of 2.6).
    const forceMag = DAMAGE.forceToSpeedProxy * (DAMAGE.minImpactSpeed + 5);
    function damageDealtBy(carId: 'streetRacer' | 'rustySedan' | 'schoolBus'): number {
      getGameState().setSelectedCar(carId);
      const t = transformer(1_000_000); // effectively indestructible: isolates one hit's damage
      applyImpact(impact(PLAYER, t, forceMag));
      return 1_000_000 - (t.hp ?? 0);
    }
    const racer = damageDealtBy('streetRacer');
    const sedan = damageDealtBy('rustySedan');
    const bus = damageDealtBy('schoolBus');

    expect(bus).toBeGreaterThan(sedan);
    expect(sedan).toBeGreaterThan(racer);
    // Exact ratio = the massFactor ratio (same base formula, only the player mass factor differs).
    expect(bus / sedan).toBeCloseTo(PLAYER_CARS.schoolBus.massFactor / PLAYER_CARS.rustySedan.massFactor, 6);
    expect(racer / sedan).toBeCloseTo(PLAYER_CARS.streetRacer.massFactor / PLAYER_CARS.rustySedan.massFactor, 6);
  });

  // Direction 2: damage the PLAYER takes is governed by the ATTACKER's mass, NOT the player's car —
  // a fragile racer does NOT take reduced incoming damage (its fragility is its 60 hp, not a discount).
  it('the damage the player TAKES from a given attacker is identical across player cars', () => {
    const forceMag = DAMAGE.forceToSpeedProxy * (DAMAGE.minImpactSpeed + 20);
    function playerLossAs(carId: 'streetRacer' | 'schoolBus'): number {
      getGameState().setSelectedCar(carId);
      getGameState().setPlayerHp(100000); // isolate one hit
      const before = getGameState().playerHp;
      applyImpact(impact(PLAYER, transformer(1_000_000), forceMag));
      return before - getGameState().playerHp;
    }
    expect(playerLossAs('streetRacer')).toBeCloseTo(playerLossAs('schoolBus'), 9);
  });
});

// --- ramDamageMultiplier (Phase 10) -----------------------------------------------------------

describe('ramDamageMultiplier', () => {
  it('police is 1 (explicit config value, same as the neutral default)', () => {
    expect(ramDamageMultiplier(pursuitUnit('police'))).toBe(1);
  });

  it('armored is 1.15, swat is 1.5 — swat hits hardest', () => {
    expect(ramDamageMultiplier(pursuitUnit('armored'))).toBeCloseTo(1.15, 10);
    expect(ramDamageMultiplier(pursuitUnit('swat'))).toBeCloseTo(1.5, 10);
    expect(ramDamageMultiplier(pursuitUnit('swat'))).toBeGreaterThan(ramDamageMultiplier(pursuitUnit('armored')));
    expect(ramDamageMultiplier(pursuitUnit('armored'))).toBeGreaterThan(ramDamageMultiplier(pursuitUnit('police')));
  });

  it('a non-pursuit or undefined attacker defaults to 1 (no multiplier)', () => {
    expect(ramDamageMultiplier(undefined)).toBe(1);
    expect(ramDamageMultiplier({ kind: 'player', districtId: -1 })).toBe(1);
    expect(ramDamageMultiplier({ kind: 'civilian', districtId: -1 })).toBe(1);
  });

  it('a pursuit entry with no unitKind defaults to 1', () => {
    expect(ramDamageMultiplier({ kind: 'pursuit', districtId: -1 })).toBe(1);
  });
});

// --- applyImpact: hp-bearing registry entries --------------------------------------------------

describe('applyImpact — transformer', () => {
  it('decrements hp using the OTHER side (player)\'s mass factor', () => {
    const t = transformer(30);
    // Force well above threshold: forceMag/forceToSpeedProxy >= minImpactSpeed.
    const forceMag = DAMAGE.forceToSpeedProxy * (DAMAGE.minImpactSpeed + 10);
    applyImpact(impact(PLAYER, t, forceMag));
    expect(t.hp).toBeLessThan(30);
    expect(t.hp).toBeGreaterThan(0);
  });

  it('a love-tap (force under threshold) leaves hp untouched', () => {
    const t = transformer(30);
    applyImpact(impact(PLAYER, t, 1)); // tiny force
    expect(t.hp).toBe(30);
  });

  it('dies at hp<=0: emits transformerDestroyed exactly once, hp clamped at 0', () => {
    const events: { districtId: number }[] = [];
    gameEvents.on('transformerDestroyed', (p) => events.push(p));
    const t = transformer(1, 7); // 1 hp — trivially lethal
    const forceMag = DAMAGE.forceToSpeedProxy * (DAMAGE.minImpactSpeed + 50);

    applyImpact(impact(PLAYER, t, forceMag));
    expect(t.hp).toBe(0);
    expect(events).toEqual([{ districtId: 7 }]);

    // Further hits on an already-dead transformer must not re-fire the death event.
    applyImpact(impact(PLAYER, t, forceMag));
    expect(t.hp).toBe(0);
    expect(events).toHaveLength(1);
  });

  it('tints the transformer\'s InstancedMesh instance dark on death', () => {
    const handles = buildTransformerMesh();
    const t = transformer(1, 4, 0);
    const forceMag = DAMAGE.forceToSpeedProxy * (DAMAGE.minImpactSpeed + 50);

    applyImpact(impact(PLAYER, t, forceMag));

    expect(handles.mesh.instanceColor).not.toBeNull();
    const readBack = new Color();
    handles.mesh.getColorAt(0, readBack);
    expect(readBack.getHexString()).toBe(new Color(DAMAGE.deadTransformerColor).getHexString());
  });

  it('death path does not throw when the archetype has no live InstancedMesh (e.g. a bare unit test)', () => {
    const t = transformer(1);
    const forceMag = DAMAGE.forceToSpeedProxy * (DAMAGE.minImpactSpeed + 50);
    expect(() => applyImpact(impact(PLAYER, t, forceMag))).not.toThrow();
  });

  // --- Phase 16: transformerDestroyed's world position (fx/eventFx.ts's spark burst) ---------

  it('carries the dead transformer\'s world position (x/y/z), read off its live InstancedMesh instance', () => {
    const handles = buildTransformerMesh();
    handles.mesh.setMatrixAt(0, new Matrix4().makeTranslation(5, 0.6, -3));
    const events: { districtId: number; x?: number; y?: number; z?: number }[] = [];
    gameEvents.on('transformerDestroyed', (p) => events.push(p));
    const t = transformer(1, 4, 0);
    const forceMag = DAMAGE.forceToSpeedProxy * (DAMAGE.minImpactSpeed + 50);

    applyImpact(impact(PLAYER, t, forceMag));

    expect(events).toHaveLength(1);
    // Precision 5, not 9: InstancedMesh's instanceMatrix is a Float32Array (matrixToTransform's
    // own test above uses the same tolerance for the same reason — float32 round-trip, not
    // float64), so an exact-to-9-decimals match would spuriously fail.
    expect(events[0].x).toBeCloseTo(5, 5);
    expect(events[0].y).toBeCloseTo(0.6, 5);
    expect(events[0].z).toBeCloseTo(-3, 5);
  });

  it('omits x/y/z when the archetype has no live InstancedMesh this run (no position to derive)', () => {
    const events: { districtId: number; x?: number }[] = [];
    gameEvents.on('transformerDestroyed', (p) => events.push(p));
    const t = transformer(1);
    const forceMag = DAMAGE.forceToSpeedProxy * (DAMAGE.minImpactSpeed + 50);

    applyImpact(impact(PLAYER, t, forceMag));

    expect(events).toHaveLength(1);
    expect(events[0].x).toBeUndefined();
  });
});

describe('applyImpact — parked car (hp-bearing non-transformer prop)', () => {
  it('emits propDestroyed{archetype} on hp-death (the resolver half of the split contract)', () => {
    const events: { archetype: string }[] = [];
    gameEvents.on('propDestroyed', (p) => events.push(p));
    const car = parkedCar(1);
    const forceMag = DAMAGE.forceToSpeedProxy * (DAMAGE.minImpactSpeed + 50);

    applyImpact(impact(PLAYER, car, forceMag));

    expect(car.hp).toBe(0);
    expect(events).toEqual([{ archetype: 'parkedCar' }]);
  });

  it('never emits propDestroyed for an hp-less prop — that half belongs to propDynamics.ts', () => {
    const events: { archetype: string }[] = [];
    gameEvents.on('propDestroyed', (p) => events.push(p));
    const mailbox = hpLessProp();
    const forceMag = DAMAGE.forceToSpeedProxy * (DAMAGE.minImpactSpeed + 50);

    expect(() => applyImpact(impact(PLAYER, mailbox, forceMag))).not.toThrow();
    expect(events).toHaveLength(0);
    expect(mailbox.hp).toBeUndefined();
  });

  // --- Phase 16: propDestroyed's world position (fx/eventFx.ts's debrisChips burst) ----------

  it('forwards the impact record\'s contact point into propDestroyed\'s x/y/z when it has one', () => {
    const events: { archetype: string; x?: number; y?: number; z?: number }[] = [];
    gameEvents.on('propDestroyed', (p) => events.push(p));
    const car = parkedCar(1);
    const forceMag = DAMAGE.forceToSpeedProxy * (DAMAGE.minImpactSpeed + 50);

    applyImpact(impact(PLAYER, car, forceMag, { x: 12, y: 0.5, z: -7 }));

    expect(events).toEqual([{ archetype: 'parkedCar', x: 12, y: 0.5, z: -7 }]);
  });

  it('omits x/y/z when the impact record carries no contact point (Rapier didn\'t report one)', () => {
    const events: { archetype: string; x?: number }[] = [];
    gameEvents.on('propDestroyed', (p) => events.push(p));
    const car = parkedCar(1);
    const forceMag = DAMAGE.forceToSpeedProxy * (DAMAGE.minImpactSpeed + 50);

    applyImpact(impact(PLAYER, car, forceMag)); // no point

    expect(events).toHaveLength(1);
    expect(events[0].x).toBeUndefined();
  });
});

// --- applyImpact: propDynamic yielding-body proxy (Phase 29 — found live in Toronto verification) --
// Toronto's parked cars/lane-closure cones are registered ALREADY dynamic (world/toronto/
// torontoColliders.ts — never fixed-then-swapped), so a real ram against one measured only
// ~4,000-14,000 N live (a yielding body gives way, same physics as the player<->pursuit case
// vehicleRamForceProxy already exists for) — the GLOBAL proxy's forceToSpeedProxy=125,000 would
// never cross minImpactSpeed at that force, so parked cars could never be damaged/scored however
// hard rammed. applySideDamage's isYieldingBodyPair widening fixes this by applying the SAME
// reduced vehicleRamForceProxy to player<->propDynamic pairs.
function dynamicParkedCar(hp: number, districtId = 5): EntityEntry {
  return { kind: 'propDynamic', archetype: 'parkedCar', districtId, hp };
}

describe('applyImpact — propDynamic yielding-body proxy (Phase 29)', () => {
  it('a force far below the GLOBAL proxy threshold (measured live: a real 6+ m/s ram read ~14,000 N) still damages a propDynamic prop via the reduced proxy', () => {
    const car = dynamicParkedCar(40);
    // 14,000 N is what Phase 29 T1's live verification actually measured ramming a Toronto
    // parked car at ~6.3 m/s — nowhere near the global proxy's 625,000 N threshold, but a
    // "solid ram" band force (matching other tests' convention) clears the REDUCED proxy easily.
    const solidRamForce = DAMAGE.vehicleRamForceProxy * (DAMAGE.minImpactSpeed + 2);
    expect(solidRamForce / DAMAGE.forceToSpeedProxy).toBeLessThan(DAMAGE.minImpactSpeed); // would be free under the old (global-only) formula

    applyImpact(impact(PLAYER, car, solidRamForce));

    expect(car.hp).toBeLessThan(40);
  });

  it('the same force against the STATIC (propStatic) parked-car fixture — pre-swap legacy shape — also damages (regression: widening must not narrow the existing propStatic path)', () => {
    const car = parkedCar(40);
    const solidRamForce = DAMAGE.forceToSpeedProxy * (DAMAGE.minImpactSpeed + 2);
    applyImpact(impact(PLAYER, car, solidRamForce));
    expect(car.hp).toBeLessThan(40);
  });

  it('a genuinely tiny nudge (below even the reduced proxy) still deals no damage — not a blanket bypass', () => {
    const car = dynamicParkedCar(40);
    const tinyForce = DAMAGE.vehicleRamForceProxy * (DAMAGE.minImpactSpeed - 1); // below threshold
    applyImpact(impact(PLAYER, car, tinyForce));
    expect(car.hp).toBe(40);
  });

  it('driving THIS car into the player (reverse direction) is symmetric — same reduced proxy applies', () => {
    const car = dynamicParkedCar(999999); // effectively indestructible, isolate player hp loss
    getGameState().setPlayerHp(100000);
    const before = getGameState().playerHp;
    const solidRamForce = DAMAGE.vehicleRamForceProxy * (DAMAGE.minImpactSpeed + 10);

    applyImpact(impact(car, PLAYER, solidRamForce));

    expect(getGameState().playerHp).toBeLessThan(before);
  });

  it('the SAME between-proxies force damages a propDynamic prop but NOT a propStatic one — proves the widening is KIND-gated, not a blanket proxy swap', () => {
    // Strictly between the two thresholds: clears the reduced proxy's minImpactSpeed
    // (100,000 / 12,000 ≈ 8.3 ≥ 5) but not the global proxy's (100,000 / 125,000 = 0.8 < 5).
    const betweenProxies = 100_000;
    expect(betweenProxies / DAMAGE.vehicleRamForceProxy).toBeGreaterThanOrEqual(DAMAGE.minImpactSpeed);
    expect(betweenProxies / DAMAGE.forceToSpeedProxy).toBeLessThan(DAMAGE.minImpactSpeed);

    const dynamicCar = dynamicParkedCar(40);
    applyImpact(impact(PLAYER, dynamicCar, betweenProxies));
    expect(dynamicCar.hp).toBeLessThan(40); // propDynamic -> reduced proxy -> damages

    const staticCar = parkedCar(40); // propStatic (pre-swap legacy shape)
    applyImpact(impact(PLAYER, staticCar, betweenProxies));
    expect(staticCar.hp).toBe(40); // propStatic -> global proxy -> below threshold, free
  });
});

// --- applyImpact: player hp (store, not registry) -----------------------------------------------

describe('applyImpact — player damage', () => {
  it('drains store playerHp and emits playerDamaged{hp, amount}', () => {
    const events: { hp: number; amount: number }[] = [];
    gameEvents.on('playerDamaged', (p) => events.push(p));
    const t = transformer(9999); // effectively indestructible for this test
    const forceMag = DAMAGE.forceToSpeedProxy * (DAMAGE.minImpactSpeed + 20);

    const before = getGameState().playerHp;
    applyImpact(impact(PLAYER, t, forceMag));

    expect(getGameState().playerHp).toBeLessThan(before);
    expect(events).toHaveLength(1);
    expect(events[0].hp).toBe(getGameState().playerHp);
    expect(events[0].amount).toBeGreaterThan(0);
  });

  it('clamps at 0 and does not double-emit once already at 0', () => {
    const events: { hp: number; amount: number }[] = [];
    gameEvents.on('playerDamaged', (p) => events.push(p));
    getGameState().setPlayerHp(0.001);
    const t = transformer(9999);
    const forceMag = DAMAGE.forceToSpeedProxy * (DAMAGE.minImpactSpeed + 200); // huge overkill hit

    applyImpact(impact(PLAYER, t, forceMag));
    expect(getGameState().playerHp).toBe(0);
    expect(events).toHaveLength(1);

    applyImpact(impact(PLAYER, t, forceMag));
    expect(getGameState().playerHp).toBe(0);
    expect(events).toHaveLength(1); // no further emission once already at 0
  });

  it('a love-tap deals no damage and does not emit', () => {
    const events: unknown[] = [];
    gameEvents.on('playerDamaged', (p) => events.push(p));
    const t = transformer(9999);
    applyImpact(impact(PLAYER, t, 1));
    expect(events).toHaveLength(0);
  });
});

// --- applyImpact: ram damage multiplier direction (Phase 10) ------------------------------------

describe('applyImpact — ram damage multiplier (Phase 10)', () => {
  // Above the vehicle-pair (dynamic-vs-dynamic) threshold — see DAMAGE.vehicleRamForceProxy.
  const ramForceMag = DAMAGE.vehicleRamForceProxy * (DAMAGE.minImpactSpeed + 10);

  function playerHpLostTo(unitKind: 'police' | 'armored' | 'swat'): number {
    getGameState().setPlayerHp(100000); // effectively indestructible, isolates one hit's damage
    const before = getGameState().playerHp;
    applyImpact(impact(PLAYER, pursuitUnit(unitKind), ramForceMag));
    return before - getGameState().playerHp;
  }

  it('a unit ramming the PLAYER scales by its own ramDamageMultiplier: swat > armored > police', () => {
    const police = playerHpLostTo('police');
    const armored = playerHpLostTo('armored');
    const swat = playerHpLostTo('swat');

    expect(armored).toBeGreaterThan(police);
    expect(swat).toBeGreaterThan(armored);
    // Matches ENEMY_UNITS' own massFactor × ramDamageMultiplier product exactly (both scale the
    // same base formula), not just "greater than" — pins the actual multiplier math.
    expect(swat / police).toBeCloseTo(
      (ENEMY_UNITS.swat.massFactor * (ENEMY_UNITS.swat.ramDamageMultiplier ?? 1)) /
        (ENEMY_UNITS.police.massFactor * (ENEMY_UNITS.police.ramDamageMultiplier ?? 1)),
      6,
    );
  });

  it('the PLAYER ramming a unit does NOT apply the unit\'s ram multiplier (directional only) — same damage to any unit kind', () => {
    const forceMag = ramForceMag;
    const police = pursuitUnit('police', 99999);
    const armored = pursuitUnit('armored', 99999);
    const swat = pursuitUnit('swat', 99999);

    applyImpact(impact(police, PLAYER, forceMag));
    applyImpact(impact(armored, PLAYER, forceMag));
    applyImpact(impact(swat, PLAYER, forceMag));

    // Damage taken depends only on the OTHER side (the player)'s mass factor, which is always
    // 1 — the target unit's own kind/multiplier must not affect what it takes from a player ram.
    const policeLoss = 99999 - (police.hp ?? 0);
    const armoredLoss = 99999 - (armored.hp ?? 0);
    const swatLoss = 99999 - (swat.hp ?? 0);
    expect(armoredLoss).toBeCloseTo(policeLoss, 10);
    expect(swatLoss).toBeCloseTo(policeLoss, 10);
  });
});

// --- single-hit damage cap (Phase 16 Task 3: closes a known large-teleport HP spike) -----------

describe('applyImpact — single-hit damage cap (Phase 16 Task 3)', () => {
  // Absurdly large — far beyond anything a real contact-force event could produce; exactly the
  // pathological "large-teleport HP spike" this cap exists to close.
  const hugeForceMag = DAMAGE.forceToSpeedProxy * 1_000_000;

  it('clamps a huge force so the player never loses more than DAMAGE.maxSingleHit in one contact event', () => {
    const events: { hp: number; amount: number }[] = [];
    gameEvents.on('playerDamaged', (p) => events.push(p));
    getGameState().setPlayerHp(100000); // effectively indestructible, isolates one hit's damage
    const t = transformer(9999);

    applyImpact(impact(PLAYER, t, hugeForceMag));

    expect(events).toHaveLength(1);
    expect(events[0].amount).toBe(DAMAGE.maxSingleHit);
    expect(getGameState().playerHp).toBeCloseTo(100000 - DAMAGE.maxSingleHit, 9);
  });

  it('clamps a huge force against an hp-bearing registry entity (transformer) the same way', () => {
    const t = transformer(9999);

    applyImpact(impact(PLAYER, t, hugeForceMag));

    expect(t.hp).toBeCloseTo(9999 - DAMAGE.maxSingleHit, 9);
  });

  it('does not clip an ordinary hit that lands under the cap', () => {
    const t = transformer(9999);
    // A normal moderate hit — well under maxSingleHit per config/damage.ts's own tuning notes
    // (a full-speed square building hit is ~25-35 hp; maxSingleHit is 45).
    const forceMag = DAMAGE.forceToSpeedProxy * (DAMAGE.minImpactSpeed + 5);

    applyImpact(impact(PLAYER, t, forceMag));

    const lost = 9999 - (t.hp ?? 0);
    expect(lost).toBeGreaterThan(0);
    expect(lost).toBeLessThan(DAMAGE.maxSingleHit);
  });

  it('the ram-multiplier-inflated damage is ALSO capped (the clamp runs after the multiplier)', () => {
    // Above the vehicle-pair (dynamic-vs-dynamic) threshold, using SWAT's 1.5x ram multiplier —
    // huge enough that even the fully-multiplied value would blow past the cap unclamped.
    getGameState().setPlayerHp(100000);
    const before = getGameState().playerHp;
    const forceMag = DAMAGE.vehicleRamForceProxy * 1_000_000;

    applyImpact(impact(PLAYER, pursuitUnit('swat'), forceMag));

    expect(before - getGameState().playerHp).toBe(DAMAGE.maxSingleHit);
  });
});

// --- guards: undefined / hp-less / no-op combinations --------------------------------------------

describe('applyImpact — defensive guards', () => {
  it('does nothing (and never throws) when both sides are undefined (unregistered colliders)', () => {
    expect(() => applyImpact(impact(undefined, undefined, 99999))).not.toThrow();
  });

  it('two hp-less, non-player entries produce no damage/events', () => {
    const a = hpLessProp();
    const b: EntityEntry = { kind: 'building', districtId: 0 };
    const events: unknown[] = [];
    gameEvents.on('propDestroyed', (p) => events.push(p));
    gameEvents.on('transformerDestroyed', (p) => events.push(p));

    applyImpact(impact(a, b, DAMAGE.forceToSpeedProxy * (DAMAGE.minImpactSpeed + 50)));

    expect(events).toHaveLength(0);
  });
});

// --- camera shake ------------------------------------------------------------------------------

// A force just above shakeForceThreshold whose resulting trauma sits at the MIDPOINT
// between the threshold's own trauma and the shake cap — chosen (rather than an arbitrary
// literal) so these tests assert a real, non-capped, non-trivial value regardless of how
// shakeForceThreshold/shakeForceScale/CAMERA.shake.maxAmplitude get retuned later, as long
// as the threshold itself maps to less trauma than the cap (true today: 0.48 < 0.5).
const thresholdTrauma = DAMAGE.shakeForceThreshold * DAMAGE.shakeForceScale;
const capRoom = CAMERA.shake.maxAmplitude - thresholdTrauma;
const nonCappedForceMag = DAMAGE.shakeForceThreshold + capRoom / 2 / DAMAGE.shakeForceScale;

describe('applyImpact — camera shake', () => {
  it('adds trauma for impacts above shakeForceThreshold', () => {
    expect(getShakeTrauma()).toBe(0);
    applyImpact(impact(undefined, undefined, nonCappedForceMag));
    expect(getShakeTrauma()).toBeCloseTo(nonCappedForceMag * DAMAGE.shakeForceScale, 9);
  });

  it('adds no trauma below shakeForceThreshold', () => {
    applyImpact(impact(undefined, undefined, DAMAGE.shakeForceThreshold - 1));
    expect(getShakeTrauma()).toBe(0);
  });

  it('shakes exactly once per impact, not once per side (both-sides-defined == neither-defined)', () => {
    const forceMag = nonCappedForceMag;

    resetShake();
    applyImpact(impact(undefined, undefined, forceMag));
    const neitherSide = getShakeTrauma();

    resetShake();
    const t = transformer(9999);
    applyImpact(impact(PLAYER, t, forceMag));
    const bothSides = getShakeTrauma();

    expect(bothSides).toBeCloseTo(neitherSide, 10);
  });

  // --- Phase 16 Task 3: impactSparks burst, pushed alongside shake for the same hits ----------

  it('pushes an impactSparks burst at the contact point for a shake-worthy hit', () => {
    const t = transformer(9999);
    applyImpact(impact(PLAYER, t, nonCappedForceMag, { x: 4, y: 1, z: -2 }));

    const seen: { preset: string; x: number; y: number; z: number }[] = [];
    drainFxBursts(-1, (b) => seen.push({ preset: b.preset, x: b.x, y: b.y, z: b.z }));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ preset: 'impactSparks', x: 4, y: 1, z: -2 });
  });

  it('pushes no impactSparks burst below shakeForceThreshold', () => {
    applyImpact(impact(undefined, undefined, DAMAGE.shakeForceThreshold - 1));

    const seen: unknown[] = [];
    drainFxBursts(-1, (b) => seen.push(b));
    expect(seen).toHaveLength(0);
  });

  // --- Phase 16 integration hardening: the two spark-only gates (see maybeShakeAndSpark's
  // doc comment — both were found live, with the pool pinned at 500/500 during a slide) ------

  it('a bare-ground scrape (one unregistered side) shakes but never sparks', () => {
    applyImpact(impact(PLAYER, undefined, nonCappedForceMag, { x: 1, y: 0, z: 1 }));

    expect(getShakeTrauma()).toBeGreaterThan(0);
    const seen: unknown[] = [];
    drainFxBursts(-1, (b) => seen.push(b));
    expect(seen).toHaveLength(0);
  });

  it('wedge-spam impacts inside sparkMinIntervalMs push exactly one burst', () => {
    const t = transformer(9999);
    applyImpact(impact(PLAYER, t, nonCappedForceMag, { x: 4, y: 1, z: -2 }));
    applyImpact(impact(PLAYER, t, nonCappedForceMag, { x: 4, y: 1, z: -2 }));
    applyImpact(impact(PLAYER, t, nonCappedForceMag, { x: 4, y: 1, z: -2 }));

    const seen: unknown[] = [];
    drainFxBursts(-1, (b) => seen.push(b));
    expect(seen).toHaveLength(1);

    // Once the throttle window has passed, the next wedge step sparks again.
    resetSparkThrottle();
    applyImpact(impact(PLAYER, t, nonCappedForceMag, { x: 4, y: 1, z: -2 }));
    const seen2: unknown[] = [];
    drainFxBursts(-1, (b) => seen2.push(b));
    expect(seen2).toHaveLength(2); // drain re-reads from -1: the prior burst + the new one
  });
});

// --- initDamageSystem: real spine integration --------------------------------------------------

describe('initDamageSystem (live combat/contacts.ts wiring)', () => {
  it('subscribes applyImpact to onImpact and applies damage through a real dispatch', () => {
    registerEntity(10, PLAYER);
    const t = transformer(1);
    registerEntity(20, t);

    const unsubscribe = initDamageSystem();
    const forceMag = DAMAGE.forceToSpeedProxy * (DAMAGE.minImpactSpeed + 50);
    dispatchImpact(10, 20, forceMag);

    expect(t.hp).toBe(0);

    unsubscribe();
    const t2 = transformer(1);
    registerEntity(21, t2);
    dispatchImpact(10, 21, forceMag);
    // Unsubscribed: a fresh dispatch must not reach the resolver anymore.
    expect(t2.hp).toBe(1);
  });
});
