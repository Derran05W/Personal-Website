// Phase 33 camera lab — the standard vantage battery's anchors. These are the SAME framings every
// candidate rig is judged on, so the properties that matter are: they exist, they are derived (not
// authored), they are inside the playable world, and a car teleported onto one lands on asphalt.
import { describe, expect, it } from 'vitest';
import { CAMERA_VANTAGE_IDS, cameraVantages } from './cameraVantages';
import { buildDistricts } from './districts';
import { PLAYABLE_POLYGON, pointInPolygon } from './polygon';
import { buildStreets, type MapRect } from './streets';

const vantages = cameraVantages();

function inRect(x: number, z: number, r: MapRect): boolean {
  return x >= r.minX && x <= r.maxX && z >= r.minY && z <= r.maxY;
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

  it('the Yonge-referenced anchors share the spine centreline', () => {
    const { streets } = buildStreets();
    const yonge = streets.find((s) => s.id === 'yonge');
    expect(yonge).toBeDefined();
    const spine = yonge?.centerline ?? NaN;
    for (const id of ['yonge-dundas', 'fold-corridor', 'ny-centre', 'harbourfront']) {
      const v = vantages.find((c) => c.id === id);
      expect(v?.x, id).toBe(spine);
    }
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
});
