// Tank-shell explosion FX (Phase 12 Task 3; TDD §5.6 tank row / phase-12-plan.md Task 3).
// combat/explosion.ts (Task 1, a concurrent sibling — combat/* is off-limits to this task,
// combat/explosionFeed.ts doubly so per its own header) pushes one ExplosionRecord per
// detonation into explosionFeed.ts's ring buffer; this component POLLS that buffer every
// frame and renders it as pure FX — same one-way seam contract as fx/Tracers.tsx's read
// of combat/tracerFeed.ts.
//
// SHIPS IN PRODUCTION, same reasoning as fx/Tracers.tsx (never behind a DEV guard): a
// blast's own flash/shake IS the primary feedback that something just detonated.
//
// RENDERING MODEL — 2 InstancedMesh draw calls + up to 2 pooled real PointLights:
//   1) ONE InstancedMesh of camera-facing quads, capacity BLAST_POOL_CAP + SMOKE_COUNT:
//      instances [0, BLAST_POOL_CAP) are the expanding flash (one per blast, indexed by
//      ring-buffer slot — exactly fx/Tracers.tsx's muzzle-flash layout), instances
//      [BLAST_POOL_CAP, BLAST_POOL_CAP + SMOKE_COUNT) are smoke puffs (EXPLOSION.smoke.
//      puffsPerBlast per blast). Both fade with Tracers.tsx's additive "colour × intensity
//      → black is invisible" trick, so flash and smoke share one material/mesh/draw call.
//      Per-puff horizontal drift is a deterministic hash of the blast's own timestamp (see
//      hash01 below) rather than stored state — zero extra pool memory, stable frame to
//      frame because a given blast's `t` never changes while it's still in the feed.
//   2) ONE separate InstancedMesh of flat ground quads (EXPLOSION.scorch.poolSize = 24,
//      oldest-recycled ring buffer) for scorch decals. These persist far longer than the
//      flash/smoke (EXPLOSION.scorch.fadeSeconds = 25s), so unlike the age-driven flash/
//      smoke pool above, scorch marks are NOT simply re-derived from the live feed every
//      frame (the feed's own CAP=16 ring buffer would evict an old blast's record long
//      before its scorch mark should fade) — this pool tracks its own write cursor + per-
//      slot age, exactly fx/SkidMarks.tsx's SKID pool, and a mark is only ever written
//      once, the frame its blast is first observed (see `lastBlastT` below). Opaque
//      MeshStandardMaterial with SkidMarks' "fade toward the ground colour" trick (colour
//      lerps from EXPLOSION.scorch.color to SKID.colors.ground over fadeSeconds, then
//      hides) — no transparency, so 24 overlapping decals cost nothing extra to sort.
//   3) Up to EXPLOSION.light.maxConcurrent (= 2) real <pointLight>s, JSX-fixed at exactly 2
//      elements to match that cap (documented, hand-kept-in-sync — same duplication-by-
//      hand discipline Tracers.tsx applies to tracerFeed's private CAP). Assigned each
//      frame to the 0-2 most recent blasts still within EXPLOSION.light.maxAgeMs; unused
//      slots park at y=EXPLOSION.light.parkY with intensity 0, per the task brief.
//
// NEW-BLAST DETECTION (drives scorch spawn + camera shake, once per blast, not once per
// frame the blast is visible): explosionFeed's `blasts` array is append-only chronological
// (performance.now() timestamps only increase) until it hits its private CAP and starts
// shifting — so instead of tracking read position by array INDEX (which shifts under a
// full buffer, same reasoning Tracers.tsx's own header calls out), this tracks the highest
// `t` already processed (`lastBlastT`) and treats every blast with `t > lastBlastT` as new,
// in ascending order. A run restart (combat/explosion.ts's teardown calling
// clearExplosions()) shows up as `blasts.length` DROPPING between frames — the only way
// that ever happens outside this component's own control — which resets `lastBlastT` and
// clears the scorch pool so a new run doesn't inherit the last run's ground scars.
//
// HOT-PATH DISCIPLINE: all working vectors/colours/matrices are module-scope scratch,
// mutated in place — zero per-frame allocation, matching Tracers.tsx/SkidMarks.tsx.

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AdditiveBlending,
  Color,
  DynamicDrawUsage,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Vector3,
  type InstancedMesh,
  type PointLight,
} from 'three';
import { EXPLOSION, SKID } from '../config';
import { readExplosions, type ExplosionRecord } from '../combat/explosionFeed';
import { addShake } from './cameraRig';

// Must match combat/explosionFeed.ts's private ring-buffer CAP — see that file's header
// and this file's header above for why duplication-by-hand (not an export) is the pattern.
const BLAST_POOL_CAP = 16;
const PUFFS_PER_BLAST = EXPLOSION.smoke.puffsPerBlast;
const SMOKE_COUNT = BLAST_POOL_CAP * PUFFS_PER_BLAST;
// [0, BLAST_POOL_CAP) = flash quads, [BLAST_POOL_CAP, BLAST_POOL_CAP + SMOKE_COUNT) = smoke.
const QUAD_COUNT = BLAST_POOL_CAP + SMOKE_COUNT;

// JSX below renders exactly this many <pointLight> elements — kept in lockstep by hand
// with EXPLOSION.light.maxConcurrent (see file header point 3).
const LIGHT_COUNT = 2;

// --- module-scope scratch (no per-frame allocation) ----------------------------------------
const HIDDEN = new Matrix4().makeScale(0, 0, 0); // degenerate → renders nothing; never mutated
const BLACK = new Color(0, 0, 0);
const FLASH_COLOR = new Color(EXPLOSION.colors.flash);
const SMOKE_COLOR = new Color(EXPLOSION.smoke.color);
const SCORCH_FRESH = new Color(EXPLOSION.scorch.color);
const SCORCH_GROUND = new Color(SKID.colors.ground); // fade target — matches SkidMarks' own ground colour

const _pos = new Vector3();
const _scale = new Vector3();
const _mat = new Matrix4();
const _c = new Color();

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Cheap deterministic pseudo-random in [0,1), seeded by a plain number (a blast's own
 * timestamp ± a puff index). Stable across frames for the same input — no stored state
 * needed for "randomized" per-puff drift/rotation. */
function hash01(n: number): number {
  const x = Math.sin(n) * 43758.5453;
  return x - Math.floor(x);
}

// --- scorch pool runtime (persists across frames; SkidMarks.tsx's SKID pool shape) -------
interface ScorchRuntime {
  readonly age: Float32Array;
  readonly alive: Uint8Array;
  writeCursor: number;
}

function createScorchRuntime(): ScorchRuntime {
  return {
    age: new Float32Array(EXPLOSION.scorch.poolSize),
    alive: new Uint8Array(EXPLOSION.scorch.poolSize),
    writeCursor: 0,
  };
}

function hideScorchSlot(mesh: InstancedMesh, i: number): void {
  mesh.setMatrixAt(i, HIDDEN);
  mesh.setColorAt(i, SCORCH_GROUND);
}

function spawnScorch(mesh: InstancedMesh, rt: ScorchRuntime, blast: ExplosionRecord): void {
  const slot = rt.writeCursor;
  rt.writeCursor = (rt.writeCursor + 1) % EXPLOSION.scorch.poolSize;
  rt.alive[slot] = 1;
  rt.age[slot] = 0;

  const size = clamp(blast.radiusM * EXPLOSION.scorch.sizeScale, EXPLOSION.scorch.sizeMin, EXPLOSION.scorch.sizeMax);
  const rotY = hash01(blast.t * 0.37) * Math.PI * 2;

  _pos.set(blast.x, EXPLOSION.scorch.yOffset, blast.z);
  _mat.makeRotationY(rotY);
  _mat.scale(_scale.set(size, 1, size));
  _mat.setPosition(_pos);
  mesh.setMatrixAt(slot, _mat);
  mesh.setColorAt(slot, SCORCH_FRESH);
}

export function Explosions() {
  const quadRef = useRef<InstancedMesh>(null);
  const scorchRef = useRef<InstancedMesh>(null);
  const light0Ref = useRef<PointLight>(null);
  const light1Ref = useRef<PointLight>(null);

  // Lazy-ref-init (SkidMarks.tsx idiom): plain mutable runtime state, not reachable through
  // a useMemo (which react-hooks' immutability rule would treat as forever-frozen).
  const scorchRuntimeRef = useRef<ScorchRuntime | null>(null);
  if (scorchRuntimeRef.current === null) scorchRuntimeRef.current = createScorchRuntime();

  // Highest blast timestamp already turned into a scorch mark + shake hit. -Infinity means
  // "nothing processed yet" (also the post-reset value — see the shrink-detection below).
  const lastBlastTRef = useRef<number>(-Infinity);
  // Previous frame's blasts.length, to detect combat/explosion.ts's clearExplosions() —
  // the only way this number ever drops between frames (see file header).
  const prevLengthRef = useRef(0);
  // True once at least one blast has ever been observed — idle-frame skip, mirrors
  // Tracers.tsx's hadAnyRef.
  const hadAnyRef = useRef(false);

  const quadGeometry = useMemo(() => new PlaneGeometry(1, 1), []);
  const quadMaterial = useMemo(
    () =>
      new MeshBasicMaterial({
        color: '#ffffff',
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );

  // Ground quad: PlaneGeometry is XY (+Z normal); rotateX(-90°) lays it flat in XZ with a
  // +Y normal (SkidMarks.tsx's own geometry setup) so the per-instance matrix only needs
  // scale/rotationY/position.
  const scorchGeometry = useMemo(() => {
    const g = new PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);
    return g;
  }, []);
  const scorchMaterial = useMemo(
    () => new MeshStandardMaterial({ color: '#ffffff', roughness: 1, metalness: 0 }),
    [],
  );

  useEffect(() => {
    return () => {
      quadGeometry.dispose();
      quadMaterial.dispose();
      scorchGeometry.dispose();
      scorchMaterial.dispose();
    };
  }, [quadGeometry, quadMaterial, scorchGeometry, scorchMaterial]);

  // Hide every flash/smoke instance before first paint (Tracers.tsx's plain-useEffect
  // convention — an all-hidden additive pool has no visible "default matrix" risk).
  useEffect(() => {
    const mesh = quadRef.current;
    if (!mesh) return;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    for (let i = 0; i < QUAD_COUNT; i += 1) {
      mesh.setMatrixAt(i, HIDDEN);
      mesh.setColorAt(i, BLACK);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.setUsage(DynamicDrawUsage);
      mesh.instanceColor.needsUpdate = true;
    }
  }, []);

  // Hide every scorch slot before first paint — useLayoutEffect (SkidMarks.tsx's
  // convention for ground decals: no frame should ever render a default-matrix ground
  // quad, unlike the additive pool above which is safe either way).
  useLayoutEffect(() => {
    const mesh = scorchRef.current;
    if (!mesh) return;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    for (let i = 0; i < EXPLOSION.scorch.poolSize; i += 1) hideScorchSlot(mesh, i);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor?.setUsage(DynamicDrawUsage);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, []);

  useFrame((state, dt) => {
    const { blasts } = readExplosions();
    const count = blasts.length;
    if (count === 0 && !hadAnyRef.current) {
      prevLengthRef.current = 0;
      return; // nothing has ever detonated — idle skip
    }

    const quads = quadRef.current;
    const scorch = scorchRef.current;
    const rt = scorchRuntimeRef.current;
    if (!quads || !scorch || !rt) return;

    // --- run-restart detection: blasts.length only ever drops via clearExplosions() ------
    if (count < prevLengthRef.current) {
      for (let i = 0; i < EXPLOSION.scorch.poolSize; i += 1) {
        hideScorchSlot(scorch, i);
        rt.alive[i] = 0;
        rt.age[i] = 0;
      }
      scorch.instanceMatrix.needsUpdate = true;
      if (scorch.instanceColor) scorch.instanceColor.needsUpdate = true;
      rt.writeCursor = 0;
      lastBlastTRef.current = -Infinity;
    }
    prevLengthRef.current = count;

    const now = performance.now();
    const camQuat = state.camera.quaternion;
    let scorchMatrixDirty = false;
    let scorchColorDirty = false;

    // --- 1) new-blast pass: spawn scorch + camera shake, ascending by timestamp ----------
    let newestT = lastBlastTRef.current;
    for (let i = 0; i < count; i += 1) {
      const blast = blasts[i];
      if (blast.t <= lastBlastTRef.current) continue;
      spawnScorch(scorch, rt, blast);
      addShake(EXPLOSION.shakeStrength);
      scorchMatrixDirty = true;
      scorchColorDirty = true;
      if (blast.t > newestT) newestT = blast.t;
    }
    lastBlastTRef.current = newestT;

    // --- 2) flash + smoke: purely age-driven off the live feed, exactly Tracers.tsx's loop
    for (let i = 0; i < BLAST_POOL_CAP; i += 1) {
      if (i >= count) {
        quads.setMatrixAt(i, HIDDEN);
        for (let p = 0; p < PUFFS_PER_BLAST; p += 1) quads.setMatrixAt(BLAST_POOL_CAP + i * PUFFS_PER_BLAST + p, HIDDEN);
        continue;
      }
      const blast = blasts[i];
      const ageMs = now - blast.t;

      // flash
      if (ageMs <= EXPLOSION.flash.maxAgeMs) {
        const t = clamp01(ageMs / EXPLOSION.flash.maxAgeMs);
        const size = lerp(EXPLOSION.flash.sizeStart, EXPLOSION.flash.sizeEnd, t);
        const intensity = 1 - t;
        _pos.set(blast.x, blast.y, blast.z);
        _scale.setScalar(size);
        _mat.compose(_pos, camQuat, _scale);
        quads.setMatrixAt(i, _mat);
        quads.setColorAt(i, _c.copy(FLASH_COLOR).multiplyScalar(intensity));
      } else {
        quads.setMatrixAt(i, HIDDEN);
      }

      // smoke puffs
      for (let p = 0; p < PUFFS_PER_BLAST; p += 1) {
        const slot = BLAST_POOL_CAP + i * PUFFS_PER_BLAST + p;
        if (ageMs > EXPLOSION.smoke.maxAgeMs) {
          quads.setMatrixAt(slot, HIDDEN);
          continue;
        }
        const t = clamp01(ageMs / EXPLOSION.smoke.maxAgeMs);
        const angle = hash01(blast.t + p * 7.13) * Math.PI * 2;
        const radius = EXPLOSION.smoke.spreadM * t;
        const size = lerp(EXPLOSION.smoke.sizeStart, EXPLOSION.smoke.sizeEnd, t);
        const rise = (EXPLOSION.smoke.riseSpeed * ageMs) / 1000;
        _pos.set(blast.x + Math.cos(angle) * radius, blast.y + rise, blast.z + Math.sin(angle) * radius);
        _scale.setScalar(size);
        _mat.compose(_pos, camQuat, _scale);
        quads.setMatrixAt(slot, _mat);
        const intensity = (1 - t) * 0.8; // a touch dimmer than the flash so it reads as haze, not a second flash
        quads.setColorAt(slot, _c.copy(SMOKE_COLOR).multiplyScalar(intensity));
      }
    }

    // --- 3) scorch aging (dt-based fade toward SKID's ground colour). `dt` is useFrame's
    // own second argument (R3F's per-frame delta) — SkidMarks.tsx's convention, NOT a
    // second call to state.clock.getDelta() (which would double-consume the shared Clock
    // and desync every other system reading it this frame).
    for (let i = 0; i < EXPLOSION.scorch.poolSize; i += 1) {
      if (rt.alive[i] === 0) continue;
      rt.age[i] += dt;
      const t = clamp01(rt.age[i] / EXPLOSION.scorch.fadeSeconds);
      if (t >= 1) {
        hideScorchSlot(scorch, i);
        rt.alive[i] = 0;
        scorchMatrixDirty = true;
        scorchColorDirty = true;
      } else {
        _c.copy(SCORCH_FRESH).lerp(SCORCH_GROUND, t);
        scorch.setColorAt(i, _c);
        scorchColorDirty = true;
      }
    }

    // --- 4) pooled lights: light the 0-2 most recent blasts still within maxAgeMs -------
    // No temp array here (an array literal every frame would violate the zero-alloc
    // budget) — LIGHT_COUNT is hand-fixed at 2, so this just resolves two blast indices
    // with plain loop-scoped numbers and drives light0Ref/light1Ref directly below.
    const maxConcurrent = EXPLOSION.light.maxConcurrent < LIGHT_COUNT ? EXPLOSION.light.maxConcurrent : LIGHT_COUNT;
    let light0BlastIdx = -1;
    let light1BlastIdx = -1;
    let picked = 0;
    for (let i = count - 1; i >= 0 && picked < maxConcurrent; i -= 1) {
      const ageMs = now - blasts[i].t;
      if (ageMs > EXPLOSION.light.maxAgeMs) break; // older entries scanning backward are only older still
      if (picked === 0) light0BlastIdx = i;
      else light1BlastIdx = i;
      picked += 1;
    }

    const light0 = light0Ref.current;
    if (light0) {
      if (light0BlastIdx >= 0) {
        const blast = blasts[light0BlastIdx];
        const t = clamp01((now - blast.t) / EXPLOSION.light.maxAgeMs);
        light0.position.set(blast.x, blast.y, blast.z);
        light0.intensity = EXPLOSION.light.intensity * (1 - t);
      } else {
        light0.intensity = 0;
        light0.position.set(0, EXPLOSION.light.parkY, 0);
      }
    }
    const light1 = light1Ref.current;
    if (light1) {
      if (light1BlastIdx >= 0) {
        const blast = blasts[light1BlastIdx];
        const t = clamp01((now - blast.t) / EXPLOSION.light.maxAgeMs);
        light1.position.set(blast.x, blast.y, blast.z);
        light1.intensity = EXPLOSION.light.intensity * (1 - t);
      } else {
        light1.intensity = 0;
        light1.position.set(0, EXPLOSION.light.parkY, 0);
      }
    }

    quads.instanceMatrix.needsUpdate = true;
    if (quads.instanceColor) quads.instanceColor.needsUpdate = true;
    if (scorchMatrixDirty) scorch.instanceMatrix.needsUpdate = true;
    if (scorchColorDirty && scorch.instanceColor) scorch.instanceColor.needsUpdate = true;

    hadAnyRef.current = true;
  });

  // frustumCulled off on both meshes: blasts can land anywhere across the finite map, far
  // from these meshes' own (small, near-origin) computed bounding volumes — same reasoning
  // as fx/Tracers.tsx / fx/SkidMarks.tsx. No shadows: additive FX and flat decals shouldn't
  // cast or catch them.
  return (
    <>
      <instancedMesh
        ref={quadRef}
        args={[quadGeometry, quadMaterial, QUAD_COUNT]}
        frustumCulled={false}
        castShadow={false}
        receiveShadow={false}
      />
      <instancedMesh
        ref={scorchRef}
        args={[scorchGeometry, scorchMaterial, EXPLOSION.scorch.poolSize]}
        frustumCulled={false}
        castShadow={false}
        receiveShadow={false}
      />
      <pointLight
        ref={light0Ref}
        intensity={0}
        distance={EXPLOSION.light.distance}
        color={EXPLOSION.light.color}
        position={[0, EXPLOSION.light.parkY, 0]}
      />
      <pointLight
        ref={light1Ref}
        intensity={0}
        distance={EXPLOSION.light.distance}
        color={EXPLOSION.light.color}
        position={[0, EXPLOSION.light.parkY, 0]}
      />
    </>
  );
}
