// Phase 44 — the CN Tower night program's HANDS: the patched material that turns heroes.ts's two
// program attributes into light, and the once-per-frame uniform write that feeds it.
//
// THE ARCHITECTURE IN ONE PARAGRAPH. The tower stays ONE merged geometry drawn with ONE
// MeshBasicMaterial (vertexColors, toneMapped=false — the standing UNLIT-LITERAL Toronto verdict),
// so the whole light show costs **zero extra draw calls, zero lights, zero bodies and zero new
// geometry to z-fight with**. `onBeforeCompile` adds ~30 lines to the fragment stage that do only
// SPATIAL work: which LED cell is this fragment (`aProgramT` → cell index), how far up the fin is
// it, how strong is the base wash there. Every decision that involves TIME — the chase phase, the
// pulse breath, the beacon's double-flash envelope — is computed on the CPU by the pure functions
// in cnNightProgram.ts and arrives as a uniform. One home for the logic, and freeze-awareness for
// free (the caller passes simNowMs()).
//
// WHY IT'S SAFE TO PATCH THIS MATERIAL:
//   • `customProgramCacheKey` is set, so three caches this program separately and can never hand
//     the patched shader to Rogers' plain material (world/palette.ts's own patch documents the
//     same pairing rule).
//   • The injection sits immediately after `<color_fragment>` and touches `diffuseColor.rgb` ONLY.
//     `diffuseColor.a` — which is `opacity`, the channel the A.5 occlusion fade writes for named/
//     hero meshes — is untouched, so a faded tower still fades, lights and all.
//   • Additive on an unlit slice: `rgb += colour * intensity`, no lighting model involved. Values
//     above 1 clip per channel on output, which is why the palettes are saturated hues — a
//     saturated colour scaled past 1 keeps its hue (only the dominant channel clips) instead of
//     washing to white. That is the intended "glow" read, not an accident.

import { Color, MeshBasicMaterial, type WebGLProgramParametersWithUniforms } from 'three';
import { CN_TOWER } from '../../config/cnTower';
import {
  beaconEnvelopeAt,
  cnProgramOverride,
  crestPhaseAt,
  paletteAt,
  ringPhaseAt,
  type CnProgramSelection,
} from './cnNightProgram';

/** Bump when the GLSL below changes materially (three caches programs by this key). */
const PROGRAM_CACHE_KEY = 'cn-night-program-v1';

interface NumberUniform {
  value: number;
}
interface ColorUniform {
  value: Color;
}

/** The live uniform block. Held by the caller and mutated in place every frame. */
export interface CnNightUniforms {
  readonly uRingColorA: ColorUniform;
  readonly uRingColorB: ColorUniform;
  readonly uRingIntensity: NumberUniform;
  readonly uRingChasePhase: NumberUniform;
  readonly uRingChaseWidth: NumberUniform;
  readonly uRingIdle: NumberUniform;
  readonly uRingCells: NumberUniform;
  /** 0 = solid, 1 = pulse, 2 = chase (a float, so no int varying/uniform plumbing). */
  readonly uMode: NumberUniform;
  readonly uCrestColor: ColorUniform;
  readonly uCrestIntensity: NumberUniform;
  readonly uCrestPhase: NumberUniform;
  readonly uCrestBase: NumberUniform;
  readonly uCrestBandWidth: NumberUniform;
  readonly uFloodColor: ColorUniform;
  readonly uFloodIntensity: NumberUniform;
  readonly uBeaconColor: ColorUniform;
  readonly uBeaconIntensity: NumberUniform;
  /**
   * Which palette's colours are currently uploaded. `Color.set(hex)` parses a string (and
   * allocates), so the per-frame write only re-reads the palette when this changes — the frame
   * path stays allocation-free, which is the rule for anything in `useFrame`.
   */
  appliedPaletteIndex: number;
}

const MODE_CODE: Record<CnProgramSelection['mode'], number> = { solid: 0, pulse: 1, chase: 2 };

function createUniforms(ringCells: number): CnNightUniforms {
  return {
    uRingColorA: { value: new Color() },
    uRingColorB: { value: new Color() },
    uRingIntensity: { value: CN_TOWER.ring.solidIntensity },
    uRingChasePhase: { value: 0 },
    uRingChaseWidth: { value: CN_TOWER.ring.chaseWidth },
    uRingIdle: { value: CN_TOWER.ring.chaseIdle },
    uRingCells: { value: ringCells },
    uMode: { value: 0 },
    uCrestColor: { value: new Color() },
    uCrestIntensity: { value: CN_TOWER.crest.intensity },
    uCrestPhase: { value: 0 },
    uCrestBase: { value: CN_TOWER.crest.base },
    uCrestBandWidth: { value: CN_TOWER.crest.bandWidth },
    uFloodColor: { value: new Color() },
    uFloodIntensity: { value: CN_TOWER.flood.intensity },
    uBeaconColor: { value: new Color(CN_TOWER.beacon.color) },
    uBeaconIntensity: { value: 0 },
    appliedPaletteIndex: -1,
  };
}

/**
 * Build the CN Tower's own material + its uniform block. One instance per mounted tower (the
 * material is mutated by the patch, so it must never be shared with another mesh — the same rule
 * cityPack/CityPackBatched.tsx follows for the dither patch).
 *
 * `ringCells` comes from the GEOMETRY (`CnTowerMeta.ringCells`), never from config: the shader's
 * cell discretization has to match the lathe that built the channel, and deriving it kills the
 * literal-drift class at the source.
 */
export function createCnNightMaterial(ringCells: number): {
  material: MeshBasicMaterial;
  uniforms: CnNightUniforms;
} {
  const uniforms = createUniforms(ringCells);
  const material = new MeshBasicMaterial({ vertexColors: true, toneMapped: false });

  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms): void => {
    shader.uniforms.uRingColorA = uniforms.uRingColorA;
    shader.uniforms.uRingColorB = uniforms.uRingColorB;
    shader.uniforms.uRingIntensity = uniforms.uRingIntensity;
    shader.uniforms.uRingChasePhase = uniforms.uRingChasePhase;
    shader.uniforms.uRingChaseWidth = uniforms.uRingChaseWidth;
    shader.uniforms.uRingIdle = uniforms.uRingIdle;
    shader.uniforms.uRingCells = uniforms.uRingCells;
    shader.uniforms.uMode = uniforms.uMode;
    shader.uniforms.uCrestColor = uniforms.uCrestColor;
    shader.uniforms.uCrestIntensity = uniforms.uCrestIntensity;
    shader.uniforms.uCrestPhase = uniforms.uCrestPhase;
    shader.uniforms.uCrestBase = uniforms.uCrestBase;
    shader.uniforms.uCrestBandWidth = uniforms.uCrestBandWidth;
    shader.uniforms.uFloodColor = uniforms.uFloodColor;
    shader.uniforms.uFloodIntensity = uniforms.uFloodIntensity;
    shader.uniforms.uBeaconColor = uniforms.uBeaconColor;
    shader.uniforms.uBeaconIntensity = uniforms.uBeaconIntensity;

    // (1) VERTEX — declare the two program attributes + their varyings, then pass them through.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
        attribute float aProgram;   // night-program element id (heroes.ts CN_PROGRAM)
        attribute float aProgramT;  // that element's parametric coord
        varying float vProgram;
        varying float vProgramT;`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
        vProgram = aProgram;
        vProgramT = aProgramT;`,
    );

    // (2) FRAGMENT — declarations at global scope.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
        uniform vec3 uRingColorA;
        uniform vec3 uRingColorB;
        uniform float uRingIntensity;
        uniform float uRingChasePhase;
        uniform float uRingChaseWidth;
        uniform float uRingIdle;
        uniform float uRingCells;
        uniform float uMode;
        uniform vec3 uCrestColor;
        uniform float uCrestIntensity;
        uniform float uCrestPhase;
        uniform float uCrestBase;
        uniform float uCrestBandWidth;
        uniform vec3 uFloodColor;
        uniform float uFloodIntensity;
        uniform vec3 uBeaconColor;
        uniform float uBeaconIntensity;
        varying float vProgram;
        varying float vProgramT;`,
    );

    // (2b) FRAGMENT — the program itself, added straight after the vertex-colour multiply. Only
    // `.rgb` is touched; `diffuseColor.a` (= material.opacity, the A.5 fade channel) is untouched.
    // The element branch uses 0.5-wide windows on the varying because a float varying across a
    // flat-tagged face is exact but not bit-exact-comparable.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
        {
          float pid = vProgram;
          if ( pid > 0.5 && pid < 1.5 ) {
            // RING — discrete LED cells. aProgramT is already the cell's own centre fraction, so
            // the floor is a belt-and-braces exact re-derivation of the cell index.
            float cellIndex = floor( vProgramT * uRingCells );
            vec3 led = mix( uRingColorA, uRingColorB, mod( cellIndex, 2.0 ) );
            float amount = uRingIntensity;
            if ( uMode > 1.5 ) {
              // chase: a window travelling around the ring; distance wraps at the seam.
              float cellCenter = ( cellIndex + 0.5 ) / uRingCells;
              float d = abs( cellCenter - uRingChasePhase );
              d = min( d, 1.0 - d );
              float lit = 1.0 - smoothstep( 0.0, max( uRingChaseWidth, 1e-4 ), d );
              amount *= mix( uRingIdle, 1.0, lit );
            }
            diffuseColor.rgb += led * amount;
          } else if ( pid > 1.5 && pid < 2.5 ) {
            // BEACON — one CPU-computed double-flash envelope drives every housing together.
            diffuseColor.rgb += uBeaconColor * uBeaconIntensity;
          } else if ( pid > 2.5 && pid < 3.5 ) {
            // CREST — a constant wash plus a soft band sweeping up the fin.
            float d = abs( vProgramT - uCrestPhase );
            float band = 1.0 - smoothstep( 0.0, max( uCrestBandWidth, 1e-4 ), d );
            diffuseColor.rgb += uCrestColor * uCrestIntensity * ( uCrestBase + ( 1.0 - uCrestBase ) * band );
          } else if ( pid > 3.5 ) {
            // FLOOD — the gradient is baked into aProgramT (1 at the ground, 0 at the leg merge).
            diffuseColor.rgb += uFloodColor * uFloodIntensity * vProgramT;
          }
        }`,
    );
  };

  material.customProgramCacheKey = (): string => PROGRAM_CACHE_KEY;

  return { material, uniforms };
}

/**
 * The whole per-frame CPU side of the show, in one allocation-free call.
 *
 * `base` is the seeded selection for the run; the dev override (cnNightProgram.ts) is composed in
 * here rather than upstream so the caller can memoize `base` on the seed and still get live
 * override switching. `tMs` MUST be `core/simClock.ts`'s `simNowMs()` — see that module's header;
 * a wall-clock caller would animate through a frozen world and light up the flicker detector.
 */
export function writeCnNightUniforms(u: CnNightUniforms, base: CnProgramSelection, tMs: number): void {
  const mode = cnProgramOverride.mode ?? base.mode;
  const paletteIndex = cnProgramOverride.paletteIndex ?? base.paletteIndex;

  if (paletteIndex !== u.appliedPaletteIndex) {
    const palette = paletteAt(paletteIndex);
    u.uRingColorA.value.set(palette.ringA);
    u.uRingColorB.value.set(palette.ringB);
    u.uCrestColor.value.set(palette.crest);
    u.uFloodColor.value.set(palette.flood);
    u.appliedPaletteIndex = paletteIndex;
  }

  const ring = ringPhaseAt(tMs, mode);
  u.uMode.value = MODE_CODE[mode];
  u.uRingIntensity.value = ring.intensity;
  u.uRingChasePhase.value = ring.chasePhase;
  u.uRingChaseWidth.value = CN_TOWER.ring.chaseWidth;
  u.uRingIdle.value = CN_TOWER.ring.chaseIdle;

  u.uCrestPhase.value = crestPhaseAt(tMs);
  u.uCrestIntensity.value = CN_TOWER.crest.intensity;
  u.uCrestBase.value = CN_TOWER.crest.base;
  u.uCrestBandWidth.value = CN_TOWER.crest.bandWidth;

  u.uFloodIntensity.value = CN_TOWER.flood.intensity;
  u.uBeaconIntensity.value = beaconEnvelopeAt(tMs) * CN_TOWER.beacon.peakIntensity;
}
