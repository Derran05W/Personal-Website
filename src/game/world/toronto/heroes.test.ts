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
import {
  buildCnTowerGeometry,
  buildRogersGeometry,
  CN_PROGRAM,
  CN_TOWER_MAX_TRIS,
  ROGERS_EMISS_T,
  ROGERS_MAX_TRIS,
} from './heroes';

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

describe('CN Tower hero mesh — the pod ring is the night program\'s LED channel (Phase 44)', () => {
  // PIN MOVED AT PHASE 44 (was: "has a vivid red-dominant BRIGHT vertex inside the ring band").
  // v1 baked the ring's light into the vertex colours, which made it light no palette, mode or
  // program state could ever turn off; the channel is now baked as a DARK HOUSING and tagged
  // RING, so the same claim ("the ring is the tower's light") is asserted one layer over: the
  // band's vertices carry the RING element and a per-cell parametric coord for the shader to
  // discretize. T2 owns the deeper program-attribute probes.
  it('the ring band is tagged RING, dark-baked, with one flat aProgramT per LED cell', () => {
    const { geometry, meta } = buildCnTowerGeometry();
    const pos = geometry.attributes.position;
    const col = geometry.attributes.color;
    const program = geometry.attributes.aProgram;
    const programT = geometry.attributes.aProgramT;
    const eps = 0.05; // float32 rounding at y≈55 wu is ~3e-6; slop for the band edges
    const cells = new Set<number>();
    let ringVerts = 0;
    for (let i = 0; i < pos.count; i++) {
      if (program.getX(i) !== CN_PROGRAM.RING) continue;
      ringVerts++;
      const y = pos.getY(i);
      expect(y).toBeGreaterThanOrEqual(meta.ringMinY - eps);
      expect(y).toBeLessThanOrEqual(meta.ringMaxY + eps);
      // Dark housing: nothing in the channel is baked bright any more.
      expect(Math.max(col.getX(i), col.getY(i), col.getZ(i))).toBeLessThan(0.1);
      cells.add(Math.floor(programT.getX(i) * meta.ringCells));
    }
    expect(ringVerts).toBeGreaterThan(0);
    // Every LED cell present exactly once, spanning the whole ring.
    expect(cells.size).toBe(meta.ringCells);
  });
});

// --- Phase 44: night-program attribute plumbing (T1's aProgram/aProgramT pair) -----------------
// T1 built these; T2 (this file) only writes the tests around them. Every probe reads the actual
// vertex buffers, matching the "features are geometry, not metadata" rule the rest of this file
// already follows for the v2 mesh itself.
describe('night-program vertex attributes exist on both heroes (Phase 44)', () => {
  it('CN geometry carries aProgram/aProgramT, one value per vertex', () => {
    const { geometry } = buildCnTowerGeometry();
    const pos = geometry.attributes.position;
    const program = geometry.attributes.aProgram;
    const programT = geometry.attributes.aProgramT;
    expect(program).toBeDefined();
    expect(programT).toBeDefined();
    expect(program.count).toBe(pos.count);
    expect(programT.count).toBe(pos.count);
  });

  it('Rogers carries the same pair, one value per vertex (Phase 45: it has a program of its own)', () => {
    // PIN MOVED AT PHASE 45 (was: "every Rogers vertex is STATIC"). The stadium now runs its own
    // night program — the south LED board and the gate/hotel emissives — off the same two
    // attributes and the same alphabet, so "untagged" is no longer the claim. What still holds,
    // and is asserted by the census below, is that Rogers carries ONLY its own ids (5/6) plus
    // STATIC: none of CN's ring/beacon/crest/flood tags leak onto it.
    const { geometry } = buildRogersGeometry();
    const pos = geometry.attributes.position;
    const program = geometry.attributes.aProgram;
    const programT = geometry.attributes.aProgramT;
    expect(program.count).toBe(pos.count);
    expect(programT.count).toBe(pos.count);
  });
});

describe('Rogers night-program element census (Phase 45)', () => {
  const { geometry, meta } = buildRogersGeometry();
  const pos = geometry.attributes.position;
  const program = geometry.attributes.aProgram;
  const programT = geometry.attributes.aProgramT;
  const counts = new Map<number, number>();
  for (let i = 0; i < program.count; i++) {
    const id = program.getX(i);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const get = (id: number) => counts.get(id) ?? 0;

  it('carries exactly STATIC + JUMBO + EMISS — no CN element ever leaks onto the stadium', () => {
    expect([...counts.keys()].sort((a, b) => a - b)).toEqual([
      CN_PROGRAM.STATIC,
      CN_PROGRAM.JUMBO,
      CN_PROGRAM.EMISS,
    ]);
    expect(get(CN_PROGRAM.STATIC)).toBeGreaterThan(get(CN_PROGRAM.JUMBO) + get(CN_PROGRAM.EMISS));
    expect(get(CN_PROGRAM.STATIC) + get(CN_PROGRAM.JUMBO) + get(CN_PROGRAM.EMISS)).toBe(program.count);
  });

  it('JUMBO is exactly the board: one flat aProgramT per column, all of it inside the panel bounds', () => {
    const board = meta.jumbotron;
    // 12 columns × 6 verts per column quad-pair (structural, not a guess — the ring-cell idiom).
    expect(get(CN_PROGRAM.JUMBO)).toBe(board.cells * 6);
    expect(meta.jumboCells).toBe(board.cells);
    const centres = Array.from({ length: board.cells }, (_, i) => (i + 0.5) / board.cells);
    const cells = new Set<number>();
    for (let i = 0; i < program.count; i++) {
      if (program.getX(i) !== CN_PROGRAM.JUMBO) continue;
      // Every board vertex sits ON the panel plane and inside its rectangle…
      expect(pos.getZ(i)).toBeCloseTo(board.z, 4); // float32 buffer: ~1e-6 at z ≈ 34
      expect(pos.getX(i)).toBeGreaterThanOrEqual(board.minX - 1e-6);
      expect(pos.getX(i)).toBeLessThanOrEqual(board.maxX + 1e-6);
      expect(pos.getY(i)).toBeGreaterThanOrEqual(board.minY - 1e-6);
      expect(pos.getY(i)).toBeLessThanOrEqual(board.maxY + 1e-6);
      // …and carries one of the exact column-centre fractions (flat per column: an interpolated
      // coord would put a discretization seam inside every block).
      const t = programT.getX(i);
      expect(Math.min(...centres.map((c) => Math.abs(c - t)))).toBeLessThan(1e-6);
      cells.add(Math.floor(t * board.cells));
    }
    expect(cells.size).toBe(board.cells);
  });

  it('the board is baked DARK — the light is the program, not the vertex colour', () => {
    const col = geometry.attributes.color;
    for (let i = 0; i < program.count; i++) {
      if (program.getX(i) !== CN_PROGRAM.JUMBO) continue;
      expect(Math.max(col.getX(i), col.getY(i), col.getZ(i))).toBeLessThan(0.1);
    }
  });

  it('EMISS splits into gate lintels (t=0) and hotel windows (t=1), each where its feature is', () => {
    const azOf = (i: number) => {
      const a = Math.atan2(pos.getX(i), pos.getZ(i));
      return a < 0 ? a + Math.PI * 2 : a;
    };
    const angDist = (a: number, b: number) => {
      const d = Math.abs(a - b) % (Math.PI * 2);
      return d > Math.PI ? Math.PI * 2 - d : d;
    };
    let gateVerts = 0;
    let hotelVerts = 0;
    for (let i = 0; i < program.count; i++) {
      if (program.getX(i) !== CN_PROGRAM.EMISS) continue;
      const t = programT.getX(i);
      expect([ROGERS_EMISS_T.gate, ROGERS_EMISS_T.hotel]).toContain(t);
      if (t === ROGERS_EMISS_T.gate) {
        gateVerts++;
        // In the lintel band, and at one of the five gate azimuths.
        expect(pos.getY(i)).toBeGreaterThanOrEqual(meta.gates.glowMinY - 1e-6);
        expect(pos.getY(i)).toBeLessThanOrEqual(meta.gates.glowMaxY + 1e-6);
        const nearest = Math.min(...meta.gates.azimuths.map((g) => angDist(azOf(i), g)));
        expect(nearest).toBeLessThan(0.12); // the bay is ±2.6 wu ≈ ±4.5° at r 33
      } else {
        hotelVerts++;
        // In the hotel band's height range, on the NORTH arc, standing proud of the shell.
        expect(pos.getY(i)).toBeGreaterThanOrEqual(meta.hotel.minY - 1e-6);
        expect(pos.getY(i)).toBeLessThanOrEqual(meta.hotel.maxY + 1e-6);
        expect(azOf(i)).toBeGreaterThanOrEqual(meta.hotel.minAz - 1e-6);
        expect(azOf(i)).toBeLessThanOrEqual(meta.hotel.maxAz + 1e-6);
        expect(pos.getZ(i)).toBeLessThan(0); // −Z is map NORTH (projection.ts)
        expect(Math.hypot(pos.getX(i), pos.getZ(i))).toBeCloseTo(meta.hotel.radius, 4);
      }
    }
    // Five gates × 36 verts (a 6-quad box each), and SOME but not all of the 12 hotel rooms lit.
    expect(gateVerts).toBe(meta.gates.azimuths.length * 36);
    expect(hotelVerts).toBeGreaterThan(0);
    expect(hotelVerts).toBeLessThan(12 * 6);
  });
});

// The v2 features are geometry, not metadata — same rule as the CN v2 probes above.
describe('Rogers Centre v2 — the features are in the MESH (vertex probes, Phase 45)', () => {
  const { geometry, meta } = buildRogersGeometry();
  const pos = geometry.attributes.position;
  const radialAt = (i: number) => Math.hypot(pos.getX(i), pos.getZ(i));
  const azOf = (i: number) => Math.atan2(pos.getX(i), pos.getZ(i)); // (−π, π], 0 = SOUTH
  const maxRadialWhere = (keep: (i: number) => boolean) => {
    let max = -Infinity;
    for (let i = 0; i < pos.count; i++) if (keep(i)) max = Math.max(max, radialAt(i));
    return max;
  };

  it('every band boundary carries a proud SEAM LIP (the roof reads as panels, not a shell)', () => {
    // At each internal band top the mesh must be WIDER than the profile radius there — that extra
    // is the lip. Measured away from the slide sector and the ribs so only the lip can explain it.
    const fixedAz = (i: number) => Math.abs(azOf(i)) > meta.slideSector.halfAngle + 0.1;
    for (let b = 0; b < meta.domeBands.length - 1; b++) {
      const band = meta.domeBands[b]!;
      const widest = maxRadialWhere((i) => Math.abs(pos.getY(i) - band.maxY) <= 1e-3 && fixedAz(i));
      expect(widest).toBeGreaterThan(band.radius + 0.2);
      expect(widest).toBeLessThan(band.radius + 1); // a lip, not a shelf
    }
  });

  it('the retractable sector rides PROUD of the fixed shell (the nesting read)', () => {
    const band = meta.domeBands[0]!;
    const atY = (i: number) => Math.abs(pos.getY(i) - band.minY) <= 1e-3;
    const inSector = maxRadialWhere((i) => atY(i) && Math.abs(azOf(i)) < meta.slideSector.halfAngle - 0.05);
    const outside = maxRadialWhere((i) => atY(i) && Math.abs(azOf(i)) > meta.slideSector.halfAngle + 0.05);
    expect(outside).toBeGreaterThan(0);
    expect(inSector).toBeGreaterThan(outside + meta.slideSector.lift - 1e-6);
    expect(meta.slideSector.lift).toBeGreaterThan(0.2);
  });

  it('the sector straddles SOUTH and is about a quarter of the dome (panels stack toward the north)', () => {
    // South (+Z, azimuth 0) is a camera-visible face; the fixed panel is the north half by
    // construction, which is what the researcher round describes (3 panels slide S→N and nest
    // under a fixed north panel).
    expect(meta.slideSector.halfAngle).toBeGreaterThan(Math.PI / 5);
    expect(meta.slideSector.halfAngle).toBeLessThan(Math.PI / 3);
  });

  it('the ring base is articulated: piers stand proud, gate bays sit back between them', () => {
    const inRing = (i: number) => pos.getY(i) > 0.5 && pos.getY(i) < meta.ringBaseTopY - 0.2;
    const domeR = meta.domeDiameter / 2;
    const widest = maxRadialWhere(inRing);
    expect(widest).toBeGreaterThan(domeR + 0.4); // the piers
    // …and at a gate azimuth the mesh is barely past the wall — the bay reads recessed.
    const gateAz = meta.gates.azimuths[0]!;
    const nearGate = maxRadialWhere(
      (i) => inRing(i) && Math.abs(Math.atan2(pos.getX(i), pos.getZ(i)) - gateAz) < 0.03,
    );
    expect(nearGate).toBeLessThan(widest - 0.2);
  });

  it('two helix ramps wrap the wall band, clear of the gates below and the rails above', () => {
    for (const ramp of meta.ramps) {
      expect(ramp.minY).toBeGreaterThan(meta.gates.glowMaxY); // nothing to crash into below
      expect(ramp.maxY).toBeLessThan(meta.domeBands[0]!.maxY); // the ribs start above this band
      expect(ramp.maxAz - ramp.minAz).toBeGreaterThan(Math.PI / 4); // an actual spiral, not a stub
    }
    expect(meta.ramps).toHaveLength(2);
    // The ribbons stand proud of the shell at their own heights (they are outside geometry).
    const domeR = meta.domeDiameter / 2;
    const rampBand = maxRadialWhere((i) => pos.getY(i) > 5 && pos.getY(i) < 10.6);
    expect(rampBand).toBeGreaterThan(domeR + 1.5);
  });

  it('nothing the CAR can reach pokes outside the ring-base collider', () => {
    // The collider class is unchanged from v1 (§5's ring-base cylinder), so every new element must
    // either sit inside its radius or start above the height a car can touch.
    const REACHABLE_Y = 4;
    const widestLow = maxRadialWhere((i) => pos.getY(i) <= REACHABLE_Y);
    expect(widestLow).toBeLessThanOrEqual(meta.collider.radius + 0.6); // piers, 0.55 proud
    expect(meta.collider.radius).toBeCloseTo(meta.domeDiameter / 2, 9);
  });
});

describe('CN night-program element census — sanity, not brittle totals (Phase 44)', () => {
  const { geometry, meta } = buildCnTowerGeometry();
  const program = geometry.attributes.aProgram;
  const counts = new Map<number, number>();
  for (let i = 0; i < program.count; i++) {
    const id = program.getX(i);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const get = (id: number) => counts.get(id) ?? 0;

  it('every CN element class (STATIC/RING/BEACON/CREST/FLOOD) is present — and no Rogers id is', () => {
    // Phase 45 turned the alphabet hero-wide, so this can no longer loop Object.values(CN_PROGRAM):
    // JUMBO/EMISS belong to the stadium. Listing CN's own five and asserting the other two are
    // ABSENT is strictly stronger than the old loop — it pins the split, not just the presence.
    for (const id of [CN_PROGRAM.STATIC, CN_PROGRAM.RING, CN_PROGRAM.BEACON, CN_PROGRAM.CREST, CN_PROGRAM.FLOOD]) {
      expect(get(id)).toBeGreaterThan(0);
    }
    expect(get(CN_PROGRAM.JUMBO)).toBe(0);
    expect(get(CN_PROGRAM.EMISS)).toBe(0);
  });

  it('RING is exactly 96 vertices — 16 cells × 6 verts per cell quad-pair (structural, not a guess)', () => {
    expect(get(CN_PROGRAM.RING)).toBe(96);
    expect(meta.ringCells).toBe(16);
  });

  it('relative sizes are plausible: STATIC > FLOOD > CREST > BEACON > RING, and the classes sum to every vertex', () => {
    const staticCount = get(CN_PROGRAM.STATIC);
    const ring = get(CN_PROGRAM.RING);
    const beacon = get(CN_PROGRAM.BEACON);
    const crest = get(CN_PROGRAM.CREST);
    const flood = get(CN_PROGRAM.FLOOD);
    expect(staticCount).toBeGreaterThan(flood);
    expect(flood).toBeGreaterThan(crest);
    expect(crest).toBeGreaterThan(beacon);
    expect(beacon).toBeGreaterThan(ring);
    expect(staticCount + ring + beacon + crest + flood).toBe(program.count);
  });

  it('meta.ringCells matches the census and meta.finTopY sits between the leg merge and the pod', () => {
    expect(meta.ringCells).toBe(16);
    expect(meta.finTopY).toBeGreaterThan(meta.legTopY);
    expect(meta.finTopY).toBeLessThan(meta.podTopY + 2);
  });
});

describe('CN night-program — RING vertex probes (Phase 44)', () => {
  const { geometry, meta } = buildCnTowerGeometry();
  const col = geometry.attributes.color;
  const program = geometry.attributes.aProgram;
  const programT = geometry.attributes.aProgramT;

  it('every ring vertex sits at one of the 16 flat LED-cell centre fractions', () => {
    const centres = Array.from({ length: meta.ringCells }, (_, i) => (i + 0.5) / meta.ringCells);
    let ringVerts = 0;
    for (let i = 0; i < program.count; i++) {
      if (program.getX(i) !== CN_PROGRAM.RING) continue;
      ringVerts++;
      const t = programT.getX(i);
      const closest = Math.min(...centres.map((c) => Math.abs(c - t)));
      expect(closest).toBeLessThan(1e-6);
    }
    expect(ringVerts).toBe(96);
  });

  it('the ring band is baked DARK — the program supplies the light now, not the vertex colour', () => {
    let ringVerts = 0;
    for (let i = 0; i < program.count; i++) {
      if (program.getX(i) !== CN_PROGRAM.RING) continue;
      ringVerts++;
      expect(Math.max(col.getX(i), col.getY(i), col.getZ(i))).toBeLessThan(0.35);
    }
    expect(ringVerts).toBeGreaterThan(0);
  });
});

describe('CN night-program — BEACON fixture probes (Phase 44)', () => {
  const { geometry, meta } = buildCnTowerGeometry();
  const pos = geometry.attributes.position;
  const program = geometry.attributes.aProgram;
  const radialAt = (i: number) => Math.hypot(pos.getX(i), pos.getZ(i));

  it('meta.beaconFixtures describes exactly 4 pod-corner strobes', () => {
    expect(meta.beaconFixtures).toHaveLength(4);
  });

  it('the pod-corner strobes stand proud of the mechanical ring lip (not coplanar with it)', () => {
    // The lip's own radius, derived from the geometry the same way the pre-existing "recessed
    // channel" test above does: the flat annulus step at ringMaxY IS the mechanical ring's lip.
    let lipRadius = 0;
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getY(i) - meta.ringMaxY) <= 1e-3) lipRadius = Math.max(lipRadius, radialAt(i));
    }
    expect(lipRadius).toBeGreaterThan(0);

    const fixture = meta.beaconFixtures[0]!;
    let maxBeaconRadiusInBand = -Infinity;
    for (let i = 0; i < program.count; i++) {
      if (program.getX(i) !== CN_PROGRAM.BEACON) continue;
      const y = pos.getY(i);
      if (y < fixture.y0 - 1e-6 || y > fixture.y1 + 1e-6) continue; // excludes the needle-tip beacon
      maxBeaconRadiusInBand = Math.max(maxBeaconRadiusInBand, radialAt(i));
    }
    expect(maxBeaconRadiusInBand).toBeGreaterThan(lipRadius);
  });

  it('the needle-tip stub is still BEACON-tagged', () => {
    let found = false;
    for (let i = 0; i < program.count; i++) {
      if (program.getX(i) !== CN_PROGRAM.BEACON) continue;
      if (pos.getY(i) >= meta.needleMinY) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});

describe('CN night-program — CREST/FLOOD parametric probes (Phase 44)', () => {
  const { geometry, meta } = buildCnTowerGeometry();
  const pos = geometry.attributes.position;
  const program = geometry.attributes.aProgram;
  const programT = geometry.attributes.aProgramT;

  it('CREST t stays within [0,1] and increases with height', () => {
    const samples: { y: number; t: number }[] = [];
    for (let i = 0; i < program.count; i++) {
      if (program.getX(i) !== CN_PROGRAM.CREST) continue;
      const t = programT.getX(i);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
      samples.push({ y: pos.getY(i), t });
    }
    expect(samples.length).toBeGreaterThan(0);
    samples.sort((a, b) => a.y - b.y);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!.t).toBeGreaterThanOrEqual(samples[i - 1]!.t - 1e-6);
    }
    expect(samples[samples.length - 1]!.t).toBeGreaterThan(samples[0]!.t);
  });

  it('FLOOD t is ~1 at the ground and 0 at/above the leg merge (legTopY)', () => {
    const atGround: number[] = [];
    const atOrAboveMerge: number[] = [];
    for (let i = 0; i < program.count; i++) {
      if (program.getX(i) !== CN_PROGRAM.FLOOD) continue;
      const y = pos.getY(i);
      const t = programT.getX(i);
      if (y <= 0.05) atGround.push(t);
      if (y >= meta.legTopY - 1e-6) atOrAboveMerge.push(t);
    }
    expect(atGround.length).toBeGreaterThan(0);
    expect(atOrAboveMerge.length).toBeGreaterThan(0);
    for (const t of atGround) expect(t).toBeGreaterThan(0.9);
    for (const t of atOrAboveMerge) expect(t).toBeCloseTo(0, 5);
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

describe('Rogers Centre hero mesh — tri budget (A.3, re-pinned at Phase 45: ≤ 1,500)', () => {
  const { geometry, meta } = buildRogersGeometry();
  it('is within the 1,500-triangle budget', () => {
    expect(meta.triangles).toBeLessThanOrEqual(ROGERS_MAX_TRIS);
    expect(ROGERS_MAX_TRIS).toBe(1500);
  });
  it('actually spends the budget — this is v2, not a token pass', () => {
    // The v1 mesh was 240 tris: a plain cylinder plus a 4-band cap. A regression that quietly
    // reverted the panelized dome / slide sector / gates / board / ramps would still pass every
    // proportion pin below, so the FLOOR is a test too (the CN v2 precedent above).
    expect(meta.triangles).toBeGreaterThan(900);
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
  it('CN Tower night-program attributes (aProgram/aProgramT) are byte-identical on repeat (Phase 44)', () => {
    const a = buildCnTowerGeometry().geometry;
    const b = buildCnTowerGeometry().geometry;
    expect(Array.from(a.attributes.aProgram.array)).toEqual(Array.from(b.attributes.aProgram.array));
    expect(Array.from(a.attributes.aProgramT.array)).toEqual(Array.from(b.attributes.aProgramT.array));
  });
  it('Rogers night-program attributes are byte-identical on repeat too (Phase 45)', () => {
    // The lit-room pattern is a fixed arithmetic rule, NOT an rng roll — this is the test that
    // would catch someone "improving" it with a seeded shuffle inside a per-process builder.
    const a = buildRogersGeometry().geometry;
    const b = buildRogersGeometry().geometry;
    expect(Array.from(a.attributes.aProgram.array)).toEqual(Array.from(b.attributes.aProgram.array));
    expect(Array.from(a.attributes.aProgramT.array)).toEqual(Array.from(b.attributes.aProgramT.array));
    expect(Array.from(a.attributes.color.array)).toEqual(Array.from(b.attributes.color.array));
  });
});
