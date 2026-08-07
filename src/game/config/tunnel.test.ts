// Phase 25.6 Task 1 (D4c) — config/tunnel.ts tests. Previously untested (pure presentation
// constants); now also owns CORRIDOR_HALF_WIDTH_WU (D3), which world/toronto/TorontoScene.tsx
// feeds to createFoldTrigger (world/toronto/tunnel.ts). This pins the derivation, not a bare
// number, per the "re-derive, never hand-pin" policy (D4d).
import { describe, expect, it } from 'vitest';
import { CAR_REF } from './cityPackScale';
import { ROAD_CLASSES } from './torontoMap';
import { CORRIDOR_HALF_WIDTH_WU, LINE_1_STATIONS_SOUTHBOUND, TUNNEL_OVERLAY } from './tunnel';

describe('CORRIDOR_HALF_WIDTH_WU — D3 derivation', () => {
  it('equals half the spine ribbon plus half a car', () => {
    expect(CORRIDOR_HALF_WIDTH_WU).toBeCloseTo(ROAD_CLASSES.spine / 2 + CAR_REF.widthWu / 2, 9);
  });

  // PHASE 75 RE-PIN: the spine doubled (10 x 2.2 = 22.0), so the Line-1 fold-trigger x-gate widens
  // with it — 6.6 → 12.1. That is correct behaviour, not drift: the corridor IS Yonge, and the
  // gate has always been "half the spine plus half a car" so a car anywhere on the ribbon (now
  // including the outer lanes the widening created) still trips the tunnel transition.
  it('is 12.1 under the current car-derived spine (Phase 75 re-grade: 10 x 2.2 = 22.0)', () => {
    expect(CORRIDOR_HALF_WIDTH_WU).toBeCloseTo(12.1, 9);
  });

  it('is strictly wider than a flat spine/2 (the whole point of the half-car pad)', () => {
    expect(CORRIDOR_HALF_WIDTH_WU).toBeGreaterThan(ROAD_CLASSES.spine / 2);
  });
});

describe('TUNNEL_OVERLAY — lifecycle timing sanity', () => {
  it('fade-in and fade-out both fit comfortably inside the total duration', () => {
    expect(TUNNEL_OVERLAY.fadeInMs).toBeLessThan(TUNNEL_OVERLAY.durationMs);
    expect(TUNNEL_OVERLAY.fadeOutMs).toBeLessThan(TUNNEL_OVERLAY.durationMs);
    expect(TUNNEL_OVERLAY.fadeInMs + TUNNEL_OVERLAY.fadeOutMs).toBeLessThan(TUNNEL_OVERLAY.durationMs);
  });
});

describe('LINE_1_STATIONS_SOUTHBOUND', () => {
  it('is a non-empty, deduplicated list of station names', () => {
    expect(LINE_1_STATIONS_SOUTHBOUND.length).toBeGreaterThan(0);
    expect(new Set(LINE_1_STATIONS_SOUTHBOUND).size).toBe(LINE_1_STATIONS_SOUTHBOUND.length);
  });
});
