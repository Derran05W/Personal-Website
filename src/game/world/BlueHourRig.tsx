// Blue-hour lighting rig (Phase 5, TDD §8.1-8.2). Drop-in replacement for CityScape's
// Phase-2 placeholder lights. Mounts the whole permanent-dusk look:
//   • a warm, low-angle dusk directional KEY whose tight 60 m shadow frustum FOLLOWS the
//     player, texel-quantized (world/lighting.ts) so shadows don't shimmer while driving;
//   • a cool HEMISPHERE ambient (blue sky above, warm ground bounce below);
//   • a gradient SKY (CanvasTexture on scene.background) matched to linear FOG so distant
//     geometry dissolves into the horizon band;
//   • ACES-filmic tone mapping + exposure.
// All tunables live in config/lighting.ts (LIGHTING). No post-processing (TDD §8.2).
//
// Render ownership (TDD §6): core/frameOrder's CameraFxSystem OWNS the gl.render() at
// useFrame priority 1. This rig only ever SETS renderer/scene state and moves the light — it
// never renders. Its per-frame work runs at priority 0 so it lands BEFORE that render pass.
// Per-frame writes go through the useFrame `state` param (state.gl/state.scene) and the
// one-time scene setup through the R3F store getter, so nothing mutates a value the React
// Compiler tracks as immutable (the same reason frameOrder mutates the camera via `state`).

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  CanvasTexture,
  CineonToneMapping,
  Color,
  Fog,
  LinearToneMapping,
  NeutralToneMapping,
  NoToneMapping,
  ReinhardToneMapping,
  SRGBColorSpace,
  type DirectionalLight,
  type HemisphereLight,
  type ToneMapping,
} from 'three';
import { LIGHTING, QUALITY_TIERS, RENDERING, resolveToneMapping, type ToneMappingMode } from '../config';
import { useGameStore } from '../state/store';
import { playerVehicle } from '../vehicles/playerRef';
import {
  SUN_BASIS,
  SUN_OFFSET,
  computeSunFollow,
  resolveSkyGlow,
  skyGradientStops,
  worldTexelSize,
  type Vec3,
} from './lighting';

// config/rendering.ts's tone-mapping MODE names → the three constant. Kept here (not in
// config) so config/rendering.ts stays three-free and unit-testable; resolveToneMapping()
// validates the name against the same TONE_MAPPING_MODES set before we index this.
const THREE_TONE_MAPPING: Record<ToneMappingMode, ToneMapping> = {
  ACESFilmic: ACESFilmicToneMapping,
  AgX: AgXToneMapping,
  Neutral: NeutralToneMapping,
  Reinhard: ReinhardToneMapping,
  Cineon: CineonToneMapping,
  Linear: LinearToneMapping,
  None: NoToneMapping,
};

/** #rgb / #rrggbb → [r,g,b] bytes (0..255) for canvas `rgba(...)` fill strings. */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Reused hot-path scratch (no per-frame allocation, matching cameraRig's discipline).
const followCenter: Vec3 = { x: 0, y: 0, z: 0 };
const followTarget: Vec3 = { x: 0, y: 0, z: 0 };
const followLight: Vec3 = { x: 0, y: 0, z: 0 };

/** Build the blue-hour sky CanvasTexture for scene.background: a vertical deep-blue-top →
 * warm-horizon → dark-bottom ramp PLUS a directional amber-pink "lake glow" lobe blended
 * over the horizon band (strongest toward the south/lake — the fixed-yaw rig makes that a
 * constant screen region; see world/lighting.ts's sky math). Now a 2D canvas (was width-2
 * vertical-only) so the lobe reads horizontally; the background pass stretches it to the
 * viewport and tone-maps it with the rest of the frame. Canvas row 0 (top) maps to screen
 * top (CanvasTexture flipY), so stop 0 is the sky top. */
function makeSkyTexture(): CanvasTexture {
  const w = 96;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    // Vertical blue-hour ramp.
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    for (const stop of skyGradientStops(LIGHTING.sky)) grad.addColorStop(stop.pos, stop.color);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Directional lake-glow lobe: a soft radial warm gradient blended over the ramp so the
    // horizon reads amber-pink strongest toward the lake. source-over (a tint, not additive)
    // keeps it from blowing out under the exposure knob.
    const lobe = resolveSkyGlow(LIGHTING.sky, w, h);
    const [r, g, b] = hexToRgb(lobe.color);
    const radial = ctx.createRadialGradient(lobe.cx, lobe.cy, 0, lobe.cx, lobe.cy, lobe.radius);
    radial.addColorStop(0, `rgba(${r},${g},${b},${lobe.strength})`);
    radial.addColorStop(0.55, `rgba(${r},${g},${b},${lobe.strength * 0.4})`);
    radial.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = radial;
    ctx.fillRect(0, 0, w, h);
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** The dusk directional key + its shadow-follow. Keyed on quality by the parent so a tier
 * change remounts it with a fresh shadow-map size (three can't resize an allocated shadow
 * map reactively). `shadowMapSize === 0` ⇒ shadows OFF (low tier): castShadow disabled and
 * the follow loop skips all shadow-camera work. */
function DuskKey({ shadowMapSize }: { shadowMapSize: number }) {
  const lightRef = useRef<DirectionalLight>(null);
  const shadowsOn = shadowMapSize > 0;
  const half = LIGHTING.shadowFrustumM / 2;

  useFrame(() => {
    const light = lightRef.current;
    if (!light) return;
    // Leva-live intensity (config is mutable; the JSX prop only sets the initial value).
    light.intensity = LIGHTING.sun.intensity;
    if (!shadowsOn) return;

    const model = playerVehicle.current;
    if (!model) return; // GARAGE / menus: no player to follow — leave the light at origin.
    const pos = model.readState().pose.position; // interpolated pose (TDD §7) — never rawPose
    followCenter.x = pos.x;
    followCenter.y = pos.y;
    followCenter.z = pos.z;

    // Quantize to whole texels of the *current* frustum/map so shadows don't shimmer, then
    // move light + target by the SAME delta so the direction stays put.
    const texel = worldTexelSize(LIGHTING.shadowFrustumM, shadowMapSize);
    computeSunFollow(followCenter, SUN_BASIS, SUN_OFFSET, texel, followTarget, followLight);

    light.position.set(followLight.x, followLight.y, followLight.z);
    light.target.position.set(followTarget.x, followTarget.y, followTarget.z);
    // light.target isn't in the scene graph, so scene.updateMatrixWorld() won't touch it —
    // update it here so the shadow camera reads the right look-at this frame.
    light.target.updateMatrixWorld();
  }, 0); // priority 0: runs before CameraFxSystem's priority-1 render (frameOrder.tsx)

  return (
    <directionalLight
      ref={lightRef}
      color={LIGHTING.sun.color}
      intensity={LIGHTING.sun.intensity}
      position={[SUN_OFFSET.x, SUN_OFFSET.y, SUN_OFFSET.z]}
      castShadow={shadowsOn}
      // A 1×1 map when shadows are off avoids allocating a real texture (castShadow is false
      // anyway, so nothing samples it).
      shadow-mapSize-width={shadowsOn ? shadowMapSize : 1}
      shadow-mapSize-height={shadowsOn ? shadowMapSize : 1}
      shadow-bias={LIGHTING.shadowBias}
      shadow-camera-near={LIGHTING.shadowNear}
      shadow-camera-far={LIGHTING.shadowFar}
      shadow-camera-left={-half}
      shadow-camera-right={half}
      shadow-camera-top={half}
      shadow-camera-bottom={-half}
    />
  );
}

/**
 * Blue-hour lighting rig. Owns the dusk key (via DuskKey, remounted on quality change), the
 * hemisphere ambient, and the scene-level sky/fog/tone-mapping state (applied imperatively,
 * with a cleanup that restores whatever was there before — game/index.tsx's flat `<color
 * background>` and the renderer's default tone mapping).
 */
export function BlueHourRig() {
  const quality = useGameStore((s) => s.settings.quality);
  const shadowMapSize = QUALITY_TIERS[quality].shadowMapSize;
  // The R3F store getter — returns the live {scene, gl,…} on demand. Reading through it (vs a
  // `useThree(s => s.scene)` selector) keeps the mutations below off the React Compiler's
  // immutability radar; these are genuinely mutable three objects that R3F expects us to poke.
  const get = useThree((s) => s.get);
  const hemiRef = useRef<HemisphereLight>(null);

  // Build the sky texture once; the effect below assigns/restores it, and this disposes it.
  const skyTexture = useMemo(() => makeSkyTexture(), []);
  useEffect(() => () => skyTexture.dispose(), [skyTexture]);

  // Scene/renderer state: sky background + matched fog + ACES tone mapping. Set on mount,
  // restored on unmount (the rig never renders — CameraFxSystem does; see the file header).
  useEffect(() => {
    const { scene, gl } = get();
    const prevBackground = scene.background;
    const prevFog = scene.fog;
    const prevToneMapping = gl.toneMapping;
    const prevExposure = gl.toneMappingExposure;

    scene.background = skyTexture;
    // Fog colour == the sky's horizon band so distant geometry dissolves into the horizon
    // cleanly (both go through the same tone mapping, so they stay matched on screen).
    scene.fog = new Fog(new Color(LIGHTING.sky.horizon), LIGHTING.fog.near, LIGHTING.fog.far);
    // Final tone-mapping/exposure pass (Phase 19): mode + exposure resolved (validated +
    // clamped) from config/rendering.ts. The background pass tone-maps the sky texture too,
    // so sky and geometry share one curve.
    const tm = resolveToneMapping();
    gl.toneMapping = THREE_TONE_MAPPING[tm.mode];
    gl.toneMappingExposure = tm.exposure;

    return () => {
      scene.background = prevBackground;
      scene.fog = prevFog;
      gl.toneMapping = prevToneMapping;
      gl.toneMappingExposure = prevExposure;
    };
  }, [get, skyTexture]);

  // Leva-live mood scalars: re-read exposure, fog range, and hemisphere intensity from the
  // (mutable) config each frame so the LIGHTING sliders move the picture without a reload.
  // Cheap scalar writes via the frame `state` (not a tracked hook value); priority 0 keeps
  // them before the render. Colours stay code-only (string leaves the leva schema skips) —
  // retune those in config/lighting.ts + HMR.
  useFrame((state) => {
    // Leva-live exposure: direct config read (zero-alloc hot path). The mount-time clamp in
    // resolveToneMapping() guards the shipped/persisted value; a dev drag stays a dev drag.
    state.gl.toneMappingExposure = RENDERING.toneMapping.exposure;
    const fog = state.scene.fog;
    if (fog instanceof Fog) {
      fog.near = LIGHTING.fog.near;
      fog.far = LIGHTING.fog.far;
    }
    if (hemiRef.current) hemiRef.current.intensity = LIGHTING.hemi.intensity;
  }, 0);

  return (
    <>
      <hemisphereLight
        ref={hemiRef}
        color={LIGHTING.hemi.skyColor}
        groundColor={LIGHTING.hemi.groundColor}
        intensity={LIGHTING.hemi.intensity}
      />
      <DuskKey key={`dusk-${quality}`} shadowMapSize={shadowMapSize} />
    </>
  );
}
