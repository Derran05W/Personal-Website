/**
 * Phase 40 — composeWorld.ts tests: determinism, the count-table pin, and the clip-volume/
 * fade-key cross-checks the plan's §Verification calls out by name.
 *
 * The world is built ONCE at module scope (composeWorld ≈ 100 ms — the plan's own budget note)
 * and shared by every test below, matching furniture.test.ts/infill.test.ts's existing
 * one-build-per-suite convention. `overlapInvariant.test.ts` owns the invariant SWEEP (no
 * overlaps); this file owns "does the SAME seed always produce the SAME world" and "are the
 * counts what the plan's baseline attributed them to be".
 */
import { describe, expect, it } from 'vitest';
import { frontageFadeKey } from './cameraClipIndex';
import { isBuildingClaimKind } from './claimIndex';
import { composeWorld } from './composeWorld';

const SEED = 416;
const world = composeWorld(SEED);

/** The fields composeWorld.test.ts and overlapInvariant.test.ts both care about, MINUS `index`
 * (a live object of closures — `toEqual` can't meaningfully diff functions, and it is re-derived
 * from the very layouts already being compared, so comparing it separately would only re-test the
 * registration loop a second time) and MINUS `seed`/`tierParams` (constant across this file's two
 * calls by construction, not what determinism is testing). */
function stableProjection(w: ReturnType<typeof composeWorld>) {
  return {
    frontage: w.frontage,
    furniture: w.furniture,
    infill: w.infill,
    dress: w.dress,
    counts: w.counts,
    clipVolumes: w.clipVolumes,
  };
}

describe('composeWorld — determinism', () => {
  it('the same seed called twice produces a deep-equal world (index excluded — see stableProjection)', () => {
    const again = composeWorld(SEED);
    expect(stableProjection(again)).toEqual(stableProjection(world));
  });
});

describe('composeWorld — the count table (seed 416), pinned', () => {
  // Every value here was MEASURED off a real composeWorld(416) run before being pinned (the plan's
  // "check them against these attributed expectations before pinning" instruction) — every one of
  // them matched the phase-40 plan's attributed baseline deltas on the first measurement, so
  // nothing here is a guess. The four deltas vs the pre-P40 baseline (recorded in
  // phase-40-plan.md's "Baseline" section) and their causes:
  //
  //   • furniture.busStops 50 (at cap, same as before) — held at cap only AFTER the flush-to-
  //     facade offset fix (furniture.ts's `busStopRowOffsetWu`): pre-fix, 30 of the 50 shelters
  //     were embedding in the streetwall facade rather than actually occupying sidewalk, so the
  //     count reaching cap here is proof the fix landed, not a no-op restatement.
  //   • furniture.trees 461 -> 453 — shelters now CLAIM FIRST among the spacing rows (composeWorld's
  //     deviation ①-adjacent ordering: "authored outranks fungible"), so 8 more trees lost their
  //     slot to a bus shelter that used to be built (and claim) after them.
  //   • infill.backlotBox 319 -> 309 — back-lot boxes now gate on the backdrop-tower row (never
  //     checked pre-P40): 10 back-lot boxes that used to interpenetrate a backdrop tower behind the
  //     same frontage are now rejected (ablation-proven in the notes; heightLaw.test.ts's crosser
  //     census independently lost 3 TALL back-lot boxes to the same gate).
  //   • infill.deepScatterTrees 443 -> 442 — the same tower gate: one deep-scatter tree candidate
  //     that used to land inside a backdrop-tower box's footprint is now rejected.
  //   • infill.deepScatterPiles 13 -> 12 — the sweep-driven stand-in fix: pile placement now gates
  //     on the REAL rotated model footprint (the same footprint the claim registers) instead of a
  //     0.6 wu stand-in, and one pile dumpster that had been reaching into already-claimed ground
  //     is now rejected (infill.ts's buildDeepScatter, Phase 40 comment).
  it('matches the measured seed-416 counts exactly', () => {
    expect(world.counts).toEqual({
      claims: 8053,
      clipVolumes: 2363,
      'frontage.total': 1400,
      'frontage.towerBoxes': 90,
      'frontage.cornerFills': 47,
      'frontage.financial': 66,
      'frontage.entertainment': 38,
      'frontage.kingWest': 58,
      'frontage.queenWest': 71,
      'frontage.chinatownKensington': 34,
      'frontage.yongeDundasQueen': 61,
      'frontage.churchWellesley': 36,
      'frontage.uoft': 40,
      'frontage.stLawrence': 12,
      'frontage.harbourfront': 229,
      'frontage.bloorYorkville': 106,
      'frontage.northYorkCentre': 51,
      'frontage.willowdaleFinch': 99,
      'frontage.genericDowntown': 417,
      'frontage.foldCorridor': 82,
      'furniture.trafficLights': 227,
      'furniture.stopSigns': 1,
      'furniture.powerBoxes': 74,
      'furniture.trees': 453,
      'furniture.hydrants': 140,
      'furniture.benches': 160,
      'furniture.trashCans': 160,
      'furniture.busStops': 50,
      'furniture.manholes': 220,
      'furniture.parked': 200,
      'infill.backlotPack': 500,
      'infill.backlotBox': 309,
      'infill.laneway': 350,
      'infill.parkingLots': 16,
      'infill.parkingCars': 115,
      'infill.constructionSites': 14,
      'infill.constructionFixed': 77,
      'infill.constructionDecor': 182,
      'infill.laneClosures': 5,
      'infill.laneClosureCones': 31,
      'infill.deepScatterTrees': 442,
      'infill.deepScatterGreenhouses': 7,
      'infill.deepScatterPiles': 12,
      'infill.fixedTotal': 1189,
      'infill.decorTotal': 548,
      'dress.bands': 27,
      'dress.awnings': 14,
      'dress.props': 96,
      'dress.queues': 2,
      'dress.plaques': 1,
    });
  });

  // The specific attributed values from the task brief, asserted individually too — so a future
  // reader can see at a glance which counts were the ones under scrutiny, without diffing the
  // whole record above.
  it.each([
    ['furniture.busStops', 50],
    ['furniture.trees', 453],
    ['furniture.benches', 160],
    ['furniture.trashCans', 160],
    ['furniture.hydrants', 140],
    ['furniture.manholes', 220],
    ['furniture.parked', 200],
    ['furniture.trafficLights', 227],
    ['furniture.powerBoxes', 74],
    ['infill.backlotBox', 309],
    ['infill.backlotPack', 500],
    ['infill.deepScatterTrees', 442],
    ['infill.laneway', 350],
    ['frontage.total', 1400],
    ['frontage.towerBoxes', 90],
    ['frontage.cornerFills', 47],
    ['dress.bands', 27],
    ['dress.props', 96],
  ] as const)('%s === %d', (key, expected) => {
    expect(world.counts[key]).toBe(expected);
  });
});

describe('composeWorld — clipVolumes is exactly the building-class claim projection', () => {
  it('clipVolumes.length equals a fresh recount of building-class claims in the index', () => {
    const recount = world.index.allClaims().filter((c) => isBuildingClaimKind(c.kind)).length;
    expect(world.clipVolumes.length).toBe(recount);
    expect(world.clipVolumes.length).toBe(world.counts.clipVolumes);
  });
});

describe('composeWorld — fade-key spot checks', () => {
  it('every namedBuilding claim carries fadeKey: null (the material-opacity path, never dither)', () => {
    const namedBuildingClaims = world.index.allClaims().filter((c) => c.kind === 'namedBuilding');
    expect(namedBuildingClaims.length).toBeGreaterThan(0);
    for (const claim of namedBuildingClaims) {
      expect(claim.fadeKey, claim.id).toBeNull();
    }
  });

  it("every frontageSlot claim's fadeKey equals frontageFadeKey() of its matching frontage slot", () => {
    expect(world.frontage.slots.length).toBeGreaterThan(0);
    const byId = new Map(world.index.allClaims().map((c) => [c.id, c]));
    for (const slot of world.frontage.slots) {
      const claim = byId.get(`frontage:${slot.slotId}`);
      expect(claim, slot.slotId).toBeDefined();
      expect(claim?.fadeKey, slot.slotId).toBe(frontageFadeKey(slot));
    }
  });
});
