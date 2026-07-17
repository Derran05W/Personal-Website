// Tank visuals + system mount (Phase 12 Task 2; TDD §5.6). Mirrors GunTruckMesh.tsx's structure
// (the mesh is also the unit system's MOUNT: registers the factory once the Rapier context is live
// and owns the ONE pair of step hooks driving tank.ts's tick list) — read GunTruckMesh.tsx's header
// first; only what's DIFFERENT is here.
//
// TWO InstancedMeshes (two draw calls), same twin-mesh turret pattern as the gun truck: a HULL
// rendered from each tank slot's body pose, PLUS a merged TURRET+BARREL mesh whose per-instance
// matrix composes the hull POSITION with the turret's own WORLD-space aim yaw (getTankTurretYaw,
// published each physics step) — so the long gun tracks the player independently of the hull.
//
// TELEGRAPH GLOW: the turret+barrel mesh's per-instance aEmissiveOn is driven from getTankTelegraph
// (progress01) — only the muzzle-tip faces carry a warm emissive cell (streetlightWarm), so the
// whole 0.8 s telegraph reads as the muzzle heating up before a shot (the police-lightbar trick).
// Task 3's FX layer reads the SAME getTankTelegraph seam for the ground laser dot + the explosion.
//
// LOOK: drab military — a WIDE, LOW militaryGreen hull on chunky metalDark tracks, a rounded
// metalGreen turret with a commander cupola, and a long protruding metalDark cannon. Unmistakably
// a tank, and distinct at a glance from the gun truck's taller narrow transport hull.

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
import { ENEMY_UNITS, SPAWN } from '../../config';
import { hpLostFraction, tintDamageColor } from '../../fx/damageStates';
import { PaletteCell } from '../../world/archetypes';
import { addBox, addPrismFrustum, createBuilder, toBufferGeometry } from '../../world/geometry/kit';
import { getCityMaterial } from '../../world/palette';
import { registerUnitFactory, unregisterUnitFactory } from '../spawnDirector';
import { unitsRef } from '../pursuitTypes';
import { createTankFactory, getTankTelegraph, getTankTurretYaw, stepTankAfter, stepTankBefore } from './tank';

const PHYSICS_DT = 1 / 60;
const CAPACITY = Math.max(...SPAWN.caps);

// Hull half-extents (m) — visual only; the physics collider stays the base chassis cuboid (the
// armored/swat/gunTruck convention, mass handled by tank.ts's 6× override). Wide + low + long so
// the silhouette reads "tank" at a glance.
const HULL = { hw: 1.5, hh: 0.5, hl: 2.4 } as const;
// Turret pivot height above the chassis CENTER (m) = the hull deck top. TankMesh places the turret
// mesh here; the barrel centerline + tip (below) are measured in the turret's own local frame.
const TURRET_DECK_Y = HULL.hh;
// Barrel centerline above the pivot + barrel tip ahead of the pivot (m). These two + TURRET_DECK_Y
// MUST match config/vehicles.ts TANK_UNIT.turret (heightM = TURRET_DECK_Y + BARREL_CENTER_Y = 0.92,
// muzzleForwardM = BARREL_TIP_Z = 3.2) so the shell + laser leave the visible muzzle.
const BARREL_CENTER_Y = 0.42;
const BARREL_TIP_Z = 3.2;

const WHITE = new Color(1, 1, 1);
const ZERO_MATRIX = new Matrix4().makeScale(0, 0, 0);

const _dummy = new Object3D();
const _turretDummy = new Object3D();
const _color = new Color();

/**
 * Chassis-centered procedural tank HULL (+Z forward, same frame convention as buildGunTruckHull):
 * a wide low militaryGreen hull, two chunky metalDark tracks straddling the sides, and a darker
 * lower skirt. No emissive faces (that's the turret's muzzle).
 */
function buildTankHull(): BufferGeometry {
  const green = PaletteCell.militaryGreen;
  const dark = PaletteCell.metalDark;
  const { hw, hh, hl } = HULL;
  const b = createBuilder();

  // Upper hull — the main militaryGreen mass (slightly inset from the tracks).
  const uhw = hw * 0.82;
  addBox(
    b,
    { minX: -uhw, maxX: uhw, minY: -hh * 0.2, maxY: hh, minZ: -hl, maxZ: hl },
    {
      px: { albedo: green },
      nx: { albedo: green },
      py: { albedo: green },
      pz: { albedo: green },
      nz: { albedo: green },
    },
  );

  // Sloped glacis hint — a short dark front plate under the nose for a bit of shape.
  addBox(
    b,
    { minX: -uhw, maxX: uhw, minY: -hh * 0.2, maxY: hh * 0.35, minZ: hl, maxZ: hl + 0.35 },
    { px: { albedo: dark }, nx: { albedo: dark }, py: { albedo: dark }, pz: { albedo: dark } },
  );

  // Tracks — two long chunky metalDark boxes running the hull length on each side, sitting low
  // and wider than the hull so the tank clearly reads as tracked.
  const trackHalfW = 0.28;
  const trackOuter = hw;
  const trackCX = trackOuter - trackHalfW;
  const trackY0 = -hh - 0.2;
  const trackY1 = hh * 0.35;
  const trackHL = hl * 1.02;
  for (const sign of [-1, 1] as const) {
    const cx = sign * trackCX;
    addBox(
      b,
      { minX: cx - trackHalfW, maxX: cx + trackHalfW, minY: trackY0, maxY: trackY1, minZ: -trackHL, maxZ: trackHL },
      {
        px: { albedo: dark },
        nx: { albedo: dark },
        py: { albedo: dark },
        ny: { albedo: dark },
        pz: { albedo: dark },
        nz: { albedo: dark },
      },
    );
  }

  return toBufferGeometry(b);
}

/**
 * Procedural TURRET + BARREL merged, built about its PIVOT at the origin (y = 0 at the deck, barrel
 * along +Z): a rounded militaryGreen 8-gon turret, a metalDark commander cupola, a mantlet, and a
 * long metalDark cannon. ONLY the muzzle-tip box carries an emissive cell (streetlightWarm) — the
 * mesh ramps that instance's aEmissiveOn with the telegraph so just the muzzle glows.
 */
function buildTankTurret(): BufferGeometry {
  const green = PaletteCell.militaryGreen;
  const dark = PaletteCell.metalDark;
  const glow = PaletteCell.streetlightWarm; // EMISSIVE muzzle cell (warm "heating up" telegraph)
  const b = createBuilder();

  // Turret body — a low rounded 8-gon, offset slightly back so the gun projects from its front.
  addPrismFrustum(b, 8, 0, 0.52, 0.86, 0.72, green, { capTop: true, offsetZ: -0.25 });

  // Commander cupola — a small dark box on top-rear of the turret, for silhouette.
  addBox(
    b,
    { minX: -0.22, maxX: 0.22, minY: 0.52, maxY: 0.74, minZ: -0.6, maxZ: -0.16 },
    { px: { albedo: dark }, nx: { albedo: dark }, py: { albedo: dark }, pz: { albedo: dark }, nz: { albedo: dark } },
  );

  // Mantlet — a blocky metalDark housing where the barrel exits the turret.
  addBox(
    b,
    { minX: -0.24, maxX: 0.24, minY: BARREL_CENTER_Y - 0.2, maxY: BARREL_CENTER_Y + 0.2, minZ: 0.4, maxZ: 0.72 },
    { px: { albedo: dark }, nx: { albedo: dark }, py: { albedo: dark }, ny: { albedo: dark }, pz: { albedo: dark } },
  );

  // Cannon — a long thin metalDark box out to just short of the tip.
  const barHalfW = 0.13;
  addBox(
    b,
    {
      minX: -barHalfW,
      maxX: barHalfW,
      minY: BARREL_CENTER_Y - barHalfW,
      maxY: BARREL_CENTER_Y + barHalfW,
      minZ: 0.62,
      maxZ: BARREL_TIP_Z - 0.32,
    },
    { px: { albedo: dark }, nx: { albedo: dark }, py: { albedo: dark }, ny: { albedo: dark } },
  );

  // Muzzle tip — a slightly fatter box at the very end; ALL faces carry the emissive glow cell so
  // the telegraph ramps a warm muzzle glow (albedo stays dark; the emissive term is what lights up).
  const tipHalfW = 0.16;
  addBox(
    b,
    {
      minX: -tipHalfW,
      maxX: tipHalfW,
      minY: BARREL_CENTER_Y - tipHalfW,
      maxY: BARREL_CENTER_Y + tipHalfW,
      minZ: BARREL_TIP_Z - 0.32,
      maxZ: BARREL_TIP_Z,
    },
    {
      px: { albedo: dark, emissive: glow },
      nx: { albedo: dark, emissive: glow },
      py: { albedo: dark, emissive: glow },
      ny: { albedo: dark, emissive: glow },
      pz: { albedo: dark, emissive: glow },
    },
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

export function TankMesh() {
  const hullRef = useRef<InstancedMesh>(null);
  const turretRef = useRef<InstancedMesh>(null);
  const { world, rapier } = useRapier();
  const capacity = CAPACITY;

  const hullGeometry = useMemo(() => makeGeometry(buildTankHull, capacity), [capacity]);
  const turretGeometry = useMemo(() => makeGeometry(buildTankTurret, capacity), [capacity]);
  const material = useMemo(() => getCityMaterial(), []);

  useEffect(() => () => hullGeometry.dispose(), [hullGeometry]);
  useEffect(() => () => turretGeometry.dispose(), [turretGeometry]);

  useEffect(() => {
    registerUnitFactory('tank', createTankFactory({ world, rapier }));
    return () => unregisterUnitFactory('tank');
  }, [world, rapier]);

  useBeforePhysicsStep(() => stepTankBefore(PHYSICS_DT));
  useAfterPhysicsStep(() => stepTankAfter());

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
      if (slot === undefined || slot.kind !== 'tank') {
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

      // Turret+barrel — hull POSITION + the deck offset, rotated by the WORLD aim yaw (independent
      // of the hull heading). Falls back to the hull yaw before the unit has published an aim.
      const aimYaw = getTankTurretYaw(slot.id);
      _turretDummy.position.set(slot.x, slot.y + TURRET_DECK_Y, slot.z);
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
      tintDamageColor(_color, hpLostFraction(slot.hp, ENEMY_UNITS.tank.hp), slot.state === 'wrecked');
      hull.setColorAt(i, _color);
      turret.setColorAt(i, _color);

      // Barrel muzzle glow ramps with the telegraph (only the muzzle-tip faces sample the emissive
      // cell, so just the muzzle lights up). Hull never glows.
      const tel = slot.state === 'wrecked' ? undefined : getTankTelegraph(slot.id);
      hullEmissive.setX(i, 0);
      turretEmissive.setX(i, tel?.progress01 ?? 0);
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
