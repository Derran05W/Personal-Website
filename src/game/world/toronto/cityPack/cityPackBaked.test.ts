// Phase 25.8 (D4) — bakeGeometry vertex-gradient: color-attribute presence per gradient flag, the
// floor→roof luminance ramp, and strength-0 identity (no attribute → byte-identical shading).
import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Matrix4 } from 'three';
import { bakeGeometry } from './cityPackBaked';
import { VERTEX_GRADIENT_BAKE } from '../../../config/torontoCohesion';

/** A tall triangle: two verts at y=0 (floor), one at y=10 (roof). */
function tallGeom(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 2, 0, 0, 1, 10, 0], 3));
  return g;
}

describe('bakeGeometry — vertex-gradient (D4)', () => {
  it('writes NO color attribute when gradient=false (byte-identical path)', () => {
    const g = bakeGeometry(tallGeom(), new Matrix4(), false);
    expect(g.getAttribute('color')).toBeUndefined();
  });

  it('writes a floor→roof luminance ramp when gradient=true', () => {
    const g = bakeGeometry(tallGeom(), new Matrix4(), true);
    const col = g.getAttribute('color');
    expect(col).toBeDefined();
    // floor verts (y=0) → startLuminance; roof vert (y=10) → endLuminance.
    expect(col!.getX(0)).toBeCloseTo(VERTEX_GRADIENT_BAKE.startLuminance, 5);
    expect(col!.getX(1)).toBeCloseTo(VERTEX_GRADIENT_BAKE.startLuminance, 5);
    expect(col!.getX(2)).toBeCloseTo(VERTEX_GRADIENT_BAKE.endLuminance, 5);
    // luminance-only (r == g == b) so it can't tint the palette.
    expect(col!.getY(2)).toBeCloseTo(col!.getX(2), 6);
    expect(col!.getZ(2)).toBeCloseTo(col!.getX(2), 6);
  });

  it('strength 0 writes no attribute (kill-switch = byte-identical)', () => {
    const saved = VERTEX_GRADIENT_BAKE.strength;
    (VERTEX_GRADIENT_BAKE as { strength: number }).strength = 0;
    try {
      const g = bakeGeometry(tallGeom(), new Matrix4(), true);
      expect(g.getAttribute('color')).toBeUndefined();
    } finally {
      (VERTEX_GRADIENT_BAKE as { strength: number }).strength = saved;
    }
  });
});
