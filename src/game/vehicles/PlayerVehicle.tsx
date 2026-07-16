// R3F wiring for the player vehicle (Phase 3, TDD §7). Renders the chassis RigidBody
// declaratively — so @react-three/rapier's interpolation writes the render transform onto
// the group the car mesh reads — and bridges it to the imperative RaycastVehicle model.
//
// Ownership split (mirrors raycastVehicle.ts's header):
//   • This component owns the RigidBody + its single CuboidCollider (React lifecycle).
//   • The RaycastVehicle model owns the Rapier vehicle controller + wheels, created against
//     our body in the mount effect and torn down on cleanup.
//
// The collider is spawned zero-density: the model sets the body's full mass / dropped COM /
// inertia via additional mass properties in create(), so all mass comes from there.
//
// Do NOT wire this into game/index.tsx here — the phase orchestrator integrates it (and the
// car mesh is a separate task, passed in as {children}).

import { useEffect, useRef, type ReactNode } from 'react';
import {
  CuboidCollider,
  RigidBody,
  useBeforePhysicsStep,
  useRapier,
  type RapierRigidBody,
} from '@react-three/rapier';
import { Group } from 'three';
import { interactionGroups, VEHICLE_TUNING } from '../config';
import { getDrivingInput } from '../input';
import { createRaycastVehicle } from './raycastVehicle';
import { playerVehicle } from './playerRef';

// Mirrors <Physics timeStep={1/60}> in game/index.tsx: useBeforePhysicsStep fires once per
// fixed step, so the model integrates against this exact dt.
const PHYSICS_DT = 1 / 60;

const PLAYER_GROUPS = interactionGroups('PLAYER');

export interface PlayerVehicleProps {
  /** Spawn position (world meters). */
  readonly position?: [number, number, number];
  /** The car mesh (a separate task). When absent, a dev wireframe box stands in. */
  readonly children?: ReactNode;
}

export function PlayerVehicle({ position = [0, 1, 0], children }: PlayerVehicleProps) {
  const { world, rapier } = useRapier();
  const bodyRef = useRef<RapierRigidBody>(null);
  const groupRef = useRef<Group>(null);

  const { chassis } = VEHICLE_TUNING;

  // Instantiate + tear down the vehicle model alongside the body. StrictMode-safe: the
  // effect creates a fresh model each mount and destroy()/null are idempotent, so the dev
  // mount → cleanup → mount cycle leaves exactly one live model and no dangling controller.
  useEffect(() => {
    const body = bodyRef.current;
    const object = groupRef.current;
    if (!body || !object) return;

    const model = createRaycastVehicle({ world, rapier, body, object });
    model.create({
      position: { x: position[0], y: position[1], z: position[2] },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    });
    playerVehicle.current = model;

    return () => {
      if (playerVehicle.current === model) playerVehicle.current = null;
      model.destroy();
    };
    // Spawn pose is read once at create; a later position change should remount, not mutate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, rapier]);

  // Feed driving intent every physics step. Rapier is paused outside PLAYING (game/index.tsx
  // sets <Physics paused={machine !== 'PLAYING'}>), so this naturally only runs during a run.
  useBeforePhysicsStep(() => {
    playerVehicle.current?.applyInputs(getDrivingInput(), PHYSICS_DT);
  });

  return (
    <RigidBody
      ref={bodyRef}
      type="dynamic"
      colliders={false}
      ccd
      canSleep={false}
      position={position}
    >
      <CuboidCollider
        args={[chassis.halfWidth, chassis.halfHeight, chassis.halfLength]}
        collisionGroups={PLAYER_GROUPS}
        density={0}
      />
      <group ref={groupRef}>
        {children ?? (
          <mesh castShadow>
            <boxGeometry
              args={[chassis.halfWidth * 2, chassis.halfHeight * 2, chassis.halfLength * 2]}
            />
            <meshStandardMaterial color="#e0533d" wireframe />
          </mesh>
        )}
      </group>
    </RigidBody>
  );
}
