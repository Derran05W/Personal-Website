// Tests for the hero primitive meshes (TORONTO-MAP-SPEC-v2.md §5, Addendum A.3/A.5) — Phase 25 for
// Rogers, Phase 43 for the CN Tower v2 rebuild. Pins the tri budgets and the data-locked
// proportions the money-shot read depends on:
//   • CN Tower ≤ 2,500 tris (A.3's 600 rose DELIBERATELY at Phase 43 — the overview's tri-budget
//     addendum), Rogers ≤ 500, triangle count == position.count / 3;
//   • CN pod centres within ±2% of 0.62·h / 0.81·h, needle spanning the top 12±2%, legs merging
//     into the shaft at 22±4% (supersedes §5's "bottom 8%" — see that test's rationale), the
//     parabolic arch apex at 14%·h, three RIBS that measurably stand proud of the hex core, an
//     EMISSIVE (bright) pod-ring band RECESSED inside its lips, and a red beacon stub at the tip;
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

describe('CN Tower hero mesh — tri budget (A.3, re-pinned at Phase 43: ≤ 2,500)', () => {
  const { geometry, meta } = buildCnTowerGeometry();
  it('is within the 2,500-triangle budget', () => {
    expect(meta.triangles).toBeLessThanOrEqual(CN_TOWER_MAX_TRIS);
    expect(CN_TOWER_MAX_TRIS).toBe(2500);
  });
  it('actually spends the budget — this is v2, not a token pass', () => {
    // The v1 mesh was 266 tris of generic hex taper. A regression that quietly reverted the
    // arched base / fluted shaft / pod massing would still pass every proportion pin above, so the
    // FLOOR is a test too. Headroom above the actual count is deliberate (Phase 44's night
    // program buys geometry with it).
    expect(meta.triangles).toBeGreaterThan(800);
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
  it('legs merge into the closed shaft at 22±4% of height', () => {
    // SUPERSEDES §5's "legs in the bottom 8%" (and v1's 0.077·h), which was simply wrong about the
    // real tower: map-researcher round 2026-07-27 (Wikipedia / CN Tower official / Designing
    // Buildings) puts the merge at the 100–150 m mark = 0.18–0.27·h, and the parabolic arch
    // negative space — not a stubby buttress — is what dominates the ground-level perimeter.
    // Phase 43 re-pins to 0.22·h ± 0.04·h; the spec addendum records the supersession.
    expect(meta.legTopY).toBeGreaterThanOrEqual(0.18 * H_CN);
    expect(meta.legTopY).toBeLessThanOrEqual(0.26 * H_CN);
  });
  it('the parabolic arch apex sits at 14%·h, below the merge', () => {
    expect(Math.abs(meta.archApexY - 0.14 * H_CN)).toBeLessThanOrEqual(0.02 * H_CN);
    expect(meta.archApexY).toBeLessThan(meta.legTopY);
  });
  it('the three ribs are 120° apart with one aimed NW (camera law)', () => {
    // The fixed rig looks NW from the SE (map north = −Z, east = +X; the eye sits at +X/+Z), so
    // one leg takes the NW azimuth = 225° in the [sin az, y, cos az] frame and the gap between the
    // other two centres on the SE diagonal — the arch void faces the lens.
    expect(meta.ribAzimuths).toHaveLength(3);
    const nw = (5 * Math.PI) / 4;
    expect(meta.ribAzimuths.some((a) => Math.abs(a - nw) < 1e-9)).toBe(true);
    const sorted = [...meta.ribAzimuths].sort((a, b) => a - b);
    expect(sorted[1]! - sorted[0]!).toBeCloseTo((2 * Math.PI) / 3, 9);
    expect(sorted[2]! - sorted[1]!).toBeCloseTo((2 * Math.PI) / 3, 9);
  });
  it('the emissive pod-ring band sits on the main pod', () => {
    expect(meta.ringMinY).toBeGreaterThanOrEqual(meta.podBottomY - 1e-6);
    expect(meta.ringMaxY).toBeLessThanOrEqual(meta.podTopY + 1e-6);
    const ringCenter = (meta.ringMinY + meta.ringMaxY) / 2;
    expect(Math.abs(ringCenter - meta.podCenterY)).toBeLessThanOrEqual(0.02 * H_CN);
  });
  it('shaft camera-volume hints (Phase 36) tile base-top → pod-bottom with tapering radii', () => {
    const bands = meta.shaftColliders;
    expect(bands).toHaveLength(5);
    // Contiguous coverage: first band picks up where the base collider hint's footprint logic
    // hands over (legTopY), last band ends at the pod bottom, no gaps between bands.
    expect(bands[0]!.centerY - bands[0]!.halfHeight).toBeCloseTo(meta.legTopY, 6);
    expect(bands[bands.length - 1]!.centerY + bands[bands.length - 1]!.halfHeight).toBeCloseTo(meta.podBottomY, 6);
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i]!.centerY - bands[i]!.halfHeight).toBeCloseTo(
        bands[i - 1]!.centerY + bands[i - 1]!.halfHeight,
        6,
      );
    }
    // Each band's radius follows the taper: strictly decreasing, never wider than the base
    // collider, always wider than nothing — so a box tightly contains its own band's concrete.
    for (let i = 0; i < bands.length; i++) {
      expect(bands[i]!.radius).toBeGreaterThan(0);
      expect(bands[i]!.radius).toBeLessThanOrEqual(meta.collider.radius);
      if (i > 0) expect(bands[i]!.radius).toBeLessThan(bands[i - 1]!.radius);
    }
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

// The v2 features are geometry, not metadata: every pin below reads the actual vertex buffer, so a
// builder that kept the meta honest while dropping the arches/ribs/channel still fails.
describe('CN Tower v2 — the features are in the MESH (vertex probes, Phase 43)', () => {
  const { geometry, meta } = buildCnTowerGeometry();
  const pos = geometry.attributes.position;
  const col = geometry.attributes.color;
  const radialAt = (i: number) => Math.hypot(pos.getX(i), pos.getZ(i));
  /** Azimuth in the builder's own frame ([sin az, y, cos az]), normalized to [0, 2π). */
  const azimuthAt = (i: number) => {
    const a = Math.atan2(pos.getX(i), pos.getZ(i));
    return a < 0 ? a + Math.PI * 2 : a;
  };
  const angDist = (a: number, b: number) => {
    const d = Math.abs(a - b) % (Math.PI * 2);
    return d > Math.PI ? Math.PI * 2 - d : d;
  };
  const ribGap = (i: number) => Math.min(...meta.ribAzimuths.map((r) => angDist(azimuthAt(i), r)));
  const maxRadialWhere = (keep: (i: number) => boolean) => {
    let max = -Infinity;
    for (let i = 0; i < pos.count; i++) if (keep(i)) max = Math.max(max, radialAt(i));
    return max;
  };

  it('the legs splay to the footprint but never out of the base collider', () => {
    // §5's ⌀21 footprint IS the leg splay's envelope, and the base cylinder collider is 10.5 —
    // anything poking past it would be visibly un-hittable concrete.
    const legBand = maxRadialWhere((i) => pos.getY(i) <= meta.legTopY);
    expect(legBand).toBeLessThanOrEqual(meta.collider.radius + 1e-6);
    // …and it must actually REACH out there: a shaft that just went straight down would pass the
    // bound above trivially.
    expect(legBand).toBeGreaterThan(0.9 * meta.collider.radius);
  });

  it('three ribs stand proud of the hex core (the flutes exist)', () => {
    // At the merge height the mesh has both a fin ring and the shaft's bottom ring, so this
    // compares like with like: the widest thing AT a rib azimuth vs the widest thing well away
    // from every rib (the hex corners). A rib-less taper would make the two equal.
    const inBand = (i: number) => Math.abs(pos.getY(i) - meta.legTopY) <= 0.05;
    const atRib = maxRadialWhere((i) => inBand(i) && ribGap(i) < 0.14); // within ~8°
    const betweenRibs = maxRadialWhere((i) => inBand(i) && ribGap(i) > 0.44); // more than ~25° off
    expect(betweenRibs).toBeGreaterThan(0);
    expect(atRib).toBeGreaterThan(betweenRibs + 0.5);
  });

  it('every shaft camera-volume band covers its own concrete INCLUDING the rib crest', () => {
    // Phase 36's see-through fix depends on these boxes containing the mesh; Phase 43 widened the
    // mesh with ribs, so the boxes have to have grown with it.
    for (const band of meta.shaftColliders) {
      const y0 = band.centerY - band.halfHeight;
      const y1 = band.centerY + band.halfHeight;
      const widest = maxRadialWhere((i) => pos.getY(i) >= y0 - 1e-4 && pos.getY(i) <= y1 + 1e-4);
      expect(widest).toBeLessThanOrEqual(band.radius + 1e-3);
    }
    // The first band's radius is the crest, not the core: it must exceed the hex core's own
    // circumradius at the merge (7 wu) by the rib depth.
    expect(meta.shaftColliders[0]!.radius).toBeGreaterThan(8);
  });

  it('the LED ring sits in a RECESSED channel, sheltered by lips above and below', () => {
    expect(meta.ringChannel.minY).toBeCloseTo(meta.ringMinY, 9);
    expect(meta.ringChannel.maxY).toBeCloseTo(meta.ringMaxY, 9);
    // Both lip rings live at exactly the channel's own y (the step is a flat annulus), so the
    // cheapest honest probe is: at each end of the band the mesh is WIDER than the channel floor.
    for (const y of [meta.ringMinY, meta.ringMaxY]) {
      const lip = maxRadialWhere((i) => Math.abs(pos.getY(i) - y) <= 1e-3);
      expect(lip).toBeGreaterThan(meta.ringChannel.radius + 0.2);
    }
    // …and the emissive band's own vertices really are at the recessed radius.
    let onChannel = 0;
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(radialAt(i) - meta.ringChannel.radius) <= 2e-3) onChannel++;
    }
    expect(onChannel).toBeGreaterThan(0);
  });

  it('a red beacon stub caps the needle', () => {
    let found = false;
    for (let i = 0; i < pos.count && !found; i++) {
      const y = pos.getY(i);
      if (y < meta.beaconTipY - 2) continue;
      const r = col.getX(i);
      const g = col.getY(i);
      const b = col.getZ(i);
      if (r > 0.4 && r > 2 * g && r > 2 * b) found = true;
    }
    expect(found).toBe(true);
    expect(meta.beaconTipY).toBeLessThanOrEqual(meta.needleMaxY + 1e-9);
    expect(meta.beaconTipY).toBeGreaterThan(meta.needleMinY);
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
