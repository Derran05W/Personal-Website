// Phase 36 (T3) — the mesh side's half of the fade-key single-sourcing rule.
//
// cameraClipIndex.ts's key block explains the rule: the clip index (which decides WHAT the
// boresight hit) and the renderer (which decides WHERE to write the fade) are two different walks
// over the same layout arrays, and they agree only if both derive keys from the ITEM's own data
// via the same functions — never from an array position, which drifts the moment a dev toggle
// (`packInfill`) or a filter (the back-lot prefix) changes one walk and not the other.
//
// The index's `buildClipIndexEntries` gets the two families handed to it PRE-SPLIT (frontage slots
// in `groundedBuildings`, infill items in `infillFixed`). CityDress does not have that luxury: it
// deliberately MERGES frontage slots, corner fills and every infill fixed item into one
// FixedPackInstances call so a model id shared across layers collapses to a single BatchedMesh. So
// the merged array needs one function that recovers the family from the item itself — this one,
// unit-tested against the index's own output so the two can never drift apart silently.

import { INFILL_BUILDING_ID_PREFIX, frontageFadeKey, infillFadeKey } from '../cameraClipIndex';

/** The two shapes that reach FixedPackInstances. Structural (no frontage/infill imports) for the
 * same reason cameraClipIndex.ts keeps its source types structural. */
export interface FadeKeyable {
  /** FrontageSlot / corner fill — the Phase 25.7 stable slot id (corner fills self-prefix). */
  readonly slotId?: string;
  /** infill.ts FixedInfillItem — the generator's unique id. */
  readonly id?: string;
}

/**
 * The dither fade key for one merged fixed-pack item, or null when the item is not a fadeable
 * building volume.
 *
 * The null cases are deliberate and match `buildClipIndexEntries` exactly:
 *   • infill items whose id is NOT `backlot:` — parking-lot cars, construction fences, dumpsters,
 *     billboards. They are furniture-class, sit below the eye line, and are not in the clip index,
 *     so a registration for them could never be hit and would only cost a per-frame Map entry.
 *   • anything carrying neither id (a bare PlacedBox from a hand-built test harness).
 */
export function fixedItemFadeKey(item: FadeKeyable): string | null {
  if (item.slotId !== undefined) return frontageFadeKey({ slotId: item.slotId });
  if (item.id !== undefined && item.id.startsWith(INFILL_BUILDING_ID_PREFIX)) return infillFadeKey({ id: item.id });
  return null;
}
