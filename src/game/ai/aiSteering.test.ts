import { describe, it, expect } from 'vitest';
import {
  pursueSteer,
  orbitDesiredDir,
  stepStandoff,
  createStandoffBrain,
  initialStuckState,
  initialStandoffState,
  roadSeekDurationFor,
  yawToward,
  wrapAngle,
  type PursuitSteerParams,
  type StandoffBrainParams,
  type StandoffState,
  type AvoidHits,
  type StuckState,
} from './aiSteering';
import { AI_STEERING } from '../config/vehicles';

// The live tuning is the test baseline (behavior must hold for the shipped numbers), with a
// clear all-open ray set as the default "no obstacles" case.
const P: PursuitSteerParams = AI_STEERING;
const SB: StandoffBrainParams = AI_STEERING; // full const has the ram-switch fields P narrows away
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
    const inReverse: StuckState = { slowSec: 0, reverseRemainSec: 0.2, reverseDir: -1, roadSeekRemainSec: 0, stuckEpisodes: 0 };
    // Even though the player is now dead ahead & the unit is "fine", reversal holds.
    const r = pursueSteer(atOrigin, 5, { x: 0, z: 40 }, still, CLEAR, inReverse, params, DT);
    expect(r.behavior).toBe('stuck');
    expect(r.command.brake).toBe(1);
    expect(r.command.steer).toBeCloseTo(-params.reverseSteer); // holds the entry direction
    expect(r.stuck.reverseRemainSec).toBeCloseTo(0.1);
  });

  it('does NOT count as stuck while moving at speed (timer resets)', () => {
    const primed: StuckState = { slowSec: 2, reverseRemainSec: 0, reverseDir: 1, roadSeekRemainSec: 0, stuckEpisodes: 0 };
    const r = pursueSteer(atOrigin, 15, { x: 0, z: 40 }, still, CLEAR, primed, params, DT);
    expect(r.stuck.slowSec).toBe(0);
    expect(r.behavior).toBe('pursue');
  });

  it('reversal steers toward the CLEARER side (right clear → +, left clear → −)', () => {
    const primed: StuckState = { slowSec: params.stuckSec, reverseRemainSec: 0, reverseDir: 1, roadSeekRemainSec: 0, stuckEpisodes: 0 };
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
    const primed: StuckState = { slowSec: 2.0, reverseRemainSec: 0, reverseDir: 1, roadSeekRemainSec: 0, stuckEpisodes: 0 };
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

// --- Phase 11: standoff orbit geometry (orbitDesiredDir) -------------------------------------
// Pure movement-direction math. Player at the origin; a unit sits on a cardinal axis so the
// tangent/radial split is easy to read. dot() with the outward radial isolates the radial term.
describe('orbit geometry (orbitDesiredDir)', () => {
  const origin = { x: 0, z: 0 };

  it('tangent flips with handedness at the ring (CW vs CCW are opposite)', () => {
    // Unit due +Z of the player, exactly at orbitRadiusM → pure tangent, no radial term.
    const onRing = { x: 0, z: P.orbitRadiusM };
    const cw = orbitDesiredDir(onRing, origin, +1, P);
    const ccw = orbitDesiredDir(onRing, origin, -1, P);
    // Outward radial is +Z, so the tangent lies on X — opposite sign for the two handednesses.
    expect(cw.x).toBeLessThan(0);
    expect(ccw.x).toBeGreaterThan(0);
    expect(cw.x).toBeCloseTo(-ccw.x);
    // No radial component at the ring: the Z (radial) part is ~0 for both.
    expect(cw.z).toBeCloseTo(0);
    expect(ccw.z).toBeCloseTo(0);
  });

  it('tangent is perpendicular to the radial (dot ≈ 0) at the ring, off a different axis', () => {
    const onRing = { x: P.orbitRadiusM, z: 0 }; // due +X of the player
    const dir = orbitDesiredDir(onRing, origin, +1, P);
    // Outward radial is +X → tangent on Z. dot(dir, radial) ≈ 0.
    expect(dir.x * 1 + dir.z * 0).toBeCloseTo(0);
    expect(Math.abs(dir.z)).toBeGreaterThan(0.5); // real tangential component
  });

  it('TOO CLOSE → radial component biases OUTWARD (away from the player)', () => {
    const tooClose = { x: 0, z: P.orbitRadiusM / 2 }; // half the ring radius
    const dir = orbitDesiredDir(tooClose, origin, +1, P);
    // Outward radial is +Z; a positive Z projection means the blend pushes away from the player.
    expect(dir.z).toBeGreaterThan(0);
  });

  it('TOO FAR → radial component biases INWARD (toward the player) and clamps', () => {
    const tooFar = { x: 0, z: P.orbitRadiusM * 3 }; // well outside the ring → saturates the clamp
    const dir = orbitDesiredDir(tooFar, origin, +1, P);
    expect(dir.z).toBeLessThan(0); // toward the player
    // Radial error here is large negative; the correction is clamped at −orbitCorrectionMax.
    expect(dir.z).toBeCloseTo(-P.orbitCorrectionMax);
  });

  it('handedness mirrors the tangent but leaves the radial correction unchanged', () => {
    const tooClose = { x: 0, z: P.orbitRadiusM / 2 };
    const cw = orbitDesiredDir(tooClose, origin, +1, P);
    const ccw = orbitDesiredDir(tooClose, origin, -1, P);
    expect(cw.x).toBeCloseTo(-ccw.x); // tangent flips
    expect(cw.z).toBeCloseTo(ccw.z); // same outward radial bias
  });
});

// --- Phase 11: standoff orbit steering mode (pursueSteer mode 'orbit') -----------------------
describe('orbit steering mode', () => {
  const origin = { x: 0, z: 0 };
  // A unit due +Z of the player, on the ring, facing +Z (yaw 0) unless aligned to the tangent.
  const onRing = { x: 0, z: P.orbitRadiusM, yaw: 0 };

  it('steers toward the tangent — handedness sets the sign (behavior "orbit")', () => {
    const cw = pursueSteer(onRing, 10, origin, still, CLEAR, initialStuckState, P, DT, 'orbit', null, +1);
    const ccw = pursueSteer(onRing, 10, origin, still, CLEAR, initialStuckState, P, DT, 'orbit', null, -1);
    expect(cw.behavior).toBe('orbit');
    expect(cw.command.steer).toBeLessThan(0); // tangent to −X → steers left
    expect(ccw.command.steer).toBeGreaterThan(0); // opposite handedness → steers right
  });

  it('never rams: a player inside commitDistM stays "orbit", not "ram"', () => {
    const closePose = { x: 0, z: 5, yaw: 0 }; // dist 5 < commitDistM (10)
    const r = pursueSteer(closePose, 10, origin, still, CLEAR, initialStuckState, P, DT, 'orbit', null, +1);
    expect(r.behavior).toBe('orbit');
  });

  it('holds ~constant orbit speed: throttle high when slow, ~base at target, ~0 overspeed', () => {
    // Face the tangent so steer≈0 and the corner-ease/wall-cut factors are ~1 → throttle is the
    // raw speed-controller output.
    const aligned = { x: 0, z: P.orbitRadiusM, yaw: -Math.PI / 2 };
    const slow = pursueSteer(aligned, 0, origin, still, CLEAR, initialStuckState, P, DT, 'orbit', null, +1);
    const atSpeed = pursueSteer(aligned, P.orbitSpeedMps, origin, still, CLEAR, initialStuckState, P, DT, 'orbit', null, +1);
    const overspeed = pursueSteer(aligned, 25, origin, still, CLEAR, initialStuckState, P, DT, 'orbit', null, +1);
    expect(Math.abs(slow.command.steer)).toBeLessThan(0.02); // aligned → ~no steer
    expect(slow.command.throttle).toBeGreaterThan(atSpeed.command.throttle);
    expect(atSpeed.command.throttle).toBeGreaterThan(overspeed.command.throttle);
    expect(atSpeed.command.throttle).toBeCloseTo(P.orbitThrottleBase); // P-controller sits at base
    expect(overspeed.command.throttle).toBeCloseTo(0); // eases off when too fast
  });

  it('AVOIDANCE WINS over orbit adherence (a blocked side overrides the tangent)', () => {
    const clear = pursueSteer(onRing, 10, origin, still, CLEAR, initialStuckState, P, DT, 'orbit', null, +1);
    // Pure orbit wants to steer LEFT here; block the LEFT so avoidance demands RIGHT.
    const leftWall: AvoidHits = { center: 0.3, left: 0.1, right: 1 };
    const dodged = pursueSteer(onRing, 10, origin, still, leftWall, initialStuckState, P, DT, 'orbit', null, +1);
    expect(clear.command.steer).toBeLessThan(0); // orbit alone → left
    expect(dodged.command.steer).toBeGreaterThan(0); // avoidance flips it to right — wins
    expect(dodged.behavior).toBe('avoid');
  });
});

// --- Phase 11: standoff ram-switch state machine (stepStandoff / createStandoffBrain) ---------
describe('standoff ram-switch (stepStandoff)', () => {
  // Scaled dwell/exit times so a few DT ticks cross the thresholds.
  const cfg: StandoffBrainParams = { ...SB, ramSwitchSec: 0.3, ramExitSec: 0.2 };
  const FAR = 30; // beyond corneredDistM → never "cornered"

  it('ORBIT → RAM after the player is slow (< ramSwitchSpeedMps) for ramSwitchSec', () => {
    let s: StandoffState = initialStandoffState;
    const slow = SB.ramSwitchSpeedMps - 1; // below the switch speed, above corneredSpeedMps
    s = stepStandoff(s, slow, FAR, DT, cfg);
    expect(s.mode).toBe('orbit'); // 0.1 s dwell
    s = stepStandoff(s, slow, FAR, DT, cfg);
    expect(s.mode).toBe('orbit'); // 0.2 s
    s = stepStandoff(s, slow, FAR, DT, cfg);
    expect(s.mode).toBe('ram'); // 0.3 s ≥ ramSwitchSec → switch
  });

  it('stays in ORBIT while the player keeps running', () => {
    let s: StandoffState = initialStandoffState;
    const running = SB.ramSwitchSpeedMps + 5;
    for (let i = 0; i < 10; i++) s = stepStandoff(s, running, FAR, DT, cfg);
    expect(s.mode).toBe('orbit');
    expect(s.slowSec).toBe(0);
  });

  it('the slow dwell RESETS on a single fast tick (only sustained slow trips it)', () => {
    let s: StandoffState = initialStandoffState;
    const slow = SB.ramSwitchSpeedMps - 1;
    s = stepStandoff(s, slow, FAR, DT, cfg); // 0.1
    s = stepStandoff(s, slow, FAR, DT, cfg); // 0.2
    s = stepStandoff(s, SB.ramSwitchSpeedMps + 5, FAR, DT, cfg); // one fast tick → reset
    expect(s.mode).toBe('orbit');
    expect(s.slowSec).toBe(0);
  });

  it('CORNERED (near-stopped AND within corneredDistM) switches to RAM instantly', () => {
    const pinned = stepStandoff(initialStandoffState, SB.corneredSpeedMps - 1, SB.corneredDistM - 1, DT, cfg);
    expect(pinned.mode).toBe('ram'); // no dwell — cornered is immediate
  });

  it('near-stopped but FAR (outside corneredDistM) is NOT cornered — waits out the dwell', () => {
    const s = stepStandoff(initialStandoffState, SB.corneredSpeedMps - 1, SB.corneredDistM + 20, DT, cfg);
    expect(s.mode).toBe('orbit'); // first tick: dwell not yet elapsed, and not cornered
    expect(s.slowSec).toBeCloseTo(DT);
  });

  it('RAM → ORBIT only after the player runs (> ramExitSpeedMps) for ramExitSec (hysteresis)', () => {
    let s: StandoffState = { mode: 'ram', slowSec: 0, fastSec: 0 };
    const running = SB.ramExitSpeedMps + 2;
    s = stepStandoff(s, running, FAR, DT, cfg);
    expect(s.mode).toBe('ram'); // 0.1 s
    s = stepStandoff(s, running, FAR, DT, cfg);
    expect(s.mode).toBe('orbit'); // 0.2 s ≥ ramExitSec → back to orbit
  });

  it('in the hysteresis gap (ramSwitch < speed < ramExit) a rammer keeps ramming', () => {
    let s: StandoffState = { mode: 'ram', slowSec: 0, fastSec: 0 };
    const between = (SB.ramSwitchSpeedMps + SB.ramExitSpeedMps) / 2; // 5 < 6.5 < 8
    for (let i = 0; i < 10; i++) s = stepStandoff(s, between, FAR, DT, cfg);
    expect(s.mode).toBe('ram');
    expect(s.fastSec).toBe(0); // never accumulated toward exit
  });

  it('the ram exit dwell RESETS on a single slow tick', () => {
    let s: StandoffState = { mode: 'ram', slowSec: 0, fastSec: 0 };
    const running = SB.ramExitSpeedMps + 2;
    s = stepStandoff(s, running, FAR, DT, cfg); // 0.1
    s = stepStandoff(s, 1, FAR, DT, cfg); // slow tick → reset
    expect(s.mode).toBe('ram');
    expect(s.fastSec).toBe(0);
  });
});

describe('standoff ram-switch (createStandoffBrain wrapper)', () => {
  const cfg: StandoffBrainParams = { ...SB, ramSwitchSec: 0.3, ramExitSec: 0.2 };

  it('starts in orbit, drives orbit↔ram through update() with the same timing', () => {
    const brain = createStandoffBrain(cfg);
    expect(brain.mode).toBe('orbit');
    // Slow player for 3 ticks → ram.
    expect(brain.update(2, 30, DT)).toBe('orbit');
    expect(brain.update(2, 30, DT)).toBe('orbit');
    expect(brain.update(2, 30, DT)).toBe('ram');
    expect(brain.mode).toBe('ram');
    // Player runs again for 2 ticks → orbit.
    expect(brain.update(12, 30, DT)).toBe('ram');
    expect(brain.update(12, 30, DT)).toBe('orbit');
    expect(brain.mode).toBe('orbit');
  });

  it('a cornered player flips update() to ram immediately', () => {
    const brain = createStandoffBrain(cfg);
    expect(brain.update(1, SB.corneredDistM - 2, DT)).toBe('ram');
  });
});

// --- Phase 16 Task 5: road-follow approach mode (pursue mode + approachTarget) ----------------
describe('road-follow approach (pursue mode, approachTarget)', () => {
  const APPROACH_ARG = (t: { x: number; z: number } | null) => t; // readability alias

  it('steers toward the road WAYPOINT, not the player, and labels behavior "approach"', () => {
    // Player far dead ahead (+Z); the road waypoint is off to the RIGHT (+X). The unit must aim
    // at the waypoint (steer right), not the player (which would be steer ~0).
    const r = pursueSteer(
      atOrigin, 10, { x: 0, z: 60 }, still, CLEAR, initialStuckState, P, DT,
      'pursue', null, 1, APPROACH_ARG({ x: 30, z: 0 }),
    );
    expect(r.behavior).toBe('approach');
    expect(r.command.steer).toBeGreaterThan(0);
  });

  it('SUPPRESSES ram: a player inside commitDistM stays "approach" (road-follow wins)', () => {
    // Player well inside the ram band, but an approachTarget is present → never rams.
    const r = pursueSteer(
      atOrigin, 10, { x: 0, z: P.commitDistM - 5 }, still, CLEAR, initialStuckState, P, DT,
      'pursue', null, 1, APPROACH_ARG({ x: 20, z: 0 }),
    );
    expect(r.behavior).toBe('approach');
    expect(r.command.steer).toBeGreaterThan(0); // toward the +X waypoint, not the +Z player
  });

  it('closes relentlessly: full throttle toward a waypoint dead ahead, floor respected in a turn', () => {
    const straight = pursueSteer(
      atOrigin, 15, { x: 0, z: 60 }, still, CLEAR, initialStuckState, P, DT,
      'pursue', null, 1, APPROACH_ARG({ x: 0, z: 40 }),
    );
    expect(straight.behavior).toBe('approach');
    expect(Math.abs(straight.command.steer)).toBeLessThan(0.05);
    expect(straight.command.throttle).toBeCloseTo(1);

    const turning = pursueSteer(
      atOrigin, 15, { x: 0, z: 60 }, still, CLEAR, initialStuckState, P, DT,
      'pursue', null, 1, APPROACH_ARG({ x: 60, z: 3 }),
    );
    expect(turning.command.throttle).toBeGreaterThanOrEqual(P.throttleFloor - 1e-9);
  });

  it('avoidance still WINS while approaching (dodging → "avoid")', () => {
    const wall: AvoidHits = { center: 0.05, left: 0.1, right: 0.9 };
    const r = pursueSteer(
      atOrigin, 10, { x: 0, z: 60 }, still, wall, initialStuckState, P, DT,
      'pursue', null, 1, APPROACH_ARG({ x: 0, z: 40 }),
    );
    expect(r.command.steer).toBeGreaterThan(0); // steers toward the clearer (right) side
    expect(r.behavior).toBe('avoid');
  });

  it('a null approachTarget is exactly the pre-Phase-16 pursue (no regression)', () => {
    const withNull = pursueSteer(
      atOrigin, 10, { x: 30, z: 0 }, still, CLEAR, initialStuckState, P, DT,
      'pursue', null, 1, APPROACH_ARG(null),
    );
    const legacy = pursueSteer(atOrigin, 10, { x: 30, z: 0 }, still, CLEAR, initialStuckState, P, DT);
    expect(withNull.behavior).toBe('pursue');
    expect(withNull.command.steer).toBeCloseTo(legacy.command.steer);
  });

  it('is IGNORED in flank mode (a claimed SWAT still boxes in)', () => {
    const r = pursueSteer(
      atOrigin, 10, { x: 0, z: 40 }, still, CLEAR, initialStuckState, P, DT,
      'flank', { x: 30, z: 0 }, 1, APPROACH_ARG({ x: -30, z: 0 }),
    );
    expect(r.behavior).toBe('flank');
    expect(r.command.steer).toBeGreaterThan(0); // toward the flank slot (+X), NOT the approach (−X)
  });

  it('is IGNORED in orbit mode (the standoff ring is unchanged)', () => {
    const onRing = { x: 0, z: P.orbitRadiusM, yaw: 0 };
    const r = pursueSteer(
      onRing, 10, { x: 0, z: 0 }, still, CLEAR, initialStuckState, P, DT,
      'orbit', null, 1, APPROACH_ARG({ x: 40, z: 0 }),
    );
    expect(r.behavior).toBe('orbit');
  });
});

// --- Phase 16 Task 5: unstick-toward-road state machine --------------------------------------
describe('roadSeekDurationFor (escalation)', () => {
  it('is the base window with no prior episodes', () => {
    expect(roadSeekDurationFor(0, P)).toBeCloseTo(P.roadSeekBaseSec);
  });

  it('escalates by roadSeekEscalationSec per consecutive episode', () => {
    expect(roadSeekDurationFor(2, P)).toBeCloseTo(P.roadSeekBaseSec + 2 * P.roadSeekEscalationSec);
  });

  it('caps at roadSeekMaxSec and never goes negative', () => {
    expect(roadSeekDurationFor(1000, P)).toBe(P.roadSeekMaxSec);
    expect(roadSeekDurationFor(-5, P)).toBeCloseTo(P.roadSeekBaseSec); // clamps episodes at 0
  });
});

describe('unstick road-seek state machine (pursueSteer)', () => {
  const params: PursuitSteerParams = { ...AI_STEERING, stuckSec: 0.3, reverseSec: 0.2 };

  it('opens a road-seek window (base) when a reversal COMPLETES this step', () => {
    // A reversal with exactly one dt left: this tick zeroes it → road-seek opens at the base
    // window (0 prior episodes).
    const finishing: StuckState = {
      slowSec: 0, reverseRemainSec: DT, reverseDir: 1, roadSeekRemainSec: 0, stuckEpisodes: 0,
    };
    const r = pursueSteer(atOrigin, 5, { x: 0, z: 40 }, still, CLEAR, finishing, params, DT);
    expect(r.behavior).toBe('stuck');
    expect(r.stuck.reverseRemainSec).toBeCloseTo(0);
    expect(r.stuck.roadSeekRemainSec).toBeCloseTo(roadSeekDurationFor(0, params));
  });

  it('the opened window ESCALATES with the banked episode count', () => {
    const finishing: StuckState = {
      slowSec: 0, reverseRemainSec: DT, reverseDir: 1, roadSeekRemainSec: 0, stuckEpisodes: 3,
    };
    const r = pursueSteer(atOrigin, 5, { x: 0, z: 40 }, still, CLEAR, finishing, params, DT);
    expect(r.stuck.roadSeekRemainSec).toBeCloseTo(roadSeekDurationFor(3, params));
  });

  it('does NOT open the window mid-reversal (still reversing → no road-seek yet)', () => {
    const midReverse: StuckState = {
      slowSec: 0, reverseRemainSec: 0.5, reverseDir: 1, roadSeekRemainSec: 0, stuckEpisodes: 2,
    };
    const r = pursueSteer(atOrigin, 5, { x: 0, z: 40 }, still, CLEAR, midReverse, params, DT);
    expect(r.stuck.reverseRemainSec).toBeCloseTo(0.4);
    expect(r.stuck.roadSeekRemainSec).toBe(0);
  });

  it('a stuck trip BANKS an episode (increments the count) and starts the reversal', () => {
    // slowSec already at stuckSec: one more slow-while-throttling tick trips the reversal.
    const primed: StuckState = {
      slowSec: params.stuckSec, reverseRemainSec: 0, reverseDir: 1, roadSeekRemainSec: 0, stuckEpisodes: 4,
    };
    const r = pursueSteer(atOrigin, 0.1, { x: 0, z: 40 }, still, CLEAR, primed, params, DT);
    expect(r.behavior).toBe('stuck');
    expect(r.stuck.reverseRemainSec).toBeCloseTo(params.reverseSec);
    expect(r.stuck.stuckEpisodes).toBe(5);
    expect(r.stuck.roadSeekRemainSec).toBe(0);
  });

  it('counts down an open window each normal tick, keeping the episode count', () => {
    const seeking: StuckState = {
      slowSec: 0, reverseRemainSec: 0, reverseDir: 1, roadSeekRemainSec: 0.5, stuckEpisodes: 3,
    };
    const r = pursueSteer(atOrigin, 15, { x: 0, z: 40 }, still, CLEAR, seeking, params, DT);
    expect(r.stuck.roadSeekRemainSec).toBeCloseTo(0.4);
    expect(r.stuck.stuckEpisodes).toBe(3); // window not yet elapsed → count preserved
  });

  it('RESETS the episode count when a window elapses without re-sticking (clean escape)', () => {
    const lastTick: StuckState = {
      slowSec: 0, reverseRemainSec: 0, reverseDir: 1, roadSeekRemainSec: DT, stuckEpisodes: 3,
    };
    const r = pursueSteer(atOrigin, 15, { x: 0, z: 40 }, still, CLEAR, lastTick, params, DT);
    expect(r.stuck.roadSeekRemainSec).toBe(0);
    expect(r.stuck.stuckEpisodes).toBe(0);
  });
});
