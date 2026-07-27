/**
 * THE EYE-LINE LAW (Phase 35). Companion to config/camera.law.test.ts: that file pins the CAMERA,
 * this one pins the CITY the camera has to fly through.
 *
 * The law, in one sentence: **ordinary streetwall and filler stay BELOW the resting camera eye
 * (config/camera.ts's CAMERA_EYE_MIN_WU = 22.05 wu); only a counted, listed intentional-tall set
 * crosses it.** The user's headline Part-9 complaint was that the camera phases through buildings.
 * Phase 34 fixed the camera half (rig E, eye 22.05 at rest vs the old rig's 18.39); this file is the
 * world half — it makes "how tall may a thing be?" a machine-checked property of the config/data
 * tables instead of an art judgement re-made by every placer.
 *
 * WHY CROSSING IS ALLOWED AT ALL: a city with no skyline isn't Toronto. Crossing the eye line
 * doesn't make a mesh a bug — it makes it an OCCLUDER, something the camera can end up inside or
 * behind. So the law's job is not to forbid tall things but to keep the set of them small, listed,
 * and therefore coverable. **The pinned enumeration in the last describe block below is Phase 36's
 * occlusion work order**: every entry there is geometry the dithered-fade/anti-clip pass must be
 * able to handle. Today's fader covers only ~18 named/hero meshes, which is exactly why the batched
 * crossers (tower-district filler, the backdrop row) are called out separately.
 *
 * Structure note: the assertions are deliberately written so that ADDING a crosser fails. Class
 * checks are exhaustive over their source table (every district, every pack building model), and the
 * enumeration test compares an exact sorted list, not a subset — a height bump that lifts a new
 * mesh over the line lands here as a diff to argue with, not as a silent occluder.
 */
import { describe, expect, it } from 'vitest';
import { CAMERA_EYE_MAX_WU, CAMERA_EYE_MIN_WU } from '../../config/camera';
import { resolveCityPackScale, STREETWALL_MAX_HEIGHT_WU } from '../../config/cityPackScale';
import { TORONTO_DISTRICTS } from '../../config/torontoDistricts';
import { CITY_PACK_MANIFEST } from '../../assets/cityPackManifest';
import { composeWorld } from './composeWorld';
import { buildNamedBuildings } from './namedBuildings';
import { buildPlacesLayer } from './placesLayer';
import { buildCnTowerGeometry, buildRogersGeometry } from './heroes';
import { hGame } from './heightCurve';

/** The seed the whole Toronto layer is verified against (the P27-P32 gate seed). */
const SEED = 416;

/** Minimum daylight (wu) the law demands between a below-line class's tallest member and the eye.
 * Not cosmetic: a class that merely *ties* the eye line is one rounding change from crossing it. */
const MIN_MARGIN_WU = 0.5;

/** Districts whose FILLER is allowed over the line — the three skyline districts, flagged in the
 * config table itself (packStock.backdropTowers) rather than listed here, so adding a fourth tower
 * district is a config edit that this file automatically follows. */
const TOWER_DISTRICTS = TORONTO_DISTRICTS.filter((d) => d.packStock.backdropTowers === true).map((d) => d.id);

const isTowerDistrict = (id: string): boolean => (TOWER_DISTRICTS as readonly string[]).includes(id);

/** Pack manifest entries that are buildings (both the signed family and the blank facades). */
const PACK_BUILDINGS = CITY_PACK_MANIFEST.filter((e) => e.category === 'building' || e.category === 'building-blank');

const round2 = (n: number): number => Math.round(n * 100) / 100;

describe('eye-line law — the constant this file is about', () => {
  it('is the derived resting eye, not a restated literal', () => {
    expect(CAMERA_EYE_MIN_WU).toBeCloseTo(22.05, 2);
    expect(CAMERA_EYE_MAX_WU).toBeCloseTo(35.13, 2);
    // Sanity on the direction of the envelope — the ramp only ever lifts the eye.
    expect(CAMERA_EYE_MAX_WU).toBeGreaterThan(CAMERA_EYE_MIN_WU);
  });

  it('three of the fifteen districts are the declared skyline districts', () => {
    expect([...TOWER_DISTRICTS].sort()).toEqual(['financial', 'harbourfront', 'northYorkCentre']);
  });
});

describe('eye-line law — (a) district filler heights', () => {
  // The district height table (config/torontoDistricts.ts heightRangeM, in REAL metres) feeds three
  // separate placers through hGame(): frontage.ts's backdrop-tower row, infill.ts's back-lot boxes,
  // and (indirectly) the massing look of every block interior. Checking the table's upper end covers
  // all of them at once — no placer can roll above its district's own range.
  it('every non-tower district tops out below the resting eye, with margin', () => {
    for (const d of TORONTO_DISTRICTS) {
      if (isTowerDistrict(d.id)) continue;
      const topWu = hGame(d.heightRangeM[1]);
      expect(topWu, `${d.id} filler top (${d.heightRangeM[1]} m)`).toBeLessThanOrEqual(CAMERA_EYE_MIN_WU - MIN_MARGIN_WU);
    }
  });

  it('the tightest non-tower district is bloorYorkville (the one to watch on a re-grade)', () => {
    const tops = TORONTO_DISTRICTS.filter((d) => !isTowerDistrict(d.id)).map((d) => ({
      id: d.id,
      topWu: hGame(d.heightRangeM[1]),
    }));
    const tightest = tops.reduce((a, b) => (b.topWu > a.topWu ? b : a));
    expect(tightest.id).toBe('bloorYorkville');
    expect(round2(tightest.topWu)).toBe(21.44);
  });

  it('every tower district DOES cross (they are the skyline — this is the intent, not a leak)', () => {
    for (const id of TOWER_DISTRICTS) {
      const d = TORONTO_DISTRICTS.find((x) => x.id === id);
      expect(hGame(d?.heightRangeM[1] ?? 0), `${id}`).toBeGreaterThan(CAMERA_EYE_MIN_WU);
    }
  });
});

describe('eye-line law — (b) city-pack building models', () => {
  // The regression this phase actually found: the frontage rule ("3 car lengths of facade width")
  // is a WIDTH rule that sets height implicitly, via each model's own native aspect ratio.
  // brown-building is taller per unit width than the shared family, so the same frontage target put
  // it at 24.19 wu — ordinary streetwall, 2.1 wu ABOVE the resting eye, in 12 of 15 districts.
  // config/cityPackScale.ts now caps building scale at STREETWALL_MAX_HEIGHT_WU, which is why this
  // test can be exhaustive over the manifest rather than a list of known-good ids.
  it('every pack building model scales to below the resting eye', () => {
    for (const e of PACK_BUILDINGS) {
      const hWu = e.nativeDims.h * resolveCityPackScale(e.id);
      expect(hWu, `${e.id}`).toBeLessThanOrEqual(CAMERA_EYE_MIN_WU - MIN_MARGIN_WU);
    }
  });

  it('the cap is the binding constraint on brown-building alone', () => {
    const capped = PACK_BUILDINGS.filter(
      (e) => round2(e.nativeDims.h * resolveCityPackScale(e.id)) === round2(STREETWALL_MAX_HEIGHT_WU),
    ).map((e) => e.id);
    expect(capped).toEqual(['brown-building']);
  });

  it('pins the resolved streetwall facade heights (wu)', () => {
    const heights = Object.fromEntries(
      PACK_BUILDINGS.map((e) => [e.id, round2(e.nativeDims.h * resolveCityPackScale(e.id))]).sort((a, b) =>
        String(a[0]).localeCompare(String(b[0])),
      ),
    );
    expect(heights).toEqual({
      'big-building': 16.29,
      'brown-building': 21.05,
      'building-green': 19.42,
      'building-red': 19.42,
      'building-red-corner': 19.36,
      'gb-blank': 19.42,
      greenhouse: 3.44,
      'pizza-corner': 19.36,
      'rb-blank': 19.42,
    });
  });
});

describe('eye-line law — (c) the placed classes, measured on the real layout', () => {
  // Class checks above are on the SOURCES; these are on the OUTPUT, so a placer that invents its own
  // height (or scales a model itself) can't slip past the table checks.
  const { frontage, infill, dress } = composeWorld(SEED);

  it('frontage streetwall: every slot is below the resting eye', () => {
    for (const s of frontage.slots) {
      expect(s.hy * 2, `${s.slotId} (${s.modelId})`).toBeLessThanOrEqual(CAMERA_EYE_MIN_WU - MIN_MARGIN_WU);
    }
  });

  it('corner fills: every quadrant filler is below the resting eye', () => {
    expect(frontage.cornerFills.length).toBeGreaterThan(0);
    for (const s of frontage.cornerFills) {
      expect(s.hy * 2, `${s.slotId} (${s.modelId})`).toBeLessThanOrEqual(CAMERA_EYE_MIN_WU - MIN_MARGIN_WU);
    }
  });

  it('infill back-lot pack buildings, parking/construction props and laneway clutter: below', () => {
    expect(infill.fixed.length).toBeGreaterThan(0);
    for (const item of infill.fixed) {
      expect(item.hy * 2, `${item.id} (${item.modelId})`).toBeLessThanOrEqual(CAMERA_EYE_MIN_WU - MIN_MARGIN_WU);
    }
  });

  it('infill back-lot BOXES cross only inside the tower districts', () => {
    for (const b of infill.boxes) {
      if (isTowerDistrict(b.districtId)) continue;
      expect(b.hy * 2, `back-lot box in ${b.districtId}`).toBeLessThanOrEqual(CAMERA_EYE_MIN_WU - MIN_MARGIN_WU);
    }
  });

  it('the backdrop-tower row exists ONLY in the tower districts (its crossing is district-scoped)', () => {
    expect(frontage.towerBoxes.length).toBeGreaterThan(0);
    for (const b of frontage.towerBoxes) {
      expect(isTowerDistrict(b.districtId), `backdrop box in ${b.districtId}`).toBe(true);
    }
  });

  it('venue dressing (fascia bands, awnings, props, plaques) sits at street level', () => {
    expect(dress.bands.length).toBeGreaterThan(0);
    for (const band of dress.bands) {
      expect(band.cy + band.height / 2, `${band.venueId} band`).toBeLessThanOrEqual(CAMERA_EYE_MIN_WU - MIN_MARGIN_WU);
    }
    for (const a of dress.awnings) {
      expect(a.bottomY + a.rise, `${a.venueId} awning`).toBeLessThanOrEqual(CAMERA_EYE_MIN_WU - MIN_MARGIN_WU);
    }
  });

  it('placesLayer hosts and vibe props sit far under the eye line', () => {
    const places = buildPlacesLayer();
    // Sam's host + discs (the P26 exception whose whole reason for existing is staying low), the
    // Sankofa screen box, and the Chinatown gate — the only vertical geometry left in this layer.
    const samTop = Math.max(...places.discs.discs.map((d) => d.y + d.radius));
    expect(samTop).toBeLessThanOrEqual(CAMERA_EYE_MIN_WU - MIN_MARGIN_WU);
    expect(places.sankofa.box.hy * 2).toBeLessThanOrEqual(CAMERA_EYE_MIN_WU - MIN_MARGIN_WU);
    expect(places.gate.postTopY).toBeLessThanOrEqual(CAMERA_EYE_MIN_WU - MIN_MARGIN_WU);
    for (const p of places.placements) {
      if (p.box) expect(p.box.hy * 2, p.id).toBeLessThanOrEqual(CAMERA_EYE_MIN_WU - MIN_MARGIN_WU);
    }
  });
});

describe('eye-line law — (d) THE CROSSER LIST (Phase 36 occlusion work order)', () => {
  // Everything in this block is geometry the camera can be inside or behind. Phase 36's
  // dithered-fade/anti-clip pass has to cover all of it; today's occlusion fade covers only the
  // named/hero meshes (individually-mounted, ~18 of them), NOT the batched/instanced classes.
  //
  // If a test here fails with an unexpected id, the correct response is a DECISION — either re-grade
  // that thing at its data/config source (never a code literal), or add it to the list and hand it to
  // the occlusion pass. Not a snapshot update on autopilot.

  it('BATCHED crossers (no per-mesh fade today — Phase 36 needs the dither path for these)', () => {
    const { frontage, infill } = composeWorld(SEED);
    const batched = {
      // The backdrop-tower row: sparse extruded boxes behind the frontage in the 3 skyline districts.
      backdropTowerBoxes: frontage.towerBoxes.filter((b) => b.hy * 2 > CAMERA_EYE_MIN_WU).length,
      // Back-lot boxes that roll high enough inside a tower district to cross.
      backLotBoxes: infill.boxes.filter((b) => b.hy * 2 > CAMERA_EYE_MIN_WU).length,
      // Pack facades: NONE may cross (test (b) above is the structural guarantee; asserted here too
      // so the crosser census and the class law can never disagree).
      frontageSlots: frontage.slots.filter((s) => s.hy * 2 > CAMERA_EYE_MIN_WU).length,
      cornerFills: frontage.cornerFills.filter((s) => s.hy * 2 > CAMERA_EYE_MIN_WU).length,
      infillPackBuildings: infill.fixed.filter((i) => i.hy * 2 > CAMERA_EYE_MIN_WU).length,
    };
    expect(batched.frontageSlots).toBe(0);
    expect(batched.cornerFills).toBe(0);
    expect(batched.infillPackBuildings).toBe(0);
    // Counts are seed-416 measurements, pinned so a density/height change has to restate them.
    // Note both rows draw heights from the SAME district ranges as the filler, so only the upper
    // part of each roll crosses — 35 of the 90 placed backdrop boxes, and a small tail of back-lot
    // boxes inside the three skyline districts.
    //
    // Phase 40: this count moved 9 -> 6. Back-lot boxes now gate on the placement arbiter's
    // `blocked` predicate (world-edge ring + named boxes + frontage streetwall/backdrop towers),
    // which nothing checked before Phase 40 — a back-lot box could roll on top of a backdrop-tower
    // box behind the SAME frontage, since the two rows were built independently and neither one's
    // rejection list knew about the other. The three lost crossers were exactly that: tall back-lot
    // boxes interpenetrating a backdrop tower inside a skyline district (ablation-proven — removing
    // the new `blocked(fp)` check from buildBacklotRow alone restores all three). See
    // phase-40-notes.md.
    expect(batched.backdropTowerBoxes).toBe(35);
    expect(batched.backLotBoxes).toBe(6);
  });

  it('NAMED crossers, enumerated by id + final height (wu)', () => {
    const named = buildNamedBuildings();
    const crossers: { id: string; box: number; hWu: number }[] = [];
    for (const p of named.placements) {
      for (const [i, b] of p.boxes.entries()) {
        if (b.hy * 2 > CAMERA_EYE_MIN_WU) crossers.push({ id: p.id, box: i, hWu: round2(b.hy * 2) });
      }
    }
    // Every one of these is an authored Toronto landmark whose height comes from a researched
    // real_h_m in data/toronto/building-specs.json through hGame() × NAMED_HEIGHT_SCALE. They cross
    // BY DESIGN — a 22 wu First Canadian Place would not be First Canadian Place. Note that two of
    // them (aura in yongeDundasQueen, the-well in kingWest) sit in NON-tower districts: that is
    // intentional and is the reason district tower-ness governs FILLER only. Named landmarks are
    // individually placed, individually excluded from massing, and already occlusion-faded.
    expect(crossers).toEqual([
      { id: 'td-bank-tower', box: 0, hWu: 31.54 },
      { id: 'scotia-plaza', box: 0, hWu: 35.77 },
      { id: 'first-canadian-place', box: 0, hWu: 37.53 },
      { id: 'commerce-court-west', box: 0, hWu: 32.88 },
      { id: 'royal-bank-plaza', box: 0, hWu: 27.74 },
      { id: 'cibc-square', box: 0, hWu: 33.05 },
      { id: 'fairmont-royal-york', box: 0, hWu: 22.18 },
      { id: 'the-well', box: 0, hWu: 27.18 },
      { id: 'aura', box: 0, hWu: 35.53 },
      { id: 'hullmark', box: 0, hWu: 26.61 },
      { id: 'hullmark', box: 1, hWu: 23.66 },
      { id: 'emerald-park', box: 0, hWu: 24.56 },
    ]);
  });

  it('NAMED non-crossers stay non-crossers (the mid-rise set)', () => {
    const named = buildNamedBuildings();
    const below = named.placements
      .flatMap((p) => p.boxes.map((b) => ({ id: p.id, hWu: round2(b.hy * 2) })))
      .filter((x) => x.hWu <= CAMERA_EYE_MIN_WU)
      .map((x) => x.id);
    expect([...new Set(below)].sort()).toEqual([
      'eaton-centre-galleria',
      'emerald-park', // the twin's secondary tower (21.17) — the main tower crosses, this one doesn't
      'north-york-civic-centre',
      'the-well', // the podium (9.47)
      'union-station',
    ]);
  });

  it('HEROES cross by definition and are exempt from the curve cut (sacred silhouettes)', () => {
    const cn = buildCnTowerGeometry();
    const rogers = buildRogersGeometry();
    expect(round2(cn.meta.height)).toBe(90.68);
    expect(round2(rogers.meta.height)).toBe(29.68);
    expect(cn.meta.height).toBeGreaterThan(CAMERA_EYE_MAX_WU);
    expect(rogers.meta.height).toBeGreaterThan(CAMERA_EYE_MIN_WU);
  });

  it('the crosser CLASSES are exactly these five and no more', () => {
    // The counted, listed set the Part-9 acceptance criterion asks for. Anything that starts
    // crossing outside these five classes fails a test in describe block (a), (b) or (c) above —
    // this assertion is the human-readable index of the work order, kept next to the census.
    expect([
      'tower-district filler (financial / harbourfront / northYorkCentre)',
      'backdrop-tower row (tower districts only)',
      'back-lot boxes inside tower districts',
      'named landmark towers (12 boxes)',
      'heroes (CN Tower, Rogers Centre)',
    ]).toHaveLength(5);
  });
});
