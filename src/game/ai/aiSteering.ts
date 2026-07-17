// Pure pursuit-steering math (Phase 9 Task 2; TDD §5.6 "AI implementation"). Numbers in,
// numbers out — NO three.js / Rapier imports, so the fun-critical chase curves unit-test
// without the wasm module (mirrors vehicles/steering.ts's split from raycastVehicle.ts).
// The caller (ai/units/policeSedan.ts) reads the live pose/velocity off the Rapier body,
// casts the three avoidance rays imperatively at think time, and feeds the results here; the
// returned VehicleInputs-shaped command is cached and applied every physics step.
//
// Behavior (all four blended into one steer/throttle/brake command):
//   • pursue  — seek the player with a VELOCITY LEAD (aim where they're going), full throttle.
//   • ram     — inside commitDistM, drop the lead and drive straight at the player's CURRENT
//               position at full throttle, so a juke makes the unit overshoot (dodgeable).
//   • avoid   — blend steering away from the more-blocked of two side rays, ease throttle when
//               a wall is dead ahead — around buildings/static props (parks are chased through).
//   • stuck   — wedged (slow while throttling for stuckSec) → a reverseSec reversal phase
//               (reverse + full lock toward the clearer side) to break free.
//
// Angle convention (matches ai/traffic.ts + raycastVehicle.ts): +Z is model-forward, yaw =
// atan2(dx, dz), and +yaw (toward +X) is the car's RIGHT — which is also +steer (DrivingInput
// steer +1 = right). So a positive heading error (target to the right) yields positive steer.

export interface PursuitSteerParams {
  readonly leadTimeSec: number;
  readonly commitDistM: number;
  readonly steerGain: number;
  readonly avoidSideWeight: number;
  readonly avoidCenterWeight: number;
  readonly avoidCenterDeadzone: number;
  readonly avoidThrottleCut: number;
  readonly throttleFloor: number;
  readonly cornerThrottleEase: number;
  readonly stuckSpeedMps: number;
  readonly stuckSec: number;
  readonly reverseSec: number;
  readonly reverseSteer: number;
}

/** Per-unit steering memory carried between 10 Hz decisions. */
export interface StuckState {
  /** Accumulated time (s) spent below stuckSpeed while trying to throttle. */
  readonly slowSec: number;
  /** Remaining time (s) in an active reversal phase (0 = not reversing). */
  readonly reverseRemainSec: number;
  /** Steer sign held for the duration of the current reversal (toward the clearer side). */
  readonly reverseDir: number;
}

export const initialStuckState: StuckState = { slowSec: 0, reverseRemainSec: 0, reverseDir: 1 };

/**
 * Forward-avoidance ray results. Each is the fraction 0..1 of the ray length at which it hit
 * an obstacle (1 = no hit / fully clear, 0 = obstacle at the ray origin). `left` is the ray
 * cast at yaw − avoidAngle (car's left), `right` at yaw + avoidAngle (car's right), `center`
 * straight ahead. Only BUILDING|PROP_STATIC colliders block these (the caller's ray mask).
 */
export interface AvoidHits {
  readonly center: number;
  readonly left: number;
  readonly right: number;
}

export interface SteerCommand {
  /** -1 (full left) .. 1 (full right). */
  readonly steer: number;
  /** 0..1. */
  readonly throttle: number;
  /** 0..1 (the pursuit chassis flips brake to reverse below crawl speed — used by stuck). */
  readonly brake: number;
}

export type SteerBehavior = 'pursue' | 'ram' | 'avoid' | 'stuck';

export interface PursueResult {
  readonly command: SteerCommand;
  readonly stuck: StuckState;
  readonly behavior: SteerBehavior;
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function clampUnit(v: number): number {
  if (v < -1) return -1;
  if (v > 1) return 1;
  return v;
}

/** Yaw (rad) facing a +Z-forward model down (dx,dz); 0 for a zero delta. */
export function yawToward(dx: number, dz: number): number {
  if (dx === 0 && dz === 0) return 0;
  return Math.atan2(dx, dz);
}

/** Shortest signed angle equivalent to `a`, wrapped to (−π, π]. */
export function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = a % twoPi;
  if (r > Math.PI) r -= twoPi;
  else if (r <= -Math.PI) r += twoPi;
  return r;
}

/**
 * One 10 Hz pursuit decision. Pure: the caller supplies the unit's planar pose (`pose`), its
 * planar speed magnitude (`speed`, for stuck detection), the player's position + velocity (XZ),
 * the three avoidance-ray fractions, the previous StuckState, the tuning, and the decision dt
 * (1 / SPAWN.aiTickHz). Returns the steer/throttle/brake command, the next StuckState, and a
 * debug behavior label. Cached by the caller and applied every physics step until the next tick.
 */
export function pursueSteer(
  pose: { readonly x: number; readonly z: number; readonly yaw: number },
  speed: number,
  player: { readonly x: number; readonly z: number },
  playerVel: { readonly x: number; readonly z: number },
  hits: AvoidHits,
  prev: StuckState,
  params: PursuitSteerParams,
  dt: number,
): PursueResult {
  // (1) A reversal already in flight: hold reverse + full lock until it elapses. This runs
  // before everything else so a mid-reversal re-evaluation can't abort the escape early.
  if (prev.reverseRemainSec > 0) {
    return {
      command: { steer: params.reverseSteer * prev.reverseDir, throttle: 0, brake: 1 },
      stuck: {
        slowSec: 0,
        reverseRemainSec: Math.max(0, prev.reverseRemainSec - dt),
        reverseDir: prev.reverseDir,
      },
      behavior: 'stuck',
    };
  }

  // (2) Desired heading: velocity-led target, or the player's current position inside the ram
  // commitment band (no lead → overshoot on a juke).
  const dxp = player.x - pose.x;
  const dzp = player.z - pose.z;
  const dist = Math.hypot(dxp, dzp);
  const ram = dist <= params.commitDistM;
  const targetX = ram ? player.x : player.x + playerVel.x * params.leadTimeSec;
  const targetZ = ram ? player.z : player.z + playerVel.z * params.leadTimeSec;
  const desiredYaw = yawToward(targetX - pose.x, targetZ - pose.z);
  const headingErr = wrapAngle(desiredYaw - pose.yaw);
  let steer = clampUnit(headingErr * params.steerGain);

  // (3) Obstacle avoidance: steer away from the more-blocked side; a symmetric wall dead ahead
  // (both sides equal) commits to the right so the unit peels off instead of grinding forever
  // (a true wedge is then caught by stuck recovery below).
  const centerBlock = clamp01(1 - hits.center);
  const leftBlock = clamp01(1 - hits.left);
  const rightBlock = clamp01(1 - hits.right);
  let avoid = (leftBlock - rightBlock) * params.avoidSideWeight;
  if (centerBlock > params.avoidCenterDeadzone) {
    const diff = leftBlock - rightBlock;
    const bias = diff !== 0 ? Math.sign(diff) : 1; // symmetric → commit right
    avoid += bias * centerBlock * params.avoidCenterWeight;
  }
  steer = clampUnit(steer + avoid);

  // (4) Throttle: full-on for relentlessness, eased down (a) when a wall is dead ahead so the
  // avoidance turn can bite, and (b) proportional to how hard we're steering — the AI, unlike a
  // human, would otherwise hold FULL throttle through full lock at speed and launch/flip the
  // raycast chassis. Never below the floor (always closing).
  let throttle = (1 - centerBlock * params.avoidThrottleCut) * (1 - Math.abs(steer) * params.cornerThrottleEase);
  if (throttle < params.throttleFloor) throttle = params.throttleFloor;

  // (5) Stuck detection: accumulate slow-while-throttling time; on trip, enter a reversal phase
  // this tick (reverse + full lock toward whichever side has more room).
  let slowSec = prev.slowSec;
  if (speed < params.stuckSpeedMps && throttle > 0) slowSec += dt;
  else slowSec = 0;

  if (slowSec >= params.stuckSec) {
    const reverseDir = rightBlock <= leftBlock ? 1 : -1;
    return {
      command: { steer: params.reverseSteer * reverseDir, throttle: 0, brake: 1 },
      stuck: { slowSec: 0, reverseRemainSec: params.reverseSec, reverseDir },
      behavior: 'stuck',
    };
  }

  const behavior: SteerBehavior = ram
    ? 'ram'
    : centerBlock > params.avoidCenterDeadzone
      ? 'avoid'
      : 'pursue';
  return {
    command: { steer, throttle, brake: 0 },
    stuck: { slowSec, reverseRemainSec: 0, reverseDir: prev.reverseDir },
    behavior,
  };
}
