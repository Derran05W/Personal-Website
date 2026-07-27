// Phase 37 out-of-bounds backstop: sustain / reset / latch / cadence semantics
// (`.planning/part-9-camera-world-edge.md` §Phase 37; plan decision "OOB trigger semantics").
// Authored against outOfBounds.ts's own doc comments: a sample is out of bounds when it is
// outside PLAYABLE_POLYGON *or* below BOUNDARY.oobMinY; the trigger samples at
// BOUNDARY.oobSampleHz and fires once BOUNDARY.oobSustainSec of CONSECUTIVE out-of-bounds
// samples have elapsed, then latches for its lifetime.
//
// Every coordinate below is DERIVED from the live polygon/zone constants rather than
// re-literalized (MAP PROJECT contract: data > code). At the current DENSITY.scale the shape is
// capsule x[1260,1740] y[0,702] → fold x[1320,1680] y[702,1362] → downtown x[600,2040]
// y[1362,2724] with the lake band from y=2484 — quoted only as orientation for a reader.
import { describe, expect, it } from 'vitest';
import { BOUNDARY } from '../../config/world';
import { PLAYABLE_POLYGON, ZONE_X_EXTENTS, pointInPolygon } from './polygon';
import { YONGE_X, ZONE_BOUNDARIES } from './projection';
import { OOB_DEFAULTS, createOobTrigger, isOutOfBounds } from './outOfBounds';

// --- live-derived probe points (world coords; world x = map x, world z = map y) ---------------

/** Downtown centre — deep inside the polygon, on the ground. */
const INSIDE = {
  x: (ZONE_X_EXTENTS.downtown[0] + ZONE_X_EXTENTS.downtown[1]) / 2,
  z: (ZONE_BOUNDARIES[2] + ZONE_BOUNDARIES[3]) / 2,
};
/** Well west of the downtown block's west edge — off a land edge, past any barrier ring. */
const OUTSIDE_WEST = { x: ZONE_X_EXTENTS.downtown[0] - 60, z: INSIDE.z };
/** In the void BESIDE the fold corridor: inside the map's bounding box, outside the shape. */
const OUTSIDE_NOTCH = {
  x: ZONE_X_EXTENTS.downtown[0] + 40,
  z: (ZONE_BOUNDARIES[1] + ZONE_BOUNDARIES[2]) / 2,
};
/** Middle of the south lake band — INSIDE the polygon (the band is part of the shape). */
const WATER_BAND = { x: YONGE_X, z: (ZONE_BOUNDARIES[3] + ZONE_BOUNDARIES[4]) / 2 };

const SAMPLE_SEC = 1 / OOB_DEFAULTS.sampleHz;
const SAMPLES_TO_FIRE = Math.round(OOB_DEFAULTS.sustainSec * OOB_DEFAULTS.sampleHz);
const PHYSICS_STEP_SEC = 1 / 60; // the production caller's dt (<Physics timeStep={1/60}>)

describe('OOB config wiring', () => {
  it('defaults come from config/world.ts BOUNDARY (no re-literalized numbers)', () => {
    expect(OOB_DEFAULTS).toEqual({
      sampleHz: BOUNDARY.oobSampleHz,
      sustainSec: BOUNDARY.oobSustainSec,
      minY: BOUNDARY.oobMinY,
    });
    // The plan's shipped values — pinned so a silent retune is a visible diff.
    expect(OOB_DEFAULTS.sampleHz).toBe(10);
    expect(OOB_DEFAULTS.sustainSec).toBe(0.5);
    expect(OOB_DEFAULTS.minY).toBe(-2);
    expect(SAMPLES_TO_FIRE).toBe(5);
  });
});

describe('isOutOfBounds — pure per-sample test', () => {
  it('is false deep inside the polygon on the ground', () => {
    expect(isOutOfBounds(INSIDE.x, 0, INSIDE.z)).toBe(false);
  });

  it('is true outside a land edge, at an otherwise perfectly normal driving height', () => {
    expect(isOutOfBounds(OUTSIDE_WEST.x, 0.5, OUTSIDE_WEST.z)).toBe(true);
  });

  it('is true in the void beside the fold corridor (inside the bbox, outside the shape)', () => {
    expect(pointInPolygon({ x: OUTSIDE_NOTCH.x, y: OUTSIDE_NOTCH.z }, PLAYABLE_POLYGON)).toBe(false);
    expect(isOutOfBounds(OUTSIDE_NOTCH.x, 0, OUTSIDE_NOTCH.z)).toBe(true);
  });

  it('is true below minY even at a perfectly legal XZ (the physics-failure case)', () => {
    expect(isOutOfBounds(INSIDE.x, OOB_DEFAULTS.minY - 1, INSIDE.z)).toBe(true);
  });

  it('treats exactly minY as still in bounds (strict `y < minY`), and ordinary bounce too', () => {
    expect(isOutOfBounds(INSIDE.x, OOB_DEFAULTS.minY, INSIDE.z)).toBe(false);
    expect(isOutOfBounds(INSIDE.x, -0.6, INSIDE.z)).toBe(false); // suspension travel, not a fall
  });

  it('is FALSE in the south water band — the lake is inside the polygon and stays enteredWater', () => {
    expect(pointInPolygon({ x: WATER_BAND.x, y: WATER_BAND.z }, PLAYABLE_POLYGON)).toBe(true);
    expect(isOutOfBounds(WATER_BAND.x, 0, WATER_BAND.z)).toBe(false);
  });
});

describe('createOobTrigger — sustain window', () => {
  it('fires after 0.5 s sustained outside the polygon at an in-bounds height', () => {
    const trigger = createOobTrigger();
    for (let i = 0; i < SAMPLES_TO_FIRE - 1; i++) {
      expect(trigger.step(OUTSIDE_WEST.x, 0.5, OUTSIDE_WEST.z, SAMPLE_SEC)).toBe(false);
    }
    expect(trigger.step(OUTSIDE_WEST.x, 0.5, OUTSIDE_WEST.z, SAMPLE_SEC)).toBe(true);
  });

  it('fires after 0.5 s sustained below minY while still inside the polygon', () => {
    const trigger = createOobTrigger();
    const y = OOB_DEFAULTS.minY - 3;
    let fired = false;
    for (let i = 0; i < SAMPLES_TO_FIRE; i++) {
      fired = trigger.step(INSIDE.x, y, INSIDE.z, SAMPLE_SEC);
      expect(fired).toBe(i === SAMPLES_TO_FIRE - 1);
    }
    expect(fired).toBe(true);
  });

  it('never fires before the window completes, however long the run of in-bounds samples', () => {
    const trigger = createOobTrigger();
    for (let i = 0; i < 200; i++) {
      expect(trigger.step(INSIDE.x, 0, INSIDE.z, SAMPLE_SEC)).toBe(false);
    }
  });

  it('does NOT fire for a 0.3 s transient excursion followed by recovery', () => {
    const trigger = createOobTrigger();
    // Shoved past the line by a barrier bounce for 3 samples (0.3 s < 0.5 s)...
    for (let i = 0; i < 3; i++) {
      expect(trigger.step(OUTSIDE_WEST.x, 0.5, OUTSIDE_WEST.z, SAMPLE_SEC)).toBe(false);
    }
    // ...then back inside — one in-bounds sample zeroes the window.
    for (let i = 0; i < 3; i++) {
      expect(trigger.step(INSIDE.x, 0, INSIDE.z, SAMPLE_SEC)).toBe(false);
    }
    // Two more outside samples would have completed 0.5 s if the window had NOT reset.
    expect(trigger.step(OUTSIDE_WEST.x, 0.5, OUTSIDE_WEST.z, SAMPLE_SEC)).toBe(false);
    expect(trigger.step(OUTSIDE_WEST.x, 0.5, OUTSIDE_WEST.z, SAMPLE_SEC)).toBe(false);
  });

  it('still fires on a LATER genuine excursion after an earlier transient reset the window', () => {
    const trigger = createOobTrigger();
    trigger.step(OUTSIDE_WEST.x, 0.5, OUTSIDE_WEST.z, SAMPLE_SEC); // transient…
    trigger.step(INSIDE.x, 0, INSIDE.z, SAMPLE_SEC); // …recovered
    for (let i = 0; i < SAMPLES_TO_FIRE - 1; i++) {
      expect(trigger.step(OUTSIDE_NOTCH.x, 0, OUTSIDE_NOTCH.z, SAMPLE_SEC)).toBe(false);
    }
    expect(trigger.step(OUTSIDE_NOTCH.x, 0, OUTSIDE_NOTCH.z, SAMPLE_SEC)).toBe(true);
  });

  it('never fires for a car parked in the water band at y=0 (that death is enteredWater\'s)', () => {
    const trigger = createOobTrigger();
    for (let i = 0; i < 100; i++) {
      // 10 s of sitting in the lake — the WATER sensor owns this, the backstop stays silent.
      expect(trigger.step(WATER_BAND.x, 0, WATER_BAND.z, SAMPLE_SEC)).toBe(false);
    }
  });
});

describe('createOobTrigger — latch', () => {
  it('fires exactly once even while the excursion continues', () => {
    const trigger = createOobTrigger();
    let fires = 0;
    for (let i = 0; i < 100; i++) {
      if (trigger.step(OUTSIDE_WEST.x, 0.5, OUTSIDE_WEST.z, SAMPLE_SEC)) fires++;
    }
    expect(fires).toBe(1);
  });

  it('stays latched even after the player returns inside and leaves again', () => {
    const trigger = createOobTrigger();
    let fires = 0;
    const drive = (p: { x: number; z: number }, y: number, steps: number): void => {
      for (let i = 0; i < steps; i++) if (trigger.step(p.x, y, p.z, SAMPLE_SEC)) fires++;
    };
    drive(OUTSIDE_WEST, 0.5, 10); // first excursion — the one fire
    drive(INSIDE, 0, 20);
    drive(OUTSIDE_NOTCH, 0, 20); // a second, equally real excursion
    expect(fires).toBe(1);
  });

  it('reset() re-arms a fired trigger (and clears the partial window)', () => {
    const trigger = createOobTrigger();
    for (let i = 0; i < SAMPLES_TO_FIRE; i++) trigger.step(OUTSIDE_WEST.x, 0.5, OUTSIDE_WEST.z, SAMPLE_SEC);
    trigger.reset();
    for (let i = 0; i < SAMPLES_TO_FIRE - 1; i++) {
      expect(trigger.step(OUTSIDE_WEST.x, 0.5, OUTSIDE_WEST.z, SAMPLE_SEC)).toBe(false);
    }
    expect(trigger.step(OUTSIDE_WEST.x, 0.5, OUTSIDE_WEST.z, SAMPLE_SEC)).toBe(true);
  });
});

describe('createOobTrigger — sampling cadence', () => {
  it('honours the 10 Hz cadence with sub-period dt (accumulates, never samples per call)', () => {
    const trigger = createOobTrigger();
    const dt = SAMPLE_SEC / 5; // 5 calls per sample
    const callsToFire = SAMPLES_TO_FIRE * 5;
    for (let i = 1; i < callsToFire; i++) {
      expect(trigger.step(OUTSIDE_WEST.x, 0.5, OUTSIDE_WEST.z, dt)).toBe(false);
    }
    expect(trigger.step(OUTSIDE_WEST.x, 0.5, OUTSIDE_WEST.z, dt)).toBe(true);
  });

  it('a sub-period excursion that ends before ANY sample lands is never even seen', () => {
    const trigger = createOobTrigger();
    // Half a sampling period outside, then back in — no sample boundary crossed while outside.
    expect(trigger.step(OUTSIDE_WEST.x, 0.5, OUTSIDE_WEST.z, SAMPLE_SEC / 2)).toBe(false);
    for (let i = 0; i < SAMPLES_TO_FIRE * 2; i++) {
      expect(trigger.step(INSIDE.x, 0, INSIDE.z, SAMPLE_SEC / 2)).toBe(false);
    }
  });

  it('fires at ~0.5 s of real time when driven with the production 1/60 s physics step', () => {
    const trigger = createOobTrigger();
    let elapsed = 0;
    let fireAt: number | null = null;
    for (let i = 0; i < 120 && fireAt === null; i++) {
      elapsed += PHYSICS_STEP_SEC;
      if (trigger.step(OUTSIDE_WEST.x, 0.5, OUTSIDE_WEST.z, PHYSICS_STEP_SEC)) fireAt = elapsed;
    }
    expect(fireAt).not.toBeNull();
    // 6 steps per 10 Hz sample × 5 samples = 30 steps = 0.5 s; allow one sample of slack for
    // the accumulator's float bookkeeping in either direction.
    expect(fireAt as number).toBeGreaterThanOrEqual(OOB_DEFAULTS.sustainSec - 1e-9);
    expect(fireAt as number).toBeLessThanOrEqual(OOB_DEFAULTS.sustainSec + SAMPLE_SEC);
  });

  it('mixed realistic dt (a stall mid-excursion) still fires, and a huge dt is clamped', () => {
    const trigger = createOobTrigger();
    // One enormous frame (tab refocus) must not credit the whole window from one stale sample.
    expect(trigger.step(OUTSIDE_WEST.x, 0.5, OUTSIDE_WEST.z, 30)).toBe(false);
    let fired = false;
    for (let i = 0; i < 60 && !fired; i++) {
      fired = trigger.step(OUTSIDE_WEST.x, 0.5, OUTSIDE_WEST.z, PHYSICS_STEP_SEC);
    }
    expect(fired).toBe(true);
  });

  it('ignores non-positive / non-finite dt instead of accumulating garbage', () => {
    const trigger = createOobTrigger();
    for (let i = 0; i < 50; i++) {
      expect(trigger.step(OUTSIDE_WEST.x, 0.5, OUTSIDE_WEST.z, 0)).toBe(false);
      expect(trigger.step(OUTSIDE_WEST.x, 0.5, OUTSIDE_WEST.z, -1)).toBe(false);
      expect(trigger.step(OUTSIDE_WEST.x, 0.5, OUTSIDE_WEST.z, Number.NaN)).toBe(false);
    }
    // The window is untouched — a full run of real samples is still needed.
    for (let i = 0; i < SAMPLES_TO_FIRE - 1; i++) {
      expect(trigger.step(OUTSIDE_WEST.x, 0.5, OUTSIDE_WEST.z, SAMPLE_SEC)).toBe(false);
    }
    expect(trigger.step(OUTSIDE_WEST.x, 0.5, OUTSIDE_WEST.z, SAMPLE_SEC)).toBe(true);
  });
});

describe('createOobTrigger — custom config', () => {
  it('respects an injected sampleHz/sustainSec/minY', () => {
    const trigger = createOobTrigger({ sampleHz: 2, sustainSec: 1, minY: -50 });
    // minY −50: a y of −10 is NOT out of bounds under this config.
    for (let i = 0; i < 10; i++) expect(trigger.step(INSIDE.x, -10, INSIDE.z, 0.5)).toBe(false);
    // 2 Hz × 1 s = 2 samples outside the polygon.
    expect(trigger.step(OUTSIDE_WEST.x, 0, OUTSIDE_WEST.z, 0.5)).toBe(false);
    expect(trigger.step(OUTSIDE_WEST.x, 0, OUTSIDE_WEST.z, 0.5)).toBe(true);
  });
});
