// Phase 41 (T3) — anchor-pin tests for the two "hand-typed, empirically-tuned" overlay constants
// that Phase 27 already caught silently drifting once: config/torontoDress.ts's
// LAMP_OVERLAY.headAnchor (the traffic-light lamp-quad position) and config/torontoTransit.ts's
// ROUTE_BOARD.busHeightWu (the transit route-board height above a bus's roofline). Both are now
// DERIVED — fraction/clearance x (manifest nativeDims x resolved scale) — instead of hand-typed
// literals (see each constant's own doc comment for the full P27 story: a scale-override retune
// changed the resolved geometry and the hand literal had to be quietly rescaled to match, caught
// only by a live-verification screenshot, not a test).
//
// These tests exist so the SAME class of drift is caught automatically: if the manifest
// regenerates with different dims, or a scale override/BUS_TARGET_LENGTH_WU changes, the
// derivation is exercised here and any resulting drift is a loud test failure instead of a silent
// visual regression. The "derivation proof" tests recompute the expected value independently
// (frac x manifest x resolver) and assert it against the exported constant — so the test also
// fails if someone reverts the source to a hand literal that merely LOOKS right today.
import { describe, expect, it } from 'vitest';
import { LAMP_OVERLAY, LAMP_HEAD_ANCHOR_FRAC } from './torontoDress';
import { ROUTE_BOARD, ROUTE_BOARD_CLEARANCE_WU } from './torontoTransit';
import { getCityPackModel } from '../assets/cityPackManifest';
import { resolveCityPackScale, colliderHalfExtents } from './cityPackScale';

describe('LAMP_OVERLAY.headAnchor — derived from the traffic-light manifest entry (Phase 41 T3)', () => {
  // Phase 27's road-diet retune dropped the traffic-light scale override 1.35 -> 1.0 and this
  // anchor had to be hand-rescaled to match (-5.4/5.1 -> -4.0/3.78) — a silent drift for one
  // commit. This test is what would have caught it automatically.
  it('stays within 0.01 wu of the historical hand-tuned anchor (-4.0, 3.78)', () => {
    expect(LAMP_OVERLAY.headAnchor.x).toBeCloseTo(-4.0, 2);
    expect(LAMP_OVERLAY.headAnchor.y).toBeCloseTo(3.78, 2);
    expect(LAMP_OVERLAY.headAnchor.z).toBe(0);
  });

  it('pins the exact resolved value (fails loudly if manifest dims or the scale override drift)', () => {
    expect(LAMP_OVERLAY.headAnchor.x).toBeCloseTo(-3.9999887730572374, 9);
    expect(LAMP_OVERLAY.headAnchor.y).toBeCloseTo(3.780008101379858, 9);
  });

  it('derivation proof: frac x (manifest nativeDims x resolved scale), recomputed independently here, equals the exported value — fails if the source ever reverts to a hand literal', () => {
    const entry = getCityPackModel('traffic-light');
    const scale = resolveCityPackScale('traffic-light');
    const expectedX = LAMP_HEAD_ANCHOR_FRAC.x * (entry.nativeDims.w * scale);
    const expectedY = LAMP_HEAD_ANCHOR_FRAC.y * (entry.nativeDims.h * scale);
    expect(LAMP_OVERLAY.headAnchor.x).toBeCloseTo(expectedX, 9);
    expect(LAMP_OVERLAY.headAnchor.y).toBeCloseTo(expectedY, 9);
  });
});

describe('ROUTE_BOARD.busHeightWu — derived from the resolved bus roofline (Phase 41 T3)', () => {
  it('stays within 0.01 wu of the historical hand-tuned height (3.6)', () => {
    expect(ROUTE_BOARD.busHeightWu).toBeCloseTo(3.6, 2);
  });

  it('pins the exact resolved value (fails loudly if manifest dims or BUS_TARGET_LENGTH_WU drift)', () => {
    expect(ROUTE_BOARD.busHeightWu).toBeCloseTo(3.5996257239117604, 9);
  });

  it('derivation proof: resolved roofline height + clearance, recomputed independently here, equals the exported value', () => {
    const roofHeightWu = colliderHalfExtents('bus').hy * 2;
    const expected = roofHeightWu + ROUTE_BOARD_CLEARANCE_WU;
    expect(ROUTE_BOARD.busHeightWu).toBeCloseTo(expected, 9);
  });

  it('streetcarHeightWu stays a hand literal (in-house model, no manifest entry to derive from)', () => {
    expect(ROUTE_BOARD.streetcarHeightWu).toBe(3.9);
  });
});
