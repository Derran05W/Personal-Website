// Ambient-helicopter visuals (Phase 14 Task 2; TDD §5.7). Renders every live slot of
// ai/heliTypes.ts's `heliRef` (the seam — ai/helicopter.ts, a concurrent sibling task, owns
// the flight model / lifecycle and WRITES those slots; this module only READS them, exactly
// like ai/TrafficMesh.tsx reads `trafficRef` and ai/units/*Mesh.tsx read `unitsRef`). No
// physics, no registry entry, no step hooks — a heli is purely a rendered pose (TDD §5.7 "no
// gameplay effect in v1"), so unlike every unit mesh in ai/units/, this component is NOT also
// a system mount: it neither registers a factory nor drives a tick list.
//
// THREE DRAW CALLS, capacity 2 each (ai/heliTypes.ts: "length 2 (slot 1 used only at ★5)"):
//   1) BODY   — the procedural fuselage (world/geometry/helicopter.ts's buildHeliBody()),
//               tinted per-livery (see LIVERY_TINT below).
//   2) ROTOR  — the main-rotor blade primitive (buildHeliRotorBlade()), spun live from
//               slot.rotor. The tail rotor is a STATIC stub baked into the body instead of a
//               third instanced part — see world/geometry/helicopter.ts's file header for why.
//   3) BLOB   — a flat, dark, semi-transparent ground quad under each heli (the "cheap
//               grounding trick" the task brief calls for) — its own tiny MeshBasicMaterial,
//               not the shared palette material (it isn't part of the palette atlas at all).
// Both BODY and ROTOR reuse world/palette.ts's ONE shared city material — their geometry bakes
// UVs against that same atlas (world/geometry/helicopter.ts), so sharing it costs nothing extra
// and keeps the "one texture for every instanced thing" rule intact; it does NOT collapse them
// into one draw call (each InstancedMesh is still its own draw call regardless of material
// sharing) — 3 extra draw calls total for at most 2 ambient helis is well inside TDD §10's
// budget.
//
// LIVERY = INSTANCE TINT OVER ONE CANONICAL GEOMETRY (task brief's explicit ask). The full
// "why white reproduces a two-tone police look" rationale lives in
// world/geometry/helicopter.ts's file header (buildHeliBody) — short version: POLICE's tint is
// the identity colour (white), so the body's baked liveryWhite hull AND its baked policeBlue
// tail-fin accent both render exactly as authored (white hull, blue fin = "police blue/white").
// SWAT and MILITARY just darken/recolour the whole assembly uniformly (near-black / drab olive)
// — no per-livery geometry branch anywhere in this file.
//
// ORIENTATION CONVENTION (this file's contribution to the seam — ai/helicopter.ts, once it
// lands, should sanity-check its bank sign against this during Phase 14 integration): body
// quaternion = qYaw(slot.yaw, world Y) * qRoll(slot.bank, the PRE-yaw local Z / forward axis).
// Rolling about Z before yaw tips the craft sideways around its own nose (which sits ON the Z
// axis pre-yaw, so roll doesn't move it), then yaw carries the whole tilted assembly — including
// its now-yawed nose — to the heading. That composition is exactly "bank into the turn," and
// matches ai/TrafficMesh.tsx's plain `setFromAxisAngle(Y_AXIS, yaw)` when bank = 0.
//
// ROTOR SPIN composes UNDER the body orientation (rigid-mast model): spin about local Y happens
// first (in the rotor's own unrotated frame), then the body's yaw+bank tilts/turns the whole
// spinning assembly together with the fuselage — so a banked heli's rotor disk visibly tilts
// with it, not independently.
//
// PRESENCE (slot.presence, 0..1 fly-in/out fade) uniformly scales BOTH the body and the rotor
// (so a fading-out heli shrinks as one rigid unit, no seam between fuselage and blades) and the
// ground blob's radius (see BLOB_RADIUS_M below) — no per-part fade timing, kept simple on
// purpose for an ambient background element.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type InstancedMesh,
} from 'three';
import { buildHeliBody, buildHeliRotorBlade, HELI_BODY } from '../world/geometry/helicopter';
import { getCityMaterial } from '../world/palette';
import { heliRef, type HeliLivery } from './heliTypes';

// Slot count is fixed by the seam contract (heliTypes.ts) — both real InstancedMeshes below are
// allocated at this capacity once, at mount (same "fixed pool, capacity from a constant, never
// resized live" discipline as ai/units/TankMesh.tsx's CAPACITY).
const CAPACITY = 2;

// --- Livery tints (canonical-geometry + instance-tint trick — full rationale in
// world/geometry/helicopter.ts's file header). ---------------------------------------------
const LIVERY_TINT: Record<HeliLivery, Color> = {
  police: new Color(1, 1, 1), // identity — body renders exactly as baked (white hull + blue fin)
  swat: new Color('#1c1d20'), // near-black, unmarked (matches ai/units/SwatMesh.tsx)
  military: new Color('#57683f'), // drab olive (matches ai/units/tank.ts's militaryGreen family)
};

// Rotor mount offset: directly above the hull center at the mast tip (world/geometry/
// helicopter.ts's HELI_BODY.rotorHubY) — rotated into the body's frame per-instance below.
const ROTOR_HUB_LOCAL = new Vector3(0, HELI_BODY.rotorHubY, 0);

// Drop-shadow blob (ground grounding trick — brief's "your call, document"): a flat, dark,
// semi-transparent square pinned to the ground plane directly under each heli's XZ position,
// regardless of its actual altitude. Presence scales its RADIUS toward 0 (not its opacity) —
// the same "fade via scale/transform, not per-instance alpha" cost discipline fx/
// TankTelegraph.tsx's quads use. Square, not circular — matches every other ground decal in
// this codebase (fx/SkidMarks.tsx, fx/Explosions.tsx); a soft radial falloff would need its own
// alpha texture, not worth it for a background element nobody stares at.
const BLOB_RADIUS_M = 3.2;
// Matches fx.ts SKID.yOffset's ground-clearance convention (slab top y=0, road surface y=0.01).
const BLOB_Y = 0.03;

const WHITE = new Color(1, 1, 1);
const ZERO_MATRIX = new Matrix4().makeScale(0, 0, 0);
const Y_AXIS = new Vector3(0, 1, 0);
const Z_AXIS = new Vector3(0, 0, 1);

// Hot-path scratch (module scope — the useFrame body allocates nothing per instance).
const _dummy = new Object3D();
const _qYaw = new Quaternion();
const _qRoll = new Quaternion();
const _qSpin = new Quaternion();
const _bodyQuat = new Quaternion();
const _hubOffset = new Vector3();
const _blobIdentity = new Quaternion();
const _blobPos = new Vector3();
const _blobScale = new Vector3();
const _blobMat = new Matrix4();

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function HeliMesh() {
  const bodyRef = useRef<InstancedMesh>(null);
  const rotorRef = useRef<InstancedMesh>(null);
  const blobRef = useRef<InstancedMesh>(null);

  // aEmissiveOn: the shared palette material samples it unconditionally (world/palette.ts) —
  // allocated all-zero and never rewritten, same as ai/TrafficMesh.tsx (helis carry no
  // emissive parts in v1 — no strobe, matching ai/units/SwatMesh.tsx's unmarked convention).
  const bodyGeometry = useMemo(() => {
    const g = buildHeliBody();
    const attr = new InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
    attr.setUsage(DynamicDrawUsage);
    g.setAttribute('aEmissiveOn', attr);
    return g;
  }, []);
  const rotorGeometry = useMemo(() => {
    const g = buildHeliRotorBlade();
    const attr = new InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
    attr.setUsage(DynamicDrawUsage);
    g.setAttribute('aEmissiveOn', attr);
    return g;
  }, []);
  const blobGeometry = useMemo(() => {
    const g = new PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2); // lie flat in XZ, +Y normal — fx/SkidMarks.tsx's exact trick
    return g;
  }, []);

  const material = useMemo(() => getCityMaterial(), []);
  const blobMaterial = useMemo(
    () =>
      new MeshBasicMaterial({
        color: '#05070a',
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );

  useEffect(() => () => bodyGeometry.dispose(), [bodyGeometry]);
  useEffect(() => () => rotorGeometry.dispose(), [rotorGeometry]);
  useEffect(() => {
    return () => {
      blobGeometry.dispose();
      blobMaterial.dispose();
    };
  }, [blobGeometry, blobMaterial]);
  // The shared city material is a memoized singleton (world/palette.ts) — never disposed here,
  // matching every other getCityMaterial() consumer.

  // Initial fill: every instance hidden, colours allocated (irrelevant while hidden).
  useEffect(() => {
    for (const mesh of [bodyRef.current, rotorRef.current]) {
      if (mesh === null) continue;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      for (let i = 0; i < CAPACITY; i++) {
        mesh.setMatrixAt(i, ZERO_MATRIX);
        mesh.setColorAt(i, WHITE);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) {
        mesh.instanceColor.setUsage(DynamicDrawUsage);
        mesh.instanceColor.needsUpdate = true;
      }
    }
    const blob = blobRef.current;
    if (blob !== null) {
      blob.instanceMatrix.setUsage(DynamicDrawUsage);
      for (let i = 0; i < CAPACITY; i++) blob.setMatrixAt(i, ZERO_MATRIX);
      blob.instanceMatrix.needsUpdate = true;
    }
  }, []);

  useFrame(() => {
    const body = bodyRef.current;
    const rotor = rotorRef.current;
    const blob = blobRef.current;
    if (body === null || rotor === null || blob === null) return;

    const slots = heliRef.current?.slots;

    for (let i = 0; i < CAPACITY; i++) {
      const slot = slots?.[i];
      if (slot === undefined || slot.livery === null) {
        body.setMatrixAt(i, ZERO_MATRIX);
        rotor.setMatrixAt(i, ZERO_MATRIX);
        blob.setMatrixAt(i, ZERO_MATRIX);
        continue;
      }

      const presence = clamp01(slot.presence);

      // Body orientation — see file header's ORIENTATION CONVENTION note.
      _qYaw.setFromAxisAngle(Y_AXIS, slot.yaw);
      _qRoll.setFromAxisAngle(Z_AXIS, slot.bank);
      _bodyQuat.copy(_qYaw).multiply(_qRoll);

      _dummy.position.set(slot.x, slot.y, slot.z);
      _dummy.quaternion.copy(_bodyQuat);
      _dummy.scale.setScalar(presence);
      _dummy.updateMatrix();
      body.setMatrixAt(i, _dummy.matrix);
      body.setColorAt(i, LIVERY_TINT[slot.livery]);

      // Rotor — hub offset rotated into the body's frame; spin composed UNDER the body
      // orientation (rigid-mast model, see file header).
      _hubOffset.copy(ROTOR_HUB_LOCAL).applyQuaternion(_bodyQuat);
      _qSpin.setFromAxisAngle(Y_AXIS, slot.rotor);
      _dummy.position.set(slot.x + _hubOffset.x, slot.y + _hubOffset.y, slot.z + _hubOffset.z);
      _dummy.quaternion.copy(_bodyQuat).multiply(_qSpin);
      _dummy.scale.setScalar(presence);
      _dummy.updateMatrix();
      rotor.setMatrixAt(i, _dummy.matrix);

      // Drop-shadow blob — pinned to the ground plane directly under the heli's XZ position;
      // presence scales its radius toward 0 (see BLOB_RADIUS_M's doc comment above).
      _blobPos.set(slot.x, BLOB_Y, slot.z);
      _blobScale.set(BLOB_RADIUS_M * presence, 1, BLOB_RADIUS_M * presence);
      _blobMat.compose(_blobPos, _blobIdentity, _blobScale);
      blob.setMatrixAt(i, _blobMat);
    }

    body.instanceMatrix.needsUpdate = true;
    if (body.instanceColor !== null) body.instanceColor.needsUpdate = true;
    rotor.instanceMatrix.needsUpdate = true;
    blob.instanceMatrix.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh ref={bodyRef} args={[bodyGeometry, material, CAPACITY]} frustumCulled={false} castShadow />
      <instancedMesh
        ref={rotorRef}
        args={[rotorGeometry, material, CAPACITY]}
        frustumCulled={false}
        castShadow={false}
      />
      <instancedMesh
        ref={blobRef}
        args={[blobGeometry, blobMaterial, CAPACITY]}
        frustumCulled={false}
        castShadow={false}
        receiveShadow={false}
      />
    </>
  );
}
