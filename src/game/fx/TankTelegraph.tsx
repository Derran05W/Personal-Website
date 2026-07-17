// Tank turret telegraph FX (Phase 12 Task 3; TDD §5.6 tank row "barrel glow + laser dot" —
// the ★5 counterplay tell: TANK.telegraphSec = 0.8 s of visible warning before a shell
// leaves the barrel, long enough to juke). SHIPS IN PRODUCTION (not DEV-gated), same
// reasoning as fx/Tracers.tsx / fx/Explosions.tsx: "about to get shelled" IS the primary
// gameplay signal a player reacts to, not a debug aid.
//
// INTEGRATION — ai/units/tank.ts (Task 2, a concurrent sibling that had not landed as of
// this file's FIRST draft — see phase-12-plan.md Task 2/3; it landed before this file's
// finish) exports getTankTelegraph(slotId): TankTelegraph | undefined exactly mirroring
// ai/units/gunTruck.ts's getGunTruckTurretYaw(slotId) publication pattern that
// ai/GunTruckAimViz.tsx already consumes by direct import — so this file does the same.
// tank.ts's TankTelegraph shape is `{ phase: 'idle'|'telegraph', progress01, aimPoint,
// barrelTip }`; `active` below is just `phase === 'telegraph'`.
//
// BARREL GLOW lives on TankMesh.tsx instead, NOT here: it drives its own turret+barrel
// InstancedMesh's per-instance aEmissiveOn straight off this same getTankTelegraph seam
// (see that file's header — "only the muzzle-tip faces carry a warm emissive cell... Task
// 3's FX layer reads the SAME getTankTelegraph seam for the ground laser dot + the
// explosion"). That's the task brief's PREFERRED path ("if TankMesh exposes a per-instance
// emissive hook use it") and it landed before this file's finish, so the billboard-quad
// glow fallback described in the brief was written, then removed once TankMesh's real hook
// showed up — no reason to double up a warm muzzle glow with a second, worse-fitting flat
// quad glued to the same spot. This file owns only what TankMesh can't: the ground-plane
// laser telling the PLAYER where the shot is aimed.
//
// RENDERING MODEL — 2 draw calls, zero per-frame allocation:
//   1) ONE LineSegments, one segment per live telegraph (TANK_TELEGRAPH.maxLines capacity) —
//      barrel tip → aim point, colour intensity ramps with progress01 (GunTruckAimViz.tsx's
//      vertex-colour LineSegments setup, but a single ramping colour instead of a green/red
//      verdict).
//   2) ONE InstancedMesh of camera-facing quads, capacity maxLines — the aim-point dot only.

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
import { TANK_TELEGRAPH } from '../config';
import { unitsRef } from '../ai/pursuitTypes';
import { getTankTelegraph } from '../ai/units/tank';

// --- module-scope scratch (no per-frame allocation) ----------------------------------------
const MAX_LINES = TANK_TELEGRAPH.maxLines;
const QUAD_COUNT = MAX_LINES; // aim-point dot only — see file header for barrel glow's home

const HIDDEN = new Matrix4().makeScale(0, 0, 0); // degenerate → renders nothing; never mutated
const BLACK = new Color(0, 0, 0);
const LINE_COLOR = new Color(TANK_TELEGRAPH.lineColor);
const DOT_COLOR = new Color(TANK_TELEGRAPH.dotColor);

const _pos = new Vector3();
const _scale = new Vector3();
const _mat = new Matrix4();
const _c = new Color();

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function TankTelegraph() {
  const lineRef = useRef<LineSegments>(null);
  const quadRef = useRef<InstancedMesh>(null);
  // Idle-skip once nothing has ever been live — mirrors Tracers.tsx's hadAnyRef. Cheap either
  // way (MAX_LINES is tiny), but keeps the pattern consistent with this task's other FX.
  const hadAnyRef = useRef(false);

  const lineGeometry = useMemo(() => {
    const g = new BufferGeometry();
    const position = new Float32BufferAttribute(new Float32Array(MAX_LINES * 2 * 3), 3);
    position.setUsage(DynamicDrawUsage);
    const color = new Float32BufferAttribute(new Float32Array(MAX_LINES * 2 * 3), 3);
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
    const slots = unitsRef.current?.slots;
    if (!slots || slots.length === 0) {
      if (!hadAnyRef.current) return;
    }

    const line = lineRef.current;
    const quads = quadRef.current;
    if (!line || !quads) return;

    const positions = lineGeometry.getAttribute('position') as BufferAttribute;
    const colors = lineGeometry.getAttribute('color') as BufferAttribute;
    const camQuat = state.camera.quaternion;

    let seg = 0;
    if (slots) {
      for (const slot of slots) {
        if (seg >= MAX_LINES) break;
        if (slot.kind !== 'tank' || slot.state !== 'pursuing') continue;
        const snap = getTankTelegraph(slot.id);
        if (!snap || snap.phase !== 'telegraph') continue;

        const intensity = clamp01(snap.progress01);
        const o = seg * 6;
        positions.array[o + 0] = snap.barrelTip.x;
        positions.array[o + 1] = snap.barrelTip.y;
        positions.array[o + 2] = snap.barrelTip.z;
        positions.array[o + 3] = snap.aimPoint.x;
        positions.array[o + 4] = snap.aimPoint.y;
        positions.array[o + 5] = snap.aimPoint.z;
        _c.copy(LINE_COLOR).multiplyScalar(intensity);
        colors.array[o + 0] = _c.r;
        colors.array[o + 1] = _c.g;
        colors.array[o + 2] = _c.b;
        colors.array[o + 3] = _c.r;
        colors.array[o + 4] = _c.g;
        colors.array[o + 5] = _c.b;

        // aim dot
        _pos.set(snap.aimPoint.x, snap.aimPoint.y, snap.aimPoint.z);
        _scale.setScalar(TANK_TELEGRAPH.dotSize);
        _mat.compose(_pos, camQuat, _scale);
        quads.setMatrixAt(seg, _mat);
        quads.setColorAt(seg, _c.copy(DOT_COLOR).multiplyScalar(intensity));

        seg += 1;
      }
    }

    for (let i = seg; i < MAX_LINES; i += 1) {
      quads.setMatrixAt(i, HIDDEN);
    }

    positions.needsUpdate = true;
    colors.needsUpdate = true;
    lineGeometry.setDrawRange(0, seg * 2);
    quads.instanceMatrix.needsUpdate = true;
    if (quads.instanceColor) quads.instanceColor.needsUpdate = true;

    if (seg > 0) hadAnyRef.current = true;
  });

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
