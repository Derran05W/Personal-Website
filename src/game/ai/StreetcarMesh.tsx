// Streetcar-traffic visuals (Phase 19 Task 3). Renders every slot of
// ai/streetcarTraffic.ts's StreetcarController roster (the seam: ai/streetcarTypes.ts's
// `streetcarRef`) as ONE InstancedMesh, mirroring ai/TrafficMesh.tsx's read-only-every-frame
// contract exactly (this module owns ONLY rendering — it never mutates a slot or the
// controller). Geometry is built with world/geometry/kit.ts (the SAME low-level accumulator
// ai/units/PoliceMesh.tsx's buildPoliceCar uses) rather than plain three.js boxes like
// vehicles/meshes/RedRocketMesh.tsx: this is an INSTANCED civilian-traffic mesh sharing the
// one city palette material (world/palette.ts's getCityMaterial), not the player's own
// individually-materialed mesh, so it must speak the shared palette-cell/uv2 contract every
// other instanced thing in the game does (CLAUDE.md: "Single palette-texture material shared
// by everything"). PaletteCell already reserves `liveryRed`/`liveryWhite` for exactly this
// ("streetcar/generic livery" — world/archetypes.ts) — this is their first consumer.
//
// Body proportions are read LIVE off PLAYER_CARS.redRocket's resolved chassis
// (getCarDef('redRocket').controller.chassis — the SAME source vehicles/meshes/RedRocketMesh.tsx
// paints over), NOT duplicated as separate numbers, so the traffic variant can never drift from
// the player-car silhouette it's meant to echo. Origin convention DIFFERS from RedRocketMesh on
// purpose: RedRocketMesh is chassis-CENTERED (a driven RaycastVehicle's rigid-body origin sits
// at the chassis center); a streetcar's kinematic/dynamic body origin sits at GROUND level (y=0,
// collider offset up by colliderCenterY — ai/streetcarTraffic.ts's spawn()/convert()), the same
// ground-up convention world/geometry/parkedCar.ts's buildParkedCar() uses for exactly the same
// reason (a static/kinematic world body, not a suspension-driven vehicle chassis) — so this
// geometry is built ground-up (y=0 at the base) too, not centered like buildPoliceCar's.
//
// No pantograph physics (brief: "no pantograph physics") — the roof is left bare; a streetcar
// glimpsed in traffic at speed doesn't need the extra ~6 triangles the player car's decorative
// bent-arm pantograph costs across every instance.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  Matrix4,
  Object3D,
  Vector3,
  type InstancedMesh,
} from 'three';
import { TRAFFIC_STREETCAR } from '../config';
import { hpLostFraction, tintDamageColor } from '../fx/damageStates';
import { getCarDef } from '../vehicles/definitions';
import { PaletteCell } from '../world/archetypes';
import { addBox, createBuilder, toBufferGeometry } from '../world/geometry/kit';
import { getCityMaterial } from '../world/palette';
import { streetcarRef } from './streetcarTypes';

// Base (high-tier) roster size — every lower tier's resolved roster (trafficActiveTarget scales
// it DOWN, never up) fits inside this capacity, mirroring ai/TrafficMesh.tsx's own
// `capacity = TRAFFIC_CIV.activeTarget` convention (not PoliceMesh's max-across-tiers pattern,
// which exists there for a differently-shaped SPAWN.caps table).
const CAPACITY = TRAFFIC_STREETCAR.activeTarget;

const WHITE = new Color(1, 1, 1);
const ZERO_MATRIX = new Matrix4().makeScale(0, 0, 0);
const Y_AXIS = new Vector3(0, 1, 0);

// Hot-path scratch (module scope — the useFrame body allocates nothing per instance).
const _dummy = new Object3D();
const _color = new Color();

// Cap silhouette proportions — mirrors vehicles/meshes/RedRocketMesh.tsx's CAP_LENGTH_FACTOR/
// CAP_WIDTH_FACTOR (the "rounded-ish stepped cap" trick), reused here for exactly the same
// look the brief asks for ("reusing RedRocketMesh's proportions"). Y placement is ground-up
// (see file header) rather than RedRocketMesh's chassis-centered fractions.
const CAP_LENGTH_FACTOR = 0.08;
const CAP_WIDTH_FACTOR = 0.82;
const BAND_Y0_FACTOR = 0.5; // fraction of bodyHeight, from the ground
const BAND_Y1_FACTOR = 0.82;
const BAND_LENGTH_FACTOR = 0.95; // relative to the main (non-cap) body slice
const BAND_PROUD_M = 0.015; // sits this far proud of the body sides — mirrors RedRocketMesh's decal trick

/**
 * Ground-up procedural streetcar body (origin y=0 at the base — see file header), built from
 * PLAYER_CARS.redRocket's resolved chassis dims: a plain-red slab with narrower stepped end
 * caps (a darker red) and a proud white window band — the plain red/white livery CLAUDE.md
 * requires (no real transit-authority branding anywhere).
 */
function buildStreetcarBody(): BufferGeometry {
  const chassis = getCarDef('redRocket').controller.chassis;
  const halfWidth = chassis.halfWidth;
  const bodyHeight = chassis.halfHeight * 2;
  const bodyLength = chassis.halfLength * 2;

  const capLength = bodyLength * CAP_LENGTH_FACTOR;
  const capHalfWidth = halfWidth * CAP_WIDTH_FACTOR;
  const mainHalfLength = bodyLength / 2 - capLength;
  const frontCapZ = chassis.halfLength - capLength / 2;
  const rearCapZ = -frontCapZ;

  const bandY0 = bodyHeight * BAND_Y0_FACTOR;
  const bandY1 = bodyHeight * BAND_Y1_FACTOR;
  const bandHalfLength = (mainHalfLength * 2 * BAND_LENGTH_FACTOR) / 2;
  const bandHalfWidth = halfWidth + BAND_PROUD_M;

  const red = PaletteCell.liveryRed;
  const darkRed = PaletteCell.wallE;
  const white = PaletteCell.liveryWhite;

  const b = createBuilder();

  // Main body — the middle slice, full width. Bottom (ny) omitted: it sits flush on the
  // ground, never seen.
  addBox(
    b,
    { minX: -halfWidth, maxX: halfWidth, minY: 0, maxY: bodyHeight, minZ: -mainHalfLength, maxZ: mainHalfLength },
    {
      px: { albedo: red },
      nx: { albedo: red },
      py: { albedo: red },
      pz: { albedo: red },
      nz: { albedo: red },
    },
  );

  // Front/rear end caps — narrower stepped slices (the "rounded-ish" read). Each omits its
  // ground face AND the face buried flush against the main body.
  addBox(
    b,
    {
      minX: -capHalfWidth,
      maxX: capHalfWidth,
      minY: 0,
      maxY: bodyHeight,
      minZ: frontCapZ - capLength / 2,
      maxZ: frontCapZ + capLength / 2,
    },
    { px: { albedo: darkRed }, nx: { albedo: darkRed }, py: { albedo: darkRed }, pz: { albedo: darkRed } },
  );
  addBox(
    b,
    {
      minX: -capHalfWidth,
      maxX: capHalfWidth,
      minY: 0,
      maxY: bodyHeight,
      minZ: rearCapZ - capLength / 2,
      maxZ: rearCapZ + capLength / 2,
    },
    { px: { albedo: darkRed }, nx: { albedo: darkRed }, py: { albedo: darkRed }, nz: { albedo: darkRed } },
  );

  // Window band — proud decal surface (mirrors ai/units/PoliceMesh.tsx's lightbar / RedRocket-
  // Mesh's own band trick), white against the red body.
  addBox(
    b,
    {
      minX: -bandHalfWidth,
      maxX: bandHalfWidth,
      minY: bandY0,
      maxY: bandY1,
      minZ: -bandHalfLength,
      maxZ: bandHalfLength,
    },
    { px: { albedo: white }, nx: { albedo: white }, pz: { albedo: white }, nz: { albedo: white } },
  );

  return toBufferGeometry(b);
}

export function StreetcarMesh() {
  const meshRef = useRef<InstancedMesh>(null);
  const capacity = CAPACITY;

  const geometry = useMemo(() => {
    const g = buildStreetcarBody();
    const emissive = new InstancedBufferAttribute(new Float32Array(capacity), 1); // all-zero
    emissive.setUsage(DynamicDrawUsage); // never rewritten — streetcars are never a blackout participant
    g.setAttribute('aEmissiveOn', emissive);
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const material = useMemo(() => getCityMaterial(), []);

  useEffect(() => {
    return () => geometry.dispose();
  }, [geometry]);

  // Initial fill: every instance hidden, instanceColor allocated white (irrelevant while hidden).
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

  // Priority-0 (default) useFrame — runs before core/frameOrder.tsx's priority-1 camera/render
  // pass, same convention ai/TrafficMesh.tsx follows, so this frame's pose lands in this frame's
  // render.
  useFrame(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    const slots = streetcarRef.current?.slots;

    for (let i = 0; i < capacity; i++) {
      const slot = slots?.[i];
      if (slot === undefined || slot.state === null) {
        mesh.setMatrixAt(i, ZERO_MATRIX);
        continue;
      }

      _dummy.position.set(slot.x, slot.y, slot.z);
      if (slot.dynamic) {
        // 'converted' / 'wrecked': physics owns the full orientation.
        _dummy.quaternion.set(slot.qx, slot.qy, slot.qz, slot.qw);
      } else {
        // 'driving': kinematic follower — yaw-only, along the loop's travel direction (reads
        // the source-of-truth yaw float directly, exactly ai/TrafficMesh.tsx's convention,
        // rather than trusting the stored quaternion fields to already be yaw-only).
        _dummy.quaternion.setFromAxisAngle(Y_AXIS, slot.yaw);
      }
      _dummy.scale.set(1, 1, 1);
      _dummy.updateMatrix();
      mesh.setMatrixAt(i, _dummy.matrix);

      // Fixed red/white livery (no per-car tint roll, unlike TrafficMesh's TRAFFIC_TINTS —
      // real streetcars aren't randomly colored) tinted toward damage on top, exactly
      // TrafficMesh/PoliceMesh's shared pattern.
      _color.copy(WHITE);
      tintDamageColor(_color, hpLostFraction(slot.hp, TRAFFIC_STREETCAR.hp), slot.state === 'wrecked');
      mesh.setColorAt(i, _color);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, capacity]}
      frustumCulled={false}
      castShadow
    />
  );
}
