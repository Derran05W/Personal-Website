// Pooled tracer/muzzle-flash/hit-spark FX for ★4 gun-truck hitscan bursts (Phase 11 Task
// 3; TDD §5.6 row 4 / phase-11-plan.md Task 3). combat/hitscan.ts (Task 2, a concurrent
// sibling — combat/* and tracerFeed.ts itself are both off-limits to this task) pushes one
// TracerShot per fired round into combat/tracerFeed.ts's ring buffer; this component POLLS
// that buffer every frame and renders it as pure FX. It never reads gameplay state beyond
// the feed and never writes back into it — a strictly one-way seam, per tracerFeed.ts's
// own header comment.
//
// SHIPS IN PRODUCTION — unlike the debug-only ai/GunTruckAimViz.tsx sibling this task also
// adds, this is real gameplay feedback (getting shot must telegraph), so it must be an
// eager, always-mounted import wherever it's wired in (mirrors fx/SkidMarks.tsx's mount
// contract), never behind an `import.meta.env.DEV` guard.
//
// RENDERING MODEL — exactly 2 draw calls total, zero per-frame allocation:
//   1) ONE LineSegments, one segment per pooled shot (muzzle → hit point). Fade is
//      expressed by lerping each vertex's COLOR toward black as the shot ages, not by
//      alpha — the material is additive with depth-write off, so a black segment
//      contributes nothing to the frame. This is fx/SkidMarks.tsx's "no-transparency fade
//      trick" adapted to additive blending: SkidMarks fades toward the ground colour under
//      normal blending, this fades toward black because additive-black IS invisible. No
//      alpha sorting cost, no alpha test.
//   2) ONE InstancedMesh of camera-facing quads, capacity 2×POOL_CAP: instances
//      [0, POOL_CAP) are muzzle flashes (indexed by ring-buffer slot), instances
//      [POOL_CAP, 2×POOL_CAP) are hit sparks (slot + POOL_CAP). "Camera-facing" = every
//      instance's rotation is copied straight from the live camera's quaternion each frame
//      (PlaneGeometry's default +Z-facing front matches a camera-quaternion rotation
//      exactly — standard three.js billboard trick, no per-instance lookAt/atan2 needed).
//      Same black-fade trick as the beam; a slot with nothing to show gets a degenerate
//      zero-scale matrix (SkidMarks.tsx's HIDDEN convention) so it rasterizes nothing.
//
// POOL_CAP mirrors combat/tracerFeed.ts's private `CAP = 64` ring-buffer size. That
// constant is NOT exported (tracerFeed.ts is a do-not-modify seam file per this task's
// brief), so the value is duplicated here BY HAND — if tracerFeed.ts's CAP ever changes,
// update POOL_CAP to match (a stale/smaller POOL_CAP would silently under-render the tail
// of a saturated buffer; a larger one just wastes a few unused pool slots).
//
// UPDATE STRATEGY: per the task brief, "rebuild only when version changes OR ages advance
// (cheap: always rewrite ≤64 quads)". Ages advance every real frame a shot is still
// fading, so in practice this rewrites the full live slice every frame the feed is
// non-empty — readTracers().shots only ever GROWS from 0 up to POOL_CAP (tracerFeed shifts
// the oldest out, it never shrinks the array), so the only real optimization worth doing
// is skipping all of this before the very first shot of the session ever fires
// (`hadAnyRef` below).

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  LineBasicMaterial,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector3,
  type BufferAttribute,
  type InstancedMesh,
  type LineSegments,
} from 'three';
import { TRACER } from '../config';
import { readTracers } from '../combat/tracerFeed';

// Must match combat/tracerFeed.ts's private ring-buffer CAP — see file header above.
const POOL_CAP = 64;
// [0, POOL_CAP) = muzzle flashes, [POOL_CAP, 2*POOL_CAP) = hit sparks.
const QUAD_COUNT = POOL_CAP * 2;

// --- module-scope scratch (no per-frame allocation) ----------------------------------------
const HIDDEN = new Matrix4().makeScale(0, 0, 0); // degenerate → renders nothing; never mutated
const BLACK = new Color(0, 0, 0);
const BEAM_COLOR = new Color(TRACER.colors.beam);
const MUZZLE_COLOR = new Color(TRACER.colors.muzzleFlash);
const SPARK_COLOR = new Color(TRACER.colors.hitSpark);

const _pos = new Vector3();
const _scale = new Vector3();
const _mat = new Matrix4();
const _c = new Color();

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function Tracers() {
  const lineRef = useRef<LineSegments>(null);
  const quadRef = useRef<InstancedMesh>(null);
  // True once at least one shot has ever been rendered — lets the idle path (no gun trucks
  // yet / pre-first-shot) skip all per-frame work instead of rewriting POOL_CAP empty slots
  // every frame for the entire run up to that point.
  const hadAnyRef = useRef(false);

  const lineGeometry = useMemo(() => {
    const g = new BufferGeometry();
    const position = new Float32BufferAttribute(new Float32Array(POOL_CAP * 2 * 3), 3);
    position.setUsage(DynamicDrawUsage);
    const color = new Float32BufferAttribute(new Float32Array(POOL_CAP * 2 * 3), 3);
    color.setUsage(DynamicDrawUsage);
    g.setAttribute('position', position);
    g.setAttribute('color', color);
    g.setDrawRange(0, 0);
    return g;
  }, []);

  const lineMaterial = useMemo(
    () =>
      new LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );

  // Shared 1x1 quad (centered, +Z-facing front) for both muzzle-flash and hit-spark
  // billboards — same geometry, different per-instance scale/colour.
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

  useEffect(() => {
    return () => {
      lineGeometry.dispose();
      lineMaterial.dispose();
      quadGeometry.dispose();
      quadMaterial.dispose();
    };
  }, [lineGeometry, lineMaterial, quadGeometry, quadMaterial]);

  // Hide every quad instance before first paint (SkidMarks.tsx's init convention, adapted:
  // a plain useEffect is fine here — unlike SkidMarks there is no visible "default matrix"
  // risk on frame 1, an all-hidden pool is simply the correct starting state either way).
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

  useFrame((state) => {
    const { shots } = readTracers();
    const count = shots.length;
    if (count === 0 && !hadAnyRef.current) return; // nothing has ever fired — idle skip

    const line = lineRef.current;
    const quads = quadRef.current;
    if (!line || !quads) return;

    const positions = lineGeometry.getAttribute('position') as BufferAttribute;
    const colors = lineGeometry.getAttribute('color') as BufferAttribute;
    const now = performance.now();
    const camQuat = state.camera.quaternion; // shared by every billboard this frame

    for (let i = 0; i < POOL_CAP; i += 1) {
      if (i >= count) {
        quads.setMatrixAt(i, HIDDEN);
        quads.setMatrixAt(POOL_CAP + i, HIDDEN);
        continue;
      }
      const shot = shots[i];
      const ageMs = now - shot.t;
      const o = i * 6;

      // --- beam: muzzle → hit/max-range point, colour fades to black over beamMaxAgeMs ---
      positions.array[o + 0] = shot.x0;
      positions.array[o + 1] = shot.y0;
      positions.array[o + 2] = shot.z0;
      positions.array[o + 3] = shot.x1;
      positions.array[o + 4] = shot.y1;
      positions.array[o + 5] = shot.z1;
      const beamIntensity = ageMs <= TRACER.beamMaxAgeMs ? 1 - clamp01(ageMs / TRACER.beamMaxAgeMs) : 0;
      _c.copy(BEAM_COLOR).multiplyScalar(beamIntensity);
      colors.array[o + 0] = _c.r;
      colors.array[o + 1] = _c.g;
      colors.array[o + 2] = _c.b;
      colors.array[o + 3] = _c.r;
      colors.array[o + 4] = _c.g;
      colors.array[o + 5] = _c.b;

      // --- muzzle flash: camera-facing quad at x0, age < muzzleFlashMaxAgeMs ---
      if (ageMs <= TRACER.muzzleFlashMaxAgeMs) {
        const intensity = 1 - clamp01(ageMs / TRACER.muzzleFlashMaxAgeMs);
        _pos.set(shot.x0, shot.y0, shot.z0);
        _scale.setScalar(TRACER.muzzleFlashSize);
        _mat.compose(_pos, camQuat, _scale);
        quads.setMatrixAt(i, _mat);
        quads.setColorAt(i, _c.copy(MUZZLE_COLOR).multiplyScalar(intensity));
      } else {
        quads.setMatrixAt(i, HIDDEN);
      }

      // --- hit spark: camera-facing quad at x1, only when the round struck something ---
      if (shot.hit && ageMs <= TRACER.hitSparkMaxAgeMs) {
        const intensity = 1 - clamp01(ageMs / TRACER.hitSparkMaxAgeMs);
        _pos.set(shot.x1, shot.y1, shot.z1);
        _scale.setScalar(TRACER.hitSparkSize);
        _mat.compose(_pos, camQuat, _scale);
        quads.setMatrixAt(POOL_CAP + i, _mat);
        quads.setColorAt(POOL_CAP + i, _c.copy(SPARK_COLOR).multiplyScalar(intensity));
      } else {
        quads.setMatrixAt(POOL_CAP + i, HIDDEN);
      }
    }

    positions.needsUpdate = true;
    colors.needsUpdate = true;
    lineGeometry.setDrawRange(0, count * 2);
    quads.instanceMatrix.needsUpdate = true;
    if (quads.instanceColor) quads.instanceColor.needsUpdate = true;

    hadAnyRef.current = true;
  });

  // frustumCulled off on both meshes: shots can land anywhere across the finite map, far
  // from these meshes' own (small, near-origin) computed bounding volumes — same reasoning
  // as fx/SkidMarks.tsx. No shadows: additive FX shouldn't cast or catch them.
  return (
    <>
      <lineSegments ref={lineRef} geometry={lineGeometry} material={lineMaterial} frustumCulled={false} />
      <instancedMesh
        ref={quadRef}
        args={[quadGeometry, quadMaterial, QUAD_COUNT]}
        frustumCulled={false}
        castShadow={false}
        receiveShadow={false}
      />
    </>
  );
}
