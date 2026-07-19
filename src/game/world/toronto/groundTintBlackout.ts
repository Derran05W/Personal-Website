// Toronto map v2 — district blackout VISUAL for the ground-tint mesh (Phase 29 T1, D2).
//
// HONEST SCOPE NOTE: the plan's D2 asked to wire district blackouts through "the existing
// contiguous [start,count] instance ranges (25.8 tier work)" the way the legacy world does
// (powergrid/emitters.ts's setDistrictEmissive, which flips a district's slice of an
// InstancedMesh's per-instance aEmissiveOn buffer). That mechanism does not exist for Toronto:
// frontage/furniture buildings render through cityPack/CityPackBatched (a THREE.BatchedMesh with
// no emissive attribute at all — buildings' "lit windows" are a per-building BAKED CanvasTexture,
// painted once, per the Phase-24 unlit-literal verdict), so there is no per-archetype emissive
// instance buffer to write to.
//
// The smallest reasonable substitute that still gives a REAL, visible district blackout: the
// district GROUND-TINT mesh (TorontoScene.tsx's buildGroundTintGeometry, one merged vertex-
// coloured quad per district rect, built in TORONTO_DISTRICTS config order — the exact same
// order torontoDistrictIndex numbers) already carries a genuinely contiguous per-district
// VERTEX range. This module computes those ranges (pure, no three.js dependency — the geometry
// builder in TorontoScene.tsx consumes it) and the color-darkening primitive TorontoScene.tsx's
// blackout-visual effect applies to a live BufferAttribute's backing array on
// `transformerDestroyed`. No flicker animation (unlike the legacy 0.6s staggered sequence) —
// an instant transition, documented simplification for this phase.
//
// pushQuad (TorontoScene.tsx) emits exactly 6 vertices (2 triangles) per rect, in the SAME
// per-district iteration order buildGroundTintGeometry loops in (buildDistricts() config order),
// so "6 vertices per rect, districts back-to-back" is the whole range derivation.
import type { ResolvedDistrict } from './districts';
import { torontoDistrictIndex } from './districts';

const VERTS_PER_QUAD = 6;

export interface GroundTintRange {
  readonly districtIndex: number;
  /** First VERTEX index (not float index — multiply by 3 for a `color` attribute offset). */
  readonly start: number;
  /** Vertex count. */
  readonly count: number;
}

/** One contiguous vertex range per district, in TORONTO_DISTRICTS config order (matching
 * torontoDistrictIndex numbering exactly) — mirrors powergrid/emitters.ts's
 * findRangeBookkeepingViolations bookkeeping guarantee (ranges tile the buffer exactly, no gaps,
 * no overlaps) for the ground-tint mesh instead of a legacy InstancedMesh. */
export function buildGroundTintRanges(districts: readonly ResolvedDistrict[]): readonly GroundTintRange[] {
  const ranges: GroundTintRange[] = [];
  let cursor = 0;
  for (const { def, rects } of districts) {
    const start = cursor;
    cursor += rects.length * VERTS_PER_QUAD;
    ranges.push({ districtIndex: torontoDistrictIndex(def.id), start, count: cursor - start });
  }
  return ranges;
}

/** Total vertex count implied by `ranges` (== the ground-tint geometry's actual vertex count,
 * when ranges is built from the SAME districts the geometry was). */
export function totalVertexCount(ranges: readonly GroundTintRange[]): number {
  return ranges.reduce((sum, r) => sum + r.count, 0);
}

/** Darkens one district's vertex-colour slice in place (a plain RGB-triplet-per-vertex array —
 * three.js's BufferAttribute.array satisfies this without a three.js import here, keeping this
 * module three-free and trivially unit-testable). Multiplies every channel by `factor` (< 1
 * darkens); called once per district on its transformerDestroyed, so repeat calls would
 * over-darken — callers must guard idempotency themselves (TorontoScene.tsx tracks "already
 * darkened" districts, mirroring emitters.ts's own darkened-district set). */
export function darkenColorRange(colors: { [i: number]: number; length: number }, range: GroundTintRange, factor: number): void {
  const lo = range.start * 3;
  const hi = (range.start + range.count) * 3;
  for (let i = lo; i < hi && i < colors.length; i++) colors[i] = colors[i] * factor;
}
