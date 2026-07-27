// Phase 45 — tests for the Rogers Centre's patched material + its per-frame uniform write. Three
// things are worth pinning here and nowhere else:
//   1. the CACHE KEY is the stadium's own (sharing CN's would let three hand one hero's compiled
//      program to the other — the rule cnNightMaterial.ts's header states and this asserts);
//   2. the write is a pure function of (selection, tMs, dark) plus the fade's own accumulator, so a
//      FROZEN sim clock produces a frozen board (the Phase 42 detector's contract);
//   3. the blackout actually dims — and does it on the powergrid's real state, which is the one
//      policy difference between this hero and the CN Tower.
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { MeshBasicMaterial } from 'three';
import { ROGERS_CENTRE } from '../../config/rogersCentre';
import { gameEvents } from '../../state/events';
import { __resetGridForTest, initPowerGrid } from '../../powergrid/grid';
import { clearFlickers } from '../../powergrid/emitters';
import { buildRogersGeometry, ROGERS_EMISS_T } from './heroes';
import { resolveRogersProgram } from './rogersProgram';
import {
  createRogersNightMaterial,
  isHeroDistrictDark,
  writeRogersNightUniforms,
  type RogersNightUniforms,
} from './rogersNightMaterial';

const JUMBO_CELLS = buildRogersGeometry().meta.jumboCells;
const SELECTION = resolveRogersProgram(416);

/** Every numeric/colour uniform as plain data — the frame-to-frame comparison the freeze test needs. */
function snapshot(u: RogersNightUniforms): string {
  return JSON.stringify({
    a: u.uJumboBlockA.value.getHex(),
    b: u.uJumboBlockB.value.getHex(),
    c: u.uJumboBlockC.value.getHex(),
    cells: u.uJumboCells.value,
    scroll: u.uJumboScroll.value,
    intensity: u.uJumboIntensity.value,
    band: u.uJumboBandPhase.value,
    width: u.uJumboBandWidth.value,
    boost: u.uJumboBandBoost.value,
    gate: u.uGateIntensity.value,
    hotel: u.uHotelIntensity.value,
    dark: u.uDark.value,
    floor: u.uDarkFloor.value,
  });
}

describe('createRogersNightMaterial — its own program, never CN\'s', () => {
  it('is the unlit vertex-coloured slice every Toronto surface uses', () => {
    const { material } = createRogersNightMaterial(JUMBO_CELLS);
    expect(material.vertexColors).toBe(true);
    expect(material.toneMapped).toBe(false);
    material.dispose();
  });

  it('declares its OWN cache key (sharing CN\'s would cross-wire the two heroes\' shaders)', () => {
    const { material } = createRogersNightMaterial(JUMBO_CELLS) as { material: MeshBasicMaterial };
    const key = material.customProgramCacheKey!();
    expect(key).toBe('rogers-night-program-v1');
    expect(key).not.toContain('cn-');
    material.dispose();
  });

  it('takes its column count from the GEOMETRY, not from config', () => {
    const { uniforms } = createRogersNightMaterial(JUMBO_CELLS);
    expect(uniforms.uJumboCells.value).toBe(JUMBO_CELLS);
    expect(JUMBO_CELLS).toBeGreaterThan(1);
  });

  it('the EMISS selector values straddle the shader\'s 0.5 mix threshold', () => {
    // The patch reads `step(0.5, vProgramT)` to tell a gate lintel from a hotel window. If the two
    // tag values ever drifted to the same side of that line, every emissive on the stadium would
    // silently become one colour — a defect no geometry test would catch.
    expect(ROGERS_EMISS_T.gate).toBeLessThan(0.5);
    expect(ROGERS_EMISS_T.hotel).toBeGreaterThan(0.5);
  });
});

describe('writeRogersNightUniforms — the frame seam', () => {
  it('same tMs → byte-identical uniforms (a frozen world paints two identical frames)', () => {
    const { uniforms } = createRogersNightMaterial(JUMBO_CELLS);
    writeRogersNightUniforms(uniforms, SELECTION, 8_000, false);
    const first = snapshot(uniforms);
    for (let i = 0; i < 5; i++) writeRogersNightUniforms(uniforms, SELECTION, 8_000, false);
    expect(snapshot(uniforms)).toBe(first);
  });

  it('advancing time DOES move the board (the freeze test above is not vacuous)', () => {
    const { uniforms } = createRogersNightMaterial(JUMBO_CELLS);
    writeRogersNightUniforms(uniforms, SELECTION, 0, false);
    const first = snapshot(uniforms);
    writeRogersNightUniforms(uniforms, SELECTION, ROGERS_CENTRE.jumbotron.scrollPeriodMs / 4, false);
    expect(snapshot(uniforms)).not.toBe(first);
  });

  it('uploads the seeded scheme once and then leaves the colours alone (no per-frame allocation)', () => {
    const { uniforms } = createRogersNightMaterial(JUMBO_CELLS);
    expect(uniforms.appliedSchemeIndex).toBe(-1);
    writeRogersNightUniforms(uniforms, SELECTION, 0, false);
    expect(uniforms.appliedSchemeIndex).toBe(SELECTION.schemeIndex);
    const before = uniforms.uJumboBlockA.value;
    writeRogersNightUniforms(uniforms, SELECTION, 16, false);
    expect(uniforms.uJumboBlockA.value).toBe(before); // same Color instance, not re-set
  });

  it('the blackout fades in over the configured time and holds at fully dark', () => {
    const { uniforms } = createRogersNightMaterial(JUMBO_CELLS);
    let t = 0;
    writeRogersNightUniforms(uniforms, SELECTION, t, true);
    expect(uniforms.uDark.value).toBe(0); // first frame has no dt — no jump
    for (let i = 0; i < 200; i++) {
      t += 16.7;
      writeRogersNightUniforms(uniforms, SELECTION, t, true);
    }
    expect(uniforms.uDark.value).toBeGreaterThan(0.95);
    // …and the fade cannot run while the world is frozen (same tMs ⇒ dt 0).
    const frozen = uniforms.uDark.value;
    for (let i = 0; i < 10; i++) writeRogersNightUniforms(uniforms, SELECTION, t, false);
    expect(uniforms.uDark.value).toBe(frozen);
  });

  it('never writes a non-finite value into a uniform, whatever the clock does', () => {
    const { uniforms } = createRogersNightMaterial(JUMBO_CELLS);
    for (const t of [0, -5_000, 1e12, 42]) {
      writeRogersNightUniforms(uniforms, SELECTION, t, t > 0);
      expect(Number.isFinite(uniforms.uJumboScroll.value)).toBe(true);
      expect(Number.isFinite(uniforms.uJumboBandPhase.value)).toBe(true);
      expect(Number.isFinite(uniforms.uDark.value)).toBe(true);
      expect(uniforms.uDark.value).toBeGreaterThanOrEqual(0);
      expect(uniforms.uDark.value).toBeLessThanOrEqual(1);
    }
  });
});

describe('isHeroDistrictDark — the ONE policy difference from the CN Tower', () => {
  let teardown: (() => void) | null = null;

  beforeEach(() => {
    __resetGridForTest();
    clearFlickers();
    teardown = initPowerGrid(15); // Toronto's district count
  });

  afterEach(() => {
    teardown?.();
    teardown = null;
    __resetGridForTest();
    clearFlickers();
  });

  it('reads false while the district still has power', () => {
    expect(isHeroDistrictDark(9)).toBe(false);
  });

  it('flips the instant that district\'s transformer dies (the ground tint\'s own trigger)', () => {
    gameEvents.emit('transformerDestroyed', { districtId: 9 });
    expect(isHeroDistrictDark(9)).toBe(true);
    expect(isHeroDistrictDark(3)).toBe(false); // …and only that district
  });
});
