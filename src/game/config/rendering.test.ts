// Pure tests for the Phase 19 rendering config: the final tone-mapping/exposure resolution
// and the bounds of the mood knobs (emissive boost, lake shimmer). No three/DOM needed —
// resolveToneMapping is deliberately three-free (world/BlueHourRig.tsx maps the mode string
// to the three constant).
import { describe, expect, it } from 'vitest';
import { RENDERING, TONE_MAPPING_MODES, resolveToneMapping } from './rendering';

describe('resolveToneMapping — final exposure/tone-mapping resolution', () => {
  it('resolves the shipped config to a known mode + in-band exposure', () => {
    const r = resolveToneMapping();
    expect(TONE_MAPPING_MODES).toContain(r.mode);
    expect(r.mode).toBe('ACESFilmic'); // the blue-hour look ships on ACES
    expect(r.exposure).toBe(RENDERING.toneMapping.exposure);
    expect(r.exposure).toBeGreaterThan(0);
  });

  it('falls back to ACESFilmic for an unknown mode', () => {
    expect(resolveToneMapping({ mode: 'Bogus', exposure: 1 }).mode).toBe('ACESFilmic');
    expect(resolveToneMapping({ mode: '', exposure: 1 }).mode).toBe('ACESFilmic');
  });

  it('passes a valid alternate mode through unchanged', () => {
    for (const mode of TONE_MAPPING_MODES) {
      expect(resolveToneMapping({ mode, exposure: 1 }).mode).toBe(mode);
    }
  });

  it('clamps exposure into a safe band (no crushed black, no blown white)', () => {
    expect(resolveToneMapping({ mode: 'ACESFilmic', exposure: 99 }).exposure).toBe(3.0);
    expect(resolveToneMapping({ mode: 'ACESFilmic', exposure: 0 }).exposure).toBe(0.1);
    expect(resolveToneMapping({ mode: 'ACESFilmic', exposure: -4 }).exposure).toBe(0.1);
    // An in-band value is untouched.
    expect(resolveToneMapping({ mode: 'ACESFilmic', exposure: 1.35 }).exposure).toBe(1.35);
  });
});

describe('RENDERING mood knobs — bounds', () => {
  it('the shipped exposure is inside the clamp band', () => {
    const { exposure } = resolveToneMapping();
    expect(exposure).toBeGreaterThanOrEqual(0.1);
    expect(exposure).toBeLessThanOrEqual(3.0);
  });

  it('Kensington emissive boost brightens (>1)', () => {
    expect(RENDERING.kensingtonEmissiveScale).toBeGreaterThan(1);
  });

  it('emissive intensity reads brighter-than-neutral for the dark scene (>1)', () => {
    expect(RENDERING.emissiveIntensity).toBeGreaterThan(1);
  });

  it('lake shimmer values are gentle + well-formed', () => {
    const w = RENDERING.water;
    expect(w.shimmerAmplitude).toBeGreaterThan(0);
    expect(w.shimmerAmplitude).toBeLessThan(0.5); // "gentle", not a strobe
    expect(w.shimmerSpeed).toBeGreaterThan(0);
    expect(w.shimmerScale).toBeGreaterThan(0);
    expect(w.streakIntensity).toBeGreaterThanOrEqual(0);
    expect(w.streakFalloff).toBeGreaterThan(0);
    expect(w.streakColor).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});
