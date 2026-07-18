import { describe, expect, it } from 'vitest';
import {
  HEAT,
  SPAWN,
  HELI,
  TANK,
  QUALITY_TIERS,
  QUALITY_TIER_ORDER,
  dynamicPropPoolCap,
  trafficActiveTarget,
  PROPS,
  TRAFFIC_CIV,
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

  it('QUALITY_TIER_ORDER lists every tier lowest→highest', () => {
    expect(QUALITY_TIER_ORDER).toEqual(['low', 'med', 'high']);
    expect([...QUALITY_TIER_ORDER].sort()).toEqual(Object.keys(QUALITY_TIERS).sort());
  });

  it('Phase 18 density knobs are present and bounded (0,1]', () => {
    for (const tier of Object.values(QUALITY_TIERS)) {
      expect(tier.trafficDensityModifier).toBeGreaterThan(0);
      expect(tier.trafficDensityModifier).toBeLessThanOrEqual(1);
      expect(tier.parkedCarKeepFraction).toBeGreaterThan(0);
      expect(tier.parkedCarKeepFraction).toBeLessThanOrEqual(1);
    }
    // high tier is the full-fat baseline (no trimming).
    expect(QUALITY_TIERS.high.trafficDensityModifier).toBe(1);
    expect(QUALITY_TIERS.high.parkedCarKeepFraction).toBe(1);
  });

  it('Phase 25.8 (D8) Toronto dress-tier knobs are present and bounded (0,1]', () => {
    for (const tier of Object.values(QUALITY_TIERS)) {
      expect(tier.dressDensityScalar).toBeGreaterThan(0);
      expect(tier.dressDensityScalar).toBeLessThanOrEqual(1);
      expect(tier.frontageOccupancyScalar).toBeGreaterThan(0);
      expect(tier.frontageOccupancyScalar).toBeLessThanOrEqual(1);
      expect(typeof tier.lampOverlay).toBe('boolean');
    }
    // high tier is the full-fat baseline (no trimming) — this is what makes it the
    // world/toronto TORONTO_TIER_IDENTITY (byte-identity golden tests in frontage.test.ts /
    // furniture.test.ts rely on exactly these three values being 1).
    expect(QUALITY_TIERS.high.dressDensityScalar).toBe(1);
    expect(QUALITY_TIERS.high.frontageOccupancyScalar).toBe(1);
    expect(QUALITY_TIERS.high.lampOverlay).toBe(true);
    // low tier drops the per-frame lamp-phase overlay; med keeps it (only draw-call/tri-budget
    // levers differ at med).
    expect(QUALITY_TIERS.low.lampOverlay).toBe(false);
    expect(QUALITY_TIERS.med.lampOverlay).toBe(true);
    // low is strictly the tightest tier on every dress lever (monotonic low <= med <= high).
    expect(QUALITY_TIERS.low.dressDensityScalar).toBeLessThan(QUALITY_TIERS.med.dressDensityScalar);
    expect(QUALITY_TIERS.med.dressDensityScalar).toBeLessThanOrEqual(QUALITY_TIERS.high.dressDensityScalar);
    expect(QUALITY_TIERS.low.frontageOccupancyScalar).toBeLessThan(QUALITY_TIERS.med.frontageOccupancyScalar);
  });
});

describe('per-tier budget resolvers (Phase 18)', () => {
  it('dynamicPropPoolCap scales the base pool by the tier dynamic-body share, capped at base', () => {
    const base = PROPS.dynamicPoolCap; // 60
    expect(dynamicPropPoolCap(base, 'high')).toBe(60);
    expect(dynamicPropPoolCap(base, 'med')).toBe(45); // 60 × 90/120
    expect(dynamicPropPoolCap(base, 'low')).toBe(30); // 60 × 60/120
  });

  it('dynamicPropPoolCap never exceeds base and never drops below 1', () => {
    expect(dynamicPropPoolCap(60, 'high')).toBeLessThanOrEqual(60);
    expect(dynamicPropPoolCap(1, 'low')).toBe(1);
    expect(dynamicPropPoolCap(0, 'low')).toBe(1);
  });

  it('trafficActiveTarget scales the base target by the tier density modifier', () => {
    const base = TRAFFIC_CIV.activeTarget; // 24
    expect(trafficActiveTarget(base, 'high')).toBe(24);
    expect(trafficActiveTarget(base, 'med')).toBe(20); // round(24 × 0.83)
    expect(trafficActiveTarget(base, 'low')).toBe(16); // round(24 × 0.67)
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
