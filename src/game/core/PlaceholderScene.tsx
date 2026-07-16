// Throwaway Phase 2 proof scene: a ground plane + one dynamic cube that together prove
// the whole stack is wired — <Canvas> renders, Rapier steps (and pauses), the collision
// groups pack correctly, and the dev panel can reach into the scene. Phase 3 deletes this
// and replaces it with the real world + player vehicle.

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RigidBody, type RapierRigidBody } from '@react-three/rapier';
import { Grid } from '@react-three/drei';
import { interactionGroups } from '../config';

// Dev-panel → scene command bus. A plain module-scope object (deliberately NO leva import
// in this file — PlaceholderScene ships in the production game chunk, and leva must not).
// devPanel.tsx (a dev-only, lazily-loaded chunk) imports this object and writes `x`/`z` +
// flips `dirty`; the scene consumes it in useFrame below. ES modules are singletons, so
// the dev-panel chunk and this chunk share the exact same object reference at runtime.
// This throwaway proof scene co-locates its dev-panel command-bus object with the
// component that consumes it; both are deleted in Phase 3.
// eslint-disable-next-line react-refresh/only-export-components
export const cubeTarget = { x: 0, z: 0, dirty: false };

const CUBE_DROP_HEIGHT = 4;

export function PlaceholderScene() {
  const cubeRef = useRef<RapierRigidBody>(null);

  useFrame(() => {
    if (!cubeTarget.dirty) return;
    const body = cubeRef.current;
    if (!body) return;
    // Teleport via setTranslation: works whether physics is paused or running, so the
    // leva → module-bus → scene wiring is provable even outside PLAYING. Zero out
    // velocities so a teleport mid-fall doesn't fling the cube.
    body.setTranslation({ x: cubeTarget.x, y: CUBE_DROP_HEIGHT, z: cubeTarget.z }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    cubeTarget.dirty = false;
  });

  return (
    <>
      {/* Blue-hour-ish placeholder lighting (real lighting rig is Phase 5). */}
      <ambientLight intensity={0.6} />
      <directionalLight
        position={[25, 35, 15]}
        intensity={1.4}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-40}
        shadow-camera-right={40}
        shadow-camera-top={40}
        shadow-camera-bottom={-40}
      />

      {/* Ground: fixed cuboid collider (zero sim cost), GROUND collision group. A thin
          300 x 300 m slab so the cube has something to land on. */}
      <RigidBody type="fixed" colliders="cuboid" collisionGroups={interactionGroups('GROUND')}>
        <mesh position={[0, -0.5, 0]} receiveShadow>
          <boxGeometry args={[300, 1, 300]} />
          <meshStandardMaterial color="#39404d" />
        </mesh>
      </RigidBody>

      {/* Cheap readability grid overlaid just above the slab (visual only, no collider). */}
      <Grid
        position={[0, 0.02, 0]}
        args={[300, 300]}
        cellSize={5}
        cellThickness={0.6}
        cellColor="#4a5568"
        sectionSize={25}
        sectionThickness={1}
        sectionColor="#647089"
        fadeDistance={220}
        fadeStrength={1.5}
        infiniteGrid={false}
      />

      {/* Dynamic demo cube: PROP_DYNAMIC group. Floats at CUBE_DROP_HEIGHT while physics
          is paused (machine !== PLAYING); falls and settles once PLAYING unpauses it. The
          dev panel's X/Z sliders teleport it (see useFrame above). */}
      <RigidBody
        ref={cubeRef}
        type="dynamic"
        colliders="cuboid"
        position={[0, CUBE_DROP_HEIGHT, 0]}
        collisionGroups={interactionGroups('PROP_DYNAMIC')}
      >
        <mesh castShadow>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="#e0533d" />
        </mesh>
      </RigidBody>
    </>
  );
}
