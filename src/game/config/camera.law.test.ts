// THE §5.3 CAMERA LAW (Phase 34). Every other camera test in the repo is deliberately RELATIVE —
// it asserts that the rig responds correctly to whatever CAMERA says, which is what let the rig
// survive three retunes untouched. This file is the opposite and exists for exactly that reason:
// it is the one place the shipped rig's ABSOLUTE numbers are written down, so a feel tweak that
// moves them has to come here and argue with the constraint that chose them.
//
// The constraint is the corridor-airspace law: under the fixed 45° yaw the camera eye stays inside
// a street's own airspace only while its horizontal radius hr = dist·cos(pitch) stays under a
// ceiling the STREET sets. Beyond that the eye is in (or behind) the frontage and the screen is a
// featureless wall — the user's headline complaint, photographed at the fold corridor in Phase 33.
//
// THE BOUND MOVED HOUSE AT PHASE 76. This header used to state the ceiling as the literal `14.8`
// while simultaneously observing that it "is a property of the WORLD … if the street widens, this
// number changes" — which is precisely how it survived Phase 27's road diet AND Phase 75's
// doubling without moving. It now comes from world/toronto/corridorLaw.ts, which derives the
// per-class ceilings from Street.halfWidth + SIDEWALK.widthWu and records what the old literal
// actually was (an EMPIRICAL discriminator fitted to the Phase 33 battery — preset B's own hr,
// 14.838, rounded down; its stated geometry was computed against a spine width that Phase 27 had
// already superseded). Read that module's header before touching anything here; the shortfalls the
// shipped rig knowingly carries are pinned in world/toronto/corridorLaw.test.ts, not hidden.
//
// This file keeps the CAMERA half of the law: the shipped rig's absolute numbers, and the
// assertion that its whole envelope stays inside the bound.
import { describe, expect, it } from 'vitest';
import { CAMERA, CAMERA_EYE_MAX_WU, CAMERA_EYE_MIN_WU, CAMERA_PRESETS } from './camera';
import { STARTER_TOP_SPEED } from './vehicles';
import { cameraDistance, cameraPitchOffsetDeg, sphericalOffset } from '../fx/cameraRig';
import { CORRIDOR_EMPIRICAL_MAX_HR_WU } from '../world/toronto/corridorLaw';

/** Max horizontal radius (wu) the shipped envelope may reach: the smallest hr the Phase 33 battery
 * ever measured to be UNSAFE, derived from the preset it was measured on (see corridorLaw.ts's
 * CORRIDOR_EMPIRICAL_MAX_HR_WU). 14.838 — the honest form of the `14.8` this file used to type. */
const CORRIDOR_MAX_HR_WU = CORRIDOR_EMPIRICAL_MAX_HR_WU;

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

describe('§5.3 camera law — the eye line (Phase 35)', () => {
  // The vertical half of the law. Where the corridor invariant below bounds the eye's HORIZONTAL
  // radius (can the eye stay inside the street?), these bound its HEIGHT (does ordinary geometry
  // clear it?). Both constants are computed in config/camera.ts from the CAMERA leaves; this block
  // is what stops them from being quietly replaced by a literal — the failure the whole "~13.8 wu
  // camera wall" doctrine was (a number that outlived the rig that produced it by two retunes).
  it('EYE_MIN is the resting eye: baseDist·sin(pitch) = 22.05 wu', () => {
    expect(CAMERA_EYE_MIN_WU).toBeCloseTo(CAMERA.baseDist * Math.sin((CAMERA.pitchDeg * Math.PI) / 180), 9);
    expect(CAMERA_EYE_MIN_WU).toBeCloseTo(22.05, 2);
  });

  it('EYE_MIN is exactly what the production rig solves at rest, ★0', () => {
    expect(envelope(0, 0).eye).toBeCloseTo(CAMERA_EYE_MIN_WU, 9);
  });

  // The anti-drift assertion the plan asks for: EYE_MAX is asserted through the COMPOSITION of the
  // rig's own exported pure fns (cameraDistance + cameraPitchOffsetDeg + sphericalOffset) at the
  // saturated end of the ramp, not by re-deriving the spherical formula. If a future ramp stops
  // being monotonic in speed/tier, or grows a third term, the constant's closed form stops matching
  // the rig and THIS fails — rather than the constant silently under-reporting the real envelope.
  it('EYE_MAX is the rig\'s own solve at top speed, ★5 = 35.13 wu', () => {
    expect(CAMERA_EYE_MAX_WU).toBeCloseTo(envelope(STARTER_TOP_SPEED, 5).eye, 9);
    expect(CAMERA_EYE_MAX_WU).toBeCloseTo(35.13, 2);
  });

  it('brackets the whole normal-play envelope (every speed × tier sits inside)', () => {
    for (const tier of TIERS) {
      for (const speed of [0, STARTER_TOP_SPEED * 0.25, STARTER_TOP_SPEED * 0.5, STARTER_TOP_SPEED]) {
        const eye = envelope(speed, tier).eye;
        expect(eye, `★${tier} @ ${speed}`).toBeGreaterThanOrEqual(CAMERA_EYE_MIN_WU - 1e-9);
        expect(eye, `★${tier} @ ${speed}`).toBeLessThanOrEqual(CAMERA_EYE_MAX_WU + 1e-9);
      }
    }
  });

  // Documented, deliberate: the death beat is NOT bounded by the eye line. BUSTED's -22° pitch is a
  // low arrest angle, a low angle means a low eye, and Phase 36's anti-clip — not a height re-grade
  // — is what keeps that 1-2 s scripted move out of the streetwall. Asserted (rather than merely
  // commented) so nobody later "fixes" the law by widening it to cover the beat.
  it('deliberately excludes the BUSTED beat, which dips below EYE_MIN by design', () => {
    const busted = envelope(0, 2, CAMERA.cinematic.bustedPullback, CAMERA.cinematic.bustedPitchOffsetDeg);
    expect(busted.eye).toBeLessThan(CAMERA_EYE_MIN_WU);
  });
});

describe('§5.3 camera law — the corridor-airspace invariant', () => {
  // THE durable assertion. Stated in the leaves themselves (not just through the rig) so the
  // failure message names the two knobs that broke it: a future feel pass that pushes speedZoom
  // back up without paying for it in speedPitchDeg fails HERE, not in a bug report about the
  // camera being inside a building at speed.
  it('holds at top speed with no heat: (baseDist + speedZoom)·cos(pitch + speedPitchDeg) ≤ the bound', () => {
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
