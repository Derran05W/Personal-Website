// SWAT-SUV visuals + system mount (Phase 10 Task 2; TDD §5.6). Mirrors
// ai/units/PoliceMesh.tsx / ArmoredMesh.tsx's structure exactly (one InstancedMesh renders
// every 'swat' slot off the shared roster; the mesh is also the SWAT system's MOUNT —
// registers the factory once the live Rapier context exists and owns the ONE pair of step
// hooks driving swatSuv.ts's tick list). Read PoliceMesh.tsx first; only what's different is
// commented here.
//
// LOOK: unmarked blacked-out tactical SUV — near-black metalDark hull, a taller boxy cabin
// (raised roofline vs. the sedan's low cabin, TDD "taller boxy body"), tinted glassCool
// windows across a full band (not police's small dark strip), NO lightbar (unmarked — the
// silhouette + total darkness of the paint is what reads "SWAT", not a strobe). Distinct from
// both police (white/red-strobe sedan) and armored (slate hull + red push-bar prow + small
// strobe) at a glance.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  useAfterPhysicsStep,
  useBeforePhysicsStep,
  useRapier,
} from '@react-three/rapier';
import {
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  Matrix4,
  Object3D,
  type InstancedMesh,
} from 'three';
import { ENEMY_UNITS, SPAWN, VEHICLE_TUNING } from '../../config';
import { hpLostFraction, tintDamageColor } from '../../fx/damageStates';
import { PaletteCell } from '../../world/archetypes';
import { addBox, createBuilder, toBufferGeometry } from '../../world/geometry/kit';
import { getCityMaterial } from '../../world/palette';
import { registerUnitFactory, unregisterUnitFactory } from '../spawnDirector';
import { unitsRef } from '../pursuitTypes';
import { createSwatFactory, stepSwatAfter, stepSwatBefore } from './swatSuv';

const PHYSICS_DT = 1 / 60;
const CAPACITY = Math.max(...SPAWN.caps);

// Visual-only bulk-up, baked into geometry (physics collider stays the base chassis box —
// same convention as ArmoredMesh). SWAT is the tallest/boxiest of the three: wider bulk than
// armored on X/Z, and a much taller cabin on top of the bulked hull.
const BULK = 1.12;
const CABIN_HEIGHT_M = 0.62;

const WHITE = new Color(1, 1, 1);
const ZERO_MATRIX = new Matrix4().makeScale(0, 0, 0);

const _dummy = new Object3D();
const _color = new Color();

/**
 * Chassis-centered procedural SWAT SUV (same origin/frame convention as buildPoliceCar /
 * buildArmoredCar). A bulked near-black metalDark lower hull topped by a TALL boxy cabin
 * (raised roofline — the "taller boxy body" TDD calls for), a full tinted glassCool window
 * band around the cabin, near-black wallF bumpers/skirts, dark wheels. No emissive faces
 * anywhere (unmarked — no lightbar).
 */
function buildSwatSuv(): BufferGeometry {
  const { chassis, wheels } = VEHICLE_TUNING;
  const hw = chassis.halfWidth * BULK;
  const hh = chassis.halfHeight * BULK;
  const hl = chassis.halfLength * BULK;
  const black = PaletteCell.metalDark;
  const trim = PaletteCell.wallF;
  const glass = PaletteCell.glassCool;

  const b = createBuilder();

  // Lower hull — bulked chassis box, near-black.
  addBox(
    b,
    { minX: -hw, maxX: hw, minY: -hh, maxY: hh, minZ: -hl, maxZ: hl },
    {
      px: { albedo: black },
      nx: { albedo: black },
      py: { albedo: black },
      ny: { albedo: black },
      pz: { albedo: black },
      nz: { albedo: black },
    },
  );

  // Tall boxy cabin — raised roofline sitting on top of the hull, nearly the hull's full
  // width/length (boxy, not tapered) — the SUV's signature "taller than a sedan" silhouette.
  const cabinHW = hw * 0.92;
  const cabinHL = hl * 0.78;
  const cabinY0 = hh;
  const cabinY1 = hh + CABIN_HEIGHT_M;
  addBox(
    b,
    { minX: -cabinHW, maxX: cabinHW, minY: cabinY0, maxY: cabinY1, minZ: -cabinHL, maxZ: cabinHL },
    {
      px: { albedo: black },
      nx: { albedo: black },
      py: { albedo: black },
      pz: { albedo: black },
      nz: { albedo: black },
    },
  );

  // Window band — full tinted strip wrapping the cabin (all four sides read glass, unlike
  // armored's thin single-height slit).
  const bandHW = cabinHW * 0.96;
  const bandHL = cabinHL * 0.96;
  const bandY0 = cabinY0 + CABIN_HEIGHT_M * 0.18;
  const bandY1 = cabinY0 + CABIN_HEIGHT_M * 0.82;
  addBox(
    b,
    { minX: -bandHW, maxX: bandHW, minY: bandY0, maxY: bandY1, minZ: -bandHL, maxZ: bandHL },
    { px: { albedo: glass }, nx: { albedo: glass }, pz: { albedo: glass }, nz: { albedo: glass } },
  );

  // Bumpers — dark trim, front/rear (plain — no push-bar; SWAT boxes in, armored bulldozes).
  const bumperHW = hw * 0.98;
  const bumperCY = -hh * 0.5;
  const bumperY0 = bumperCY - 0.13;
  const bumperY1 = bumperCY + 0.13;
  const bumperDepth = 0.16;
  addBox(
    b,
    { minX: -bumperHW, maxX: bumperHW, minY: bumperY0, maxY: bumperY1, minZ: hl, maxZ: hl + bumperDepth },
    { px: { albedo: trim }, nx: { albedo: trim }, py: { albedo: trim }, pz: { albedo: trim } },
  );
  addBox(
    b,
    { minX: -bumperHW, maxX: bumperHW, minY: bumperY0, maxY: bumperY1, minZ: -hl - bumperDepth, maxZ: -hl },
    { px: { albedo: trim }, nx: { albedo: trim }, py: { albedo: trim }, nz: { albedo: trim } },
  );

  // Wheels — dark, chunky (bulked with the hull).
  const r = wheels.radius * BULK;
  const wheelHalfW = 0.15;
  const wheelCY = -0.46;
  const corners: readonly [number, number][] = [
    [-wheels.halfTrack * BULK, wheels.frontZ * BULK],
    [wheels.halfTrack * BULK, wheels.frontZ * BULK],
    [-wheels.halfTrack * BULK, wheels.rearZ * BULK],
    [wheels.halfTrack * BULK, wheels.rearZ * BULK],
  ];
  for (const [cx, cz] of corners) {
    addBox(
      b,
      { minX: cx - wheelHalfW, maxX: cx + wheelHalfW, minY: wheelCY - r, maxY: wheelCY + r, minZ: cz - r, maxZ: cz + r },
      { px: { albedo: black }, nx: { albedo: black }, pz: { albedo: black }, nz: { albedo: black } },
    );
  }

  return toBufferGeometry(b);
}

export function SwatMesh() {
  const meshRef = useRef<InstancedMesh>(null);
  const { world, rapier } = useRapier();
  const capacity = CAPACITY;

  const geometry = useMemo(() => {
    const g = buildSwatSuv();
    const attr = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    attr.setUsage(DynamicDrawUsage);
    g.setAttribute('aEmissiveOn', attr);
    return g;
  }, [capacity]);

  const material = useMemo(() => getCityMaterial(), []);

  useEffect(() => () => geometry.dispose(), [geometry]);

  useEffect(() => {
    registerUnitFactory('swat', createSwatFactory({ world, rapier }));
    return () => unregisterUnitFactory('swat');
  }, [world, rapier]);

  useBeforePhysicsStep(() => stepSwatBefore(PHYSICS_DT));
  useAfterPhysicsStep(() => stepSwatAfter());

  useEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    for (let i = 0; i < capacity; i++) {
      mesh.setMatrixAt(i, ZERO_MATRIX);
      mesh.setColorAt(i, WHITE);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) {
      mesh.instanceColor.setUsage(DynamicDrawUsage);
      mesh.instanceColor.needsUpdate = true;
    }
  }, [capacity]);

  useFrame(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    const slots = unitsRef.current?.slots;
    const emissiveAttr = mesh.geometry.getAttribute('aEmissiveOn') as InstancedBufferAttribute;

    for (let i = 0; i < capacity; i++) {
      const slot = slots?.[i];
      // Render only live SWAT slots (other kinds have their own mesh).
      if (slot === undefined || slot.kind !== 'swat') {
        mesh.setMatrixAt(i, ZERO_MATRIX);
        emissiveAttr.setX(i, 0);
        continue;
      }

      _dummy.position.set(slot.x, slot.y, slot.z);
      _dummy.quaternion.set(slot.qx, slot.qy, slot.qz, slot.qw);
      _dummy.scale.set(1, 1, 1);
      _dummy.updateMatrix();
      mesh.setMatrixAt(i, _dummy.matrix);

      _color.copy(WHITE);
      // Phase 16: graduated damage tint (25/50/75% HP lost), full charred at 'wrecked' — see
      // fx/damageStates.ts's tintDamageColor header.
      tintDamageColor(_color, hpLostFraction(slot.hp, ENEMY_UNITS.swat.hp), slot.state === 'wrecked');
      mesh.setColorAt(i, _color);

      // No lightbar — unmarked. aEmissiveOn stays 0 for every live/wrecked instance.
      emissiveAttr.setX(i, 0);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    emissiveAttr.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[geometry, material, capacity]} frustumCulled={false} castShadow />
  );
}
