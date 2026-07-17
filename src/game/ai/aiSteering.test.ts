import { describe, it, expect } from 'vitest';
import {
  pursueSteer,
  initialStuckState,
  yawToward,
  wrapAngle,
  type PursuitSteerParams,
  type AvoidHits,
  type StuckState,
} from './aiSteering';
import { AI_STEERING } from '../config/vehicles';

// The live tuning is the test baseline (behavior must hold for the shipped numbers), with a
// clear all-open ray set as the default "no obstacles" case.
const P: PursuitSteerParams = AI_STEERING;
const CLEAR: AvoidHits = { center: 1, left: 1, right: 1 };
const DT = 0.1; // 1 / SPAWN.aiTickHz

// A unit sitting still at the origin facing +Z (yaw 0), well outside the ram band unless said.
const atOrigin = { x: 0, z: 0, yaw: 0 };
const still = { x: 0, z: 0 };

describe('angle helpers', () => {
  it('yawToward matches the +Z-forward / atan2(dx,dz) convention', () => {
    expect(yawToward(0, 1)).toBeCloseTo(0); // straight ahead (+Z)
    expect(yawToward(1, 0)).toBeCloseTo(Math.PI / 2); // to the right (+X)
    expect(yawToward(-1, 0)).toBeCloseTo(-Math.PI / 2); // to the left (−X)
    expect(yawToward(0, 0)).toBe(0);
  });

  it('wrapAngle folds into (−π, π]', () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(Math.PI * 2)).toBeCloseTo(0);
    expect(wrapAngle(Math.PI * 1.5)).toBeCloseTo(-Math.PI / 2);
    expect(wrapAngle(-Math.PI * 1.5)).toBeCloseTo(Math.PI / 2);
  });
});

describe('pursue: seek direction & sign', () => {
  it('steers RIGHT (+) toward a player on the +X side', () => {
    const r = pursueSteer(atOrigin, 10, { x: 30, z: 0 }, still, CLEAR, initialStuckState, P, DT);
    expect(r.command.steer).toBeGreaterThan(0);
    expect(r.behavior).toBe('pursue');
  });

  it('steers LEFT (−) toward a player on the −X side', () => {
    const r = pursueSteer(atOrigin, 10, { x: -30, z: 0 }, still, CLEAR, initialStuckState, P, DT);
    expect(r.command.steer).toBeLessThan(0);
  });

  it('drives near-straight (steer ~0) at a player dead ahead, full throttle', () => {
    const r = pursueSteer(atOrigin, 10, { x: 0, z: 40 }, still, CLEAR, initialStuckState, P, DT);
    expect(Math.abs(r.command.steer)).toBeLessThan(0.05);
    expect(r.command.throttle).toBeCloseTo(1);
    expect(r.command.brake).toBe(0);
  });
});

describe('velocity lead', () => {
  it('aims AHEAD of a laterally-moving player (leads the target)', () => {
    // Player far ahead on +Z, sliding toward +X. With lead the aim point shifts +X, so the
    // unit steers further right than it would at the player's current position.
    const moving = { x: 20, z: 0 };
    const led = pursueSteer(atOrigin, 10, { x: 0, z: 40 }, moving, CLEAR, initialStuckState, P, DT);
    const noLead = pursueSteer(atOrigin, 10, { x: 0, z: 40 }, still, CLEAR, initialStuckState, P, DT);
    expect(led.command.steer).toBeGreaterThan(noLead.command.steer);
    // The lead offset is exactly playerVel × leadTimeSec.
    const expectedAimX = 0 + moving.x * P.leadTimeSec;
    expect(yawToward(expectedAimX, 40)).toBeGreaterThan(0);
  });
});

describe('ram commitment', () => {
  it('inside commitDistM: behavior ram, full throttle, and IGNORES the lead', () => {
    // Player just inside the commit band, moving fast sideways. Ram must aim at the CURRENT
    // position (steer ~0 for a dead-ahead player), not the led one.
    const closeAhead = { x: 0, z: P.commitDistM - 1 };
    const fastSideways = { x: 40, z: 0 };
    const r = pursueSteer(atOrigin, 10, closeAhead, fastSideways, CLEAR, initialStuckState, P, DT);
    expect(r.behavior).toBe('ram');
    expect(r.command.throttle).toBeCloseTo(1);
    expect(Math.abs(r.command.steer)).toBeLessThan(0.05); // current pos is dead ahead → no lead
  });

  it('just OUTSIDE the band still leads (behavior pursue, not ram)', () => {
    const justOutside = { x: 0, z: P.commitDistM + 2 };
    const fastSideways = { x: 40, z: 0 };
    const r = pursueSteer(atOrigin, 10, justOutside, fastSideways, CLEAR, initialStuckState, P, DT);
    expect(r.behavior).toBe('pursue');
    expect(r.command.steer).toBeGreaterThan(0.05); // leads toward +X
  });
});

describe('obstacle avoidance', () => {
  it('center + RIGHT more blocked → steers LEFT even with the player dead ahead', () => {
    const hits: AvoidHits = { center: 0.2, left: 0.9, right: 0.1 };
    const r = pursueSteer(atOrigin, 10, { x: 0, z: 40 }, still, hits, initialStuckState, P, DT);
    expect(r.command.steer).toBeLessThan(0);
    expect(r.behavior).toBe('avoid');
  });

  it('center + LEFT more blocked → steers RIGHT', () => {
    const hits: AvoidHits = { center: 0.2, left: 0.1, right: 0.9 };
    const r = pursueSteer(atOrigin, 10, { x: 0, z: 40 }, still, hits, initialStuckState, P, DT);
    expect(r.command.steer).toBeGreaterThan(0);
  });

  it('symmetric wall dead ahead → commits RIGHT (breaks the tie, no grind)', () => {
    const hits: AvoidHits = { center: 0.05, left: 0.5, right: 0.5 };
    const r = pursueSteer(atOrigin, 10, { x: 0, z: 40 }, still, hits, initialStuckState, P, DT);
    expect(r.command.steer).toBeGreaterThan(0);
  });

  it('a wall dead ahead cuts throttle (but not below the floor)', () => {
    const hits: AvoidHits = { center: 0, left: 0.5, right: 0.5 };
    const r = pursueSteer(atOrigin, 10, { x: 0, z: 40 }, still, hits, initialStuckState, P, DT);
    expect(r.command.throttle).toBeLessThan(1);
    expect(r.command.throttle).toBeGreaterThanOrEqual(P.throttleFloor - 1e-9);
  });

  it('eases the throttle in a hard turn (anti-launch), full throttle going straight', () => {
    const straight = pursueSteer(atOrigin, 20, { x: 0, z: 40 }, still, CLEAR, initialStuckState, P, DT);
    const hardTurn = pursueSteer(atOrigin, 20, { x: 60, z: 3 }, still, CLEAR, initialStuckState, P, DT);
    expect(straight.command.throttle).toBeCloseTo(1);
    expect(Math.abs(hardTurn.command.steer)).toBeGreaterThan(0.8);
    expect(hardTurn.command.throttle).toBeLessThan(straight.command.throttle);
    expect(hardTurn.command.throttle).toBeGreaterThanOrEqual(P.throttleFloor - 1e-9);
  });

  it('clear rays add no avoidance (pure seek), full throttle dead ahead', () => {
    const seek = pursueSteer(atOrigin, 10, { x: 0, z: 40 }, still, CLEAR, initialStuckState, P, DT);
    expect(seek.behavior).toBe('pursue');
    expect(Math.abs(seek.command.steer)).toBeLessThan(0.05);
    expect(seek.command.throttle).toBeCloseTo(1);
  });
});

describe('stuck recovery', () => {
  const params: PursuitSteerParams = { ...AI_STEERING, stuckSec: 0.3, reverseSec: 0.2 };

  it('accumulates slow-while-throttling time, then trips into a reversal phase', () => {
    let stuck: StuckState = initialStuckState;
    let last = pursueSteer(atOrigin, 0.1, { x: 0, z: 40 }, still, CLEAR, stuck, params, DT);
    // First tick: slow but not yet past stuckSec → still pursuing.
    expect(last.behavior).toBe('pursue');
    stuck = last.stuck;
    expect(stuck.slowSec).toBeCloseTo(DT);

    // Keep it slow while throttling; after stuckSec (0.3s = 3 ticks) it trips.
    for (let i = 0; i < 3; i++) {
      last = pursueSteer(atOrigin, 0.1, { x: 0, z: 40 }, still, CLEAR, stuck, params, DT);
      stuck = last.stuck;
    }
    expect(last.behavior).toBe('stuck');
    expect(last.command.brake).toBe(1);
    expect(last.command.throttle).toBe(0);
    expect(Math.abs(last.command.steer)).toBeCloseTo(params.reverseSteer);
    expect(stuck.reverseRemainSec).toBeGreaterThan(0);
  });

  it('reversal phase counts down and is not aborted by re-evaluation', () => {
    const inReverse: StuckState = { slowSec: 0, reverseRemainSec: 0.2, reverseDir: -1 };
    // Even though the player is now dead ahead & the unit is "fine", reversal holds.
    const r = pursueSteer(atOrigin, 5, { x: 0, z: 40 }, still, CLEAR, inReverse, params, DT);
    expect(r.behavior).toBe('stuck');
    expect(r.command.brake).toBe(1);
    expect(r.command.steer).toBeCloseTo(-params.reverseSteer); // holds the entry direction
    expect(r.stuck.reverseRemainSec).toBeCloseTo(0.1);
  });

  it('does NOT count as stuck while moving at speed (timer resets)', () => {
    const primed: StuckState = { slowSec: 2, reverseRemainSec: 0, reverseDir: 1 };
    const r = pursueSteer(atOrigin, 15, { x: 0, z: 40 }, still, CLEAR, primed, params, DT);
    expect(r.stuck.slowSec).toBe(0);
    expect(r.behavior).toBe('pursue');
  });

  it('reversal steers toward the CLEARER side (right clear → +, left clear → −)', () => {
    const primed: StuckState = { slowSec: params.stuckSec, reverseRemainSec: 0, reverseDir: 1 };
    const rightClear: AvoidHits = { center: 0, left: 0.1, right: 0.9 };
    const rr = pursueSteer(atOrigin, 0.1, { x: 0, z: 40 }, still, rightClear, primed, params, DT);
    expect(rr.command.steer).toBeGreaterThan(0);
    const leftClear: AvoidHits = { center: 0, left: 0.9, right: 0.1 };
    const rl = pursueSteer(atOrigin, 0.1, { x: 0, z: 40 }, still, leftClear, primed, params, DT);
    expect(rl.command.steer).toBeLessThan(0);
  });
});

// --- Phase 10: slow-target press-in (BUSTED reachability, phase-09-notes.md debt) ------------
describe('slow-target press-in (pursue mode)', () => {
  // A near-stopped player just OUTSIDE the ram band but inside pressDistM.
  const slowClose = { x: 0, z: 12 }; // dist 12: > commitDistM(10), < pressDistM(15)
  const creep = { x: 1.5, z: 0 }; // speed 1.5 < pressSpeedMps(2)
  const fast = { x: 0, z: 10 }; // speed 10 > pressSpeedMps → no press

  it('engages (behavior "press") when the player is slow AND within pressDistM but past the ram band', () => {
    const r = pursueSteer(atOrigin, 5, slowClose, creep, CLEAR, initialStuckState, P, DT);
    expect(r.behavior).toBe('press');
    expect(r.command.throttle).toBeGreaterThan(0);
  });

  it('COMMITS (drops the lead → aims at the current position) so a lateral drift is ignored', () => {
    // creep drifts toward +X; a leading unit would steer right, a committed one aims dead ahead.
    const r = pursueSteer(atOrigin, 5, slowClose, creep, CLEAR, initialStuckState, P, DT);
    expect(Math.abs(r.command.steer)).toBeLessThan(0.05);
  });

  it('does NOT engage for a moving player (identical geometry) — normal pursue is unchanged', () => {
    const r = pursueSteer(atOrigin, 5, slowClose, fast, CLEAR, initialStuckState, P, DT);
    expect(r.behavior).toBe('pursue');
  });

  it('DAMPS avoidance (crowd the wall-pinned player) vs. a full-strength pursue turn', () => {
    const oneSideBlocked: AvoidHits = { center: 1, left: 0.2, right: 1 }; // left more blocked → steer right
    const pressed = pursueSteer(atOrigin, 5, slowClose, creep, oneSideBlocked, initialStuckState, P, DT);
    const pursuing = pursueSteer(atOrigin, 5, slowClose, fast, oneSideBlocked, initialStuckState, P, DT);
    expect(pressed.behavior).toBe('press');
    expect(pressed.command.steer).toBeGreaterThan(0); // still steers away a bit
    expect(pressed.command.steer).toBeLessThan(pursuing.command.steer); // but far less than a normal avoid
  });

  it('SUPPRESSES stuck recovery — a unit leaning on a stopped player never reverses away', () => {
    // Slow-while-throttling with time already banked: press-in must reset the timer (never trip);
    // the non-press contrast keeps accumulating. Kept below stuckSec so the contrast doesn't trip.
    const primed: StuckState = { slowSec: 2.0, reverseRemainSec: 0, reverseDir: 1 };
    const pressed = pursueSteer(atOrigin, 0.1, slowClose, still, CLEAR, primed, P, DT);
    expect(pressed.behavior).toBe('press');
    expect(pressed.stuck.slowSec).toBe(0);
    // The same slow unit against a FAST (non-press) player DOES keep accumulating toward a reversal.
    const notPressed = pursueSteer(atOrigin, 0.1, slowClose, fast, CLEAR, primed, P, DT);
    expect(notPressed.stuck.slowSec).toBeGreaterThan(0);
  });

  it('drives HARD at the player (wall-ahead throttle cut lifted) to close the pin', () => {
    // A building dead ahead would normally cut throttle; while pressing in it must not.
    const wallAhead: AvoidHits = { center: 0, left: 1, right: 1 };
    const pressed = pursueSteer(atOrigin, 5, slowClose, creep, wallAhead, initialStuckState, P, DT);
    const pursuing = pursueSteer(atOrigin, 5, slowClose, fast, wallAhead, initialStuckState, P, DT);
    expect(pressed.command.throttle).toBeGreaterThan(pursuing.command.throttle);
  });
});

// --- Phase 10: flank steering mode (SWAT hold formation on a squad slot) ---------------------
describe('flank steering mode', () => {
  const player = { x: 0, z: 40 }; // player straight ahead
  const flankRight = { x: 30, z: 0 }; // squad slot off to the RIGHT of the unit

  it('seeks the FLANK TARGET, not the player (behavior "flank")', () => {
    const r = pursueSteer(atOrigin, 10, player, still, CLEAR, initialStuckState, P, DT, 'flank', flankRight);
    expect(r.behavior).toBe('flank');
    expect(r.command.steer).toBeGreaterThan(0); // toward +X (the slot), NOT +Z (the player)
  });

  it('never rams: a flank target inside the ram band stays "flank", not "ram"', () => {
    const closeSlot = { x: 0, z: 5 }; // inside commitDistM
    const r = pursueSteer(atOrigin, 10, { x: 0, z: 5 }, still, CLEAR, initialStuckState, P, DT, 'flank', closeSlot);
    expect(r.behavior).toBe('flank');
  });

  it('eases the throttle on close approach so it holds formation instead of ramming through', () => {
    const far = pursueSteer(atOrigin, 10, player, still, CLEAR, initialStuckState, P, DT, 'flank', { x: 0, z: 30 });
    const near = pursueSteer(atOrigin, 10, player, still, CLEAR, initialStuckState, P, DT, 'flank', { x: 0, z: 1 });
    expect(far.command.throttle).toBeCloseTo(1); // full throttle far from the slot
    expect(near.command.throttle).toBeLessThan(far.command.throttle);
    // At the slot the throttle tapers toward flankArriveThrottle (below the pursue floor).
    expect(near.command.throttle).toBeLessThan(P.throttleFloor);
    expect(near.command.throttle).toBeGreaterThan(0);
  });

  it('falls back to pursue when it holds no slot (flankTarget null)', () => {
    const r = pursueSteer(atOrigin, 10, { x: 30, z: 0 }, still, CLEAR, initialStuckState, P, DT, 'flank', null);
    expect(r.behavior).toBe('pursue');
    expect(r.command.steer).toBeGreaterThan(0); // seeks the player again
  });
});
