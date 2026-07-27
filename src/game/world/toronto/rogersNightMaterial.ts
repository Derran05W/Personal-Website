// Phase 45 — the Rogers Centre night program's HANDS: the patched material that turns heroes.ts's
// two program attributes into light on the stadium, and the once-per-frame uniform write that feeds
// it. Architecturally this is a COPY of cnNightMaterial.ts (Phase 44), deliberately and by
// instruction: one merged geometry, one MeshBasicMaterial, an `onBeforeCompile` patch that does
// only SPATIAL work, and every time-dependent decision computed on the CPU by pure functions
// (rogersProgram.ts) and handed over as a uniform. The whole board costs **zero extra draw calls,
// zero lights, zero bodies and zero new geometry to z-fight with**.
//
// WHAT IT DOES NOT SHARE WITH CN:
//   • its own `customProgramCacheKey`. NEVER reuse CN's — three caches compiled programs by that
//     key, and two materials that claim the same key but inject different GLSL will hand one
//     hero's shader to the other. Same pairing rule world/palette.ts documents for its own patch.
//   • its own uniform block, and its own SLICE of the shared hero program alphabet (heroes.ts's
//     CN_PROGRAM): this patch implements ids 5 (JUMBO) and 6 (EMISS) only, and adds nothing for
//     ids 1–4, exactly as CN's patch now adds nothing for 5–6.
//   • the BLACKOUT. CN's program is structurally forbidden from importing powergrid (the tower
//     stays lit through DARK CITY — that IS the money shot, and cnBlackoutLaw.test.ts polices it).
//     Rogers is the counter-case: it DIMS with its district, so this file reads the grid's dark
//     state and drives the `uDark` uniform through a config-driven lerp. The lerp is stepped by the
//     caller's own sim-time delta, so a frozen world freezes the fade too.
//
// The injection sits immediately after `<color_fragment>` and touches `diffuseColor.rgb` ONLY.
// `diffuseColor.a` — `opacity`, the channel the A.5 occlusion fade writes for hero meshes — is
// untouched, so a faded stadium still fades, board and all.

import { Color, MeshBasicMaterial, type WebGLProgramParametersWithUniforms } from 'three';
import { ROGERS_CENTRE } from '../../config/rogersCentre';
import { isDistrictDark as flickerIsDistrictDark } from '../../powergrid/emitters';
import { gridRef } from '../../powergrid/grid';
import { jumboPhaseAt, schemeAt, stepDarkLevel, type RogersProgramSelection } from './rogersProgram';

/** Bump when the GLSL below changes materially (three caches programs by this key). */
const PROGRAM_CACHE_KEY = 'rogers-night-program-v1';

interface NumberUniform {
  value: number;
}
interface ColorUniform {
  value: Color;
}

/** The live uniform block. Held by the caller and mutated in place every frame. */
export interface RogersNightUniforms {
  readonly uJumboBlockA: ColorUniform;
  readonly uJumboBlockB: ColorUniform;
  readonly uJumboBlockC: ColorUniform;
  readonly uJumboCells: NumberUniform;
  readonly uJumboScroll: NumberUniform;
  readonly uJumboIntensity: NumberUniform;
  readonly uJumboBandPhase: NumberUniform;
  readonly uJumboBandWidth: NumberUniform;
  readonly uJumboBandBoost: NumberUniform;
  readonly uGateColor: ColorUniform;
  readonly uGateIntensity: NumberUniform;
  readonly uHotelColor: ColorUniform;
  readonly uHotelIntensity: NumberUniform;
  /** 0 = lit, 1 = blacked out. Multiplies EVERY program emissive (through `uDarkFloor`). */
  readonly uDark: NumberUniform;
  readonly uDarkFloor: NumberUniform;
  /**
   * Which scheme's colours are currently uploaded. `Color.set(hex)` parses a string (and
   * allocates), so the per-frame write only re-reads the scheme when this changes — the frame path
   * stays allocation-free, which is the rule for anything in `useFrame`.
   */
  appliedSchemeIndex: number;
  /** Last `tMs` the write saw, so the blackout fade can advance by a real sim-time delta. */
  lastTMs: number | null;
}

function createUniforms(jumboCells: number): RogersNightUniforms {
  return {
    uJumboBlockA: { value: new Color() },
    uJumboBlockB: { value: new Color() },
    uJumboBlockC: { value: new Color() },
    uJumboCells: { value: jumboCells },
    uJumboScroll: { value: 0 },
    uJumboIntensity: { value: ROGERS_CENTRE.jumbotron.baseIntensity },
    uJumboBandPhase: { value: 0 },
    uJumboBandWidth: { value: ROGERS_CENTRE.jumbotron.bandWidth },
    uJumboBandBoost: { value: ROGERS_CENTRE.jumbotron.bandBoost },
    uGateColor: { value: new Color(ROGERS_CENTRE.gates.color) },
    uGateIntensity: { value: ROGERS_CENTRE.gates.intensity },
    uHotelColor: { value: new Color(ROGERS_CENTRE.hotel.color) },
    uHotelIntensity: { value: ROGERS_CENTRE.hotel.intensity },
    uDark: { value: 0 },
    uDarkFloor: { value: ROGERS_CENTRE.blackout.floor },
    appliedSchemeIndex: -1,
    lastTMs: null,
  };
}

/**
 * Build the Rogers Centre's own material + its uniform block. One instance per mounted stadium
 * (the material is mutated by the patch, so it must never be shared with another mesh — the same
 * rule cityPack/CityPackBatched.tsx follows for the dither patch).
 *
 * `jumboCells` comes from the GEOMETRY (`RogersMeta.jumboCells`), never from config: the shader's
 * column discretization has to match the board the builder actually emitted, and deriving it kills
 * the literal-drift class at the source (the same rule CN's `ringCells` follows).
 */
export function createRogersNightMaterial(jumboCells: number): {
  material: MeshBasicMaterial;
  uniforms: RogersNightUniforms;
} {
  const uniforms = createUniforms(jumboCells);
  const material = new MeshBasicMaterial({ vertexColors: true, toneMapped: false });

  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms): void => {
    shader.uniforms.uJumboBlockA = uniforms.uJumboBlockA;
    shader.uniforms.uJumboBlockB = uniforms.uJumboBlockB;
    shader.uniforms.uJumboBlockC = uniforms.uJumboBlockC;
    shader.uniforms.uJumboCells = uniforms.uJumboCells;
    shader.uniforms.uJumboScroll = uniforms.uJumboScroll;
    shader.uniforms.uJumboIntensity = uniforms.uJumboIntensity;
    shader.uniforms.uJumboBandPhase = uniforms.uJumboBandPhase;
    shader.uniforms.uJumboBandWidth = uniforms.uJumboBandWidth;
    shader.uniforms.uJumboBandBoost = uniforms.uJumboBandBoost;
    shader.uniforms.uGateColor = uniforms.uGateColor;
    shader.uniforms.uGateIntensity = uniforms.uGateIntensity;
    shader.uniforms.uHotelColor = uniforms.uHotelColor;
    shader.uniforms.uHotelIntensity = uniforms.uHotelIntensity;
    shader.uniforms.uDark = uniforms.uDark;
    shader.uniforms.uDarkFloor = uniforms.uDarkFloor;

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
        uniform vec3 uJumboBlockA;
        uniform vec3 uJumboBlockB;
        uniform vec3 uJumboBlockC;
        uniform float uJumboCells;
        uniform float uJumboScroll;
        uniform float uJumboIntensity;
        uniform float uJumboBandPhase;
        uniform float uJumboBandWidth;
        uniform float uJumboBandBoost;
        uniform vec3 uGateColor;
        uniform float uGateIntensity;
        uniform vec3 uHotelColor;
        uniform float uHotelIntensity;
        uniform float uDark;
        uniform float uDarkFloor;
        varying float vProgram;
        varying float vProgramT;`,
    );

    // (2b) FRAGMENT — the program itself, straight after the vertex-colour multiply. Only `.rgb`
    // is touched. The element branch uses 0.5-wide windows on the varying (a float varying across a
    // flat-tagged face is exact but not bit-exact-comparable), and ids this hero doesn't carry
    // (CN's 1–4) fall through adding nothing.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
        {
          float pid = vProgram;
          float gain = mix( 1.0, uDarkFloor, clamp( uDark, 0.0, 1.0 ) );
          if ( pid > 4.5 && pid < 5.5 ) {
            // JUMBO — discrete colour-block columns. aProgramT is already the column's own centre
            // fraction, so the floor is an exact re-derivation of the column index; the scroll is
            // floored to a WHOLE column shift so the blocks step rather than slide sub-pixel.
            float cell = floor( vProgramT * uJumboCells );
            float shift = floor( uJumboScroll * uJumboCells );
            float sel = mod( cell + shift, 3.0 );
            vec3 block = sel < 0.5 ? uJumboBlockA : ( sel < 1.5 ? uJumboBlockB : uJumboBlockC );
            // …plus a brighter band travelling across the board; distance wraps at the edge.
            float cellCenter = ( cell + 0.5 ) / uJumboCells;
            float d = abs( cellCenter - uJumboBandPhase );
            d = min( d, 1.0 - d );
            float band = 1.0 - smoothstep( 0.0, max( uJumboBandWidth, 1e-4 ), d );
            diffuseColor.rgb += block * ( uJumboIntensity + uJumboBandBoost * band ) * gain;
          } else if ( pid > 5.5 ) {
            // EMISS — one id, two receivers: aProgramT selects gates (0) from hotel windows (1).
            float sel = step( 0.5, vProgramT );
            vec3 c = mix( uGateColor, uHotelColor, sel );
            float amount = mix( uGateIntensity, uHotelIntensity, sel );
            diffuseColor.rgb += c * amount * gain;
          }
        }`,
    );
  };

  material.customProgramCacheKey = (): string => PROGRAM_CACHE_KEY;

  return { material, uniforms };
}

/**
 * Is the district the stadium stands in currently dark? Reads BOTH powergrid sources for the same
 * reason core/debugBridge.ts's own `isDistrictDark` does: `grid.ts`'s `gridRef.current.lit` flips
 * the instant `transformerDestroyed` fires (the power IS out — this is what the ground tint keys
 * off, see TorontoScene's groundTintBlackout effect), while `emitters.ts` only reports dark once
 * that district's ~0.6 s flicker sequence has settled. ORing them means the board starts dimming
 * with the rest of the district and can't be left lit by whichever path a given run took.
 *
 * Reading this file's own import is deliberate: Rogers MAY import powergrid (only the CN night
 * program's four files are under the structural ban — cnBlackoutLaw.test.ts, which now carries
 * THIS file as a second positive control precisely to pin the distinction).
 */
export function isHeroDistrictDark(districtId: number): boolean {
  return gridRef.current.lit[districtId] === false || flickerIsDistrictDark(districtId);
}

/**
 * The whole per-frame CPU side of the board, in one allocation-free call.
 *
 * `base` is the seeded selection for the run. `tMs` MUST be `core/simClock.ts`'s `simNowMs()` — see
 * that module's header; a wall-clock caller would animate through a frozen world and light up the
 * flicker detector. `dark` is the district's power state (see `isHeroDistrictDark`); the fade
 * toward it advances by this call's own sim-time delta, so a frozen clock freezes the fade too.
 */
export function writeRogersNightUniforms(
  u: RogersNightUniforms,
  base: RogersProgramSelection,
  tMs: number,
  dark: boolean,
): void {
  if (base.schemeIndex !== u.appliedSchemeIndex) {
    const scheme = schemeAt(base.schemeIndex);
    u.uJumboBlockA.value.set(scheme.blocks[0]);
    u.uJumboBlockB.value.set(scheme.blocks[1]);
    u.uJumboBlockC.value.set(scheme.blocks[2]);
    u.appliedSchemeIndex = base.schemeIndex;
  }

  const phase = jumboPhaseAt(tMs);
  u.uJumboScroll.value = phase.scroll;
  u.uJumboBandPhase.value = phase.bandPhase;
  u.uJumboIntensity.value = ROGERS_CENTRE.jumbotron.baseIntensity;
  u.uJumboBandWidth.value = ROGERS_CENTRE.jumbotron.bandWidth;
  u.uJumboBandBoost.value = ROGERS_CENTRE.jumbotron.bandBoost;
  u.uGateIntensity.value = ROGERS_CENTRE.gates.intensity;
  u.uHotelIntensity.value = ROGERS_CENTRE.hotel.intensity;
  u.uDarkFloor.value = ROGERS_CENTRE.blackout.floor;

  // The fade's dt is a SIM-time delta (frozen world ⇒ 0 ⇒ no motion). A first frame, or a clock
  // that moved backwards (a retry resets the sim clock), contributes nothing rather than a jump.
  const dtMs = u.lastTMs === null ? 0 : tMs - u.lastTMs;
  u.lastTMs = tMs;
  u.uDark.value = stepDarkLevel(u.uDark.value, dark, dtMs);
}
