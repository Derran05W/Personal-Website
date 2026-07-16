// Player garage + enemy roster tunables. TDD §5.9 (player cars), §5.6 (enemy roster).

// Starter car's top speed in m/s — the 100% baseline that enemy `topSpeedPct` values
// (TDD §5.6) are relative to. Concrete tuning target for the Phase 3 fun gate.
export const STARTER_TOP_SPEED = 25;

// Stat letter grades as shown in the TDD §5.9 table. Numeric mapping (grade -> actual
// accel curve / handling response) is Phase 3/17 work, not a config concern here.
export type StatGrade = 'A' | 'B' | 'C' | 'D';

export interface PlayerCarDef {
  readonly name: string;
  readonly speed: StatGrade;
  readonly accel: StatGrade;
  readonly handling: StatGrade;
  readonly hp: number;
  readonly massFactor: number;
  readonly character: string;
}

// Keyed by car id. TDD §5.9 table, in table order.
export const PLAYER_CARS = {
  rustySedan: {
    name: 'Rusty Sedan',
    speed: 'C',
    accel: 'C',
    handling: 'B',
    hp: 100,
    massFactor: 1.0,
    character: 'Honest, balanced',
  },
  streetRacer: {
    name: 'Street Racer',
    speed: 'A',
    accel: 'A',
    handling: 'A',
    hp: 60,
    massFactor: 0.8,
    character: 'Glass cannon — outrun everything, die to one tank shell',
  },
  pickup: {
    name: 'Pickup',
    speed: 'B',
    accel: 'C',
    handling: 'C',
    hp: 130,
    massFactor: 1.4,
    character: 'Good pusher, stable',
  },
  schoolBus: {
    name: 'School Bus',
    speed: 'D',
    accel: 'D',
    handling: 'D',
    hp: 220,
    massFactor: 2.6,
    character: 'Wrecking ball; smashes props without slowing',
  },
  monsterTruck: {
    name: 'Monster Truck',
    speed: 'C',
    accel: 'B',
    handling: 'C',
    hp: 180,
    massFactor: 2.2,
    character: 'Rides over civilian cars (crush = auto-wreck them)',
  },
  redRocket: {
    name: 'Red Rocket',
    speed: 'C',
    accel: 'D',
    handling: 'D',
    hp: 260,
    massFactor: 3.0,
    character: 'Absurd Toronto joke unlock; huge, nearly unstoppable, turns like a boat',
  },
} as const satisfies Record<string, PlayerCarDef>;

export type PlayerCarId = keyof typeof PLAYER_CARS;

// Enemy AI behavior kinds. TDD §5.6.
export type EnemyBehavior = 'pursuit' | 'flank' | 'standoff' | 'siege';

export interface EnemyUnitDef {
  readonly hp: number;
  readonly massFactor: number;
  // Top speed as a percentage of STARTER_TOP_SPEED. TDD §5.6.
  readonly topSpeedPct: number;
  readonly behavior: EnemyBehavior;
}

// Keyed by unit id. TDD §5.6 table.
export const ENEMY_UNITS = {
  police: { hp: 40, massFactor: 1.0, topSpeedPct: 105, behavior: 'pursuit' },
  armored: { hp: 90, massFactor: 1.6, topSpeedPct: 90, behavior: 'pursuit' },
  swat: { hp: 120, massFactor: 1.8, topSpeedPct: 100, behavior: 'flank' },
  gunTruck: { hp: 100, massFactor: 1.5, topSpeedPct: 95, behavior: 'standoff' },
  tank: { hp: 400, massFactor: 6.0, topSpeedPct: 55, behavior: 'siege' },
} as const satisfies Record<string, EnemyUnitDef>;

export type EnemyUnitId = keyof typeof ENEMY_UNITS;

// SWAT flanking behavior params. TDD §5.6: two units steer to +/-30 deg offsets ahead
// of the player to box in; others ram.
export const SWAT = {
  flankOffsetDeg: 30,
} as const;

// Gun truck standoff + turret burst params. TDD §5.6: orbits at ~20 m, closes to ram
// only if the player is slow/cornered; turret gunner fires 3-round hitscan bursts,
// 3 dmg + 600 N impulse per hit, 2.5 s cooldown. Tank gun params live in tank.ts.
export const GUN_TRUCK = {
  standoffRadius: 20,
  burst: {
    rounds: 3,
    dmgPerHit: 3,
    impulsePerHit: 600,
    cooldownSec: 2.5,
  },
} as const;
