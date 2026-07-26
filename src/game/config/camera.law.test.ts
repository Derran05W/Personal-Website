// THE §5.3 CAMERA LAW (Phase 34). Every other camera test in the repo is deliberately RELATIVE —
// it asserts that the rig responds correctly to whatever CAMERA says, which is what let the rig
// survive three retunes untouched. This file is the opposite and exists for exactly that reason:
// it is the one place the shipped rig's ABSOLUTE numbers are written down, so a feel tweak that
// moves them has to come here and argue with the constraint that chose them.
//
// The constraint is the corridor-airspace law, measured live in Phase 33: on the dieted Yonge
// spine the streetwall face plane sits ~10.7 wu off the centreline, so under the fixed 45° yaw
// the camera eye stays inside the street's own airspace only while its horizontal radius
// hr = dist·cos(pitch) ≤ ~14.8 wu. Beyond that the eye is in (or behind) the frontage and the
// screen is a featureless wall — the user's headline complaint, photographed at that vantage.
// Downtown facades tower over any sane eye height, so "clear it by rising above the roofline" is
// not available: staying inside the canyon is the ONLY way through a street here.
//
// The bound is a property of the WORLD (road diet + streetwall setback, Phases 27-28), not of the
// camera, which is why it is stated as a constant here rather than derived from CAMERA: if the
// street widens, this number changes and the rig gets headroom back.
import { describe, expect, it } from 'vitest';
import { CAMERA, CAMERA_PRESETS } from './camera';
import { STARTER_TOP_SPEED } from './vehicles';
import { cameraDistance, cameraPitchOffsetDeg, sphericalOffset } from '../fx/cameraRig';

/** Max horizontal radius (wu) that keeps the eye inside a dieted street's airspace under yaw 45.
 * Phase 33 Discovery 3 — the number that eliminated every candidate rig above it. */
const CORRIDOR_MAX_HR_WU = 14.8;

/** Absolute pitch (deg) past which the framing reads as vertigo rather than a 3/4 view. A feel
 * ceiling, not a measurement: it is the other jaw of the vice the speed/tier pitch ramp lives in
 * (more pitch always buys corridor margin, so something has to stop it). */
const MAX_ABSOLUTE_PITCH_DEG = 70;

const TIERS = [0, 1, 2, 3, 4, 5] as const;

/**
 * The rig's own solve for a player state, read back as the four numbers the law is about. Runs the
 * PRODUCTION path (cameraDistance + cameraPitchOffsetDeg + sphericalOffset) rather than restating
 * the spherical formula — a duplicated formula would keep passing after the rig stopped using it.
 */
function envelope(speed: number, tier: number, pullback = 0, externalPitchOffsetDeg = 0) {
  const dist = cameraDistance(speed, tier, pullback);
  const pitchOffset = cameraPitchOffsetDeg(speed, tier) + externalPitchOffsetDeg;
  const offset = sphericalOffset({ x: 0, y: 0, z: 0 }, dist, 0, pitchOffset);
  return {
    dist,
    pitchDeg: CAMERA.pitchDeg + pitchOffset,
    eye: offset.y,
    hr: Math.hypot(offset.x, offset.z),
  };
}

describe('§5.3 camera law — the shipped rig', () => {
  // Rig E, picked by the user at the Phase 33 USER GATE (2026-07-26). Changing any of these four
  // is a camera-law change: it needs a user decision, not a tuning session.
  it('is yaw 45 / pitch 58 / baseDist 26 / FOV 38', () => {
    expect(CAMERA.yawDeg).toBe(45);
    expect(CAMERA.pitchDeg).toBe(58);
    expect(CAMERA.baseDist).toBe(26);
    expect(CAMERA.fov).toBe(38);
  });

  it('rests at eye 22.05 wu / horizontal radius 13.78 wu', () => {
    const rest = envelope(0, 0);
    expect(rest.dist).toBeCloseTo(CAMERA.baseDist, 9);
    expect(rest.eye).toBeCloseTo(22.05, 2);
    expect(rest.hr).toBeCloseTo(13.78, 2);
  });

  it('adds no ramp at all at rest with no heat (the rest numbers ARE the base leaves)', () => {
    expect(cameraPitchOffsetDeg(0, 0)).toBe(0);
    expect(envelope(0, 0).pitchDeg).toBe(CAMERA.pitchDeg);
  });

  // The lab's preset table is the map of every rig this decision considered; E is the one that
  // shipped. Keeping the two in lockstep means a live `setCameraPreset('E')` reproduces the
  // default boot exactly, which is what makes lab evidence comparable to shipped frames.
  it('is preset E, field for field', () => {
    const e = CAMERA_PRESETS.find((p) => p.id === 'E');
    expect(e).toBeDefined();
    expect({ yawDeg: e?.yawDeg, pitchDeg: e?.pitchDeg, baseDist: e?.baseDist, fov: e?.fov }).toEqual({
      yawDeg: CAMERA.yawDeg,
      pitchDeg: CAMERA.pitchDeg,
      baseDist: CAMERA.baseDist,
      fov: CAMERA.fov,
    });
  });
});

describe('§5.3 camera law — the corridor-airspace invariant', () => {
  // THE durable assertion. Stated in the leaves themselves (not just through the rig) so the
  // failure message names the two knobs that broke it: a future feel pass that pushes speedZoom
  // back up without paying for it in speedPitchDeg fails HERE, not in a bug report about the
  // camera being inside a building at speed.
  it('holds at top speed with no heat: (baseDist + speedZoom)·cos(pitch + speedPitchDeg) ≤ 14.8', () => {
    const hr =
      (CAMERA.baseDist + CAMERA.speedZoom) * Math.cos(((CAMERA.pitchDeg + CAMERA.speedPitchDeg) * Math.PI) / 180);
    expect(hr).toBeLessThanOrEqual(CORRIDOR_MAX_HR_WU);
    // ...and the rig actually solves to that, i.e. the leaves above are the ones it reads.
    expect(envelope(STARTER_TOP_SPEED, 0).hr).toBeCloseTo(hr, 9);
  });

  it('holds across the whole ★ ladder, at rest and at top speed', () => {
    for (const tier of TIERS) {
      expect(envelope(0, tier).hr, `rest ★${tier}`).toBeLessThanOrEqual(CORRIDOR_MAX_HR_WU);
      expect(envelope(STARTER_TOP_SPEED, tier).hr, `top speed ★${tier}`).toBeLessThanOrEqual(CORRIDOR_MAX_HR_WU);
    }
  });

  it('buys that margin with pitch, not by refusing to zoom (the frame still opens up)', () => {
    const rest = envelope(0, 0);
    const fast = envelope(STARTER_TOP_SPEED, 0);
    expect(fast.dist).toBeGreaterThan(rest.dist);
    expect(fast.eye).toBeGreaterThan(rest.eye);
    // The whole point of the split: more distance, MORE eye height, and yet a SHORTER radius.
    expect(fast.hr).toBeLessThan(rest.hr);
  });

  it('never pitches past the vertigo ceiling anywhere in the envelope', () => {
    for (const tier of TIERS) {
      expect(envelope(STARTER_TOP_SPEED, tier).pitchDeg, `top speed ★${tier}`).toBeLessThanOrEqual(
        MAX_ABSOLUTE_PITCH_DEG,
      );
    }
  });

  // The death beat is the one moment the player is guaranteed to be staring at the frame, so its
  // WRECKED framing is held to the same bound as normal play at the tiers a wreck is likeliest.
  // BUSTED is deliberately NOT: an arrest angle is low, a low angle is geometrically wide, and
  // that excursion is measured and documented in config/camera.ts rather than pretended away.
  it('keeps the WRECKED survey pull-back inside the corridor at ★0-★3', () => {
    for (const tier of [0, 1, 2, 3]) {
      const beat = envelope(0, tier, CAMERA.deathPullback, CAMERA.cinematic.wreckedPitchOffsetDeg);
      expect(beat.hr, `wrecked ★${tier}`).toBeLessThanOrEqual(CORRIDOR_MAX_HR_WU);
      expect(beat.dist, `wrecked ★${tier}`).toBeGreaterThan(envelope(0, tier).dist);
    }
  });

  it('keeps the BUSTED arrest low enough to read as an arrest', () => {
    // Absolute pitch at the tiers a bust actually happens on (BUSTED arms at ★1+; ★2-★3 is the
    // realistic band) — the low-angle identity the -22 offset exists to restore.
    for (const tier of [2, 3]) {
      const beat = envelope(0, tier, CAMERA.cinematic.bustedPullback, CAMERA.cinematic.bustedPitchOffsetDeg);
      expect(beat.pitchDeg, `busted ★${tier}`).toBeGreaterThan(36);
      expect(beat.pitchDeg, `busted ★${tier}`).toBeLessThan(41);
      // ...and it converges IN, never out (the WRECKED beat is the one that steps back).
      expect(beat.dist, `busted ★${tier}`).toBeLessThan(envelope(0, tier).dist);
    }
  });
});
