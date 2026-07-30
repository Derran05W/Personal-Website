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
  //
  // PHASE 45 RE-PIN — the rail-lands strip claim (world/toronto/railLands.ts). The block south of
  // Front between Spadina and Bay is now RESERVED: its two lots plus the whole corridor interior
  // enter as `namedExclusion` zones with the seed-independent prefix, so every seed-dependent
  // placer rejects inside it. Measured deltas, each attributed:
  //   • claims 8053 → 8056. +16 registered (3 rail-lands zones + 8 building volumes + 5 patio prop
  //     footprints), −13 net from the placements the strip displaced (below).
  //   • clipVolumes 2363 → 2373 (+10): the 8 new `namedBuilding` volumes plus the +2 net
  //     back-lot boxes below (clipVolumes is exactly the building-class claim projection).
  //   • infill.backlotBox 309 → 311 (+2) and infill.deepScatterGreenhouses 7 → 8 (+1): the strip
  //     rejects candidates inside the corridor, and the deterministic per-candidate rng forks make
  //     the WALK continue rather than stop — a rejected candidate frees the budget for later ones,
  //     so two back-lot boxes and one greenhouse that used to be trimmed now land elsewhere.
  //   • infill.deepScatterTrees 442 → 426 (−16): the deep-interior scatter's biggest single
  //     catchment WAS the empty rail-lands block. Those 16 trees are exactly the "generic downtown"
  //     dressing the phase set out to remove — the corridor now reads as ballast, track and
  //     turntable instead of scrub.
  //   • infill.fixedTotal 1189 → 1174 = the sum of the three above (+2 +1 −16 = −13).
  //   • frontage.* ALL UNCHANGED, by design: the strip is inset from every bounding street by the
  //     sidewalk band plus one pack-streetwall depth, so Front's south wall, Bremner's north wall
  //     and the Spadina/Bay flanks survive the claim intact (railLands.ts's STREETWALL_RESERVE_WU).
  //   • Verified after the fact: a blocking-claim census of the strip returns ONLY the 13
  //     rail-lands claims — nothing generic is left inside the corridor.
  //
  // PHASE 46 RE-PIN — the bespoke-named-geometry seam's first two claims (world/toronto/
  // namedGeometry.ts, registered by worldContext step 3a). EXACTLY TWO NUMBERS MOVE, and nothing
  // else in this table does:
  //   • claims 8056 → 8058 (+2): `named-bespoke:union-station:go-shed` (the GO train shed behind
  //     the headhouse, kind `namedBuilding`) and `named-bespoke:union-station:moat` (the sunken
  //     carriageway strip in front of it, kind `decor`).
  //   • clipVolumes 2373 → 2374 (+1): only the shed is building-class; `decor` never reaches the
  //     camera clip projection.
  //   • EVERY placement count is UNCHANGED, and that was measured, not assumed. Both new claims
  //     land on ground that was already empty: the moat strip sits inside Union's own 3 wu
  //     namedExclusion rect (so furniture's point-margin gate had already vacated the Front Street
  //     frontage in front of the station), and the shed sits inside the Phase-45 rail-lands strip
  //     (reserved, and swept clean by that phase). A blocking-claim census of both rectangles on
  //     the pre-Phase-46 world returned zero hits — which is why the seam's first landmark costs no
  //     displacement at all.
  // PHASE 47 RE-PIN — the civic heart (new-city-hall + old-city-hall + osgoode-hall through the
  // P46 seam). Unlike P46's zero-displacement pair, this phase CLEARS MOST OF A BLOCK (Queen ×
  // Bay × University), so the whole table was re-measured. claims 8058 → 8081 (+23), attributed
  // EXACTLY:
  //   • +14 authored: 5 named-building box claims (NCH's east tower + west twin + podium, OCH,
  //     Osgoode) + 5 namedExclusion zones (one per box) + 3 decor claims (`nps-square`,
  //     `osgoode-lawn-s`, `osgoode-lawn-w`) + 1 namedBuilding claim (`toronto-sign`, the square's
  //     one collider-backed fixture).
  //   • +9 net displacement reshuffle: cornerFills +4, backlotBox −3, furniture.trees −2,
  //     deepScatterTrees +10 (the vacated block's interior scatter re-rolled elsewhere;
  //     fixedTotal +10 is exactly the scatter-tree delta). Frontage redistributed WITHIN its
  //     saturated 1400 cap (genericDowntown −5, yongeDundasQueen −2 vs +1 each across seven other
  //     districts — the civic exclusions freed/blocked different street-walk slots).
  //   • Fence panels net 0: the P47 per-panel gate (southFenceRun's rejectFp — the seed-7
  //     tree×fence class fixed structurally at T0) drops nothing in the final world; the class it
  //     closes was expressed only by the mid-T0 reshuffle.
  //   • clipVolumes 2374 → 2381 (+7): +6 new building-class claims (5 named boxes + the sign) and
  //     the +4/−3 corner/backlot building-class net.
  it('matches the measured seed-416 counts exactly', () => {
    expect(world.counts).toEqual({
      claims: 8081,
      clipVolumes: 2381,
      'frontage.total': 1400,
      'frontage.towerBoxes': 90,
      'frontage.cornerFills': 51,
      'frontage.financial': 67,
      'frontage.entertainment': 38,
      'frontage.kingWest': 58,
      'frontage.queenWest': 71,
      'frontage.chinatownKensington': 35,
      'frontage.yongeDundasQueen': 59,
      'frontage.churchWellesley': 36,
      'frontage.uoft': 41,
      'frontage.stLawrence': 12,
      'frontage.harbourfront': 230,
      'frontage.bloorYorkville': 107,
      'frontage.northYorkCentre': 51,
      'frontage.willowdaleFinch': 100,
      'frontage.genericDowntown': 412,
      'frontage.foldCorridor': 83,
      'furniture.trafficLights': 227,
      'furniture.stopSigns': 1,
      'furniture.powerBoxes': 74,
      'furniture.trees': 451,
      'furniture.hydrants': 140,
      'furniture.benches': 160,
      'furniture.trashCans': 160,
      'furniture.busStops': 50,
      'furniture.manholes': 220,
      'furniture.parked': 200,
      'infill.backlotPack': 500,
      'infill.backlotBox': 308,
      'infill.laneway': 350,
      'infill.parkingLots': 16,
      'infill.parkingCars': 115,
      'infill.constructionSites': 14,
      'infill.constructionFixed': 77,
      'infill.constructionDecor': 182,
      'infill.laneClosures': 5,
      'infill.laneClosureCones': 31,
      'infill.deepScatterTrees': 436,
      'infill.deepScatterGreenhouses': 8,
      'infill.deepScatterPiles': 12,
      'infill.fixedTotal': 1184,
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
    ['furniture.trees', 451],
    ['furniture.benches', 160],
    ['furniture.trashCans', 160],
    ['furniture.hydrants', 140],
    ['furniture.manholes', 220],
    ['furniture.parked', 200],
    ['furniture.trafficLights', 227],
    ['furniture.powerBoxes', 74],
    ['infill.backlotBox', 308],
    ['infill.backlotPack', 500],
    ['infill.deepScatterTrees', 436],
    ['infill.laneway', 350],
    ['frontage.total', 1400],
    ['frontage.towerBoxes', 90],
    ['frontage.cornerFills', 51],
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
