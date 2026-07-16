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

// Raycast-vehicle tuning (Phase 3 fun gate). Field names follow Rapier's
// DynamicRayCastVehicleController API where one exists. Every number here is
// live-tunable via the leva Config folder; values below are the tuned Phase 3
// baseline for the Rusty Sedan — the TDD gives only the targets (0→top ≈ 2.5 s,
// top ≈ 25 m/s = STARTER_TOP_SPEED, "toy-car bouncy"), not the numbers.
// Phase 17 derives the other five cars' params from this shape via their
// speed/accel/handling grades + massFactor.
export const VEHICLE_TUNING = {
  chassis: {
    // Cuboid half-extents (m): ~1.8 m wide, 4 m long sedan.
    halfWidth: 0.9,
    halfHeight: 0.35,
    halfLength: 2.0,
    massKg: 1200,
    // Center of mass dropped below the collider center: arcade anti-flip.
    comYOffset: -0.25,
  },
  engine: {
    maxForce: 20500,
    reverseForce: 12000,
    brakeForce: 60,
    // Handbrake: rear-wheel brake + rear friction drop (slide) — TDD §7.
    handbrakeForce: 18,
    handbrakeRearFrictionMul: 0.4,
    // Below this forward speed (m/s), a brake press flips to reverse instead (TDD §7).
    brakeToReverseSpeed: 1,
    // Reverse tops out at this fraction of STARTER_TOP_SPEED (arcade: reverse is slow).
    reverseSpeedCapPct: 0.4,
  },
  steering: {
    // Steer clamp eases from maxAngleDeg (standstill) to highSpeedAngleDeg (top speed).
    maxAngleDeg: 35,
    highSpeedAngleDeg: 14,
    // How fast the wheel angle chases the input, per second.
    rateDegPerSec: 260,
    returnRateDegPerSec: 340,
  },
  suspension: {
    restLength: 0.4,
    maxTravel: 0.25,
    stiffness: 42,
    compressionDamping: 4.0,
    relaxationDamping: 2.6,
    maxForce: 24000,
  },
  wheels: {
    radius: 0.34,
    // Chassis-local connection points: ±halfTrack on X, front/rear on Z,
    // connectionY below the chassis center.
    halfTrack: 0.78,
    frontZ: 1.25,
    rearZ: -1.3,
    connectionY: -0.15,
    frictionSlip: 3.2,
    sideFrictionStiffness: 1.0,
  },
  stability: {
    // High angular damping is the main arcade self-stabilizer (TDD §7).
    angularDamping: 3.0,
    linearDamping: 0.05,
    // Mild speed-scaled downforce: N per (m/s), applied -Y at chassis center.
    downforcePerSpeed: 40,
  },
} as const;

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
