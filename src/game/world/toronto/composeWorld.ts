// Phase 40 — THE COMPOSITION ROOT. One call builds the whole Toronto placement layer, in one
// declared order, through one claim index.
//
// Before this module there was no composition root: `TorontoScene.tsx` held seven independent
// `useMemo`s (parks / named / places / worldEdge / frontage / furniture / infill / venueDress),
// each builder re-derived the street table for itself, and three of them hand-maintained their
// own exclusion set. Whether two layers avoided each other was decided ad hoc, per pair, and the
// `.planning/part-10-placement-integrity.md` audit found seven pairs where nobody had decided at
// all (furniture ⟂ frontage, furniture ⟂ infill, furniture ⟂ parks, lane closures ⟂ everything,
// venue props ⟂ furniture, duplicate venue claims, and the three drifting compositions).
//
// THE ORDER (the plan's recorded decision; two deliberate deviations from the part file's arrow
// chain, both explained below):
//
//   named + hero lots → places → parks → worldEdge      (seed-independent — worldContext.ts)
//     → frontage (venue claims, street walk, backdrops, corner fills)
//     → venueDress                                       ①
//     → infill main (construction → back lot → parking → laneway → deep scatter)
//     → furniture (masts, boxes, rows, manholes, parked cars)
//     → lane closures                                    ②
//
//   ① venueDress moves BEFORE furniture. Its props derive purely from frontage claims, and
//     authored venue dressing must outrank fungible generic furniture: this way a random bench
//     can never displace the flower pots outside a money-shot storefront. venueDress itself gains
//     no gates — it REGISTERS, it does not check — so its output stays byte-identical.
//   ② lane closures move AFTER furniture, because gap 4 requires them to gate on furniture's
//     street-parked cars and manhole covers. Both moves are rng-neutral: every layer draws from
//     its own named mulberry fork, which is seeded by label rather than by call order.
//
// LATER IS SUBORDINATE: a layer rejects against everything already registered and never relocates
// (the reject-never-relocate rule the whole Toronto world is built on). The index it threads is an
// INSTANCE owned by this call — two composeWorld calls never see each other's claims, which is
// what keeps `composeWorld(s)` deep-equal to `composeWorld(s)`.
//
// Pure TS: no three, no react. `TorontoScene.tsx` calls this once per seed/tier in a single memo
// and reads every layer off the result, including `clipVolumes` — the camera clip index is now
// literally a projection of the placed world (see claimIndex.buildingClipVolumes).

import { TORONTO_TIER_IDENTITY, type TorontoTierParams } from '../../config/torontoDress';
import { VENUE_QUEUE } from '../../config/venueDressing';
import { backdropFadeKey, frontageFadeKey, infillFadeKey, type ClipEntry } from './cameraClipIndex';
import {
  aabbAround,
  buildingClipVolumes,
  type ClaimIndex,
  type ClaimIndexView,
  type ClaimInput,
} from './claimIndex';
import { buildFrontage, type FrontageLayout, type FrontageSlot, type PlacedBox } from './frontage';
import { buildFurniture, type FurnitureLayout } from './furniture';
import {
  buildInfillMain,
  buildLaneClosuresLayer,
  mergeInfill,
  type DecorPlacement,
  type FixedInfillItem,
  type InfillLayout,
} from './infill';
import { buildVenueDress, type VenueDress } from './venueDress';
import { createPlacementContext, propFootprint, type WorldPrefix } from './worldContext';

/** Everything the scene (and the tests, and the invariant sweep) needs from one world build. */
export interface ComposedWorld extends WorldPrefix {
  readonly seed: number;
  readonly tierParams: TorontoTierParams;
  readonly frontage: FrontageLayout;
  readonly dress: VenueDress;
  readonly infill: InfillLayout;
  readonly furniture: FurnitureLayout;
  /** The arbiter, read-only, holding every claim this composition registered. */
  readonly index: ClaimIndexView;
  /** Every building-class claim as a camera ClipEntry — what `setClipIndex` is fed (plus the two
   * hero volumes, which are derived from three geometry and so are appended by the scene). */
  readonly clipVolumes: readonly ClipEntry[];
  /** Per-layer placement counts, for the count table + regression bounds. */
  readonly counts: Readonly<Record<string, number>>;
}

// --- claim helpers --------------------------------------------------------------------------------

/** A ground-anchored pack placement's claim footprint + vertical extent. */
function groundedClaim(item: PlacedBox & { readonly hy: number }): { aabb: ReturnType<typeof aabbAround>; yRange: readonly [number, number] } {
  return {
    aabb: aabbAround(item.position[0], item.position[2], item.hx, item.hz),
    yRange: [0, 2 * item.hy],
  };
}

/** Phase 45 moved `propFootprint` (and its "claim the trunk, not the canopy" exception table) down
 * into worldContext.ts, which now registers prop claims of its own — the rail-lands patio dressing.
 * Re-exported here so every existing call site and import path is unchanged. */
export { propFootprint } from './worldContext';

/** A parking-lot / construction-site item's owning lot, parsed off the generator id
 * (`construction:3-fence-1`, `parking:7-car-2`, `construction:3-dumpster`). Shared-owner pairs are
 * SANCTIONED overlaps — a lot's own fence run, dumpster and cars legitimately sit inside it. */
function lotOwnerOf(id: string): string | undefined {
  for (const marker of ['-fence-', '-car-', '-dumpster', '-billboard']) {
    const at = id.lastIndexOf(marker);
    if (at > 0) return `infill:${id.slice(0, at)}`;
  }
  return undefined;
}

// --- the composition ------------------------------------------------------------------------------

/**
 * Build the whole Toronto placement layer for `seed` at `tierParams`. Deterministic: the same
 * arguments produce a deep-equal result (composeWorld.test.ts pins it), because every builder is
 * a pure function of its inputs and the index is a per-call instance.
 */
export function composeWorld(seed: number, tierParams: TorontoTierParams = TORONTO_TIER_IDENTITY): ComposedWorld {
  const ctx = createPlacementContext();
  const index: ClaimIndex = ctx.index;

  // --- frontage: the streetwall, its venue claims, backdrops and corner fills -------------------
  const frontage = buildFrontage(seed, tierParams, ctx);
  const claimOwner = (slot: FrontageSlot): string | undefined =>
    slot.venueId === undefined ? undefined : `venue:${slot.venueId}`;
  for (const slot of frontage.slots) {
    index.register({
      id: `frontage:${slot.slotId}`,
      kind: 'frontageSlot',
      source: 'frontage',
      ...(claimOwner(slot) !== undefined ? { owner: claimOwner(slot)! } : {}),
      ...groundedClaim(slot),
      fadeKey: frontageFadeKey(slot),
    });
  }
  for (const slot of frontage.cornerFills) {
    index.register({
      id: `frontage:${slot.slotId}`,
      kind: 'cornerFill',
      source: 'frontage',
      ...groundedClaim(slot),
      fadeKey: frontageFadeKey(slot),
    });
  }
  for (const box of frontage.towerBoxes) {
    index.register({
      id: `frontage-${backdropFadeKey(box)}`,
      kind: 'backdropBox',
      source: 'frontage',
      aabb: aabbAround(box.x, box.z, box.hx, box.hz),
      yRange: [0, 2 * box.hy],
      fadeKey: backdropFadeKey(box),
    });
  }

  // --- venue dressing: registers, never checks (deviation ① in the header) ----------------------
  // Only the GROUND props claim space. Fascia bands, awnings and the Alo plaque are wall-mounted —
  // config/layering.ts's WALL_STACK territory (Phase 39), not the arbiter's.
  const dress = buildVenueDress(frontage.venueClaims);
  dress.props.forEach((prop, i) => {
    index.register({
      id: `venue-prop:${prop.venueId}:${i}`,
      kind: 'venueProp',
      source: 'venueDress',
      owner: `venue:${prop.venueId}`,
      aabb: propFootprint(prop.modelId, prop.position[0], prop.position[2], prop.rotationY),
    });
  });
  for (const queue of dress.queues) {
    const postHalf = VENUE_QUEUE.postSizeWu.w / 2;
    queue.posts.forEach((post, i) => {
      index.register({
        id: `venue-queue-post:${queue.venueId}:${i}`,
        kind: 'queueProp',
        source: 'venueDress',
        owner: `venue:${queue.venueId}`,
        aabb: aabbAround(post.x, post.z, postHalf, postHalf),
      });
    });
    queue.blobs.forEach((blob, i) => {
      index.register({
        id: `venue-queue-blob:${queue.venueId}:${i}`,
        kind: 'queueProp',
        source: 'venueDress',
        owner: `venue:${queue.venueId}`,
        aabb: aabbAround(blob.x, blob.z, VENUE_QUEUE.blobSizeWu.w / 2, VENUE_QUEUE.blobSizeWu.d / 2),
      });
    });
  }

  // --- infill: reserved lots, back lots, laneway clutter, deep scatter ---------------------------
  const infillMain = buildInfillMain(seed, ctx, tierParams);
  infillMain.constructionLots.forEach((rect, i) => {
    index.register({ id: `construction-lot:${i}`, kind: 'constructionLot', source: 'infill', owner: `infill:construction:${i}`, aabb: rect });
  });
  infillMain.parkingLots.forEach((rect, i) => {
    index.register({ id: `parking-lot:${i}`, kind: 'parkingLot', source: 'infill', owner: `infill:parking:${i}`, aabb: rect });
  });
  for (const item of infillMain.groups.backlot) {
    index.register({
      id: `infill:${item.id}`,
      kind: 'backlotBuilding',
      source: 'infill',
      ...groundedClaim(item),
      fadeKey: infillFadeKey(item),
    });
  }
  for (const box of infillMain.boxes) {
    index.register({
      id: `infill-${backdropFadeKey(box)}`,
      kind: 'backdropBox',
      source: 'infill',
      aabb: aabbAround(box.x, box.z, box.hx, box.hz),
      yRange: [0, 2 * box.hy],
      fadeKey: backdropFadeKey(box),
    });
  }
  const registerLotItem = (item: FixedInfillItem): void => {
    const owner = lotOwnerOf(item.id);
    index.register({
      id: `infill:${item.id}`,
      kind: item.id.includes('-car-') ? 'lotCar' : 'lotFixture',
      source: 'infill',
      ...(owner !== undefined ? { owner } : {}),
      ...groundedClaim(item),
    });
  };
  for (const item of infillMain.groups.parking) registerLotItem(item);
  for (const item of infillMain.groups.construction) registerLotItem(item);
  for (const item of infillMain.groups.scatterFixed) {
    index.register({ id: `infill:${item.id}`, kind: 'scatterProp', source: 'infill', ...groundedClaim(item) });
  }
  // Colliderless decor. Each family gets ONE shared owner: laneway clutter runs a street with no
  // self-check, construction props are deliberately clustered (cone clusters jitter ±1.2 wu around
  // a shared centre and are MEANT to touch), and the deep-scatter piles already reject each other
  // internally. Sanctioning within a family keeps the invariant sweep honest without pretending
  // those authored clusters are defects.
  const registerDecor = (items: readonly DecorPlacement[], prefix: string, owner: string): void => {
    items.forEach((item, i) => {
      index.register({
        id: `${prefix}:${i}`,
        kind: item.modelId === 'cone' ? 'cone' : 'decor',
        source: 'infill',
        owner,
        aabb: propFootprint(item.modelId, item.position[0], item.position[2], item.rotationY),
      });
    });
  };
  registerDecor(infillMain.groups.laneway, 'infill-laneway', 'infill:laneway');
  registerDecor(infillMain.groups.constructionDecor, 'infill-construction-decor', 'infill:constructionDecor');
  registerDecor(infillMain.groups.scatterDecor, 'infill-scatter-decor', 'infill:scatterDecor');

  // --- furniture: the last seed-dependent layer that answers to everything above -----------------
  const furniture = buildFurniture(seed, ctx, tierParams);
  const registerFurniture = (
    items: readonly { readonly modelId: string; readonly position: readonly [number, number, number]; readonly rotationY: number }[],
    prefix: string,
    kind: 'furniture' | 'manhole' | 'parkedCar',
    owner?: string,
  ): void => {
    items.forEach((item, i) => {
      index.register({
        id: `${prefix}:${i}`,
        kind,
        source: 'furniture',
        ...(owner !== undefined ? { owner } : {}),
        aabb: propFootprint(item.modelId, item.position[0], item.position[2], item.rotationY),
      });
    });
  };
  // The intersection-rule ensemble (masts / stop signs / power boxes) shares ONE owner: they are
  // corner-pinned, identity-bearing (lampClock emitters, the 74 blackout transformers) and
  // deliberately NOT gated against each other (furniture.ts's documented tradeoff) — a mast and
  // its corner's power box standing together is the designed streetscape, not a defect.
  registerFurniture(furniture.trafficLights, 'furniture-mast', 'furniture', 'furniture:corner');
  registerFurniture(furniture.stopSigns.items, 'furniture-stop-sign', 'furniture', 'furniture:corner');
  registerFurniture(furniture.powerBoxes.items, 'furniture-power-box', 'furniture', 'furniture:corner');
  registerFurniture(furniture.trees.items, 'furniture-tree', 'furniture');
  registerFurniture(furniture.hydrants.items, 'furniture-hydrant', 'furniture');
  registerFurniture(furniture.benches.items, 'furniture-bench', 'furniture');
  registerFurniture(furniture.trashCans.items, 'furniture-trash-can', 'furniture');
  registerFurniture(furniture.busStops.items, 'furniture-bus-stop', 'furniture');
  registerFurniture(furniture.manholes.items, 'furniture-manhole', 'manhole');
  registerFurniture(furniture.parked.items, 'furniture-parked', 'parkedCar');

  // --- lane closures: last, gated on the parked cars + manholes above (deviation ②) --------------
  const closures = buildLaneClosuresLayer(seed, ctx, tierParams);
  const closureClaims: ClaimInput[] = [
    ...closures.cones.map((cone, i) => ({
      id: `lane-closure-cone:${i}`,
      kind: 'cone' as const,
      source: 'infill' as const,
      owner: 'infill:laneClosure',
      aabb: propFootprint(cone.modelId, cone.position[0], cone.position[2], cone.rotationY),
    })),
    ...closures.decor.map((plate, i) => ({
      id: `lane-closure-plate:${i}`,
      kind: 'decor' as const,
      source: 'infill' as const,
      owner: 'infill:laneClosure',
      aabb: propFootprint(plate.modelId, plate.position[0], plate.position[2], plate.rotationY),
    })),
  ];
  index.registerAll(closureClaims);

  const infill = mergeInfill(infillMain, closures);

  const counts: Record<string, number> = {
    claims: index.size(),
    clipVolumes: 0, // filled below (the selector walks the finished index)
  };
  for (const [key, value] of Object.entries(frontage.counts)) counts[`frontage.${key}`] = value;
  for (const [key, value] of Object.entries(furniture.counts)) counts[`furniture.${key}`] = value;
  for (const [key, value] of Object.entries(infill.counts)) counts[`infill.${key}`] = value;
  counts['dress.bands'] = dress.bands.length;
  counts['dress.awnings'] = dress.awnings.length;
  counts['dress.props'] = dress.props.length;
  counts['dress.queues'] = dress.queues.length;
  counts['dress.plaques'] = dress.plaques.length;

  const clipVolumes = buildingClipVolumes(index);
  counts.clipVolumes = clipVolumes.length;

  return {
    ...(ctx as WorldPrefix),
    seed,
    tierParams,
    frontage,
    dress,
    infill,
    furniture,
    index,
    clipVolumes,
    counts,
  };
}
