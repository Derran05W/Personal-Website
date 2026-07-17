// TDD-first: authored from TORONTO-MAP-SPEC-v2.md §3c (the height-compression power curve)
// and the §3 test list BEFORE heightCurve.ts existed. The data-driven cases read
// data/toronto/building-specs.json off disk; if that file is absent when this runs (it is
// authored by a concurrent agent), those cases are skipped rather than failing.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COEFFICIENT,
  EXPONENT,
  SHADOW_FACTOR,
  hGame,
  shadowWu,
} from './heightCurve';

interface BuildingSpec {
  id: string;
  real_h_m: number;
  expected_game_h_wu: number;
  footprint_wu?: number;
}
interface BuildingSpecsFile {
  buildings: BuildingSpec[];
}

const specsPath = resolve(process.cwd(), 'data/toronto/building-specs.json');
const specsPresent = existsSync(specsPath);
const specs: BuildingSpec[] = specsPresent
  ? (JSON.parse(readFileSync(specsPath, 'utf-8')) as BuildingSpecsFile).buildings
  : [];

describe('heightCurve — constants (spec §3c)', () => {
  it('exposes the §3c curve constants', () => {
    expect(COEFFICIENT).toBe(2.05);
    expect(EXPONENT).toBe(0.6);
    expect(SHADOW_FACTOR).toBe(0.35);
  });

  it('shadowWu is a fixed fraction of game height', () => {
    expect(shadowWu(40)).toBeCloseTo(0.35 * 40, 10);
    expect(shadowWu(hGame(553.3))).toBeCloseTo(0.35 * hGame(553.3), 10);
  });
});

describe('heightCurve — hGame(real_m) = 2.05·real^0.6', () => {
  it('is strictly monotonic over (0, 600]', () => {
    let prev = -Infinity;
    for (let m = 1; m <= 600; m += 1) {
      const h = hGame(m);
      expect(h).toBeGreaterThan(prev);
      prev = h;
    }
  });

  it('maps the CN Tower to ~91 wu and never exceeds the 100 wu cap', () => {
    expect(hGame(553.3)).toBeGreaterThan(90);
    expect(Math.abs(hGame(553.3) - 91)).toBeLessThanOrEqual(1);
    expect(hGame(553.3)).toBeLessThanOrEqual(100);
  });

  it('collapses the CN:shop ratio to ~10× (vs ~46× linear) — the §3c intent', () => {
    const ratio = hGame(553.3) / hGame(12);
    expect(Math.abs(ratio - 10)).toBeLessThanOrEqual(0.5);
    // Linear scaling would give the raw metre ratio, ~46× — proving the curve does its job.
    expect(553.3 / 12).toBeGreaterThan(45);
  });
});

describe.runIf(specsPresent)('heightCurve — building-specs.json cross-check (single source)', () => {
  it('every skyline row: expected_game_h_wu within ±1.5 of hGame(real_h_m)', () => {
    expect(specs.length).toBeGreaterThan(0);
    for (const b of specs) {
      expect(Math.abs(b.expected_game_h_wu - hGame(b.real_h_m))).toBeLessThanOrEqual(1.5);
    }
  });

  it('CN Tower is the tallest game height in the catalogue', () => {
    const cn = specs.find((b) => b.id === 'cn-tower');
    expect(cn).toBeDefined();
    const maxH = Math.max(...specs.map((b) => hGame(b.real_h_m)));
    expect(hGame(cn!.real_h_m)).toBe(maxH);
  });

  it('footprint rule real_m/1.55×0.5 — skipped: no real-footprint-metre input in the file', () => {
    // building-specs.json carries footprint_wu (the OUTPUT) but no real-world footprint metre
    // input, so §3b's real_m/1.55×0.5 rule has nothing to re-derive from here. Documented as a
    // deliberate no-op; footprints are validated where their metre inputs live (Phase 22+).
    const hasFootprintInputs = specs.some(
      (b) => (b as { footprint_m?: number }).footprint_m !== undefined,
    );
    expect(hasFootprintInputs).toBe(false);
  });
});
