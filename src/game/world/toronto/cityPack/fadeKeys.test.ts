// Phase 36 (T3) — the fade-key agreement test.
//
// The whole dither pass rests on one property: the key the CLIP INDEX mints for a volume is the
// key the RENDERER registered its writer under. They are produced by two different walks over the
// same layout (the index splits frontage from infill; CityDress merges them so a shared model id
// collapses to one BatchedMesh), so nothing but a test can guarantee they agree. If this file goes
// red, occluders silently stop fading — no crash, no console error, just the bug the phase exists
// to fix, back again.
import { describe, expect, it } from 'vitest';
import { fixedItemFadeKey } from './fadeKeys';
import { frontageFadeKey, infillFadeKey } from '../cameraClipIndex';
import { composeWorld } from '../composeWorld';

const box = { position: [10, 0, 20] as const, hx: 3, hy: 4, hz: 5 };

describe('fixedItemFadeKey', () => {
  it('resolves a frontage slot / corner fill by its slotId', () => {
    expect(fixedItemFadeKey({ slotId: 'yonge:p:138' })).toBe('frontage:yonge:p:138');
    expect(fixedItemFadeKey({ slotId: 'corner:yonge:p:12' })).toBe('frontage:corner:yonge:p:12');
  });

  it('resolves a back-lot infill building by its id', () => {
    expect(fixedItemFadeKey({ id: 'backlot:king:n:4' })).toBe('infill:backlot:king:n:4');
  });

  it('returns null for the furniture-class infill items (never in the index, never fadeable)', () => {
    expect(fixedItemFadeKey({ id: 'lot-3-car-7' })).toBeNull();
    expect(fixedItemFadeKey({ id: 'site-2-fence-1' })).toBeNull();
    expect(fixedItemFadeKey({ id: 'site-2-dumpster' })).toBeNull();
    expect(fixedItemFadeKey({})).toBeNull();
  });
});

describe('agreement with the clip index (the single-sourcing rule)', () => {
  it('mints exactly the keys the arbiter registered on the same items', () => {
    const slots = [
      { ...box, slotId: 'yonge:p:1' },
      { ...box, slotId: 'corner:king:n:9' },
    ];
    const fixed = [
      { ...box, id: 'backlot:king:n:4' },
      { ...box, id: 'lot-3-car-7' }, // NOT a building claim — must be null here too
    ];
    // Phase 40: the index side mints via composeWorld's registration, which calls exactly these two
    // exported functions on exactly these item shapes. Asserting the derivation directly is now the
    // honest form of the agreement test (the old shared `buildClipIndexEntries` walk is gone).
    expect([...slots, ...fixed].map(fixedItemFadeKey)).toEqual([
      frontageFadeKey({ slotId: 'yonge:p:1' }),
      frontageFadeKey({ slotId: 'corner:king:n:9' }),
      infillFadeKey({ id: 'backlot:king:n:4' }),
      null,
    ]);
  });

  it('every REAL frontage/corner/back-lot item the renderer keys is a key the clip index carries', () => {
    const world = composeWorld(416);
    const indexKeys = new Set(world.clipVolumes.map((v) => v.fadeKey).filter((k): k is string => k !== null));
    const rendererItems = [
      ...world.frontage.slots,
      ...world.frontage.cornerFills,
      ...world.infill.fixed,
    ];
    for (const item of rendererItems) {
      const key = fixedItemFadeKey(item);
      if (key === null) continue; // cars/fences/scatter: never faded, never indexed
      expect(indexKeys.has(key), key).toBe(true);
    }
  });
});
