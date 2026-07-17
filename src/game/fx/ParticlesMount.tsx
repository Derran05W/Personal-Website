// The R3F skin over fx/particles.ts's simulation core: EXACTLY TWO InstancedMesh draw calls
// (one additive, one alpha) that render the whole shared 500-slot pool as camera-facing quad
// billboards. All the interesting logic — pooling, rationing, motion — lives in the sim
// (three-free, unit-tested); this file only advances the sim once per frame and uploads the
// live particles to instance buffers. It renders NOTHING by itself until a producer pushes a
// burst / attaches an emitter (fx/particleFeed.ts).
//
// TWO MATERIALS, TWO FADE STYLES (both use per-instance `instanceColor`, no depth sort):
//   • ADDITIVE mesh — sparks/embers/fire/arcs. AdditiveBlending + depthWrite off; a soft
//     round sprite (CanvasTexture) shapes each quad. Fade rides the COLOUR: colour·scalar,
//     and a black instance contributes nothing under additive blending (fx/Tracers.tsx's
//     "fade toward black is invisible" trick). No per-instance alpha needed.
//   • ALPHA mesh — smoke/matte debris. NormalBlending + depthWrite off; the same soft sprite.
//     Smoke must OCCLUDE, so it needs REAL per-instance transparency — instanceColor can't
//     carry alpha, so this mesh adds one extra per-instance float attribute `aOpacity` and a
//     3-line onBeforeCompile injection multiplies it into the fragment alpha. That is one
//     upload beyond the additive mesh's matrix+colour, and a deliberate, minimal deviation
//     from "one colour upload per material" — the honest cost of smoke that darkens the scene
//     instead of brightening it (Explosions.tsx's additive smoke can only ever add light).
//   Draw calls stay at exactly two. No depth sorting either way — additive is order-free, and
//   the part file explicitly accepts alpha-sort artifacts (low-poly style forgives them).
//
// BILLBOARDING: every instance's rotation is copied straight from the live camera quaternion
// (PlaneGeometry's default +Z front matches a camera-quaternion rotation exactly — the same
// no-atan2 trick as fx/Tracers.tsx / fx/Explosions.tsx). One shared quat per frame.
//
// FRAME SLOT: a plain priority-0 useFrame (like fx/SkidMarks.tsx) — runs before
// core/frameOrder.tsx's priority-1 camera pass that owns the render, so the buffers written
// here are current when the scene renders. Zero per-frame allocation (module-scope scratch).
//
// MOUNT CONTRACT: exported but NOT mounted here — the orchestrator wires it into
// game/index.tsx (inside <Physics>, alongside the other fx/* meshes). Owner-agnostic: it just
// polls the sim/feed, so registration order vs. producers never matters.

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  LinearFilter,
  Matrix4,
  MeshBasicMaterial,
  NormalBlending,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
  type InstancedMesh,
  type Texture,
} from 'three';
import { QUALITY_TIERS } from '../config';
import { useGameStore } from '../state/store';
import {
  PARTICLE_POOL_CAPACITY,
  getParticleBuffers,
  getParticleSpecs,
  resetParticles,
  setParticleBudget,
  updateParticles,
  MATERIAL_ADDITIVE,
} from './particles';

const CAP = PARTICLE_POOL_CAPACITY;

// --- module-scope scratch (no per-frame allocation) -----------------------------------------
const _pos = new Vector3();
const _scale = new Vector3();
const _mat = new Matrix4();
const _c = new Color();

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Soft round sprite shared by both meshes: white core → transparent rim. Under the additive
 * mesh its alpha (via the SrcAlpha blend factor) softens the glow; under the alpha mesh it is
 * the puff's actual silhouette. Same recipe as fx/Searchlight.tsx's ground spot. */
function buildSpriteTexture(): Texture | null {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const r = size / 2;
  const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export function ParticlesMount() {
  const additiveRef = useRef<InstancedMesh>(null);
  const alphaRef = useRef<InstancedMesh>(null);

  // Effective pool budget follows the live quality tier (config/quality.ts's particleCap):
  // low tier runs a smaller pool. Reactive so a mid-session quality change re-budgets.
  const quality = useGameStore((s) => s.settings.quality);
  useEffect(() => {
    setParticleBudget(QUALITY_TIERS[quality].particleCap);
  }, [quality]);

  const sprite = useMemo(() => buildSpriteTexture(), []);

  // Additive material: glow fades to black (invisible) — no per-instance alpha needed.
  const additiveMaterial = useMemo(
    () =>
      new MeshBasicMaterial({
        map: sprite,
        color: '#ffffff',
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    [sprite],
  );

  // Alpha material: real transparency via a per-instance `aOpacity` attribute injected into
  // the fragment alpha. `<color_fragment>` (instanceColor) and `<begin_vertex>` / `<common>`
  // are stable three chunks (verified against three 0.185); the injection multiplies vOpacity
  // into diffuseColor.a before it becomes gl_FragColor in `<opaque_fragment>`.
  const alphaMaterial = useMemo(() => {
    const m = new MeshBasicMaterial({
      map: sprite,
      color: '#ffffff',
      transparent: true,
      blending: NormalBlending,
      depthWrite: false,
    });
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aOpacity;\nvarying float vOpacity;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvOpacity = aOpacity;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vOpacity;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vOpacity;');
    };
    return m;
  }, [sprite]);

  // Plain quad for the additive mesh.
  const additiveGeometry = useMemo(() => new PlaneGeometry(1, 1), []);

  // Alpha quad carries the extra per-instance opacity attribute the onBeforeCompile injection
  // reads. The frame loop pulls it back off the geometry (alp.geometry.getAttribute) rather
  // than stashing it in a ref — writing a ref during render trips react-hooks/refs.
  const alphaGeometry = useMemo(() => {
    const g = new PlaneGeometry(1, 1);
    const attr = new InstancedBufferAttribute(new Float32Array(CAP), 1);
    attr.setUsage(DynamicDrawUsage);
    g.setAttribute('aOpacity', attr);
    return g;
  }, []);

  useEffect(() => {
    return () => {
      additiveGeometry.dispose();
      alphaGeometry.dispose();
      additiveMaterial.dispose();
      alphaMaterial.dispose();
      sprite?.dispose();
    };
  }, [additiveGeometry, alphaGeometry, additiveMaterial, alphaMaterial, sprite]);

  // Start empty: count 0 so frame 1 (before the first useFrame) draws nothing instead of CAP
  // identity-matrix quads at the origin. Buffers marked dynamic (rewritten most frames).
  useLayoutEffect(() => {
    // Drop any particles left from a previous mount/run so a (keyed) remount starts clean.
    // The feed's emitter Set is owned by its attach()/release() sources, not touched here.
    resetParticles();
    const add = additiveRef.current;
    const alp = alphaRef.current;
    if (add) {
      add.instanceMatrix.setUsage(DynamicDrawUsage);
      add.count = 0;
    }
    if (alp) {
      alp.instanceMatrix.setUsage(DynamicDrawUsage);
      alp.count = 0;
    }
  }, []);

  useFrame((state, dt) => {
    const add = additiveRef.current;
    const alp = alphaRef.current;
    if (!add || !alp) return;
    const opacityAttr = alp.geometry.getAttribute('aOpacity') as InstancedBufferAttribute | undefined;
    if (!opacityAttr) return;

    // Advance the sim first (spawn + integrate) so the buffers we read are this frame's state.
    const cam = state.camera.position;
    updateParticles(dt, cam.x, cam.y, cam.z);

    const b = getParticleBuffers();
    const specs = getParticleSpecs();
    const camQuat = state.camera.quaternion;
    const time = state.clock.elapsedTime;
    const opacity = opacityAttr.array as Float32Array;

    let addCount = 0;
    let alphaCount = 0;

    for (let i = 0; i < CAP; i += 1) {
      const l = b.life[i];
      if (l === 0) continue; // free slot

      const t = clamp01(b.age[i] / l);
      const spec = specs[b.specId[i]];
      const fade = spec.cfg.fade;
      const fin = fade.inFrac > 0 ? clamp01(t / fade.inFrac) : 1;
      const fout = Math.pow(1 - t, fade.outPow);
      let scalar = fin * fout;

      // Electrical/flame shimmer: jitter brightness per particle (sin over time + slot phase).
      if (spec.cfg.flicker) scalar *= 0.65 + 0.35 * Math.sin(time * 30 + i * 1.7);

      const sizeNow = b.size0[i] + (b.size1[i] - b.size0[i]) * t;
      _pos.set(b.px[i], b.py[i], b.pz[i]);
      _scale.setScalar(sizeNow);
      _mat.compose(_pos, camQuat, _scale);

      // The pool stores raw sRGB components (fx/particles.ts's hexToRgb); pass SRGBColorSpace
      // so setRGB converts to the linear working space — matching `new Color('#hex')` in
      // Tracers/Explosions — before any brightness scaling.
      if (spec.material === MATERIAL_ADDITIVE) {
        // Fade rides the colour → black = invisible under additive blending (scale in linear).
        _c.setRGB(b.cr[i], b.cg[i], b.cb[i], SRGBColorSpace).multiplyScalar(scalar);
        add.setMatrixAt(addCount, _mat);
        add.setColorAt(addCount, _c);
        addCount += 1;
      } else {
        // Colour stays true; fade rides the real per-instance opacity.
        _c.setRGB(b.cr[i], b.cg[i], b.cb[i], SRGBColorSpace);
        alp.setMatrixAt(alphaCount, _mat);
        alp.setColorAt(alphaCount, _c);
        opacity[alphaCount] = scalar * fade.peakOpacity;
        alphaCount += 1;
      }
    }

    add.count = addCount;
    alp.count = alphaCount;
    add.instanceMatrix.needsUpdate = true;
    if (add.instanceColor) add.instanceColor.needsUpdate = true;
    alp.instanceMatrix.needsUpdate = true;
    if (alp.instanceColor) alp.instanceColor.needsUpdate = true;
    opacityAttr.needsUpdate = true;
  });

  // frustumCulled off: particles spread across the whole finite map, far from these meshes'
  // own (small, near-origin) computed bounds — same reasoning as every other fx/* mesh. No
  // shadows: additive glow and translucent smoke shouldn't cast or catch them.
  return (
    <>
      <instancedMesh
        ref={additiveRef}
        args={[additiveGeometry, additiveMaterial, CAP]}
        frustumCulled={false}
        castShadow={false}
        receiveShadow={false}
      />
      <instancedMesh
        ref={alphaRef}
        args={[alphaGeometry, alphaMaterial, CAP]}
        frustumCulled={false}
        castShadow={false}
        receiveShadow={false}
      />
    </>
  );
}
