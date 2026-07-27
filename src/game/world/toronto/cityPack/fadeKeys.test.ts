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
import { buildClipIndexEntries, frontageFadeKey, infillFadeKey } from '../cameraClipIndex';

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
  it('mints exactly the keys buildClipIndexEntries puts on the same items', () => {
    const slots = [
      { ...box, slotId: 'yonge:p:1' },
      { ...box, slotId: 'corner:king:n:9' },
    ];
    const fixed = [
      { ...box, id: 'backlot:king:n:4' },
      { ...box, id: 'lot-3-car-7' }, // filtered OUT of the index — must be null here too
    ];
    const entries = buildClipIndexEntries({
      groundedBuildings: slots,
      centredBoxes: [],
      infillFixed: fixed,
      namedBoxes: [],
      heroBases: [],
    });
    const indexKeys = entries.map((e) => e.fadeKey);
    // The index emits one entry per slot plus ONE for the back-lot item (the car is filtered).
    expect(indexKeys).toEqual([
      frontageFadeKey({ slotId: 'yonge:p:1' }),
      frontageFadeKey({ slotId: 'corner:king:n:9' }),
      infillFadeKey({ id: 'backlot:king:n:4' }),
    ]);
    // ...and the renderer-side derivation agrees item-for-item, including the null.
    expect([...slots, ...fixed].map(fixedItemFadeKey)).toEqual([...indexKeys, null]);
  });
});
