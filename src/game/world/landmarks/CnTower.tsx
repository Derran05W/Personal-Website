// CN Tower landmark (Phase 19 Task 2; TDD §13). A stylized wayfinding landmark near the
// lakefront — tapered cylinder stack + a flared "pod", ~160 m tall, low-poly (<=600 tris; see
// world/geometry/landmarks.ts's buildCnTowerGeometry). Standalone mount: this component is
// NEVER rendered by world/CityScape.tsx's district-instancing pipeline — the phase-19
// orchestrator mounts it as a sibling inside the same <Physics> tree (see this file's export
// for the mount contract).
//
// Reads `world.landmarks?.cnTower` defensively (world/landmarks/landmarksData.ts) and renders
// nothing until Task 1's generator populates it.
//
// fog:false + no shadows + one base-only cylinder collider — three locked phase-19-plan.md
// decisions:
//   - fog:false (world/landmarks/landmarkMaterial.ts): the tower must read from anywhere on
//     the 640 m map, so it can't fade into the blue-hour distance fog like ordinary buildings.
//   - castShadow={false} everywhere: "no tower shadows" (a ~160 m shadow sweeping the city as
//     the player drives would be a distracting, disproportionate cost for a background
//     landmark — BlueHourRig's shadow frustum already follows the PLAYER, not this).
//   - ONE fixed base-cylinder collider, sized to the base segment only ("nobody reaches the
//     pod") — CLAUDE.md's convex-primitives-only list names cuboids/capsules/balls, but
//     Rapier's CylinderCollider (also convex) is what the phase-19 plan explicitly locked in
//     for this literally-cylindrical base; flagged here for the record.
//
// BEACON: a separate small pulsing MeshBasicMaterial mesh at the antenna tip, NOT baked into
// the body geometry's emissive UVs — see world/landmarks/landmarkMaterial.ts's header for why
// the shared palette material's per-instance emissive plumbing isn't available to a
// fog:false-material object, and this file's own comment on beaconMaterial below for the
// pulse itself. "No real light" (phase-19 brief) — no THREE.PointLight, just a brightness
// pulse on an unlit-looking mesh, mirroring fx/Searchlight.tsx's/ai/HeliMesh.tsx's ground
// blob idiom of small dedicated FX meshes living outside the palette system.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RigidBody } from '@react-three/rapier';
import { Color, Mesh, MeshBasicMaterial, SphereGeometry } from 'three';
import { PROP_DIMS, interactionGroups } from '../../config';
import { buildCnTowerGeometry, CN_TOWER_TOTAL_HEIGHT_M } from '../geometry/landmarks';
import { getLandmarkMaterial } from './landmarkMaterial';
import { districtIdAtWorldPos, getLandmarks } from './landmarksData';
import { RegisteredCylinderCollider } from './registeredCollider';
import type { EntityEntry } from '../registry';
import type { WorldData } from '../types';

const BUILDING_GROUPS = interactionGroups('BUILDING');
const BEACON_PULSE_HZ = 1;
const BEACON_MIN = 0.35;
const BEACON_MAX = 1;
const BEACON_BASE_COLOR = new Color('#ff3b30'); // matches PaletteCell.signalRed's hue family

export interface CnTowerProps {
  readonly world: WorldData;
}

export function CnTower({ world }: CnTowerProps) {
  const point = getLandmarks(world)?.cnTower;

  const geometry = useMemo(() => buildCnTowerGeometry(), []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const material = useMemo(() => getLandmarkMaterial(), []);

  const beaconGeometry = useMemo(() => new SphereGeometry(PROP_DIMS.cnTower.beaconRadiusM, 6, 4), []);
  const beaconMaterial = useMemo(
    () => new MeshBasicMaterial({ color: BEACON_BASE_COLOR.clone(), toneMapped: false }),
    [],
  );
  useEffect(() => {
    return () => {
      beaconGeometry.dispose();
      beaconMaterial.dispose();
    };
  }, [beaconGeometry, beaconMaterial]);

  const beaconRef = useRef<Mesh>(null);

  useFrame((state) => {
    const beacon = beaconRef.current;
    if (!beacon) return;
    const phase = state.clock.elapsedTime * BEACON_PULSE_HZ * Math.PI * 2;
    const level = BEACON_MIN + (BEACON_MAX - BEACON_MIN) * (0.5 + 0.5 * Math.sin(phase));
    (beacon.material as MeshBasicMaterial).color.copy(BEACON_BASE_COLOR).multiplyScalar(level);
  });

  if (!point) return null;

  const d = PROP_DIMS.cnTower;
  const entry: EntityEntry = { kind: 'building', districtId: districtIdAtWorldPos(point.x, point.z) };

  return (
    <>
      <mesh
        geometry={geometry}
        material={material}
        position={[point.x, 0, point.z]}
        castShadow={false}
        receiveShadow={false}
      />
      <mesh
        ref={beaconRef}
        geometry={beaconGeometry}
        material={beaconMaterial}
        position={[point.x, CN_TOWER_TOTAL_HEIGHT_M, point.z]}
        castShadow={false}
        receiveShadow={false}
      />
      <RigidBody type="fixed" colliders={false} collisionGroups={BUILDING_GROUPS}>
        <RegisteredCylinderCollider
          entry={entry}
          halfHeight={d.baseHeightM / 2}
          radius={d.baseRadiusM}
          position={[point.x, d.baseHeightM / 2, point.z]}
        />
      </RigidBody>
    </>
  );
}
