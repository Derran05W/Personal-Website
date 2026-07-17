// Armored-police visuals + system mount (Phase 10 Task 2; TDD §5.6). Mirrors
// ai/units/PoliceMesh.tsx's structure exactly — see that file's header for the shared
// mechanism (one InstancedMesh renders every 'armored' slot off the shared roster, the mesh
// is also the armored system's MOUNT: registers the factory once the live Rapier context
// exists, owns the ONE pair of step hooks that drive armoredPolice.ts's tick list, AND now
// also owns the shove system's onImpact subscription for its mount lifetime). Read
// PoliceMesh.tsx first; only what's different is commented here.
//
// LOOK (silhouette must read distinct from police at a glance, TDD escalation bar): one
// continuous slate-grey (wallF) armored hull baked ~1.15× the base chassis half-extents (no
// separate white-body/dark-cabin split like the sedan — a single bulkier mass instead), a
// forward push-bar/grille-guard prow in metalDark projecting past the front bumper, a thin
// dark tinted window band instead of a full greenhouse, and a SMALL red lightbar (same
// emissive-strobe mechanism as police, kept low-profile — still visibly a police vehicle,
// just armored). Chunkier dark wheels to match the bulkier hull.

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
import { SPAWN, VEHICLE_TUNING } from '../../config';
import { PaletteCell } from '../../world/archetypes';
import { addBox, createBuilder, toBufferGeometry } from '../../world/geometry/kit';
import { getCityMaterial } from '../../world/palette';
import { registerUnitFactory, unregisterUnitFactory } from '../spawnDirector';
import { unitsRef } from '../pursuitTypes';
import {
  createArmoredFactory,
  initArmoredShoveSystem,
  stepArmoredAfter,
  stepArmoredBefore,
} from './armoredPolice';

const PHYSICS_DT = 1 / 60;
// Mirrors PoliceMesh: capacity = the largest pursuit cap across tiers, cheap at this count.
const CAPACITY = Math.max(...SPAWN.caps);
const STROBE_HZ = 3;

// Visual-only bulk-up factor over the shared chassis half-extents (physics collider itself
// stays the base VEHICLE_TUNING.chassis box — see armoredPolice.ts's file header for why the
// real weight difference is a mass override, not a bigger collider). Baked into the geometry
// (not the instance scale — PoliceMesh's convention keeps instance scale fixed at 1,1,1).
const BULK = 1.15;

const WHITE = new Color(1, 1, 1);
const WRECK_CHAR = new Color('#2a2622');
const ZERO_MATRIX = new Matrix4().makeScale(0, 0, 0);

const _dummy = new Object3D();
const _color = new Color();

/**
 * Chassis-centered procedural armored cruiser (same origin/frame convention as
 * buildPoliceCar). One continuous slate hull (bulked BULK× over the base chassis
 * half-extents), a metalDark push-bar prow ahead of the front bumper, a thin glassCool
 * window band, a small red lightbar (uv2 → signalRed for the strobe), and chunky metalDark
 * wheels.
 */
function buildArmoredCar(): BufferGeometry {
  const { chassis, wheels } = VEHICLE_TUNING;
  const hw = chassis.halfWidth * BULK;
  const hh = chassis.halfHeight * BULK;
  const hl = chassis.halfLength * BULK;
  const slate = PaletteCell.wallF;
  const dark = PaletteCell.metalDark;
  const glass = PaletteCell.glassCool;
  const red = PaletteCell.signalRed;

  const b = createBuilder();

  // Hull — one continuous slate mass (no separate cabin box — reads bulkier/blockier than
  // the sedan's white-body/dark-cabin split).
  addBox(
    b,
    { minX: -hw, maxX: hw, minY: -hh, maxY: hh, minZ: -hl, maxZ: hl },
    {
      px: { albedo: slate },
      nx: { albedo: slate },
      py: { albedo: slate },
      ny: { albedo: slate },
      pz: { albedo: slate },
      nz: { albedo: slate },
    },
  );

  // Window band — thin dark tinted strip near the roofline (armored slit, not a greenhouse).
  const bandHW = hw * 0.82;
  const bandHL = hl * 0.62;
  const bandY0 = hh * 0.45;
  const bandY1 = hh * 0.72;
  addBox(
    b,
    { minX: -bandHW, maxX: bandHW, minY: bandY0, maxY: bandY1, minZ: -bandHL, maxZ: bandHL },
    { px: { albedo: glass }, nx: { albedo: glass }, pz: { albedo: glass }, nz: { albedo: glass } },
  );

  // Lightbar — small, low-profile (armored still reads police, just a lower emphasis than
  // the sedan's full-width bar).
  const barHW = hw * 0.4;
  const barHL = 0.14;
  const barY0 = hh;
  const barY1 = hh + 0.1;
  const barZ = hl * -0.1;
  addBox(
    b,
    { minX: -barHW, maxX: barHW, minY: barY0, maxY: barY1, minZ: barZ - barHL, maxZ: barZ + barHL },
    {
      px: { albedo: red, emissive: red },
      nx: { albedo: red, emissive: red },
      py: { albedo: red, emissive: red },
      pz: { albedo: red, emissive: red },
      nz: { albedo: red, emissive: red },
    },
  );

  // Push-bar prow — a metalDark grille-guard block projecting past the front (+Z) bumper,
  // the silhouette's most distinguishing feature at a glance.
  const prowHW = hw * 0.7;
  const prowY0 = -hh * 0.7;
  const prowY1 = hh * 0.15;
  const prowDepth = 0.55;
  addBox(
    b,
    { minX: -prowHW, maxX: prowHW, minY: prowY0, maxY: prowY1, minZ: hl, maxZ: hl + prowDepth },
    { px: { albedo: dark }, nx: { albedo: dark }, py: { albedo: dark }, pz: { albedo: dark } },
  );

  // Rear bumper — dark, plain (no push-bar aft).
  const bumperHW = hw * 0.96;
  const bumperCY = -hh * 0.55;
  const bumperY0 = bumperCY - 0.11;
  const bumperY1 = bumperCY + 0.11;
  const bumperDepth = 0.18;
  addBox(
    b,
    { minX: -bumperHW, maxX: bumperHW, minY: bumperY0, maxY: bumperY1, minZ: -hl - bumperDepth, maxZ: -hl },
    { px: { albedo: dark }, nx: { albedo: dark }, py: { albedo: dark }, nz: { albedo: dark } },
  );

  // Wheels — chunkier than the sedan's (bulked with the hull), dark boxy stubs.
  const r = wheels.radius * BULK;
  const wheelHalfW = 0.15;
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

export function ArmoredMesh() {
  const meshRef = useRef<InstancedMesh>(null);
  const { world, rapier } = useRapier();
  const capacity = CAPACITY;

  const geometry = useMemo(() => {
    const g = buildArmoredCar();
    const attr = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    attr.setUsage(DynamicDrawUsage);
    g.setAttribute('aEmissiveOn', attr);
    return g;
  }, [capacity]);

  const material = useMemo(() => getCityMaterial(), []);

  useEffect(() => () => geometry.dispose(), [geometry]);

  // Register the armored factory + the shove system now that the Rapier context is live.
  // Both are unmounted together — the shove system has nothing to do once no armored unit
  // can exist (registerUnitFactory removed), but its own unsubscribe is still explicit so a
  // dev remount can't accumulate a second onImpact subscriber.
  useEffect(() => {
    registerUnitFactory('armored', createArmoredFactory({ world, rapier }));
    const unsubscribeShove = initArmoredShoveSystem({ world });
    return () => {
      unregisterUnitFactory('armored');
      unsubscribeShove();
    };
  }, [world, rapier]);

  useBeforePhysicsStep(() => stepArmoredBefore(PHYSICS_DT));
  useAfterPhysicsStep(() => stepArmoredAfter());

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
    const t = performance.now() / 1000;
    const emissiveAttr = mesh.geometry.getAttribute('aEmissiveOn') as InstancedBufferAttribute;

    for (let i = 0; i < capacity; i++) {
      const slot = slots?.[i];
      // Render only live ARMORED slots (other kinds have their own mesh, exactly like
      // PoliceMesh only rendering 'police').
      if (slot === undefined || slot.kind !== 'armored') {
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
      if (slot.state === 'wrecked') _color.multiply(WRECK_CHAR);
      mesh.setColorAt(i, _color);

      const phase = (t * STROBE_HZ + i * 0.13) % 1;
      emissiveAttr.setX(i, slot.state === 'wrecked' ? 0 : phase < 0.5 ? 1 : 0);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    emissiveAttr.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[geometry, material, capacity]} frustumCulled={false} castShadow />
  );
}
