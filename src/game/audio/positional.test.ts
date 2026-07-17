import { describe, expect, it } from 'vitest';
import {
  CAMERA_YAW_RAD,
  bearingPan,
  distanceGain,
  resolvePositionalMasterTarget,
  selectHumVoices,
  spatialParams,
  type HumCandidate,
} from './positional';
import { CAMERA } from '../config/camera';

// jsdom has no Web Audio implementation, so — as in sirens/manager — only the pure decision
// logic is unit-tested here: distance gain, bearing pan (incl. the camera-azimuth rotation),
// the nearest-N lit-only hum cull with hysteresis, and the master gate. The impure oscillator/
// StereoPanner plumbing is a human-on-hardware check (see positional.ts's file header).

const SQRT1_2 = Math.SQRT1_2; // cos45 = sin45 ≈ 0.7071

describe('distanceGain', () => {
  it('is 1 at distance 0', () => {
    expect(distanceGain(0, 25)).toBe(1);
  });

  it('is 0 at exactly the radius', () => {
    expect(distanceGain(25, 25)).toBe(0);
  });

  it('is 0 beyond the radius (clamped, not negative)', () => {
    expect(distanceGain(1000, 25)).toBe(0);
  });

  it('is linear in between', () => {
    expect(distanceGain(12.5, 25)).toBeCloseTo(0.5);
  });

  it('clamps a defensively-negative distance to 1, not >1', () => {
    expect(distanceGain(-5, 25)).toBe(1);
  });

  it('treats a non-finite distance as silence (0)', () => {
    expect(distanceGain(NaN, 25)).toBe(0);
    expect(distanceGain(Infinity, 25)).toBe(0);
  });

  it('is 0 for a non-positive radius', () => {
    expect(distanceGain(1, 0)).toBe(0);
    expect(distanceGain(1, -10)).toBe(0);
  });
});

describe('CAMERA_YAW_RAD', () => {
  it('is the fixed follow-camera yaw in radians (the pan reference axis)', () => {
    expect(CAMERA_YAW_RAD).toBeCloseTo((CAMERA.yawDeg * Math.PI) / 180);
  });
});

describe('bearingPan (view-space stereo pan)', () => {
  // Default camera yaw = 45°: camera sits +X/+Z of the player looking back at it, so the
  // view-space right axis is right_h = (cos45, -sin45).
  it('pans a source along the camera-right axis hard right (+1)', () => {
    // right_h direction = (cos45, -sin45)
    expect(bearingPan(SQRT1_2, -SQRT1_2)).toBeCloseTo(1);
  });

  it('pans a source along the camera-left axis hard left (-1)', () => {
    expect(bearingPan(-SQRT1_2, SQRT1_2)).toBeCloseTo(-1);
  });

  it('pans a source dead ahead/behind to center (0)', () => {
    // view-forward = (-sin45, -cos45); anything along that axis has no left/right component
    expect(bearingPan(-SQRT1_2, -SQRT1_2)).toBeCloseTo(0);
  });

  it('due-East is to the right, due-West is to the left (at yaw 45°)', () => {
    expect(bearingPan(1, 0)).toBeCloseTo(SQRT1_2); // +right
    expect(bearingPan(-1, 0)).toBeCloseTo(-SQRT1_2); // -left
  });

  it('due-North is right, due-South is left (at yaw 45°)', () => {
    expect(bearingPan(0, -1)).toBeCloseTo(SQRT1_2); // -Z (north) → right
    expect(bearingPan(0, 1)).toBeCloseTo(-SQRT1_2); // +Z (south) → left
  });

  it('is antisymmetric: swapping the source across the listener flips the pan', () => {
    expect(bearingPan(3, -2)).toBeCloseTo(-bearingPan(-3, 2));
  });

  it('returns 0 when the source sits on top of the listener', () => {
    expect(bearingPan(0, 0)).toBe(0);
    expect(bearingPan(1e-9, -1e-9)).toBe(0);
  });

  it('stays within [-1, 1]', () => {
    for (const [dx, dz] of [
      [100, -3],
      [-2, 40],
      [0.1, -0.1],
      [-50, -50],
    ]) {
      const pan = bearingPan(dx, dz);
      expect(pan).toBeGreaterThanOrEqual(-1);
      expect(pan).toBeLessThanOrEqual(1);
    }
  });

  it('defaults to CAMERA_YAW_RAD', () => {
    expect(bearingPan(1, 0)).toBe(bearingPan(1, 0, CAMERA_YAW_RAD));
  });

  it('the camera-azimuth rotation changes the pan of the SAME world source', () => {
    // A source due East (dx=1, dz=0):
    //  • yaw 0  (camera looks -Z): East is the screen-right axis → hard right (+1).
    //  • yaw 90° (camera looks -X): East is straight ahead → dead center (0).
    expect(bearingPan(1, 0, 0)).toBeCloseTo(1);
    expect(bearingPan(1, 0, Math.PI / 2)).toBeCloseTo(0);
  });
});

describe('spatialParams', () => {
  it('gain uses distance FROM the listener; pan uses the displacement', () => {
    const listener = { x: 10, z: -4 };
    const onTop = spatialParams(10, -4, listener, 25);
    expect(onTop.gain).toBe(1);
    expect(onTop.pan).toBe(0);
  });

  it('gain falls to 0 at the radius from the listener (not from the world origin)', () => {
    const listener = { x: 100, z: 100 };
    const atEdge = spatialParams(100 + 25, 100, listener, 25);
    expect(atEdge.gain).toBeCloseTo(0);
  });

  it('pan matches bearingPan of the listener-relative displacement', () => {
    const listener = { x: 5, z: 5 };
    const p = spatialParams(5 + 1, 5, listener, 90); // displacement (1, 0)
    expect(p.pan).toBeCloseTo(bearingPan(1, 0));
  });
});

describe('selectHumVoices (nearest-N, lit-only, hysteresis)', () => {
  const cands: readonly HumCandidate[] = [
    { districtId: 0, x: 5, z: 0 },
    { districtId: 1, x: 10, z: 0 },
    { districtId: 2, x: 15, z: 0 },
    { districtId: 3, x: 20, z: 0 },
  ];
  const origin = { x: 0, z: 0 };
  const allLit = () => true;

  it('keeps the nearest maxVoices, ascending by distance', () => {
    const r = selectHumVoices(origin, cands, allLit, { radiusM: 100, maxVoices: 3 });
    expect(r.map((s) => s.districtId)).toEqual([0, 1, 2]);
    expect(r.map((s) => s.dist)).toEqual([5, 10, 15]);
  });

  it('excludes DARK/destroyed districts, promoting the next-nearest lit one', () => {
    const isLit = (d: number) => d !== 0; // district 0's transformer is destroyed
    const r = selectHumVoices(origin, cands, isLit, { radiusM: 100, maxVoices: 3 });
    expect(r.map((s) => s.districtId)).toEqual([1, 2, 3]);
  });

  it('culls candidates beyond the audible radius', () => {
    const r = selectHumVoices(origin, cands, allLit, { radiusM: 12, maxVoices: 3 });
    expect(r.map((s) => s.districtId)).toEqual([0, 1]); // 15 and 20 are out of range
  });

  it('hysteresis: an already-voiced district keeps its voice out to radius + hysteresis', () => {
    const opts = { radiusM: 12, maxVoices: 3, hysteresisM: 5 };
    // district 2 is at dist 15: outside the 12 m acquire radius, inside the 17 m release radius.
    const cold = selectHumVoices(origin, cands, allLit, opts);
    expect(cold.map((s) => s.districtId)).toEqual([0, 1]); // 2 not acquired

    const warm = selectHumVoices(origin, cands, allLit, { ...opts, prevSelected: new Set([2]) });
    expect(warm.map((s) => s.districtId)).toEqual([0, 1, 2]); // 2 retained via hysteresis
  });

  it('hysteresis still culls a previously-voiced district past the release radius', () => {
    const r = selectHumVoices(origin, cands, allLit, {
      radiusM: 12,
      maxVoices: 3,
      hysteresisM: 5,
      prevSelected: new Set([3]), // district 3 at dist 20 > release radius 17
    });
    expect(r.map((s) => s.districtId)).toEqual([0, 1]);
  });

  it('computes straight-line XZ distance (3-4-5)', () => {
    const r = selectHumVoices(origin, [{ districtId: 7, x: 3, z: 4 }], allLit, {
      radiusM: 100,
      maxVoices: 1,
    });
    expect(r[0].dist).toBe(5);
  });

  it('returns [] for no candidates and for maxVoices 0', () => {
    expect(selectHumVoices(origin, [], allLit, { radiusM: 100, maxVoices: 3 })).toEqual([]);
    expect(selectHumVoices(origin, cands, allLit, { radiusM: 100, maxVoices: 0 })).toEqual([]);
  });
});

describe('resolvePositionalMasterTarget', () => {
  it('is 1 only while PLAYING and unmuted, else 0', () => {
    expect(resolvePositionalMasterTarget(false, 'PLAYING')).toBe(1);
    expect(resolvePositionalMasterTarget(true, 'PLAYING')).toBe(0);
    expect(resolvePositionalMasterTarget(false, 'PAUSED')).toBe(0);
    expect(resolvePositionalMasterTarget(false, 'GARAGE')).toBe(0);
    expect(resolvePositionalMasterTarget(false, 'GAMEOVER')).toBe(0);
    expect(resolvePositionalMasterTarget(false, 'BOOT')).toBe(0);
    expect(resolvePositionalMasterTarget(false, 'LOADING')).toBe(0);
  });
});
