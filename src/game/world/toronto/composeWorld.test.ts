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
  //
  // ============================================================================================
  // PHASE 75 RE-PIN — THE ROAD EXPANSION. The largest table churn since Phase 27, because this is
  // the first phase since the road diet to move the ribbons themselves: spine 11.0 → 22.0, artery
  // 9.9 → 19.8, major 8.8 → 17.6, minor 6.6 → 13.2 wu. Every placer in this table measures from a
  // ribbon edge, so every one of them re-walked. Attribution below is by SOURCE first (which adds
  // to the claim delta exactly), then per-count, and each of the four T3 code changes was ABLATED
  // individually so no number here is attributed by narrative.
  //
  // THE HEADLINE, MEASURED (before-worktree @00eaeb1 vs this tree, seed 416):
  //   • net road area (rect-union, so intersection double-count is removed exactly)
  //     192,796 → 373,184 wu² inside the 2,535,840 wu² playable polygon: 7.60 % → 14.72 % of the
  //     map, so BUILDABLE land falls 7.70 %. (The plan's "−2.75 %" divided by the 6,780,000 wu²
  //     bounding box rather than the polygon; against the real polygon the trade is ~2.8× that.)
  //   • total frontage LENGTH 44,181.6 → 44,122.2 wu, −0.13 % — and even that is not the widening:
  //     it is Bloor's boundary-nudge (streets.ts nudges a boundary-flush centreline in by its own
  //     half-width, which doubled) stepping 4.95 wu south and shortening the six N-S streets that
  //     terminate on it, 4.95 × 6 × 2 sides = 59.4 wu exactly.
  //   • so the plan's prediction HELD: the streetwall count is preserved (`frontage.total` 1400,
  //     the hardCap, before and after) and what shrank is block-interior DEPTH. The cost shows up
  //     in the interior layers below (back-lot boxes, deep scatter) and in the pre-cap supply,
  //     which frontage.test.ts's tier-wiring pin now measures and records (−10 % raw supply; the
  //     low tier stopped saturating the cap, 1400 → 1340).
  //
  // BY SOURCE (sums to claims 8076 → 8046, −30):
  //   • worldEdge 2306 → 2381 (+75) — the dead-end jersey rows, the ring's only width-derived
  //     dressing. Full attribution on worldEdge.test.ts's census pin.
  //   • infill 2093 → 2024 (−69) — backlotBox −24, scatterProp −42, decor −3.
  //   • furniture 1683 → 1655 (−28) — trees −26, powerBoxes −2.
  //   • frontage 1540 → 1533 (−7) — cornerFills −7 (slots + towerBoxes are both capped and flat).
  //   • venueDress 114 → 113 (−1) — the one gated venue prop (below).
  //   • named / places / parks / streets / world: UNCHANGED. The seed-independent prefix does not
  //     read a ribbon width for its claim COUNT (the three named buildings this phase re-anchored
  //     moved, but a moved box is still one box).
  //
  // PER-COUNT:
  //   • frontage.total 1400 (FLAT — the hardCap binds before and after), but the per-district
  //     split re-rolled wholesale: the candidate walk skips each crossing by `crossHalfWidth +
  //     cornerClearance`, so every crossing now eats ~2× the block segment and every surviving
  //     candidate's along-coordinate moved; the facade line also stepped out by 3.3-5.5 wu per
  //     class. Biggest movers harbourfront +14, foldCorridor +5, bloorYorkville +5 vs financial
  //     −19, churchWellesley −7, genericDowntown −6. A saturated cap means these are a
  //     REDISTRIBUTION of a fixed 1400, not a density change.
  //   • frontage.cornerFills 50 → 43 (−7). Corner pieces fill the diagonal notch at an
  //     intersection and are positioned at `nsHalf + sidewalk + half` on BOTH axes; doubling both
  //     half-widths pushes every piece diagonally outward into ground the streetwall, back lots or
  //     the arbiter already hold, and 7 more are rejected. (1 of the 7 is the named re-anchoring —
  //     ablated, below.)
  //   • frontage.towerBoxes 90 (FLAT — capped map-wide; a DIFFERENT 90, which is why
  //     heightLaw.test.ts's crosser list moved 36 → 43).
  //   • furniture.trees 451 → 425 (−26) and furniture.powerBoxes 74 → 72 (−2). Both rows are laid
  //     from the ribbon edge outward and both reject against everything already placed; the wider
  //     ribbons + re-rolled streetwall leave fewer legal points. Every district still keeps a
  //     transformer (the blackout-chain invariant has its own test and is green).
  //   • infill.backlotBox 305 → 281 (−24). Back lots sit BEHIND the streetwall — the layer that
  //     directly loses the block-interior depth the roads took.
  //   • infill.deepScatterTrees 431 → 389 (−42) and deepScatterPiles 12 → 8 (−4). The single
  //     biggest loser, and by construction: deep scatter is only eligible strictly beyond
  //     DEEP_SCATTER.minDistFromRibbonWu (35 wu) from EVERY ribbon, so widening every ribbon by
  //     3.3-5.5 wu per side erodes that catchment from all sides at once.
  //   • infill.fixedTotal 1179 → 1137 (−42) = exactly the scatter-tree delta.
  //   • infill.decorTotal 548 → 545 (−3) = piles −4, +1 lane-closure road plate. The plates gate on
  //     manholes / parked cars / crosswalk bands, and T1 moved all three (manhole centreline
  //     offset, re-laid parking rows, CROSSWALK.bandWu 2.2 → 3.0), freeing one blocked plate.
  //   • infill.laneClosures 5 / laneClosureCones 31 (FLAT).
  //   • dress.props 96 → 95 (−1) — the venue-prop arbiter gate (see composeWorld.ts): a
  //     `loblaws-mlg` flank prop stood 0.09 wu inside its next-door neighbour once the re-pitched
  //     streetwall closed to 0.37 wu, and is now rejected like any other placement.
  //   • claims 8076 → 8046 (−30) = the by-source table above.
  //   • clipVolumes 2380 → 2349 (−31) = cornerFill −7 + backdropBox −24, and nothing else — the
  //     projection is exactly the building-class claims, and frontageSlot / backlotBuilding /
  //     namedBuilding are all flat.
  //
  // THE FOUR T3 CODE CHANGES, ABLATED ONE AT A TIME AGAINST THIS TABLE:
  //   • TRAFFIC_LIGHT.postHalfWidthWu 0.25 → derived 0.435: **ZERO count change.** The claim now
  //     describes the rendered post instead of a stranded literal, and displaced nothing doing it.
  //   • lane-closure cone taper re-derived across the carriageway: **ZERO count change** (cone
  //     POSITIONS move on the three median arteries; no cone is newly rejected).
  //   • the three named corner-pair re-anchors (hockey-hall-of-fame / fairmont-royal-york /
  //     old-city-hall, each pulled out of a ribbon it had been pushed into): cornerFills −1,
  //     backlotBox +2, deepScatterTrees −1 (fixedTotal −1), clipVolumes +1, and a ±1-2 shuffle
  //     across seven frontage districts inside the flat 1400.
  //   • the venue-prop gate: exactly −1 prop / −1 claim, nothing else.
  //
  // ============================================================================================
  // PHASE 75 (T4) RE-PIN — THE MEDIAN PLANTING. Two numbers move, and only two:
  //   • furniture.medianPlanting: NEW, 136. Sparse trees on the four median-carrying streets'
  //     grass, walked over the segments `roadStrips.medianBandRuns` reports (4,850.7 wu of grass in
  //     36 segments after the 36 crossing cut-outs and the 5 terminus insets) at
  //     MEDIAN_PLANTING.pitchWu (39.65, derived from the camera's own visible ground band). Well
  //     under its 160 cap, so the cap is not shaping the number.
  //   • claims 8046 → 8182 (+136) = exactly one `medianPlanting` claim per placement. Nothing is
  //     displaced: the layer is built and claimed LAST inside buildFurniture, so every earlier
  //     category was already placed against an index it had not touched.
  //
  // EVERY OTHER COUNT IS BYTE-IDENTICAL, and that was measured rather than assumed — trees 425,
  // hydrants 140, benches 160, bins 160, shelters 50, manholes 220, parked 200, masts 227, power
  // boxes 72, the whole frontage/infill/dress table, and clipVolumes 2349 (medianPlanting is not a
  // building-class kind, so the camera-clip projection is untouched). The layer also draws from its
  // own named rng fork (`median-planting`), so no other category's rolls shifted.
  // ============================================================================================
  it('matches the measured seed-416 counts exactly', () => {
    expect(world.counts).toEqual({
      claims: 8182,
      clipVolumes: 2349,
      'frontage.total': 1400,
      'frontage.towerBoxes': 90,
      'frontage.cornerFills': 43,
      'frontage.financial': 45,
      'frontage.entertainment': 39,
      'frontage.kingWest': 57,
      'frontage.queenWest': 74,
      'frontage.chinatownKensington': 37,
      'frontage.yongeDundasQueen': 62,
      'frontage.churchWellesley': 30,
      'frontage.uoft': 41,
      'frontage.stLawrence': 11,
      'frontage.harbourfront': 244,
      'frontage.bloorYorkville': 112,
      'frontage.northYorkCentre': 54,
      'frontage.willowdaleFinch': 99,
      'frontage.genericDowntown': 407,
      'frontage.foldCorridor': 88,
      'furniture.trafficLights': 227,
      'furniture.stopSigns': 1,
      'furniture.powerBoxes': 72,
      'furniture.trees': 425,
      'furniture.hydrants': 140,
      'furniture.benches': 160,
      'furniture.trashCans': 160,
      'furniture.busStops': 50,
      'furniture.manholes': 220,
      'furniture.medianPlanting': 136,
      'furniture.parked': 200,
      'infill.backlotPack': 500,
      'infill.backlotBox': 281,
      'infill.laneway': 350,
      'infill.parkingLots': 16,
      'infill.parkingCars': 115,
      'infill.constructionSites': 14,
      'infill.constructionFixed': 77,
      'infill.constructionDecor': 182,
      'infill.laneClosures': 5,
      'infill.laneClosureCones': 31,
      'infill.deepScatterTrees': 389,
      'infill.deepScatterGreenhouses': 8,
      'infill.deepScatterPiles': 8,
      'infill.fixedTotal': 1137,
      'infill.decorTotal': 545,
      'dress.bands': 27,
      'dress.awnings': 14,
      'dress.props': 95,
      'dress.queues': 2,
      'dress.plaques': 1,
    });
  });

  // The specific attributed values from the task brief, asserted individually too — so a future
  // reader can see at a glance which counts were the ones under scrutiny, without diffing the
  // whole record above.
  it.each([
    ['furniture.busStops', 50],
    ['furniture.trees', 425],
    ['furniture.benches', 160],
    ['furniture.trashCans', 160],
    ['furniture.hydrants', 140],
    ['furniture.manholes', 220],
    ['furniture.medianPlanting', 136],
    ['furniture.parked', 200],
    ['furniture.trafficLights', 227],
    ['furniture.powerBoxes', 72],
    ['infill.backlotBox', 281],
    ['infill.backlotPack', 500],
    ['infill.deepScatterTrees', 389],
    ['infill.laneway', 350],
    ['frontage.total', 1400],
    ['frontage.towerBoxes', 90],
    ['frontage.cornerFills', 43],
    ['dress.bands', 27],
    ['dress.props', 95],
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
