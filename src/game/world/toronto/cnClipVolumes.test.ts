import { describe, expect, it } from 'vitest';
import { buildCnTowerGeometry } from './heroes';
import { cnBaseBandCuts, cnBaseClipVolumes, cnShaftClipVolumes, heroCylinderClipVolume } from './cnClipVolumes';
import type { ClipAabb } from './cameraClipIndex';
import { solveAntiClipPull } from './cameraAntiClip';
import { CAMERA } from '../../config/camera';

/** Where the tower stands in these tests. Arbitrary and non-zero on purpose: every assertion below
 * is written in tower-local coordinates and translated through `at`, so a translation bug cannot
 * hide behind an origin of (0,0). */
const AT = { x: 1170, z: 2298 };

const cn = buildCnTowerGeometry();
const META = cn.meta;
const POSITIONS = cn.geometry.getAttribute('position').array as Float32Array;
const BASE = cnBaseClipVolumes(POSITIONS, META, AT);
const SHAFT = cnShaftClipVolumes(META.shaftColliders, AT);
const ALL = [...BASE, ...SHAFT];

/** The volume CN's base used to contribute: ONE box around the leg splay's bounding cylinder. Kept
 * here as the before-picture every tightness assertion below is measured against. */
const OLD_BASE_BOX = heroCylinderClipVolume(META.collider, AT);

function inside(vols: readonly ClipAabb[], x: number, y: number, z: number, margin = 0): boolean {
  return vols.some(
    (b) =>
      x >= b.minX - margin &&
      x <= b.maxX + margin &&
      y >= b.minY - margin &&
      y <= b.maxY + margin &&
      z >= b.minZ - margin &&
      z <= b.maxZ + margin,
  );
}

/** A tower-local polar point (azimuth measured from +Z toward +X, the convention ribAzimuths use). */
function atAz(az: number, r: number, y: number): { x: number; y: number; z: number } {
  return { x: AT.x + r * Math.sin(az), y, z: AT.z + r * Math.cos(az) };
}

/** The fixed rig's eye for a parked car: yaw 45 (so the eye sits SE of the car on the diagonal) at
 * `CAMERA.baseDist` and `CAMERA.pitchDeg`. Written from the config, not from the measured 13.78 /
 * 22.05 constants, so a rig change re-derives instead of silently invalidating the test. */
function eyeFor(car: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const p = (CAMERA.pitchDeg * Math.PI) / 180;
  const horiz = CAMERA.baseDist * Math.cos(p) * Math.SQRT1_2;
  return { x: car.x + horiz, y: car.y + CAMERA.baseDist * Math.sin(p), z: car.z + horiz };
}

const NW_AZ = META.ribAzimuths[1]; // 225 deg — the leg that points down the boresight
const SE_GAP_AZ = NW_AZ + Math.PI; // 45 deg — the arch void that faces the lens

describe('cnBaseClipVolumes — coverage (the property that must never regress)', () => {
  it('contains every base vertex of the shipped tower mesh', () => {
    let uncovered = 0;
    for (let i = 0; i < POSITIONS.length; i += 3) {
      const y = POSITIONS[i + 1];
      if (y > META.legTopY) continue; // above the merge the shaft hints take over
      if (!inside(BASE, AT.x + POSITIONS[i], y, AT.z + POSITIONS[i + 2], 1e-6)) uncovered++;
    }
    expect(uncovered).toBe(0);
  });

  it('contains every base triangle centroid too (bands take whole triangles, not loose vertices)', () => {
    let uncovered = 0;
    for (let t = 0; t + 8 < POSITIONS.length; t += 9) {
      const cx = (POSITIONS[t] + POSITIONS[t + 3] + POSITIONS[t + 6]) / 3;
      const cy = (POSITIONS[t + 1] + POSITIONS[t + 4] + POSITIONS[t + 7]) / 3;
      const cz = (POSITIONS[t + 2] + POSITIONS[t + 5] + POSITIONS[t + 8]) / 3;
      if (cy > META.legTopY) continue;
      if (!inside(BASE, AT.x + cx, cy, AT.z + cz, 1e-6)) uncovered++;
    }
    expect(uncovered).toBe(0);
  });

  it('covers each leg out to its splay and the core at every band', () => {
    for (const az of META.ribAzimuths) {
      for (const y of [0.5, 4, 8, 12, 16, 19]) {
        // A point on the rib azimuth, well inside the leg's radial reach at that height.
        const p = atAz(az, 8, y);
        expect(inside(BASE, p.x, p.y, p.z)).toBe(true);
      }
    }
    for (const y of [0.5, 6, 12, 18]) {
      expect(inside(BASE, AT.x, y, AT.z)).toBe(true); // the trunk/shaft core itself
    }
  });

  it('is fed a triangle SOUP, which is the assumption its band assignment rests on', () => {
    // Three consecutive position triples = one triangle. An indexed geometry would silently break
    // that grouping (the bands would take arbitrary vertex triples as triangles), so the day
    // heroes.ts starts indexing its merge, this fails loudly instead of quietly mis-banding.
    expect(cn.geometry.index).toBeNull();
    expect(POSITIONS.length % 9).toBe(0);
  });

  it('stays inside its own scope: nothing below the ground or above the leg merge', () => {
    for (const b of BASE) {
      expect(b.minY).toBeGreaterThanOrEqual(0);
      expect(b.maxY).toBeLessThanOrEqual(META.legTopY + 1e-9);
    }
    expect(cnBaseBandCuts(META)[0]).toBe(0);
    expect(cnBaseBandCuts(META).at(-1)).toBeCloseTo(META.legTopY, 9);
    expect(cnBaseBandCuts(META)).toContain(META.archApexY);
  });
});

describe('cnBaseClipVolumes — tightness (the property that unsticks the anti-clip guard)', () => {
  it('leaves the boresight diagonal clear past the legs, where the old box claimed air', () => {
    const margin = CAMERA.antiClip.marginWu;
    for (const y of [1, 3, 6, 9]) {
      const p = atAz(NW_AZ, 11.5, y);
      expect(inside(BASE, p.x, p.y, p.z, margin)).toBe(false);
      // …and the single fat box DID contain it: its half-diagonal reached 10.5 * sqrt2 = 14.85 wu.
      expect(inside([OLD_BASE_BOX], p.x, p.y, p.z, margin)).toBe(true);
    }
  });

  it('frees the diagonal corners on every quadrant, not just the boresight one', () => {
    for (const az of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
      const p = atAz(az, 12, 5);
      expect(inside(ALL, p.x, p.y, p.z, CAMERA.antiClip.marginWu)).toBe(false);
      expect(inside([OLD_BASE_BOX], p.x, p.y, p.z)).toBe(true);
    }
  });

  it('reads the arch void under the apex as the open air it is', () => {
    // The gap centre that faces the camera, below the arch's springing: nothing but air between the
    // set-back trunk and the footprint edge.
    for (const y of [1, 2, 3]) {
      for (const r of [7, 8.5, 10]) {
        const p = atAz(SE_GAP_AZ, r, y);
        expect(inside(BASE, p.x, p.y, p.z)).toBe(false);
      }
    }
  });

  it('never claims volume beyond the tower footprint by more than the leg rectangles corner slack', () => {
    // Each leg box is the AABB of a rotated rectangle, so its corners sit slightly outside the
    // 10.5 wu footprint radius. Pinned so a future re-proportioning that made the base genuinely
    // wider would have to say so out loud.
    let worst = 0;
    for (const b of BASE) {
      for (const x of [b.minX, b.maxX]) {
        for (const z of [b.minZ, b.maxZ]) {
          worst = Math.max(worst, Math.hypot(x - AT.x, z - AT.z));
        }
      }
    }
    expect(worst).toBeLessThan(META.collider.radius + 1.2);
  });
});

describe('cnBaseClipVolumes — determinism and placement', () => {
  it('is a pure function of its inputs', () => {
    expect(cnBaseClipVolumes(POSITIONS, META, AT)).toEqual(BASE);
  });

  it('translates exactly with the lot centre', () => {
    const other = { x: AT.x - 400, z: AT.z + 137 };
    const moved = cnBaseClipVolumes(POSITIONS, META, other);
    expect(moved).toHaveLength(BASE.length);
    moved.forEach((b, i) => {
      expect(b.minX - other.x).toBeCloseTo(BASE[i].minX - AT.x, 9);
      expect(b.minZ - other.z).toBeCloseTo(BASE[i].minZ - AT.z, 9);
      expect(b.minY).toBeCloseTo(BASE[i].minY, 9);
      expect(b.maxY).toBeCloseTo(BASE[i].maxY, 9);
    });
  });

  it('emits no fade key — heroes ride the material-opacity fade path, never the dither', () => {
    for (const b of ALL) expect(b.fadeKey).toBeNull();
  });

  it('pins the volume count (a deliberate index re-pin, not a silent drift)', () => {
    // 6 height bands x (2 core plus-boxes + 3 legs x 2 lateral halves) = 48 base boxes,
    // + 5 shaft bands x 2 = 10. The tower entered the index as 6 boxes before Phase 44.
    expect(BASE).toHaveLength(48);
    expect(SHAFT).toHaveLength(10);
  });
});

describe('cnShaftClipVolumes', () => {
  it('covers each band out to its own radius on every azimuth', () => {
    for (const band of META.shaftColliders) {
      const y = band.centerY;
      for (let k = 0; k < 12; k++) {
        const p = atAz((k * Math.PI) / 6, band.radius - 1e-6, y);
        expect(inside(SHAFT, p.x, p.y, p.z)).toBe(true);
      }
    }
  });

  it('stops at its radius on the diagonal, where a square band claimed 41% more', () => {
    const band = META.shaftColliders[0];
    const p = atAz(Math.PI / 4, band.radius * 1.2, band.centerY);
    expect(inside(SHAFT, p.x, p.y, p.z)).toBe(false);
    expect(inside([heroCylinderClipVolume(band, AT)], p.x, p.y, p.z)).toBe(true);
  });
});

describe('heroCylinderClipVolume', () => {
  it('is the pre-Phase-44 shape, unchanged (Rogers still enters the index this way)', () => {
    const v = heroCylinderClipVolume({ radius: 3, halfHeight: 2, centerY: 5 }, { x: 10, z: -20 });
    expect(v).toEqual({ minX: 7, maxX: 13, minY: 3, maxY: 7, minZ: -23, maxZ: -17, fadeKey: null });
  });

  it('floors minY at the ground, like every other indexed building', () => {
    expect(heroCylinderClipVolume({ radius: 1, halfHeight: 4, centerY: 2 }, { x: 0, z: 0 }).minY).toBe(0);
  });
});

describe('the Phase 43 parked-dead-behind defect, solved through the real anti-clip solver', () => {
  const test = (vols: readonly ClipAabb[]) => (x: number, y: number, z: number) =>
    inside(vols, x, y, z, CAMERA.antiClip.marginWu);
  const oldVols = [OLD_BASE_BOX, ...META.shaftColliders.map((c) => heroCylinderClipVolume(c, AT))];

  /** Car parked `d` wu NW of the tower axis on the boresight diagonal — the P43 repro pose. */
  const carAt = (d: number) => ({ x: AT.x - d * Math.SQRT1_2, y: 0.84, z: AT.z - d * Math.SQRT1_2 });

  it('used to find no escape at all across the whole reachable band', () => {
    for (const d of [12, 13, 14, 15, 16]) {
      const car = carAt(d);
      const eye = eyeFor(car);
      expect(test(oldVols)(eye.x, eye.y, eye.z)).toBe(true); // the eye IS inside the tower
      expect(solveAntiClipPull(eye, car, test(oldVols), CAMERA.antiClip)).toBe(0); // …and stuck
    }
  });

  it('now escapes at every one of those poses', () => {
    for (const d of [12, 13, 14, 15, 16]) {
      const car = carAt(d);
      const eye = eyeFor(car);
      const pull = solveAntiClipPull(eye, car, test(ALL), CAMERA.antiClip);
      expect(pull).toBeGreaterThan(0);
      expect(pull).toBeLessThanOrEqual(CAMERA.antiClip.maxPullM);
    }
  });

  it('needs a SHALLOWER pull than before wherever the old index did escape', () => {
    for (const d of [17, 18, 20, 22]) {
      const car = carAt(d);
      const before = solveAntiClipPull(eyeFor(car), car, test(oldVols), CAMERA.antiClip);
      const after = solveAntiClipPull(eyeFor(car), car, test(ALL), CAMERA.antiClip);
      expect(before).toBeGreaterThan(0);
      expect(after).toBeLessThan(before);
    }
  });

  it('leaves the eye outside every volume once pulled — the guard idempotence the rig relies on', () => {
    for (const d of [12, 14, 16, 18, 20]) {
      const car = carAt(d);
      const eye = eyeFor(car);
      const pull = solveAntiClipPull(eye, car, test(ALL), CAMERA.antiClip);
      const len = Math.hypot(car.x - eye.x, car.y - eye.y, car.z - eye.z);
      const moved = {
        x: eye.x + ((car.x - eye.x) / len) * pull,
        y: eye.y + ((car.y - eye.y) / len) * pull,
        z: eye.z + ((car.z - eye.z) / len) * pull,
      };
      expect(test(ALL)(moved.x, moved.y, moved.z)).toBe(false);
      expect(solveAntiClipPull(moved, car, test(ALL), CAMERA.antiClip)).toBe(0);
    }
  });

  it('documents the residual: a ~1x4 wu patch flat against the tower NW face still cannot escape', () => {
    // Measured at Phase 44 (T3): the eye there sits deep on the tower axis and the boresight —
    // which runs NW, straight down the NW leg — needs more than maxPullM of travel to clear the
    // splay. The frame it produces is a WIDE one (the tower is back-face-culled, and it is behind
    // the camera anyway), so this residual is the least-bad reading, not a broken one.
    const car = carAt(11.5);
    const eye = eyeFor(car);
    expect(test(ALL)(eye.x, eye.y, eye.z)).toBe(true);
    expect(solveAntiClipPull(eye, car, test(ALL), CAMERA.antiClip)).toBe(0);
  });
});
