import { describe, expect, it } from 'vitest';
import {
  HEAT,
  SPAWN,
  HELI,
  TANK,
  QUALITY_TIERS,
  PLAYER_CARS,
  ENEMY_UNITS,
  BUSTED,
  UNLOCKS,
  unlockedCarIdsForScore,
  CollisionGroup,
  COLLIDES_WITH,
  interactionGroups,
  type CollisionGroupName,
  type EnemyUnitDef,
} from './index';

describe('heat', () => {
  it('tier thresholds are ascending, length 6, start at 0', () => {
    expect(HEAT.tierThresholds).toHaveLength(6);
    expect(HEAT.tierThresholds[0]).toBe(0);
    for (let i = 1; i < HEAT.tierThresholds.length; i++) {
      expect(HEAT.tierThresholds[i]).toBeGreaterThan(HEAT.tierThresholds[i - 1]);
    }
  });

  it('spot-checks exact TDD §5.5 values', () => {
    expect(HEAT.events.tankWreck).toBe(100);
    expect(HEAT.events.policeWreck).toBe(25);
    expect(HEAT.events.transformer).toBe(12);
    expect(HEAT.passivePerSec).toBe(1);
  });
});

describe('spawn + heli', () => {
  it('caps length matches tier count, caps[0] is 0', () => {
    expect(SPAWN.caps).toHaveLength(HEAT.tierThresholds.length);
    expect(SPAWN.caps[0]).toBe(0);
  });

  it('heli perTier has length 6', () => {
    expect(HELI.perTier).toHaveLength(6);
  });
});

describe('tank', () => {
  it('spot-checks exact TDD §5.6 values', () => {
    expect(TANK.blast.impulse).toBe(20_000);
    expect(TANK.shellSpeed).toBe(45);
    expect(TANK.turretYawDegPerSec).toBe(60);
  });
});

describe('busted', () => {
  it('spot-checks exact TDD §5.10 values', () => {
    expect(BUSTED.holdSec).toBe(3);
    expect(BUSTED.maxSpeed).toBe(1);
    expect(BUSTED.minPursuers).toBe(3);
    expect(BUSTED.pursuerRadius).toBe(8);
  });
});

describe('collision groups', () => {
  const names = Object.keys(CollisionGroup) as CollisionGroupName[];

  it('interaction table is symmetric: a includes b iff b includes a', () => {
    for (const a of names) {
      for (const b of names) {
        const aIncludesB = (COLLIDES_WITH[a] & CollisionGroup[b]) !== 0;
        const bIncludesA = (COLLIDES_WITH[b] & CollisionGroup[a]) !== 0;
        expect(aIncludesB).toBe(bIncludesA);
      }
    }
  });

  it('projectile does not collide with projectile', () => {
    expect(COLLIDES_WITH.PROJECTILE & CollisionGroup.PROJECTILE).toBe(0);
  });

  it('water collides with exactly the three vehicle groups', () => {
    expect(COLLIDES_WITH.WATER).toBe(
      CollisionGroup.PLAYER | CollisionGroup.PURSUIT | CollisionGroup.CIVILIAN,
    );
  });

  it('packed interactionGroups has the PLAYER bit in the high 16 bits', () => {
    const packed = interactionGroups('PLAYER');
    expect(packed >>> 16).toBe(CollisionGroup.PLAYER);
  });
});

describe('quality tiers', () => {
  it('has exactly high/med/low', () => {
    expect(Object.keys(QUALITY_TIERS).sort()).toEqual(['high', 'low', 'med']);
  });

  it('dprCap is never above 2', () => {
    for (const tier of Object.values(QUALITY_TIERS)) {
      expect(tier.dprCap).toBeLessThanOrEqual(2);
    }
  });

  it('low tier has shadows off', () => {
    expect(QUALITY_TIERS.low.shadowMapSize).toBe(0);
  });
});

describe('vehicles', () => {
  it('PLAYER_CARS has exactly the six ids, all with positive hp', () => {
    const ids = Object.keys(PLAYER_CARS).sort();
    expect(ids).toEqual(
      ['monsterTruck', 'pickup', 'redRocket', 'rustySedan', 'schoolBus', 'streetRacer'].sort(),
    );
    for (const car of Object.values(PLAYER_CARS)) {
      expect(car.hp).toBeGreaterThan(0);
    }
  });

  it('ENEMY_UNITS has the five kinds', () => {
    expect(Object.keys(ENEMY_UNITS).sort()).toEqual(
      ['armored', 'gunTruck', 'police', 'swat', 'tank'].sort(),
    );
  });

  it('Phase 10: armored/swat escalate hp, mass, and ram multiplier over police', () => {
    expect(ENEMY_UNITS.armored.hp).toBeGreaterThan(ENEMY_UNITS.police.hp);
    expect(ENEMY_UNITS.swat.hp).toBeGreaterThan(ENEMY_UNITS.armored.hp);
    expect(ENEMY_UNITS.armored.massFactor).toBeGreaterThan(ENEMY_UNITS.police.massFactor);
    expect(ENEMY_UNITS.swat.massFactor).toBeGreaterThan(ENEMY_UNITS.armored.massFactor);
    expect(ENEMY_UNITS.armored.ramDamageMultiplier ?? 1).toBeGreaterThan(
      ENEMY_UNITS.police.ramDamageMultiplier ?? 1,
    );
    expect(ENEMY_UNITS.swat.ramDamageMultiplier ?? 1).toBeGreaterThan(
      ENEMY_UNITS.armored.ramDamageMultiplier ?? 1,
    );
  });

  it('only armored defines a shoveImpulse', () => {
    // ENEMY_UNITS is `as const`, so each entry's literal type only carries the keys actually
    // written for it — widen to EnemyUnitDef (structurally compatible; optional fields simply
    // absent) to assert absence on police/swat without a type error.
    const police: EnemyUnitDef = ENEMY_UNITS.police;
    const swat: EnemyUnitDef = ENEMY_UNITS.swat;
    expect(ENEMY_UNITS.armored.shoveImpulse).toBeGreaterThan(0);
    expect(police.shoveImpulse).toBeUndefined();
    expect(swat.shoveImpulse).toBeUndefined();
  });
});

describe('unlocks (Phase 17)', () => {
  it('UNLOCKS has exactly the six PLAYER_CARS ids, rustySedan at threshold 0', () => {
    expect(Object.keys(UNLOCKS).sort()).toEqual(Object.keys(PLAYER_CARS).sort());
    expect(UNLOCKS.rustySedan).toBe(0);
  });

  it('thresholds are non-negative and strictly ascending in PLAYER_CARS table order', () => {
    const values = Object.values(UNLOCKS);
    expect(values.every((v) => v >= 0)).toBe(true);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });

  describe('unlockedCarIdsForScore', () => {
    it('rustySedan is unlocked at score 0 (threshold 0)', () => {
      expect(unlockedCarIdsForScore(0)).toEqual(['rustySedan']);
    });

    it('a score just below a threshold does not unlock that car (already-unlocked ones stay)', () => {
      const ids = unlockedCarIdsForScore(UNLOCKS.streetRacer - 1);
      expect(ids).toContain('rustySedan');
      expect(ids).not.toContain('streetRacer');
    });

    it('a score exactly at a threshold unlocks that car (inclusive)', () => {
      expect(unlockedCarIdsForScore(UNLOCKS.streetRacer)).toContain('streetRacer');
    });

    it('is idempotent — a higher score never drops a previously unlocked car', () => {
      const lower = new Set(unlockedCarIdsForScore(UNLOCKS.pickup));
      const higher = new Set(unlockedCarIdsForScore(UNLOCKS.pickup + 10_000));
      for (const id of lower) expect(higher.has(id)).toBe(true);
    });

    it('a score at/above the top threshold unlocks every car', () => {
      expect(unlockedCarIdsForScore(UNLOCKS.redRocket).sort()).toEqual(Object.keys(UNLOCKS).sort());
    });
  });
});
