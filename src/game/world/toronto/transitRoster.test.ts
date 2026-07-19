// Phase 31 (Part-8 D2, T1) — transitRoster.ts tests: tier-scaled counts, seeded determinism
// (seeds 416/9417 per the phase brief), and the showpiece-route weighting bias.
import { describe, expect, it } from 'vitest';
import { TORONTO_TRANSIT_ROSTER, TORONTO_TRANSIT_WEIGHTING } from '../../config/torontoTransit';
import {
  assignTransitRoster,
  torontoBusTransitRoster,
  torontoStreetcarTransitRoster,
} from './transitRoster';

describe('tier-scaled roster counts', () => {
  it('bus roster matches config/torontoTransit.ts TORONTO_TRANSIT_ROSTER.bus at every tier', () => {
    for (const tier of ['high', 'med', 'low'] as const) {
      expect(torontoBusTransitRoster(416, tier).length).toBe(TORONTO_TRANSIT_ROSTER.bus[tier]);
    }
  });

  it('streetcar roster matches TORONTO_TRANSIT_ROSTER.streetcar at every tier', () => {
    for (const tier of ['high', 'med', 'low'] as const) {
      expect(torontoStreetcarTransitRoster(416, tier).length).toBe(TORONTO_TRANSIT_ROSTER.streetcar[tier]);
    }
  });

  it('bus + streetcar totals the plan-pinned 12/9/6', () => {
    expect(TORONTO_TRANSIT_ROSTER.bus.high + TORONTO_TRANSIT_ROSTER.streetcar.high).toBe(12);
    expect(TORONTO_TRANSIT_ROSTER.bus.med + TORONTO_TRANSIT_ROSTER.streetcar.med).toBe(9);
    expect(TORONTO_TRANSIT_ROSTER.bus.low + TORONTO_TRANSIT_ROSTER.streetcar.low).toBe(6);
  });

  it('returns an empty roster for count <= 0', () => {
    expect(assignTransitRoster('bus', 0, 416)).toEqual([]);
    expect(assignTransitRoster('bus', -1, 416)).toEqual([]);
  });
});

describe('determinism (seeds 416 / 9417)', () => {
  for (const seed of [416, 9417]) {
    it(`seed ${seed}: identical calls produce the identical assignment (route ids in order)`, () => {
      const a = assignTransitRoster('bus', 8, seed).map((x) => x.route.id);
      const b = assignTransitRoster('bus', 8, seed).map((x) => x.route.id);
      expect(a).toEqual(b);
      expect(a.length).toBe(8);
    });

    it(`seed ${seed}: every assigned slot carries a real polyline + a non-empty label`, () => {
      const roster = assignTransitRoster('streetcar', 4, seed);
      for (const slot of roster) {
        expect(slot.avenue.length).toBeGreaterThanOrEqual(2);
        expect(slot.label.length).toBeGreaterThan(0);
        expect(slot.label.startsWith(slot.route.id)).toBe(true);
      }
    });
  }

  it('different seeds can (and, sampled here, do) produce a different assignment', () => {
    const a = assignTransitRoster('bus', 8, 416).map((x) => x.route.id);
    const b = assignTransitRoster('bus', 8, 9417).map((x) => x.route.id);
    expect(a).not.toEqual(b);
  });

  it('slotId is stable 0..count-1 in order', () => {
    const roster = assignTransitRoster('bus', 8, 416);
    expect(roster.map((s) => s.slotId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('showpiece weighting (97/501/504/510 favoured)', () => {
  it('showpiece routes are picked more often than the per-route uniform share over a large sample', () => {
    const sample = assignTransitRoster('bus', 4000, 416);
    const counts = new Map<string, number>();
    for (const s of sample) counts.set(s.route.id, (counts.get(s.route.id) ?? 0) + 1);
    const uniformShare = sample.length / 8; // 8 bus routes total
    const showpieceBusIds = TORONTO_TRANSIT_WEIGHTING.showpieceRouteIds.filter((id) => id === '97');
    expect(showpieceBusIds).toEqual(['97']);
    expect(counts.get('97')!).toBeGreaterThan(uniformShare * 1.5);
  });

  it('a non-showpiece bus route is picked close to its uniform share (not starved)', () => {
    const sample = assignTransitRoster('bus', 4000, 416);
    const counts = new Map<string, number>();
    for (const s of sample) counts.set(s.route.id, (counts.get(s.route.id) ?? 0) + 1);
    // '19' (Bay) is a non-showpiece route among 8 bus routes with one showpiece (97) weighted 3x:
    // total weight = 7*1 + 1*3 = 10; '19' share = 1/10 of the sample.
    const expected = sample.length / 10;
    expect(counts.get('19')!).toBeGreaterThan(expected * 0.5);
    expect(counts.get('19')!).toBeLessThan(expected * 1.5);
  });

  it('streetcar showpiece routes (501/504/510) are all picked more often than a non-showpiece one (505/506/509/511)', () => {
    const sample = assignTransitRoster('streetcar', 4000, 416);
    const counts = new Map<string, number>();
    for (const s of sample) counts.set(s.route.id, (counts.get(s.route.id) ?? 0) + 1);
    const nonShowpieceAvg = (counts.get('505')! + counts.get('506')! + counts.get('509')! + counts.get('511')!) / 4;
    for (const id of ['501', '504', '510']) {
      expect(counts.get(id)!, id).toBeGreaterThan(nonShowpieceAvg * 1.5);
    }
  });
});

describe('startFrac spread (Phase 31 lockstep fix)', () => {
  for (const seed of [416, 9417]) {
    it(`seed ${seed}: slots sharing a route get evenly-spread distinct startFracs`, () => {
      for (const mode of ['bus', 'streetcar'] as const) {
        const roster = assignTransitRoster(mode, 8, seed);
        const byRoute = new Map<string, number[]>();
        for (const a of roster) {
          expect(a.startFrac).toBeGreaterThanOrEqual(0);
          expect(a.startFrac).toBeLessThan(1);
          const l = byRoute.get(a.route.id) ?? [];
          l.push(a.startFrac);
          byRoute.set(a.route.id, l);
        }
        for (const [routeId, fracs] of byRoute) {
          const expected = fracs.map((_, i) => i / fracs.length);
          expect(fracs, `route ${routeId}`).toEqual(expected);
        }
      }
    });
  }
});
