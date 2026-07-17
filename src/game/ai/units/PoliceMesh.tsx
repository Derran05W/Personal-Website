// Police-sedan visuals + system mount (Phase 9 Task 2; TDD §5.6). ONE InstancedMesh (capacity =
// the max pursuit cap, 10) renders every police slot of the spawn director's roster
// (ai/pursuitTypes.ts's `unitsRef`), mirroring ai/TrafficMesh.tsx: it reads the pose slots each
// frame and never mutates them. Part 4's armored/SWAT/etc. units get their OWN meshes reading the
// same roster (each renders only its own `slot.kind`), so multiple unit meshes coexist over the
// one shared slot array.
//
// This component is also the police system's MOUNT (the task's "mesh/mount"): besides rendering it
//   (1) registers the police factory with the director once the live Rapier context exists
//       (useRapier — the deps can't exist at import time, so registration can't be an import
//       side-effect), and
//   (2) owns the ONE shared useBeforePhysicsStep / useAfterPhysicsStep that drive policeSedan.ts's
//       module-scope tick list (apply cached forces before the step; sync pose + wreck after).
// The director drives think() (10 Hz staggered) and spawn/despawn; it does NOT apply forces.
//
// Must live inside <Physics> (step hooks read the Rapier context) and be keyed on the world seed
// alongside the city/traffic/director so the whole pursuit system tears down and rebuilds on
// regenerate. Uses the ONE shared palette material (world/palette.ts) so it costs one draw call.
//
// LIGHTBAR (Phase 16 Task 3 polish — was v1 single-colour): the police body bakes uv2 = asphalt
// (dark, no emission) on every face EXCEPT a small roof bar whose uv2 = signalRed. The shared
// material's per-instance aEmissiveOn attribute gates the whole instance's emissive term
// uniformly (it's per-instance, not per-face), so one scalar can only ever gate ONE baked colour
// on/off — genuine two-colour alternation needs a second, independently-gated emissive surface.
// Rather than touch the shared material's shader (world/palette.ts — every instanced thing in the
// game depends on its aEmissiveOn contract; out of scope for this polish), a SECOND small BLUE
// accent pod is baked as its OWN geometry (buildPoliceLightbarBlue), stacked directly on top of
// the red bar (non-overlapping footprint — no z-fight) and rendered via a SECOND InstancedMesh
// sharing the exact same per-instance world matrix as the main body (both baked in the same
// chassis-local frame, so no extra transform math needed). fx/lightbarStrobe.ts's lightbarPhase()
// drives the two meshes' aEmissiveOn attributes on complementary windows of the same cycle — red
// lit while blue is dark and vice versa, config/fx.ts's LIGHTBAR block (Hz/duty/split). One extra
// draw call for the blue pod (~10 extra triangles) — trivial against the TDD §10 budget.

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
import { lightbarPhase } from '../../fx/lightbarStrobe';
import { PaletteCell } from '../../world/archetypes';
import { addBox, createBuilder, toBufferGeometry } from '../../world/geometry/kit';
import { getCityMaterial } from '../../world/palette';
import { registerUnitFactory, unregisterUnitFactory } from '../spawnDirector';
import { unitsRef } from '../pursuitTypes';
import { createPoliceFactory, stepPursuitAfter, stepPursuitBefore } from './policeSedan';

const PHYSICS_DT = 1 / 60;
// Pool/mesh capacity = the largest pursuit cap across tiers (SPAWN.caps[5] = 10 = the director's
// slot-array length), so the mesh has an instance for every possible roster index.
const CAPACITY = Math.max(...SPAWN.caps);

const WHITE = new Color(1, 1, 1);
const ZERO_MATRIX = new Matrix4().makeScale(0, 0, 0);

// Hot-path scratch (module scope — the useFrame body allocates nothing per instance).
const _dummy = new Object3D();
const _color = new Color();

/**
 * Chassis-centered procedural police cruiser (origin = chassis center, +Z forward, +Y up — the
 * frame the slot pose is written in). Reuses VEHICLE_TUNING's chassis + wheel dimensions so the
 * paint sits exactly on the collider the pursuit chassis drives. Black-and-white livery: white
 * body, dark greenhouse/bumpers/wheels, red roof lightbar (its uv2 → signalRed for the strobe).
 * Wheels are baked static (instanced — no per-wheel suspension animation like the player mesh).
 */
function buildPoliceCar(): BufferGeometry {
  const { chassis, wheels } = VEHICLE_TUNING;
  const hw = chassis.halfWidth;
  const hh = chassis.halfHeight;
  const hl = chassis.halfLength;
  const white = PaletteCell.liveryWhite;
  const dark = PaletteCell.metalDark;
  const red = PaletteCell.signalRed;

  const b = createBuilder();

  // Body — the white shell (chassis box).
  addBox(
    b,
    { minX: -hw, maxX: hw, minY: -hh, maxY: hh, minZ: -hl, maxZ: hl },
    {
      px: { albedo: white },
      nx: { albedo: white },
      py: { albedo: white },
      ny: { albedo: white },
      pz: { albedo: white },
      nz: { albedo: white },
    },
  );

  // Cabin — dark greenhouse, aft-shifted for a sedan silhouette (underside flush on roof, omitted).
  const cabinHW = hw * 0.8;
  const cabinHL = hl * 0.5;
  const cabinZ = hl * -0.08;
  const cabinY0 = hh;
  const cabinY1 = hh + 0.42;
  addBox(
    b,
    { minX: -cabinHW, maxX: cabinHW, minY: cabinY0, maxY: cabinY1, minZ: cabinZ - cabinHL, maxZ: cabinZ + cabinHL },
    {
      px: { albedo: dark },
      nx: { albedo: dark },
      py: { albedo: dark },
      pz: { albedo: dark },
      nz: { albedo: dark },
    },
  );

  // Lightbar — small red bar across the roof; uv2 = signalRed so aEmissiveOn strobes ONLY this.
  const barHW = cabinHW * 0.7;
  const barHL = 0.16;
  const barY0 = cabinY1;
  const barY1 = cabinY1 + 0.14;
  addBox(
    b,
    { minX: -barHW, maxX: barHW, minY: barY0, maxY: barY1, minZ: cabinZ - barHL, maxZ: cabinZ + barHL },
    {
      px: { albedo: red, emissive: red },
      nx: { albedo: red, emissive: red },
      py: { albedo: red, emissive: red },
      pz: { albedo: red, emissive: red },
      nz: { albedo: red, emissive: red },
    },
  );

  // Bumpers — dark, front (+Z) / rear (−Z). Buried faces omitted.
  const bumperHW = hw * 0.96;
  const bumperCY = -hh * 0.55;
  const bumperY0 = bumperCY - 0.11;
  const bumperY1 = bumperCY + 0.11;
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

  // Wheels — dark boxy stubs at the four corners, baked near the settled ride height. Top (hidden)
  // and bottom (on the ground) faces omitted.
  const r = wheels.radius;
  const wheelHalfW = 0.13;
  const wheelCY = -0.48;
  const corners: readonly [number, number][] = [
    [-wheels.halfTrack, wheels.frontZ],
    [wheels.halfTrack, wheels.frontZ],
    [-wheels.halfTrack, wheels.rearZ],
    [wheels.halfTrack, wheels.rearZ],
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
 * The BLUE strobe accent pod (Phase 16 Task 3): a small box stacked directly on top of
 * buildPoliceCar's red lightbar, same chassis-local frame, non-overlapping Y range (no
 * z-fight against the ever-present red bar). Dimensions are DERIVED from the same numbers
 * buildPoliceCar uses for its bar (not shared constants — that function's are intentionally
 * function-local) — if the cabin/bar geometry is ever retuned there, this must move with it.
 */
function buildPoliceLightbarBlue(): BufferGeometry {
  const { chassis } = VEHICLE_TUNING;
  const hw = chassis.halfWidth;
  const hh = chassis.halfHeight;
  const blue = PaletteCell.policeBlue;

  const cabinHW = hw * 0.8;
  const cabinZ = chassis.halfLength * -0.08;
  const cabinY1 = hh + 0.42;
  const barHW = cabinHW * 0.7;
  const barHL = 0.16;
  const barY1 = cabinY1 + 0.14; // top of the red bar — this pod's floor

  const podHW = barHW * 0.6;
  const podHL = barHL * 0.8;
  const podY0 = barY1;
  const podY1 = barY1 + 0.1;

  const b = createBuilder();
  addBox(
    b,
    { minX: -podHW, maxX: podHW, minY: podY0, maxY: podY1, minZ: cabinZ - podHL, maxZ: cabinZ + podHL },
    {
      px: { albedo: blue, emissive: blue },
      nx: { albedo: blue, emissive: blue },
      py: { albedo: blue, emissive: blue },
      pz: { albedo: blue, emissive: blue },
      nz: { albedo: blue, emissive: blue },
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

export function PoliceMesh() {
  const meshRef = useRef<InstancedMesh>(null);
  const blueBarRef = useRef<InstancedMesh>(null);
  const { world, rapier } = useRapier();
  const capacity = CAPACITY;

  // Geometry + its per-instance aEmissiveOn attribute (the shared palette material samples it
  // unconditionally, so every geometry it renders must carry it). Built once; the attribute is
  // read back off the mesh geometry inside useFrame (not captured here) so the lint rule that
  // forbids mutating a useMemo value after render stays satisfied.
  const geometry = useMemo(() => makeGeometry(buildPoliceCar, capacity), [capacity]);
  // Blue strobe accent pod (Phase 16 Task 3) — see this file's header + buildPoliceLightbarBlue's
  // doc comment. Same capacity, same attribute contract, own draw call.
  const blueBarGeometry = useMemo(() => makeGeometry(buildPoliceLightbarBlue, capacity), [capacity]);

  const material = useMemo(() => getCityMaterial(), []);

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => blueBarGeometry.dispose(), [blueBarGeometry]);

  // Register the police factory with the director now that the Rapier context is live (deps
  // don't exist at import time — see policeSedan.ts's createPoliceFactory). Unregister on unmount.
  useEffect(() => {
    registerUnitFactory('police', createPoliceFactory({ world, rapier }));
    return () => unregisterUnitFactory('police');
  }, [world, rapier]);

  // The ONE shared per-step drivers of the module tick list (policeSedan.ts): apply cached inputs
  // before the physics step, copy pose + run wreck detection after.
  useBeforePhysicsStep(() => stepPursuitBefore(PHYSICS_DT));
  useAfterPhysicsStep(() => stepPursuitAfter());

  // Initial fill: every instance hidden, colour allocated (both meshes).
  useEffect(() => {
    for (const mesh of [meshRef.current, blueBarRef.current]) {
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
    const mesh = meshRef.current;
    const blueBar = blueBarRef.current;
    if (mesh === null || blueBar === null) return;
    const slots = unitsRef.current?.slots;
    const t = performance.now() / 1000;
    const emissiveAttr = mesh.geometry.getAttribute('aEmissiveOn') as InstancedBufferAttribute;
    const blueEmissiveAttr = blueBar.geometry.getAttribute('aEmissiveOn') as InstancedBufferAttribute;

    for (let i = 0; i < capacity; i++) {
      const slot = slots?.[i];
      // Render only live POLICE slots (free slots carry kind null; other kinds have their own mesh).
      if (slot === undefined || slot.kind !== 'police') {
        mesh.setMatrixAt(i, ZERO_MATRIX);
        blueBar.setMatrixAt(i, ZERO_MATRIX);
        emissiveAttr.setX(i, 0);
        blueEmissiveAttr.setX(i, 0);
        continue;
      }

      _dummy.position.set(slot.x, slot.y, slot.z);
      _dummy.quaternion.set(slot.qx, slot.qy, slot.qz, slot.qw);
      _dummy.scale.set(1, 1, 1);
      _dummy.updateMatrix();
      mesh.setMatrixAt(i, _dummy.matrix);
      // Blue accent pod is baked in the SAME chassis-local frame as the main body — the exact
      // same world matrix places it correctly, no separate transform needed.
      blueBar.setMatrixAt(i, _dummy.matrix);

      _color.copy(WHITE);
      // Phase 16: graduated damage tint (25/50/75% HP lost), full charred at 'wrecked' — see
      // fx/damageStates.ts's tintDamageColor header. Shared by both meshes (one damage state
      // per unit, regardless of which pod is currently lit).
      tintDamageColor(_color, hpLostFraction(slot.hp, ENEMY_UNITS.police.hp), slot.state === 'wrecked');
      mesh.setColorAt(i, _color);
      blueBar.setColorAt(i, _color);

      // Strobe the lightbar (off on wrecked debris): fx/lightbarStrobe.ts's lightbarPhase()
      // alternates red/blue on complementary windows of the same cycle — never both lit at
      // once — per-instance phase offset (config/fx.ts's LIGHTBAR.phaseStaggerPerInstance)
      // staggers the roster so they don't blink in unison.
      const phase = slot.state === 'wrecked' ? null : lightbarPhase(t, i);
      emissiveAttr.setX(i, phase?.red ?? 0);
      blueEmissiveAttr.setX(i, phase?.blue ?? 0);
    }

    mesh.instanceMatrix.needsUpdate = true;
    blueBar.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    if (blueBar.instanceColor !== null) blueBar.instanceColor.needsUpdate = true;
    emissiveAttr.needsUpdate = true;
    blueEmissiveAttr.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh ref={meshRef} args={[geometry, material, capacity]} frustumCulled={false} castShadow />
      <instancedMesh
        ref={blueBarRef}
        args={[blueBarGeometry, material, capacity]}
        frustumCulled={false}
        castShadow
      />
    </>
  );
}
