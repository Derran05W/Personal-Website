// Tests for the Phase 25 hero primitive meshes (TORONTO-MAP-SPEC-v2.md §5, Addendum A.3/A.5).
// Pins the tri budgets and the data-locked proportions the money-shot read depends on:
//   • CN Tower ≤ 600 tris, Rogers ≤ 500 (A.3), triangle count == position.count / 3;
//   • CN pod centres within ±2% of 0.62·h / 0.81·h, needle spanning the top 12±2%, legs in the
//     bottom 8±2%, an EMISSIVE (bright) pod-ring band sitting on the main pod;
//   • Rogers dome diameter 66±0.5 wu, ring base ≈ 15%·h;
//   • both builders are deterministic (no random — same call → byte-identical geometry).
// Heights are recomputed here from data/toronto/building-specs.json via hGame (the single-source
// rule, mirroring namedBuildings.test.ts); the JSON's expected_game_h_wu is only a cross-check.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { hGame } from './heightCurve';
import { buildCnTowerGeometry, buildRogersGeometry, CN_TOWER_MAX_TRIS, ROGERS_MAX_TRIS } from './heroes';

interface SpecRow {
  id: string;
  real_h_m: number;
  footprint_wu: number;
  dome_diameter_wu?: number;
}
const specsPath = resolve(process.cwd(), 'data/toronto/building-specs.json');
const specs: SpecRow[] = existsSync(specsPath)
  ? (JSON.parse(readFileSync(specsPath, 'utf-8')) as { buildings: SpecRow[] }).buildings
  : [];
const specById = new Map(specs.map((s) => [s.id, s]));
const cnReal = specById.get('cn-tower')!.real_h_m; // 553.3
const rogersReal = specById.get('rogers-centre')!.real_h_m; // 86
const H_CN = hGame(cnReal);
const H_ROGERS = hGame(rogersReal);

/** Number of triangles from a (non-indexed or indexed) BufferGeometry. */
function triCountOf(g: BufferGeometry): number {
  return g.index ? g.index.count / 3 : g.attributes.position.count / 3;
}

describe('CN Tower hero mesh — tri budget (A.3: ≤ 600)', () => {
  const { geometry, meta } = buildCnTowerGeometry();
  it('is within the 600-triangle budget', () => {
    expect(meta.triangles).toBeLessThanOrEqual(CN_TOWER_MAX_TRIS);
    expect(CN_TOWER_MAX_TRIS).toBe(600);
  });
  it('meta.triangles equals the geometry position/index triangle count', () => {
    expect(meta.triangles).toBe(triCountOf(geometry));
  });
});

describe('CN Tower hero mesh — data-locked proportions (§5)', () => {
  const { meta } = buildCnTowerGeometry();
  const within2pct = (value: number, expected: number) => Math.abs(value - expected) <= 0.02 * H_CN;

  it('total height is hGame(real_h_m) from the JSON (single source)', () => {
    expect(meta.height).toBeCloseTo(H_CN, 6);
  });
  it('base diameter is footprint_wu (⌀21)', () => {
    expect(meta.baseDiameter).toBeCloseTo(specById.get('cn-tower')!.footprint_wu, 6);
  });
  it('main pod centre is within ±2% of 0.62·h', () => {
    expect(within2pct(meta.podCenterY, 0.62 * H_CN)).toBe(true);
  });
  it('SkyPod centre is within ±2% of 0.81·h', () => {
    expect(within2pct(meta.skyPodCenterY, 0.81 * H_CN)).toBe(true);
  });
  it('needle spans the top 12±2% (bottom at 0.88·h, top at h)', () => {
    expect(meta.needleMaxY).toBeCloseTo(H_CN, 4);
    expect(Math.abs(meta.needleMinY - 0.88 * H_CN)).toBeLessThanOrEqual(0.02 * H_CN);
  });
  it('legs occupy the bottom 8±2% of height', () => {
    expect(meta.legTopY).toBeGreaterThanOrEqual(0.06 * H_CN);
    expect(meta.legTopY).toBeLessThanOrEqual(0.1 * H_CN);
  });
  it('the emissive pod-ring band sits on the main pod', () => {
    expect(meta.ringMinY).toBeGreaterThanOrEqual(meta.podBottomY - 1e-6);
    expect(meta.ringMaxY).toBeLessThanOrEqual(meta.podTopY + 1e-6);
    const ringCenter = (meta.ringMinY + meta.ringMaxY) / 2;
    expect(Math.abs(ringCenter - meta.podCenterY)).toBeLessThanOrEqual(0.02 * H_CN);
  });
});

describe('CN Tower hero mesh — the pod ring is actually BRIGHT (emissive read)', () => {
  it('has a vivid (red-dominant, bright) vertex inside the ring band', () => {
    const { geometry, meta } = buildCnTowerGeometry();
    const pos = geometry.attributes.position;
    const col = geometry.attributes.color;
    // Float32 attribute rounding at y≈55 wu is ~3e-6, so the band check needs a hair of slop.
    const eps = 0.05;
    let found = false;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const r = col.getX(i);
      const g = col.getY(i);
      const b = col.getZ(i);
      // A lit red/white LED texel: strongly bright and red-leaning, seated in the ring band.
      if (y >= meta.ringMinY - eps && y <= meta.ringMaxY + eps && r > 0.6 && r >= g && r >= b) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});

describe('Rogers Centre hero mesh — tri budget (A.3: ≤ 500)', () => {
  const { geometry, meta } = buildRogersGeometry();
  it('is within the 500-triangle budget', () => {
    expect(meta.triangles).toBeLessThanOrEqual(ROGERS_MAX_TRIS);
    expect(ROGERS_MAX_TRIS).toBe(500);
  });
  it('meta.triangles equals the geometry triangle count', () => {
    expect(meta.triangles).toBe(triCountOf(geometry));
  });
});

describe('Rogers Centre hero mesh — data-locked proportions (§5)', () => {
  const { meta } = buildRogersGeometry();
  it('total height is hGame(real_h_m) from the JSON', () => {
    expect(meta.height).toBeCloseTo(H_ROGERS, 6);
  });
  it('dome diameter is 66±0.5 wu (dome_diameter_wu)', () => {
    expect(Math.abs(meta.domeDiameter - specById.get('rogers-centre')!.dome_diameter_wu!)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(meta.domeDiameter - 66)).toBeLessThanOrEqual(0.5);
  });
  it('ring base is ~15% of height', () => {
    expect(Math.abs(meta.ringBaseTopY - 0.15 * H_ROGERS)).toBeLessThanOrEqual(0.02 * H_ROGERS);
  });
  it('dome apex is at total height', () => {
    expect(meta.apexY).toBeCloseTo(H_ROGERS, 4);
  });
});

describe('hero meshes — deterministic (no random)', () => {
  it('CN Tower geometry is byte-identical on repeat', () => {
    const a = buildCnTowerGeometry().geometry.attributes.position.array;
    const b = buildCnTowerGeometry().geometry.attributes.position.array;
    expect(Array.from(a)).toEqual(Array.from(b));
  });
  it('Rogers geometry is byte-identical on repeat', () => {
    const a = buildRogersGeometry().geometry.attributes.position.array;
    const b = buildRogersGeometry().geometry.attributes.position.array;
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
