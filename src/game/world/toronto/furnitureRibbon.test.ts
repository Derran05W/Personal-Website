// Phase 25.8 (D10) — the global no-furniture-on-ribbon invariant, asserted map-wide over the real
// layout. Kept in its own file (not furniture.test.ts) so it composes cleanly alongside the D8
// tier-wiring tests. Manholes + parked are the on-road exemptions.
import { describe, expect, it } from 'vitest';
import { buildStreets, type MapRect } from './streets';
import { buildFurniture, isOnAnyRibbon } from './furniture';

describe('isOnAnyRibbon', () => {
  const ribbons: MapRect[] = [{ minX: 0, maxX: 10, minY: 0, maxY: 4 }];
  it('true strictly inside, false on/outside the edge', () => {
    expect(isOnAnyRibbon(5, 2, ribbons)).toBe(true);
    expect(isOnAnyRibbon(0, 2, ribbons)).toBe(false); // on the edge
    expect(isOnAnyRibbon(-1, 2, ribbons)).toBe(false);
    expect(isOnAnyRibbon(5, 5, ribbons)).toBe(false);
  });
});

describe('no-furniture-on-ribbon invariant (map-wide)', () => {
  const streets = buildStreets().streets;
  const ribbons: MapRect[] = streets.map((s) => s.ribbon);
  const f = buildFurniture(2026);

  const nonExempt = [
    ['trafficLights', f.trafficLights],
    ['stopSigns', f.stopSigns.items],
    ['powerBoxes', f.powerBoxes.items],
    ['trees', f.trees.items],
    ['hydrants', f.hydrants.items],
    ['benches', f.benches.items],
    ['trashCans', f.trashCans.items],
    ['busStops', f.busStops.items],
  ] as const;

  for (const [name, items] of nonExempt) {
    it(`${name}: no placement sits inside any ribbon`, () => {
      for (const p of items) {
        expect(isOnAnyRibbon(p.position[0], p.position[2], ribbons)).toBe(false);
      }
    });
  }

  it('manholes are exempt (on the asphalt by design — at least one IS on a ribbon)', () => {
    // Manholes sit on the centreline, so effectively all are inside a ribbon; assert the exemption
    // is real (the invariant did NOT strip them).
    expect(f.manholes.items.length).toBeGreaterThan(0);
    expect(f.manholes.items.some((m) => isOnAnyRibbon(m.position[0], m.position[2], ribbons))).toBe(true);
  });
});
