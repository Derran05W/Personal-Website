// Phase 45 — pure tests for the Rogers Centre night-program config (config/rogersCentre.ts). Pins
// the LAW, not the literals, exactly as config/cnTower.test.ts does for the tower: table shape,
// parseable colours, positive weights (so no scheme can silently starve), the blue-hour legibility
// rule, and the two things that make this leaf different from CN's — the board must stay QUIETER
// than the tower's hero ring, and the blackout fade must actually dim.
import { describe, expect, it } from 'vitest';
import { CN_TOWER } from './cnTower';
import { ROGERS_CENTRE } from './rogersCentre';

const HEX6 = /^#[0-9a-fA-F]{6}$/;

describe('ROGERS_CENTRE — jumbotron scheme table', () => {
  it('schemes and schemeWeights are the same length', () => {
    expect(ROGERS_CENTRE.jumbotron.schemeWeights).toHaveLength(ROGERS_CENTRE.jumbotron.schemes.length);
  });

  it('every scheme has exactly 3 parseable colour blocks', () => {
    for (const s of ROGERS_CENTRE.jumbotron.schemes) {
      expect(s.blocks).toHaveLength(3);
      for (const hex of s.blocks) expect(hex).toMatch(HEX6);
    }
  });

  it('every scheme name is unique and every weight is positive', () => {
    const names = ROGERS_CENTRE.jumbotron.schemes.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const w of ROGERS_CENTRE.jumbotron.schemeWeights) expect(w).toBeGreaterThan(0);
  });

  it('no block is deep blue — a deep-blue board on a blue-hour sky is an invisible board', () => {
    // Same legibility rule cnTower.ts's palettes follow (the time of day is LOCKED to blue hour).
    for (const s of ROGERS_CENTRE.jumbotron.schemes) {
      for (const hex of s.blocks) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        const blueDominant = b > r + 40 && b > g + 40;
        expect(blueDominant && Math.max(r, g) < 120).toBe(false);
      }
    }
  });
});

describe('ROGERS_CENTRE — brightness sits UNDER the CN Tower (the tower is the hero light)', () => {
  it('the board peaks below the tower ring\'s steady brightness', () => {
    const boardPeak = ROGERS_CENTRE.jumbotron.baseIntensity + ROGERS_CENTRE.jumbotron.bandBoost;
    expect(ROGERS_CENTRE.jumbotron.baseIntensity).toBeLessThan(CN_TOWER.ring.solidIntensity);
    expect(boardPeak).toBeLessThanOrEqual(CN_TOWER.ring.pulseMaxIntensity);
  });

  it('the gate and hotel washes are subtler still', () => {
    expect(ROGERS_CENTRE.gates.intensity).toBeLessThan(ROGERS_CENTRE.jumbotron.baseIntensity);
    expect(ROGERS_CENTRE.hotel.intensity).toBeLessThan(ROGERS_CENTRE.jumbotron.baseIntensity);
    expect(ROGERS_CENTRE.gates.color).toMatch(HEX6);
    expect(ROGERS_CENTRE.hotel.color).toMatch(HEX6);
  });
});

describe('ROGERS_CENTRE — animation periods and the band', () => {
  it('every period is a positive, human-readable number of milliseconds', () => {
    expect(ROGERS_CENTRE.jumbotron.scrollPeriodMs).toBeGreaterThan(500);
    expect(ROGERS_CENTRE.jumbotron.bandPeriodMs).toBeGreaterThan(500);
    // Slower than a strobe: the board reads as a board, never as a flicker source (Phase 42).
    expect(ROGERS_CENTRE.jumbotron.bandPeriodMs).toBeGreaterThan(1000);
  });

  it('the sweeping band is a band, not the whole board', () => {
    expect(ROGERS_CENTRE.jumbotron.bandWidth).toBeGreaterThan(0);
    expect(ROGERS_CENTRE.jumbotron.bandWidth).toBeLessThan(0.5);
  });
});

describe('ROGERS_CENTRE — the blackout (the ONE place Rogers differs from CN by policy)', () => {
  it('the fade is long enough to read on camera and short enough to finish', () => {
    expect(ROGERS_CENTRE.blackout.fadeMs).toBeGreaterThanOrEqual(500);
    expect(ROGERS_CENTRE.blackout.fadeMs).toBeLessThanOrEqual(5000);
  });

  it('the floor really dims (a lit stadium next to a dark skyline would dilute DARK CITY)', () => {
    expect(ROGERS_CENTRE.blackout.floor).toBeGreaterThan(0); // standby lighting, not a hole
    expect(ROGERS_CENTRE.blackout.floor).toBeLessThan(0.15);
  });
});
