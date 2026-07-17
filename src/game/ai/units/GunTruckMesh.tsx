// Gun-truck visuals + system mount (Phase 11 Task 2; TDD §5.6). Mirrors ArmoredMesh.tsx /
// SwatMesh.tsx's structure (the mesh is also the unit system's MOUNT: registers the factory once
// the Rapier context is live and owns the ONE pair of step hooks driving gunTruck.ts's tick list)
// — read ArmoredMesh.tsx first; only what's DIFFERENT is commented here.
//
// TWO InstancedMeshes, not one (the task's "twin instanced meshes"): a HULL mesh rendered from
// each gun-truck slot's body pose exactly like the other units, PLUS a TURRET mesh whose per-
// instance matrix composes the hull POSITION with the turret's own WORLD-space aim yaw
// (getGunTruckTurretYaw, published by the unit each physics step) — so the barrel tracks the
// player independently of which way the hull is pointing as it orbits. Two draw calls total.
//
// LOOK: military drab — a blocky militaryGreen transport hull with a metalDark cab greenhouse and
// chunky dark wheels (no police strobe — this is the military tier), topped by a dark turret ring
// + gunner block + a long forward barrel. Distinct at a glance from the white/red police sedan,
// slate armored, and blacked-out SWAT SUV.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useAfterPhysicsStep, useBeforePhysicsStep, useRapier } from '@react-three/rapier';
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
import { addBox, addPrismFrustum, createBuilder, toBufferGeometry } from '../../world/geometry/kit';
import { getCityMaterial } from '../../world/palette';
import { registerUnitFactory, unregisterUnitFactory } from '../spawnDirector';
import { unitsRef } from '../pursuitTypes';
import { createGunTruckFactory, getGunTruckTurretYaw, stepGunTruckAfter, stepGunTruckBefore } from './gunTruck';

const PHYSICS_DT = 1 / 60;
const CAPACITY = Math.max(...SPAWN.caps);

// Visual-only bulk (physics collider stays the base chassis box — armored/swat convention).
const BULK = 1.18;
// Turret pivot height above the chassis CENTER (m): the hull top, so the ring sits on the deck.
const TURRET_MOUNT_Y = VEHICLE_TUNING.chassis.halfHeight * BULK;

const WHITE = new Color(1, 1, 1);
const ZERO_MATRIX = new Matrix4().makeScale(0, 0, 0);

const _dummy = new Object3D();
const _turretDummy = new Object3D();
const _color = new Color();

/**
 * Chassis-centered procedural gun-truck HULL (same origin/frame convention as buildArmoredCar):
 * a bulked militaryGreen box hull, a metalDark cab greenhouse at the front (+Z), dark bumpers,
 * and chunky dark wheels. No emissive faces (military — no strobe).
 */
function buildGunTruckHull(): BufferGeometry {
  const { chassis, wheels } = VEHICLE_TUNING;
  const hw = chassis.halfWidth * BULK;
  const hh = chassis.halfHeight * BULK;
  const hl = chassis.halfLength * BULK;
  const green = PaletteCell.militaryGreen;
  const dark = PaletteCell.metalDark;
  const glass = PaletteCell.glassCool;

  const b = createBuilder();

  // Lower hull — one bulky militaryGreen mass.
  addBox(
    b,
    { minX: -hw, maxX: hw, minY: -hh, maxY: hh, minZ: -hl, maxZ: hl },
    {
      px: { albedo: green },
      nx: { albedo: green },
      py: { albedo: green },
      ny: { albedo: green },
      pz: { albedo: green },
      nz: { albedo: green },
    },
  );

  // Cab greenhouse — a dark boxy cab over the FRONT third (+Z), shorter than the hull length so
  // the rear deck stays open for the turret to sit proud.
  const cabHW = hw * 0.9;
  const cabHL = hl * 0.34;
  const cabCZ = hl * 0.55;
  const cabY0 = hh;
  const cabY1 = hh + 0.5;
  addBox(
    b,
    { minX: -cabHW, maxX: cabHW, minY: cabY0, maxY: cabY1, minZ: cabCZ - cabHL, maxZ: cabCZ + cabHL },
    {
      px: { albedo: dark },
      nx: { albedo: dark },
      py: { albedo: dark },
      pz: { albedo: glass },
      nz: { albedo: glass },
    },
  );

  // Bumpers — dark, front + rear.
  const bumperHW = hw * 0.98;
  const bumperCY = -hh * 0.5;
  const bumperY0 = bumperCY - 0.14;
  const bumperY1 = bumperCY + 0.14;
  const bumperDepth = 0.18;
  addBox(
    b,
    { minX: -bumperHW, maxX: bumperHW, minY: bumperY0, maxY: bumperY1, minZ: hl, maxZ: hl + bumperDepth },
    { px: { albedo: dark }, nx: { albedo: dark }, py: { albedo: dark }, pz: { albedo: dark } },
  );
  addBox(
    b,
    { minX: -bumperHW, maxX: bumperHW, minY: bumperY0, maxY: bumperY1, minZ: -hl - bumperDepth, maxZ: -hl },
    { px: { albedo: dark }, nx: { albedo: dark }, py: { albedo: dark }, nz: { albedo: dark } },
  );

  // Wheels — chunky dark boxy stubs (bulked with the hull).
  const r = wheels.radius * BULK;
  const wheelHalfW = 0.16;
  const wheelCY = -0.48;
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
      { px: { albedo: dark }, nx: { albedo: dark }, pz: { albedo: dark }, nz: { albedo: dark } },
    );
  }

  return toBufferGeometry(b);
}

/**
 * Procedural TURRET, built about its PIVOT at the origin (y = 0 at the ring base, barrel along
 * +Z): a metalDark octagonal ring, a militaryGreen gunner block, and a long dark barrel. The mesh
 * places this at the hull deck and rotates it by the turret's world aim yaw each frame.
 */
function buildGunTruckTurret(): BufferGeometry {
  const green = PaletteCell.militaryGreen;
  const dark = PaletteCell.metalDark;
  const b = createBuilder();

  // Ring base — low 8-gon prism.
  addPrismFrustum(b, 8, 0, 0.22, 0.42, 0.42, dark, { capTop: true });

  // Gunner block — a boxy housing on the ring.
  const gHW = 0.3;
  const gHL = 0.34;
  const gY0 = 0.22;
  const gY1 = 0.62;
  addBox(
    b,
    { minX: -gHW, maxX: gHW, minY: gY0, maxY: gY1, minZ: -gHL, maxZ: gHL },
    {
      px: { albedo: green },
      nx: { albedo: green },
      py: { albedo: green },
      pz: { albedo: green },
      nz: { albedo: green },
    },
  );

  // Barrel — a long thin box projecting forward (+Z) from the housing.
  const barHW = 0.09;
  const barCY = 0.44;
  const barZ0 = gHL * 0.5;
  const barZ1 = 1.6;
  addBox(
    b,
    { minX: -barHW, maxX: barHW, minY: barCY - barHW, maxY: barCY + barHW, minZ: barZ0, maxZ: barZ1 },
    { px: { albedo: dark }, nx: { albedo: dark }, py: { albedo: dark }, ny: { albedo: dark }, pz: { albedo: dark } },
  );

  return toBufferGeometry(b);
}

function makeGeometry(build: () => BufferGeometry, capacity: number): BufferGeometry {
  const g = build();
  const attr = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  attr.setUsage(DynamicDrawUsage);
  g.setAttribute('aEmissiveOn', attr);
  return g;
}

export function GunTruckMesh() {
  const hullRef = useRef<InstancedMesh>(null);
  const turretRef = useRef<InstancedMesh>(null);
  const { world, rapier } = useRapier();
  const capacity = CAPACITY;

  const hullGeometry = useMemo(() => makeGeometry(buildGunTruckHull, capacity), [capacity]);
  const turretGeometry = useMemo(() => makeGeometry(buildGunTruckTurret, capacity), [capacity]);
  const material = useMemo(() => getCityMaterial(), []);

  useEffect(() => () => hullGeometry.dispose(), [hullGeometry]);
  useEffect(() => () => turretGeometry.dispose(), [turretGeometry]);

  useEffect(() => {
    registerUnitFactory('gunTruck', createGunTruckFactory({ world, rapier }));
    return () => unregisterUnitFactory('gunTruck');
  }, [world, rapier]);

  useBeforePhysicsStep(() => stepGunTruckBefore(PHYSICS_DT));
  useAfterPhysicsStep(() => stepGunTruckAfter());

  // Initialize both meshes to hidden with white instance color.
  useEffect(() => {
    for (const mesh of [hullRef.current, turretRef.current]) {
      if (mesh === null) continue;
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
    }
  }, [capacity]);

  useFrame(() => {
    const hull = hullRef.current;
    const turret = turretRef.current;
    if (hull === null || turret === null) return;
    const slots = unitsRef.current?.slots;
    const hullEmissive = hull.geometry.getAttribute('aEmissiveOn') as InstancedBufferAttribute;
    const turretEmissive = turret.geometry.getAttribute('aEmissiveOn') as InstancedBufferAttribute;

    for (let i = 0; i < capacity; i++) {
      const slot = slots?.[i];
      if (slot === undefined || slot.kind !== 'gunTruck') {
        hull.setMatrixAt(i, ZERO_MATRIX);
        turret.setMatrixAt(i, ZERO_MATRIX);
        hullEmissive.setX(i, 0);
        turretEmissive.setX(i, 0);
        continue;
      }

      // Hull — straight off the body pose.
      _dummy.position.set(slot.x, slot.y, slot.z);
      _dummy.quaternion.set(slot.qx, slot.qy, slot.qz, slot.qw);
      _dummy.scale.set(1, 1, 1);
      _dummy.updateMatrix();
      hull.setMatrixAt(i, _dummy.matrix);

      // Turret — hull POSITION + the deck offset, rotated by the WORLD aim yaw (independent of the
      // hull heading). Falls back to the hull yaw before the unit has published an aim.
      const aimYaw = getGunTruckTurretYaw(slot.id);
      _turretDummy.position.set(slot.x, slot.y + TURRET_MOUNT_Y, slot.z);
      if (aimYaw === undefined) {
        _turretDummy.quaternion.set(slot.qx, slot.qy, slot.qz, slot.qw);
      } else {
        _turretDummy.rotation.set(0, aimYaw, 0);
      }
      _turretDummy.scale.set(1, 1, 1);
      _turretDummy.updateMatrix();
      turret.setMatrixAt(i, _turretDummy.matrix);

      _color.copy(WHITE);
      // Phase 16: graduated damage tint (25/50/75% HP lost), full charred at 'wrecked' — see
      // fx/damageStates.ts's tintDamageColor header. Applied once, shared by both meshes
      // (hull + turret always render the same damage state for one unit).
      tintDamageColor(_color, hpLostFraction(slot.hp, ENEMY_UNITS.gunTruck.hp), slot.state === 'wrecked');
      hull.setColorAt(i, _color);
      turret.setColorAt(i, _color);

      hullEmissive.setX(i, 0);
      turretEmissive.setX(i, 0);
    }

    hull.instanceMatrix.needsUpdate = true;
    turret.instanceMatrix.needsUpdate = true;
    if (hull.instanceColor !== null) hull.instanceColor.needsUpdate = true;
    if (turret.instanceColor !== null) turret.instanceColor.needsUpdate = true;
    hullEmissive.needsUpdate = true;
    turretEmissive.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh ref={hullRef} args={[hullGeometry, material, capacity]} frustumCulled={false} castShadow />
      <instancedMesh ref={turretRef} args={[turretGeometry, material, capacity]} frustumCulled={false} castShadow />
    </>
  );
}
