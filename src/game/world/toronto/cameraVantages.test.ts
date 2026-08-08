// Phase 33 camera lab — the standard vantage battery's anchors. These are the SAME framings every
// candidate rig is judged on, so the properties that matter are: they exist, they are derived (not
// authored), they are inside the playable world, and a car teleported onto one lands on asphalt.
//
// Phase 76 adds three MID-BLOCK, on-lane anchors and a self-describing pose (`kind`/`cls`/
// `laneOffsetWu`/`onMedian`). Two new obligations follow, and both are MEASUREMENTS in the Phase 75
// tripwire tradition rather than opinions: (a) the resolved street/district each new anchor lands
// on is pinned, so a street-table or district re-grade reports itself instead of silently
// relocating an anchor; (b) the set of anchors sitting ON a Phase 75 planted median is pinned, so
// the `fold-corridor` artefact stays a recorded fact.
import { describe, expect, it } from 'vitest';
import { LANE_OFFSET_WU } from '../../config/torontoMap';
import { CAMERA_VANTAGE_IDS, cameraVantages, tallestStreetwallDistrict } from './cameraVantages';
import { buildDistricts, districtAt } from './districts';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import { buildStreets, type MapRect } from './streets';

const vantages = cameraVantages();

/** The three Phase 76 additions, in builder order. */
const MIDBLOCK_IDS = ['minor-midblock', 'spine-midblock', 'streetwall-canyon'] as const;

function inRect(x: number, z: number, r: MapRect): boolean {
  return x >= r.minX && x <= r.maxX && z >= r.minY && z <= r.maxY;
}

function vantage(id: string) {
  const v = vantages.find((c) => c.id === id);
  if (!v) throw new Error(`test setup: vantage "${id}" is missing`);
  return v;
}

describe('cameraVantages', () => {
  it('returns the declared id set, in order', () => {
    expect(vantages.map((v) => v.id)).toEqual(CAMERA_VANTAGE_IDS);
  });

  it('is deterministic (pure function of the street table)', () => {
    expect(cameraVantages()).toEqual(vantages);
  });

  it('every anchor is a finite world coordinate', () => {
    for (const v of vantages) {
      expect(Number.isFinite(v.x)).toBe(true);
      expect(Number.isFinite(v.z)).toBe(true);
    }
  });

  it('every anchor is inside the playable polygon', () => {
    for (const v of vantages) {
      expect(pointInPolygon({ x: v.x, y: v.z }, PLAYABLE_POLYGON), v.id).toBe(true);
    }
  });

  it('every anchor sits on a street ribbon (a teleported car lands on asphalt)', () => {
    const { streets } = buildStreets();
    for (const v of vantages) {
      const onRoad = streets.some((s) => inRect(v.x, v.z, s.ribbon));
      expect(onRoad, v.id).toBe(true);
    }
  });

  it('the seven Phase 33 Yonge-referenced anchors share the spine centreline', () => {
    const { streets } = buildStreets();
    const yonge = streets.find((s) => s.id === 'yonge');
    expect(yonge).toBeDefined();
    const spine = yonge?.centerline ?? NaN;
    for (const id of ['yonge-dundas', 'fold-corridor', 'ny-centre', 'harbourfront']) {
      const v = vantages.find((c) => c.id === id);
      expect(v?.x, id).toBe(spine);
    }
    // …and `spine-midblock` deliberately does NOT: it is the on-LANE spine pose the historic four
    // are not, offset by exactly the spine's carriageway centre toward the camera side.
    expect(vantage('spine-midblock').x - spine).toBeCloseTo(LANE_OFFSET_WU.spine, 6);
  });

  it('fold-corridor sits between the two Yonge-stem anchors it separates', () => {
    const nyCentre = vantages.find((v) => v.id === 'ny-centre');
    const fold = vantages.find((v) => v.id === 'fold-corridor');
    const dundas = vantages.find((v) => v.id === 'yonge-dundas');
    expect(nyCentre && fold && dundas).toBeTruthy();
    expect(fold?.z).toBeGreaterThan(nyCentre?.z ?? Infinity);
    expect(fold?.z).toBeLessThan(dundas?.z ?? -Infinity);
  });

  it('kensington lands inside the Chinatown/Kensington district bounds', () => {
    const v = vantages.find((c) => c.id === 'kensington');
    expect(v).toBeDefined();
    const district = buildDistricts().find((d) => d.def.id === 'chinatownKensington');
    expect(district).toBeDefined();
    const inside = (district?.rects ?? []).some((r) => inRect(v?.x ?? NaN, v?.z ?? NaN, r));
    expect(inside).toBe(true);
  });

  it('financial-canyon is off the spine (it is the Bay/King canyon, not Yonge)', () => {
    const { streets } = buildStreets();
    const spine = streets.find((s) => s.id === 'yonge')?.centerline ?? NaN;
    const v = vantages.find((c) => c.id === 'financial-canyon');
    expect(v?.x).not.toBe(spine);
  });

  it('harbourfront is the southernmost anchor (the clamp-stressed water edge)', () => {
    const south = [...vantages].sort((a, b) => b.z - a.z)[0];
    expect(south.id).toBe('harbourfront');
  });

  // --- Phase 76: the self-describing pose ------------------------------------------------------

  it('every anchor describes the ribbon it is actually on', () => {
    const { streets } = buildStreets();
    for (const v of vantages) {
      expect(v.streetIds.length, v.id).toBeGreaterThan(0);
      expect(v.streetIds, v.id).toContain(v.streetId);
      const primary = streets.find((s) => s.id === v.streetId);
      expect(primary, v.id).toBeDefined();
      // `streetId` is the WIDEST containing ribbon, and every listed id really does contain it.
      for (const id of v.streetIds) {
        const s = streets.find((st) => st.id === id);
        expect(s && inRect(v.x, v.z, s.ribbon), `${v.id}/${id}`).toBe(true);
        expect(s?.width ?? Infinity, `${v.id}/${id}`).toBeLessThanOrEqual(primary?.width ?? 0);
      }
      // The signed lateral offset is measured off that street's centreline on its perpendicular
      // axis, and always lands inside the ribbon.
      const lateral = primary?.axis === 'ns' ? v.x - primary.centerline : v.z - (primary?.centerline ?? NaN);
      expect(v.laneOffsetWu, v.id).toBeCloseTo(lateral, 6);
      expect(Math.abs(v.laneOffsetWu), v.id).toBeLessThanOrEqual(primary?.halfWidth ?? 0);
    }
  });

  it('a junction pose is exactly one with ribbons of both axes under it', () => {
    const { streets } = buildStreets();
    for (const v of vantages) {
      const under = streets.filter((s) => inRect(v.x, v.z, s.ribbon));
      const crossed = under.some((s) => s.axis === 'ns') && under.some((s) => s.axis === 'ew');
      expect(v.kind, v.id).toBe(crossed ? 'junction' : 'midblock');
    }
  });

  // MEASUREMENT (Phase 75 tripwire tradition), not a preference: exactly one historic anchor sits
  // on a Phase 75 planted median. `fold-corridor` is Yonge's centreline mid-band, and roadStrips'
  // medianBandRuns cuts the strip at every crossing so the three Yonge JUNCTION anchors are on
  // bare asphalt. If this set ever grows, an anchor has silently started framing grass.
  it('pins which anchors sit on a planted median', () => {
    expect(vantages.filter((v) => v.onMedian).map((v) => v.id)).toEqual(['fold-corridor']);
  });

  // --- Phase 76: the three mid-block anchors ---------------------------------------------------

  it('the three new anchors are mid-block, on a lane, and off the median', () => {
    const { streets } = buildStreets();
    for (const id of MIDBLOCK_IDS) {
      const v = vantage(id);
      expect(v.kind, id).toBe('midblock');
      expect(v.onMedian, id).toBe(false);
      // Exactly one ribbon under it — neither a junction nor a Phase 75 swallowed carriageway.
      expect(v.streetIds, id).toEqual([v.streetId]);
      // On the camera-side lane, at exactly its own class's carriageway centre.
      const cls = streets.find((s) => s.id === v.streetId)?.cls;
      expect(cls, id).toBeDefined();
      expect(v.laneOffsetWu, id).toBeCloseTo(LANE_OFFSET_WU[cls ?? 'minor'], 6);
      expect(v.laneOffsetWu, id).toBeGreaterThan(0);
    }
  });

  it('the three new anchors sample three distinct streets and three distinct road classes', () => {
    const picked = MIDBLOCK_IDS.map((id) => vantage(id));
    expect(new Set(picked.map((v) => v.streetId)).size).toBe(MIDBLOCK_IDS.length);
    expect(new Set(picked.map((v) => v.cls)).size).toBe(MIDBLOCK_IDS.length);
  });

  it('minor-midblock is on a minor street and spine-midblock is on the spine', () => {
    expect(vantage('minor-midblock').cls).toBe('minor');
    expect(vantage('spine-midblock').streetId).toBe('yonge');
    expect(vantage('spine-midblock').cls).toBe('spine');
  });

  // MEASUREMENT: the street + district each derived anchor resolves onto today. Nothing reads
  // these values; they exist so a street-table or district re-grade REPORTS the relocation instead
  // of silently changing what an evidence screenshot means.
  it('pins where the three new anchors resolve', () => {
    const districts = buildDistricts();
    const resolved = MIDBLOCK_IDS.map((id) => {
      const v = vantage(id);
      return { id, street: v.streetId, cls: v.cls, district: districtAt({ x: v.x, y: v.z }, districts)?.id };
    });
    expect(resolved).toEqual([
      { id: 'minor-midblock', street: 'richmond', cls: 'minor', district: 'financial' },
      { id: 'spine-midblock', street: 'yonge', cls: 'spine', district: 'harbourfront' },
      { id: 'streetwall-canyon', street: 'queen', cls: 'major', district: 'financial' },
    ]);
  });

  // MEASUREMENT: the built-form ranking `streetwall-canyon` is selected on. `financial` wins on the
  // range FLOOR (42 m — the "continuous" term) by a clear margin over the two other tower
  // districts, so the pick is not a near-tie that a small re-grade would flip unnoticed.
  it('pins the tallest-streetwall district and its margin', () => {
    expect(tallestStreetwallDistrict().def.id).toBe('financial');
    const ranked = [...buildDistricts()]
      .sort((a, b) => b.def.heightRangeM[0] - a.def.heightRangeM[0] || b.def.heightRangeM[1] - a.def.heightRangeM[1])
      .slice(0, 3)
      .map((d) => [d.def.id, ...d.def.heightRangeM]);
    expect(ranked).toEqual([
      ['financial', 42, 110],
      ['northYorkCentre', 28, 83],
      ['harbourfront', 28, 66],
    ]);
  });
});
