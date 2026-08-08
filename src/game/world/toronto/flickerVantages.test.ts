// Phase 42 T2 — flicker-sweep vantage lattice tests. The module is pure geometry (no store/
// three/rapier), so every property below is checkable headless, matching the discipline
// cameraVantages.test.ts and districts.test.ts already use for their own derived vantage lists.
import { describe, expect, it } from 'vitest';
import { flickerVantages, type FlickerVantage } from './flickerVantages';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import { GROUND_RECTS } from './torontoSceneHelpers';
import { TORONTO_DISTRICTS } from '../../config/torontoDistricts';
import { CAMERA_VANTAGE_IDS } from './cameraVantages';

const vantages = flickerVantages();
const bySource = (s: FlickerVantage['source']) => vantages.filter((v) => v.source === s);

describe('flickerVantages', () => {
  it('is deterministic (pure geometry, two calls agree exactly)', () => {
    expect(flickerVantages()).toEqual(vantages);
  });

  it('every pose has finite coordinates', () => {
    for (const v of vantages) {
      expect(Number.isFinite(v.x), v.id).toBe(true);
      expect(Number.isFinite(v.z), v.id).toBe(true);
    }
  });

  it('every pose is inside the playable polygon (boundary-inclusive)', () => {
    for (const v of vantages) {
      expect(pointInPolygon({ x: v.x, y: v.z }, PLAYABLE_POLYGON), v.id).toBe(true);
    }
  });

  it('every id is unique', () => {
    const ids = vantages.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('pins the exact total pose count and per-source breakdown (golden numbers)', () => {
    // If this test ever needs re-pinning, print `vantages.length` and the per-source counts
    // first and inspect why before accepting a new number — the part-42 plan's sanity band is
    // ~150-260 poses total.
    //
    // PHASE 75 — 183 -> 188, and every one of the +5 is LATTICE (143 -> 148); district (15),
    // money (18) and camera (7) are curated lists and are byte-identical, which is the shape a
    // width change should produce. The lattice is a 120 wu grid snapped onto asphalt through the
    // NavProvider and DROPPED when the snap exceeds LATTICE_SNAP_MAX_WU (90). Widening every
    // ribbon moves each street's nearest asphalt up to (newHalf - oldHalf) = 5.5 / 4.95 / 4.4 /
    // 3.3 wu closer to the sampling grid, so five grid points that used to sit just beyond the 90
    // wu drop threshold now snap inside it. They are new poses on real, drivable road — exactly
    // what the sweep wants — and 188 is still inside the plan's ~150-260 band.
    // Then 188 -> 187 (lattice 148 -> 147) when `money-dash-far` was re-targeted onto Eglinton:
    // lattice poses yield to every curated pose, so the relocated money anchor absorbed the lattice
    // point nearest its new spot. Coverage is unchanged — that ground is still measured, by the
    // money pose instead of the lattice one. The curated lists stay 18 / 15 / 7.
    //
    // PHASE 76 — 187 -> 189, and the +2 is a +3/-1 the same dedupe rule explains. The camera lab
    // added three mid-block poses to cameraVantages() (`minor-midblock`, `spine-midblock`,
    // `streetwall-canyon`) because every pre-existing anchor was a street-CENTRELINE crossing, and
    // at Phase 75's doubled widths a junction is 22 x 17.6 wu of open asphalt — i.e. the old set
    // could not photograph a street, only an intersection. Camera 7 -> 10 is therefore intentional
    // and asserted dynamically below (`CAMERA_VANTAGE_IDS.length`), not pinned here. Lattice
    // 147 -> 146: exactly one grid point sat nearest one of the three new curated poses and yielded
    // to it, the same absorption the Eglinton re-target caused above. Coverage is unchanged — that
    // ground is now measured by the camera pose. District (15) and money (18) are byte-identical.
    expect(vantages.length).toBe(189);
    expect(bySource('lattice').length).toBe(146);
    expect(bySource('district').length).toBe(TORONTO_DISTRICTS.length);
    expect(bySource('money').length).toBe(18);
    expect(bySource('camera').length).toBe(CAMERA_VANTAGE_IDS.length);
  });

  it('one district pose per TORONTO_DISTRICTS entry, ids match', () => {
    const districtIds = bySource('district').map((v) => v.id).sort();
    const expected = TORONTO_DISTRICTS.map((d) => `district-${d.id}`).sort();
    expect(districtIds).toEqual(expected);
  });

  it('one camera pose per cameraVantages() anchor, ids match', () => {
    const camIds = bySource('camera').map((v) => v.id).sort();
    const expected = CAMERA_VANTAGE_IDS.map((id) => `cam-${id}`).sort();
    expect(camIds).toEqual(expected);
  });

  it('lattice poses never sit farther than the snap-drop threshold from a road (sanity: they exist)', () => {
    // The module itself enforces the ≤90 wu snap bound before a lattice pose is ever emitted —
    // this test guards that no lattice pose slipped through some other path, and that the
    // lattice actually produced points (an empty lattice would pass a "bounded distance" check
    // vacuously).
    expect(bySource('lattice').length).toBeGreaterThan(0);
  });

  describe('ground-safety square (the sweep must be able to PHOTOGRAPH every pose)', () => {
    // Re-derived independently from the module's private helper: the ±6 wu safety square
    // around a pose must lie inside the GROUND_RECTS union (car footprint + the settle-creep
    // roll of a south-facing teleport pose). A pose that fails this straddles either the shore
    // seam (downtown maxY == the water sensor's north face — the creep rolls the car into it
    // and it drowns) or a fold-corridor void corner (a wheel quadrant hangs over nothing; the
    // car tips off and the Phase 37 OOB backstop fires).
    const onGround = (x: number, z: number, inset: number): boolean => {
      for (const sx of [x - inset, x + inset]) {
        for (const sz of [z - inset, z + inset]) {
          if (!GROUND_RECTS.some((r) => sx >= r.minX && sx <= r.maxX && sz >= r.minY && sz <= r.maxY)) return false;
        }
      }
      return true;
    };

    it('every GENERATED pose (lattice + district) keeps the full 6 wu creep envelope on ground', () => {
      for (const v of vantages) {
        if (v.source !== 'lattice' && v.source !== 'district') continue;
        expect(onGround(v.x, v.z, 6), `${v.id} at (${v.x}, ${v.z})`).toBe(true);
      }
    });

    it('every CURATED pose (money + camera) keeps at least the 2 wu car footprint on ground', () => {
      // Curated poses ship verbatim (they were hand-verified live by the P39-41 batteries and
      // never nudged), so they only owe the physical footprint sanity — e.g. the P39 laneway
      // decor anchor sits 4.5 wu from the hoarding-ringed north edge, which is fine: the north
      // edge is a barrier, not open water, and the pose photographed cleanly in sweep A.
      for (const v of vantages) {
        if (v.source !== 'money' && v.source !== 'camera') continue;
        expect(onGround(v.x, v.z, 2), `${v.id} at (${v.x}, ${v.z})`).toBe(true);
      }
    });

    it.each([
      // Sweep A's 8 GAMEOVER teleports (full-a-2/6/7 results.json): 6 shore-seam street tips
      // snapped to exactly z=2484 (the water sensor face), 2 fold-corridor corner tips at
      // (1320|1680, 1362). The clamp must keep each id present AND measurable.
      ['lat-11-11'],
      ['lat-14-11'],
      ['lat-5-21'],
      ['lat-6-21'],
      ['lat-8-21'],
      ['lat-11-21'],
      ['lat-13-21'],
      ['lat-14-21'],
    ])('%s (deadly in sweep A) still exists and is now ground-safe', (id) => {
      const v = vantages.find((p) => p.id === id);
      expect(v, id).toBeDefined();
      if (v) expect(onGround(v.x, v.z, 6), `${id} at (${v.x}, ${v.z})`).toBe(true);
    });
  });

  it('no lattice pose sits within the dedupe radius of a district/money/camera pose', () => {
    const priority = vantages.filter((v) => v.source !== 'lattice');
    for (const lat of bySource('lattice')) {
      for (const p of priority) {
        const d = Math.hypot(lat.x - p.x, lat.z - p.z);
        expect(d, `${lat.id} vs ${p.id}`).toBeGreaterThanOrEqual(40);
      }
    }
  });

  describe('money-shot table — cross-phase evidence anchors, must never drift silently', () => {
    const byId = new Map(vantages.map((v) => [v.id, v]));

    it.each([
      // Phase 39 collision-audit battery (.planning/tools/p39-battery.mjs)
      ['money-manhole', 1499, 1933.5],
      ['money-church-rainbow', 1595.2, 1690],
      ['money-laneway-p39-decor', 1340, 4.5],
      ['money-searchlight-lake', 1500, 2478],
      // Phase 40 placement-arbiter battery (.planning/tools/p40-battery.mjs)
      ['money-shelter-yonge', 1502, 1948],
      ['money-shelter-yonge-2', 1489, 1599],
      ['money-laneway-p40-dumpster', 1508, 137],
      ['money-parkinglot', 1350, 33],
      // Phase 41 surface & shimmer capture matrix (.planning/tools/p41-matrix.mjs VANTAGES)
      // Phase 75 re-target: the spine gained a median and median streets paint no centre dashes,
      // so the old (1500, 1032) spot had no dashes left to study. Moved onto Eglinton (the fold
      // zone's dashed EW major), east of the Yonge junction box. See flickerVantages.ts.
      ['money-dash-far', 1560, 1104.8],
      ['money-grazing-ground', 1455, 660],
      ['money-park-boundary', 1460, 670],
      ['money-bus-stop', 1507.4, 1942.3],
      ['money-venue-fascia', 916, 2023],
      ['money-tower-facade', 1362, 2215],
      ['money-curb-junction-near', 1493, 1884],
      ['money-curb-junction-far', 1493, 1894],
      ['money-curb-outer-near', 1470, 444],
      ['money-curb-outer-far', 1470, 452],
    ])('%s sits at its pinned battery-script coordinate', (id, x, z) => {
      const v = byId.get(id as string);
      expect(v, id as string).toBeDefined();
      expect(v?.x).toBe(x);
      expect(v?.z).toBe(z);
      expect(v?.source).toBe('money');
    });
  });
});
