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
    // Raised from 35/14 after the M1 user gate: "steering should be more sensitive".
    maxAngleDeg: 42,
    highSpeedAngleDeg: 22,
    // How fast the wheel angle chases the input, per second. Raised 260/340 → 400/500
    // for the same user-gate feedback (snappier response).
    rateDegPerSec: 400,
    returnRateDegPerSec: 500,
    // Arcade reverse steering (M1 user gate): while clearly reversing, flip the steer
    // response so the car's HEADING swings toward the pressed arrow. Physically-correct
    // reverse geometry (nose swings away from the wheel direction) reads as "backwards
    // controls" in a top-down arcade game.
    invertInReverse: true,
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
    // Raised 1.0 → 1.4 at the M1 user gate: the at-speed turn was grip-limited (more
    // steer angle changed nothing — fronts were sliding), so sensitivity comes from
    // lateral grip. Watch the flip-risk tradeoff (flat-ground torture must stay clean).
    sideFrictionStiffness: 1.4,
  },
  stability: {
    // High angular damping is the main arcade self-stabilizer (TDD §7). Lowered 3.0 →
    // 1.8 at the M1 user gate: at 3.0 it capped the yaw rate so hard that steering felt
    // numb at speed (raising steer angle/grip changed nothing). Flat-ground torture
    // stays clean at 1.8 (re-verified — see phase notes).
    angularDamping: 1.8,
    linearDamping: 0.05,
    // Mild speed-scaled downforce: N per (m/s), applied -Y at chassis center.
    downforcePerSpeed: 40,
  },
  // Fall-through safety catch (Phase 6 wave-2). Belt-and-suspenders behind the chassis↔GROUND
  // cuboid collision + CCD (which a headless Rapier reproduction proved already stop a stalled
  // car dead). NOT a feel parameter — the trigger sits below the ground plane (y=0), which the
  // car can only reach by punching clean through the map, so it never fires during normal
  // driving and cannot touch the M1-signed-off feel. See vehicles/steering.ts fallThroughCatch.
  safety: {
    // Chassis-center world Y below which the car counts as fallen-through and is caught.
    // Deep enough to sit under any legitimate suspension sag (worst measured ≈0.32 m) yet
    // above the fell-out net (BOUNDARY.fellOutResetY −5), so the catch fires first.
    triggerY: -0.5,
    // Lift a caught chassis to here — just above the ≈0.837 m settle height, so the wheel
    // rays are already in ground contact and the suspension takes over without a bounce.
    liftToY: 0.85,
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
//
// Phase 9 note (police): the pursuit chassis (ai/pursuitVehicle.ts) consumes these abstract
// stats DIRECTLY rather than duplicating them as concrete kg / scale leaves — massFactor 1.0
// resolves to 1200 kg against the 1200 kg reference chassis (VEHICLE_TUNING.chassis.massKg,
// which the reused RaycastVehicle applies verbatim), and topSpeedPct 105 → a 1.05 top-speed
// scale over STARTER_TOP_SPEED. Keeping ENEMY_UNITS the single source of truth (matching the
// TDD §5.6 table) avoids a massKg/topSpeedScale pair drifting out of sync with massFactor/
// topSpeedPct.
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

// Pursuit steering-behavior tunables (TDD §5.6 "AI implementation": seek/pursue with velocity
// lead, ram commitment, 3-ray obstacle avoidance, stuck recovery). Consumed by the PURE math
// in ai/aiSteering.ts (decisions cached at SPAWN.aiTickHz, forces applied every physics step)
// and the pursuit chassis overdrive in ai/pursuitVehicle.ts. All leva-live; the values below
// are the Phase 9 starting baseline (the TDD gives only the behavior, not the numbers) — any
// retune from these is recorded in the phase handoff notes.
export const AI_STEERING = {
  // Velocity LEAD: aim at playerPos + playerVel × leadTimeSec so the unit cuts toward where
  // the player is GOING, not where they are — this is what makes a moving player get boxed in.
  leadTimeSec: 0.35,
  // Ram COMMITMENT band: within this range of the player the unit drops the lead and drives
  // full-throttle straight at the player's CURRENT position — so a juke makes it overshoot
  // (relentless but dodgeable). Metres.
  commitDistM: 10,
  // Heading error (rad) → steer input gain, clamped to [-1,1]. ~0.45 rad (26°) → full lock.
  steerGain: 2.2,
  // --- 3-ray obstacle avoidance (rays cast center / ±avoidAngleDeg at think time, masked to
  // BUILDING|PROP_STATIC only — chasing through parks/dynamic debris is desired) ------------
  avoidAngleDeg: 15,
  // Ray length (m) and how far ahead of the chassis center the rays START (past the front
  // bumper so they never self-hit): ~halfLength + margin.
  avoidRayLenM: 9,
  avoidRayOriginAheadM: 2.3,
  // Height (m) the horizontal probe rays sit at — mid-body, clear of the ground slab (top
  // y=0) so they read building/prop boxes, not the road (mirrors traffic's RAY_HEIGHT_M).
  avoidRayHeightM: 0.6,
  // Side-ray blockage differential → steer-away weight; center-ray blockage → extra steer
  // toward the clearer side (deadzone below which the center ray is ignored as noise).
  avoidSideWeight: 1.3,
  avoidCenterWeight: 1.1,
  avoidCenterDeadzone: 0.12,
  // A wall dead ahead cuts throttle by up to this fraction so the avoidance turn can bite
  // instead of grinding head-on — but never below throttleFloor (keep closing = relentless).
  avoidThrottleCut: 0.65,
  throttleFloor: 0.35,
  // Ease the throttle off in hard turns (fraction of throttle removed at full lock, scaling
  // with |steer|). The AI — unlike a human — otherwise holds FULL throttle through full lock
  // at top speed, which launches/flips the reused raycast chassis. This keeps units planted on
  // straights (relentless) but composed through corners. Paired with downforcePerSpeed below.
  cornerThrottleEase: 0.5,
  // --- stuck recovery (wedged against a corner) --------------------------------------------
  // Below this planar speed (m/s) while trying to throttle, for stuckSec seconds, triggers a
  // reverseSec reversal phase (reverse + full lock toward the clearer side) to break free.
  stuckSpeedMps: 0.5,
  stuckSec: 3,
  reverseSec: 1,
  reverseSteer: 1,
  // --- chassis overdrive (ai/pursuitVehicle.ts) --------------------------------------------
  // The reused RaycastVehicle governs its engine force to zero at STARTER_TOP_SPEED, so a
  // >100% unit needs a small supplemental forward push in the (base, topSpeed) band to reach
  // its spec'd cap. Fraction of engine.maxForce available at the band bottom, tapering to 0
  // at topSpeed (so it can never run away). 0 = disable the overdrive (unit caps at 100%).
  overdriveGain: 0.5,
  // EXTRA speed-scaled downforce (N per m/s) applied to pursuit chassis in ai/pursuitVehicle.ts,
  // ON TOP of the shared VEHICLE_TUNING.stability.downforcePerSpeed (40) that keeps the human-
  // driven player planted. The AI floors into turns far harder than a human, so pursuit units
  // need more anti-launch grip; applied ONLY to pursuit bodies, never the player. Tuned so units
  // stay grounded at speed without feeling glued. (Solo units stay planted at ~1.1 m peak;
  // in a tight multi-unit pileup, collision impulses can still briefly toss one — inherent
  // swarm chaos that downforce can't cancel, left as an M4 feel-tuning watch-item.)
  downforcePerSpeed: 100,
  // --- wreck-by-flip detection (ai/units/policeSedan.ts) -----------------------------------
  // A pursuit unit wrecks on hp≤0 OR a sustained roll: uprightness (world-up·body-up) below
  // wreckUpDot for wreckFlipSustainSec seconds. Mirrors the civilian values (TRAFFIC_CIV) for
  // consistent "on its roof = dead" behavior across all vehicles.
  wreckUpDot: 0.3,
  wreckFlipSustainSec: 1.5,
} as const;
