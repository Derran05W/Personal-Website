// The city's ONE palette texture + ONE shared material (TDD §8.2). Every instanced static
// in the world (buildings + street props) UV-maps its faces to flat cells of a tiny
// canvas-generated atlas and shares the single MeshLambertMaterial built here — one
// material, zero texture-memory pressure, instancing-friendly (per-instance tint via
// InstancedMesh.instanceColor, per-instance lit/unlit via the aEmissiveOn attribute below).
//
// The atlas cell grid, cell ids, and UV convention are the SEAM in world/archetypes.ts —
// this module only renders colours into those cells and wires the emissive sampling; it
// never invents cell ids. Geometry builders (world/geometry/*) bake `uv` (albedo cell) and
// `uv2` (emissive cell) per vertex against the same contract.

import {
  CanvasTexture,
  MeshLambertMaterial,
  NearestFilter,
  SRGBColorSpace,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { PALETTE_COLS, PALETTE_ROWS, PaletteCell, type PaletteCellName } from './archetypes';
import { RENDERING } from '../config';

// --- Cell colours -------------------------------------------------------------------------
// One flat sRGB colour per named cell (world/archetypes.ts's PaletteCell). Tuned for the
// permanent blue-hour scene (TDD §8.1): muted-but-saturated walls, dark unlit glass, and
// the four EMISSIVE cells (windowWarm/streetlightWarm/signalRed/signalGreen) picked bright
// so that — multiplied by RENDERING.emissiveIntensity — lit windows and lamps clearly read
// against a dark city. Reserved cells (ids past the named set) stay pure black so a
// geometry builder can point a non-emissive face's `uv2` at one and have it add nothing.
const CELL_HEX: Record<PaletteCellName, string> = {
  asphalt: '#2b2f36', // matches CityScape's placeholder ROAD_COLOR
  sidewalk: '#6c7178', // light concrete
  wallA: '#8a5a42', // warm brick
  wallB: '#6d7683', // cool concrete
  wallC: '#3f8f8a', // painted teal
  wallD: '#b7a06a', // sandstone
  wallE: '#7c3b3b', // deep red
  wallF: '#4a515c', // slate
  roof: '#33383f', // dark roof
  foliage: '#3f7a4e', // matches CityScape's placeholder PARK_COLOR family
  foliageDark: '#2f5c3b',
  trunk: '#5b4636',
  metal: '#8a929c',
  metalDark: '#4b525b',
  glassCool: '#35506b', // unlit window: dark dusk-blue glass
  windowWarm: '#ffc879', // EMISSIVE: warm lit window
  streetlightWarm: '#ffb44d', // EMISSIVE: sodium streetlight head
  signalRed: '#ff3b30', // EMISSIVE: traffic-light red
  signalGreen: '#33e070', // EMISSIVE: traffic-light green
  water: '#2f6f93', // matches CityScape's placeholder WATER_COLOR
  sand: '#cdbb87',
  liveryRed: '#d23b33',
  liveryWhite: '#e8e8ea',
  policeBlue: '#2b5fd0',
  militaryGreen: '#4a5a3a',
  tailRed: '#ff2a1f',
  headWarm: '#fff3d0',
};

// Canvas cell pixel size — big enough that NearestFilter sampling at each cell CENTRE
// (paletteCellUv) lands squarely inside a flat block, small enough that the whole atlas is
// a trivially-sized texture (PALETTE_COLS·8 × PALETTE_ROWS·8 = 64×32). Structural, not a
// look knob, so it lives here rather than in config/ (see config/rendering.ts).
const CELL_PX = 8;

/**
 * Render the flat 8×4 palette atlas (world/archetypes.ts's cell grid) into a CanvasTexture:
 * one flat sRGB colour per cell, NearestFilter both ways with mipmaps OFF so adjacent cells
 * never bleed into each other, colorSpace sRGB (three then decodes to linear on sample).
 *
 * flipY stays at three's default `true`: cell 0 is drawn at the canvas TOP-LEFT (row 0),
 * and with flipY the top canvas row maps to v→1, which is exactly paletteCellUv's
 * convention (v = 0 at the atlas bottom = row PALETTE_ROWS-1). Verified against
 * paletteCellUv(): cell 0 → v≈0.875 (top), cell 24 → v≈0.125 (bottom).
 */
export function buildPaletteTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = PALETTE_COLS * CELL_PX;
  canvas.height = PALETTE_ROWS * CELL_PX;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('palette: 2D canvas context unavailable');

  // Start pure black so every reserved (unnamed) cell is black — the "adds nothing"
  // emissive target for non-emissive faces (see CELL_HEX comment).
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const [name, cell] of Object.entries(PaletteCell)) {
    const col = cell % PALETTE_COLS;
    const row = Math.floor(cell / PALETTE_COLS);
    ctx.fillStyle = CELL_HEX[name as PaletteCellName];
    ctx.fillRect(col * CELL_PX, row * CELL_PX, CELL_PX, CELL_PX);
  }

  const texture = new CanvasTexture(canvas);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = SRGBColorSpace;
  texture.flipY = true;
  texture.needsUpdate = true;
  return texture;
}

// --- The emissive intensity uniform -------------------------------------------------------
// A single shared uniform object whose `value` is a live view onto RENDERING.emissiveIntensity.
// three reads uniform.value each frame at upload time, so pointing it at the config leaf
// makes the auto-built leva Config → RENDERING → emissiveIntensity knob (which mutates the
// config block in place, exactly like every other config leaf — see core/devPanel.tsx)
// tune the glow live, with no per-frame plumbing of our own. setEmissiveIntensity() writes
// the same leaf for code/tests.
const emissiveIntensityUniform: { value: number } = {
  get value(): number {
    return RENDERING.emissiveIntensity;
  },
  set value(v: number) {
    // RENDERING is `as const` (compile-time readonly) but a plain mutable object at runtime;
    // strip readonly to write the live leaf, matching core/devPanel.tsx's writeConfigLeaf.
    (RENDERING as { emissiveIntensity: number }).emissiveIntensity = v;
  },
};

/** Set the emissive intensity live (leva "emissive intensity" control / code). */
export function setEmissiveIntensity(value: number): void {
  emissiveIntensityUniform.value = value;
}

/** Current emissive intensity (the live config leaf). */
export function getEmissiveIntensity(): number {
  return emissiveIntensityUniform.value;
}

// --- The shared material + shader patch ---------------------------------------------------
// A stable key so three caches THIS patched program separately from any unpatched Lambert
// and never confuses the two (docs: pair onBeforeCompile with customProgramCacheKey). Bump
// the suffix if the patch below changes materially.
const PROGRAM_CACHE_KEY = 'city-palette-emissive-v1';

let cityMaterial: MeshLambertMaterial | null = null;

/**
 * THE one shared material for every instanced world static (memoized singleton).
 *
 * MeshLambertMaterial + the palette texture as `map`; InstancedMesh.instanceColor tints the
 * albedo automatically (three sets USE_INSTANCING_COLOR when a mesh has instanceColor).
 * onBeforeCompile then adds a per-instance emissive term sampled from the SAME atlas at a
 * SECOND UV set — the plumbing TDD §5.8 blackouts flip. This is the most exotic code in the
 * repo; the patch is deliberately tiny — two string replaces per stage (declarations at
 * global scope after <common>, body after an existing chunk) — and heavily commented.
 *
 * three r160+ removed the built-in second UV set (USE_UV2), so we declare the `uv2`
 * attribute + a `vUv2` varying ourselves. This is safe: our material samples a map only on
 * UV channel 0, so three never declares `uv2` itself (WebGLProgram only emits it under
 * `#ifdef USE_UV2`), and never names a `vUv2` varying — no collision either way.
 */
export function getCityMaterial(): MeshLambertMaterial {
  if (cityMaterial !== null) return cityMaterial;

  const material = new MeshLambertMaterial({ map: buildPaletteTexture() });

  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms): void => {
    // Expose the leva-live intensity uniform to the fragment stage.
    shader.uniforms.uEmissiveIntensity = emissiveIntensityUniform;

    // (1) VERTEX — declarations at global scope (after <common>): the per-instance lit flag
    // (InstancedBufferAttribute, world/instancing.ts), the geometry's baked emissive-cell UV,
    // and the varyings that carry both to the fragment stage.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
        attribute float aEmissiveOn;   // per-instance: 1 lit, 0 blacked-out (Phase 13)
        attribute vec2 uv2;            // per-vertex: emissive palette cell (v=0 => adds nothing)
        varying float vEmissiveOn;
        varying vec2 vUv2;`,
    );
    // (1b) VERTEX — pass them through (after <uv_vertex>, which fills vUv/vMapUv).
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
        vEmissiveOn = aEmissiveOn;
        vUv2 = uv2;`,
    );

    // (2) FRAGMENT — declarations at global scope (after <common>).
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
        uniform float uEmissiveIntensity;
        varying float vEmissiveOn;
        varying vec2 vUv2;`,
    );
    // (2b) FRAGMENT — add the emissive term (after <emissivemap_fragment>, where the built-in
    // totalEmissiveRadiance is finalised before light accumulation). Sample the SAME atlas
    // (`map`) at the emissive cell, gate it per-instance by aEmissiveOn, scale by the uniform.
    // A blacked-out district's instances carry aEmissiveOn=0 → the whole term drops to black.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
        totalEmissiveRadiance += texture2D( map, vUv2 ).rgb * vEmissiveOn * uEmissiveIntensity;`,
    );
  };

  // Distinguish the patched program from any stock Lambert in three's cache.
  material.customProgramCacheKey = (): string => PROGRAM_CACHE_KEY;

  cityMaterial = material;
  return cityMaterial;
}

/** Dispose + drop the singleton (hard teardown, e.g. WebGL context loss). Next
 * getCityMaterial() rebuilds it. */
export function disposeCityMaterial(): void {
  if (cityMaterial === null) return;
  cityMaterial.map?.dispose();
  cityMaterial.dispose();
  cityMaterial = null;
}
