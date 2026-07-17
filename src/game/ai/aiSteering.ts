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
  // --- slow-target press-in (BUSTED reachability; pursue mode only) -------------------------
  /** Below this player speed (m/s) a close unit presses in instead of orbiting. */
  readonly pressSpeedMps: number;
  /** Press-in engages within this range (m) of a slow player — reaches past commitDistM. */
  readonly pressDistM: number;
  /** Avoidance influence is multiplied by this while pressing in (crowd, don't peel off). */
  readonly pressAvoidScale: number;
  // --- flank arrival easing (flank mode only) ----------------------------------------------
  /** Inside this range (m) of the flank target the flanker eases off to hold formation. */
  readonly flankArriveM: number;
  /** Throttle floor a flanker tapers to at its slot (below the pursue throttleFloor). */
  readonly flankArriveThrottle: number;
  // --- standoff orbit (orbit mode only; Phase 11 gun trucks) --------------------------------
  /** Ring radius (m) the orbit steering holds the unit at around the player. */
  readonly orbitRadiusM: number;
  /** Target tangential cruise speed (m/s) the orbit throttle controller holds. */
  readonly orbitSpeedMps: number;
  /** Radial pull-back gain: normalized radius error × this → correction toward the ring. */
  readonly orbitCorrectionGain: number;
  /** Clamp (±) on the radial correction term so a far-out unit spirals in without over-steering. */
  readonly orbitCorrectionMax: number;
  /** Base cruise throttle (the P-controller's seed at orbitSpeedMps). */
  readonly orbitThrottleBase: number;
  /** Throttle P-controller gain: +(orbitSpeedMps − speed) × this, clamped 0..1. */
  readonly orbitSpeedGain: number;
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

export type SteerBehavior = 'pursue' | 'ram' | 'avoid' | 'stuck' | 'press' | 'flank' | 'orbit';

/** Steering mode (Phase 10–11). 'pursue' seeks the player with velocity-lead + ram-commit +
 * slow-target press-in (the existing police behavior, unchanged for a moving player). 'flank'
 * seeks an arbitrary world target (a squad slot, ai/squad.ts) with the same avoidance but NO ram
 * and a throttle that eases on close approach, so the unit HOLDS formation ~parallel to the player
 * instead of ramming through. SWAT units (Phase 10 Task 2) drive 'flank' when they hold a claim.
 * 'orbit' (Phase 11) circles the player at a standoff RING (orbitRadiusM): a tangential heading
 * (handedness from the `orbitDir` param, seeded per unit at spawn) blended with a radial pull back
 * onto the ring, at a throttle that holds ~constant orbit speed. Gun trucks (Phase 11 Task 2) drive
 * 'orbit' while standing off, switching to 'pursue' (its ram-commit) when the standoff brain says
 * ram — see createStandoffBrain below. Avoidance layers on top and WINS in every mode. */
export type SteerMode = 'pursue' | 'flank' | 'orbit';

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

/** Clamp to the symmetric range [−m, m] (m ≥ 0). */
function clampAbs(v: number, m: number): number {
  if (v > m) return m;
  if (v < -m) return -m;
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
 * The unnormalized desired MOVEMENT direction (XZ) for a unit orbiting the player at a standoff
 * ring (Phase 11 gun trucks, aiSteering 'orbit' mode). Pure geometry, no avoidance — the caller
 * (pursueSteer) turns this into a heading and then lets the avoidance rays win over it.
 *
 * Two blended parts:
 *   • TANGENTIAL — circle the player. The tangent is the outward radial (player→unit) rotated 90°;
 *     `orbitDir` picks which way (≥ 0 → one circulation sense, < 0 → the opposite). Handedness is
 *     seeded once per unit at spawn, so two trucks can orbit opposite ways (great crossfire).
 *   • RADIAL correction — hold the ring. `orbitRadiusM − dist` is +ve when the unit is TOO CLOSE
 *     (bias OUTWARD, away from the player) and −ve when TOO FAR (bias INWARD), normalized by the
 *     radius and clamped to ±orbitCorrectionMax. Small near the ring (a clean circle), saturating
 *     far out so a fresh spawn at 60–90 m just spirals straight in.
 *
 * Degenerate case (unit on top of the player, dist ≈ 0) falls back to an arbitrary +X radial so the
 * tangent is still defined and finite.
 */
export function orbitDesiredDir(
  pose: { readonly x: number; readonly z: number },
  player: { readonly x: number; readonly z: number },
  orbitDir: number,
  params: Pick<PursuitSteerParams, 'orbitRadiusM' | 'orbitCorrectionGain' | 'orbitCorrectionMax'>,
): { readonly x: number; readonly z: number } {
  const rx = pose.x - player.x;
  const rz = pose.z - player.z;
  const dist = Math.hypot(rx, rz);
  // Outward radial unit vector (player → unit); arbitrary +X when the unit sits on the player.
  const ux = dist > 1e-6 ? rx / dist : 1;
  const uz = dist > 1e-6 ? rz / dist : 0;
  // Tangent = radial rotated 90°, handedness from orbitDir. +1 and −1 give opposite circulation.
  const h = orbitDir >= 0 ? 1 : -1;
  const tx = -uz * h;
  const tz = ux * h;
  // Radial correction toward the ring: + pushes OUTWARD (too close), − pulls INWARD (too far).
  const radialNorm = (params.orbitRadiusM - dist) / params.orbitRadiusM;
  const radialTerm = clampAbs(radialNorm * params.orbitCorrectionGain, params.orbitCorrectionMax);
  return { x: tx + radialTerm * ux, z: tz + radialTerm * uz };
}

/**
 * One 10 Hz steering decision. Pure: the caller supplies the unit's planar pose (`pose`), its
 * planar speed magnitude (`speed`, for stuck detection), the player's position + velocity (XZ),
 * the three avoidance-ray fractions, the previous StuckState, the tuning, and the decision dt
 * (1 / SPAWN.aiTickHz). Returns the steer/throttle/brake command, the next StuckState, and a
 * debug behavior label. Cached by the caller and applied every physics step until the next tick.
 *
 * `mode` (default 'pursue', so existing callers are unchanged) selects the behavior:
 *   • 'pursue' — seek the player: velocity lead → ram-commit inside commitDistM → slow-target
 *                press-in (crowd a near-stopped, close player instead of orbiting — the Phase 10
 *                BUSTED-reachability fix). `flankTarget` is ignored.
 *   • 'flank'  — seek `flankTarget` (a squad slot) with the same avoidance but NO ram/lead/press,
 *                easing the throttle inside flankArriveM so the unit holds formation ~parallel to
 *                the player rather than ramming through. Falls back to 'pursue' if flankTarget is
 *                null (defensive — a flanker with no live claim just pursues).
 *   • 'orbit'  — circle the player at the standoff ring (orbitDesiredDir + a hold-speed throttle
 *                controller), `orbitDir` (±1, seeded per unit) picking the handedness. NO ram/lead/
 *                press; `flankTarget` ignored. The Phase 11 gun-truck standoff — the unit's brain
 *                (createStandoffBrain) flips it to 'pursue' to actually ram. Avoidance still wins.
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
  mode: SteerMode = 'pursue',
  flankTarget: { readonly x: number; readonly z: number } | null = null,
  orbitDir = 1,
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

  const orbiting = mode === 'orbit';
  const flanking = mode === 'flank' && flankTarget !== null;

  // (2) Desired heading + throttle target.
  // ORBIT: circle the player at the standoff ring (tangential + radial-correction blend; ram/lead/
  //   press don't apply). FLANK: seek the squad slot directly (no lead/ram/press). PURSUE: velocity-
  //   led target, dropping the lead to the player's CURRENT position inside the ram band (dist ≤
  //   commitDistM) OR when pressing in on a slow, close player (dist < pressDistM && player barely
  //   moving) — so a juke makes the unit overshoot, and a stopped player gets crowded.
  const dxp = player.x - pose.x;
  const dzp = player.z - pose.z;
  const dist = Math.hypot(dxp, dzp);
  const ram = !flanking && !orbiting && dist <= params.commitDistM;
  const playerSpeed = Math.hypot(playerVel.x, playerVel.z);
  const pressIn =
    !flanking && !orbiting && playerSpeed < params.pressSpeedMps && dist < params.pressDistM;
  const commit = ram || pressIn; // aim at the player's current position, no lead

  let desiredYaw: number;
  if (orbiting) {
    const dir = orbitDesiredDir(pose, player, orbitDir, params);
    desiredYaw = yawToward(dir.x, dir.z);
  } else if (flanking) {
    desiredYaw = yawToward(flankTarget.x - pose.x, flankTarget.z - pose.z);
  } else if (commit) {
    desiredYaw = yawToward(dxp, dzp);
  } else {
    desiredYaw = yawToward(dxp + playerVel.x * params.leadTimeSec, dzp + playerVel.z * params.leadTimeSec);
  }
  const headingErr = wrapAngle(desiredYaw - pose.yaw);
  let steer = clampUnit(headingErr * params.steerGain);

  // (3) Obstacle avoidance: steer away from the more-blocked side; a symmetric wall dead ahead
  // (both sides equal) commits to the right so the unit peels off instead of grinding forever
  // (a true wedge is then caught by stuck recovery below). While pressing in on a stopped player
  // the avoidance is DAMPED (pressAvoidScale) so the unit crowds up to a wall-pinned player
  // instead of arcing around the building behind them.
  const centerBlock = clamp01(1 - hits.center);
  const leftBlock = clamp01(1 - hits.left);
  const rightBlock = clamp01(1 - hits.right);
  let avoid = (leftBlock - rightBlock) * params.avoidSideWeight;
  if (centerBlock > params.avoidCenterDeadzone) {
    const diff = leftBlock - rightBlock;
    const bias = diff !== 0 ? Math.sign(diff) : 1; // symmetric → commit right
    avoid += bias * centerBlock * params.avoidCenterWeight;
  }
  if (pressIn) avoid *= params.pressAvoidScale;
  steer = clampUnit(steer + avoid);

  // (4) Throttle: full-on for relentlessness, eased down (a) when a wall is dead ahead so the
  // avoidance turn can bite, and (b) proportional to how hard we're steering — the AI, unlike a
  // human, would otherwise hold FULL throttle through full lock at speed and launch/flip the
  // raycast chassis.
  let throttle = (1 - centerBlock * params.avoidThrottleCut) * (1 - Math.abs(steer) * params.cornerThrottleEase);
  if (orbiting) {
    // Hold a roughly constant orbit speed: a P-controller around orbitSpeedMps (throttle up when
    // slow, ease off when overspeed), scaled by the base wall-cut/corner-ease above so a wall dead
    // ahead or a hard avoidance turn still bleeds throttle (avoidance wins over orbit adherence).
    // NO floor — an orbiting truck may coast to let the dodge bite; it isn't relentlessly closing.
    const orbitCruise = clamp01(
      params.orbitThrottleBase + (params.orbitSpeedMps - speed) * params.orbitSpeedGain,
    );
    throttle *= orbitCruise;
  } else if (flanking) {
    // Arrival easing: taper from full throttle (far) to flankArriveThrottle (at the slot) so the
    // flanker settles into formation instead of ramming through. No relentless floor in flank mode.
    const dxt = flankTarget.x - pose.x;
    const dzt = flankTarget.z - pose.z;
    const distToTarget = Math.hypot(dxt, dzt);
    const arrive =
      params.flankArriveThrottle +
      (1 - params.flankArriveThrottle) * clamp01(distToTarget / params.flankArriveM);
    throttle *= arrive;
  } else {
    // Press-in drives HARD at the player: the wall-ahead throttle cut is lifted (the player is the
    // target, not an obstacle — a building past/beside the player must not stop the crowd short of
    // the pin), keeping only the corner ease. Otherwise a wall dead ahead cuts throttle normally.
    if (pressIn) throttle = 1 - Math.abs(steer) * params.cornerThrottleEase;
    if (throttle < params.throttleFloor) throttle = params.throttleFloor; // always closing
  }

  // (5) Stuck detection: accumulate slow-while-throttling time; on trip, enter a reversal phase
  // this tick (reverse + full lock toward whichever side has more room). Applies in both modes —
  // a flanker can wedge on a building just as a pursuer can — but is SUPPRESSED while pressing in:
  // a unit deliberately leaning on a stopped player is slow-while-throttling too, and if it counted
  // as "wedged" the unit would reverse away at exactly stuckSec — right as the BUSTED window
  // (speed<1 for 3 s with ≥3 pursuers within 8 m) was about to close — and could never pin the
  // player. Pressing in against the player is the intended terminal state, not a wedge.
  let slowSec = prev.slowSec;
  if (speed < params.stuckSpeedMps && throttle > 0 && !pressIn) slowSec += dt;
  else slowSec = 0;

  if (slowSec >= params.stuckSec) {
    const reverseDir = rightBlock <= leftBlock ? 1 : -1;
    return {
      command: { steer: params.reverseSteer * reverseDir, throttle: 0, brake: 1 },
      stuck: { slowSec: 0, reverseRemainSec: params.reverseSec, reverseDir },
      behavior: 'stuck',
    };
  }

  const dodging = centerBlock > params.avoidCenterDeadzone;
  const behavior: SteerBehavior = orbiting
    ? dodging
      ? 'avoid'
      : 'orbit'
    : flanking
      ? 'flank'
      : ram
        ? 'ram'
        : pressIn
          ? 'press'
          : dodging
            ? 'avoid'
            : 'pursue';
  return {
    command: { steer, throttle, brake: 0 },
    stuck: { slowSec, reverseRemainSec: 0, reverseDir: prev.reverseDir },
    behavior,
  };
}

// ============================================================================================
// Standoff ram-switch state machine (Phase 11 gun trucks). Decides ORBIT vs RAM — a separate,
// higher-level decision than the per-tick steering above: it flips a truck out of its standoff
// orbit to charge a player who has stopped running, and back to orbit once they're running again.
// The unit (ai/units/gunTruck.ts, Task 2) drives createStandoffBrain and maps its output to the
// steering mode it passes to pursueSteer: 'orbit' → mode 'orbit' (with the unit's seeded orbitDir),
// 'ram' → mode 'pursue' (which ram-commits inside commitDistM). Kept here (not in the unit) so the
// timing/hysteresis is pure and unit-testable without a Rapier body. See TDD §5.6 gun-truck row:
// "orbits at ~20 m; closes to ram only if player is slow/cornered".
// ============================================================================================

/** The tuning the standoff brain reads (a structural subset of AI_STEERING). */
export interface StandoffBrainParams {
  /** In ORBIT, a player slower than this for ramSwitchSec triggers a switch to RAM. m/s. */
  readonly ramSwitchSpeedMps: number;
  /** How long (s) the player must stay below ramSwitchSpeedMps before ORBIT → RAM. */
  readonly ramSwitchSec: number;
  /** "Cornered" heuristic: a player slower than this AND within corneredDistM switches instantly. */
  readonly corneredSpeedMps: number;
  /** "Cornered" range (m): a near-stopped player this close is pinned → immediate RAM. */
  readonly corneredDistM: number;
  /** In RAM, the player must exceed this speed for ramExitSec to switch back to ORBIT. m/s. */
  readonly ramExitSpeedMps: number;
  /** How long (s) the player must stay above ramExitSpeedMps before RAM → ORBIT (hysteresis). */
  readonly ramExitSec: number;
}

/** Standoff decision: hold the ring, or charge in to ram. */
export type StandoffMode = 'orbit' | 'ram';

/** Pure state carried between standoff decisions (createStandoffBrain owns one internally). */
export interface StandoffState {
  readonly mode: StandoffMode;
  /** Time (s) the player has been below ramSwitchSpeedMps while ORBITING (→ RAM at ramSwitchSec). */
  readonly slowSec: number;
  /** Time (s) the player has been above ramExitSpeedMps while RAMMING (→ ORBIT at ramExitSec). */
  readonly fastSec: number;
}

/** Trucks spawn holding the standoff orbit. */
export const initialStandoffState: StandoffState = { mode: 'orbit', slowSec: 0, fastSec: 0 };

/**
 * One standoff decision, pure: given the previous state, the player's planar speed, the unit→player
 * distance, and the elapsed time, return the next state. Asymmetric hysteresis keeps a marginal
 * player from flickering the truck between orbit and ram:
 *   • ORBIT → RAM when the player is CORNERED (near-stopped AND within corneredDistM — pinned, so
 *     charge immediately) OR has been slow (< ramSwitchSpeedMps) continuously for ramSwitchSec.
 *   • RAM → ORBIT only once the player is clearly running again (> ramExitSpeedMps for ramExitSec).
 * The slow/fast timers reset the instant the condition breaks (a single fast tick zeroes slowSec),
 * so only SUSTAINED behavior flips the mode.
 */
export function stepStandoff(
  prev: StandoffState,
  playerSpeed: number,
  dist: number,
  dt: number,
  cfg: StandoffBrainParams,
): StandoffState {
  if (prev.mode === 'orbit') {
    const cornered = playerSpeed < cfg.corneredSpeedMps && dist < cfg.corneredDistM;
    const slowSec = playerSpeed < cfg.ramSwitchSpeedMps ? prev.slowSec + dt : 0;
    if (cornered || slowSec >= cfg.ramSwitchSec) {
      return { mode: 'ram', slowSec: 0, fastSec: 0 };
    }
    return { mode: 'orbit', slowSec, fastSec: 0 };
  }
  // mode === 'ram'
  const fastSec = playerSpeed > cfg.ramExitSpeedMps ? prev.fastSec + dt : 0;
  if (fastSec >= cfg.ramExitSec) {
    return { mode: 'orbit', slowSec: 0, fastSec: 0 };
  }
  return { mode: 'ram', slowSec: 0, fastSec };
}

/** The stateful standoff brain the gun-truck unit drives (Task 2 consumes this). */
export interface StandoffBrain {
  /** Advance the state machine one decision and return the resulting mode. */
  update(playerSpeed: number, dist: number, dt: number): StandoffMode;
  /** The current mode without advancing (read-only). */
  readonly mode: StandoffMode;
}

/**
 * Create a standoff brain seeded in ORBIT. Each gun truck owns one; every 10 Hz think it calls
 * `update(playerSpeed, dist, dt)` and steers by the returned mode ('orbit' or 'ram'). A thin
 * stateful wrapper over the pure `stepStandoff` reducer — the reducer is what the tests exercise.
 */
export function createStandoffBrain(cfg: StandoffBrainParams): StandoffBrain {
  let state: StandoffState = initialStandoffState;
  return {
    get mode(): StandoffMode {
      return state.mode;
    },
    update(playerSpeed: number, dist: number, dt: number): StandoffMode {
      state = stepStandoff(state, playerSpeed, dist, dt, cfg);
      return state.mode;
    },
  };
}
