// Phase 3 driving-feel test scene. Replaces core/PlaceholderScene.tsx: same ground slab
// + grid + lighting as the Phase 2 proof scene, plus a hand-placed obstacle course (a
// scatter of static cuboids and one ramp) so the fun gate (TDD M1) has something to
// actually drive around and jump off. Throwaway by design — Phase 4's seeded world
// generator replaces this file outright, so placements are inline literals here rather
// than game/config tunables (CLAUDE.md's "no magic numbers" rule is scoped to real
// gameplay config, not this scene).

import { RigidBody } from '@react-three/rapier';
import { Grid } from '@react-three/drei';
import { interactionGroups } from '../config';

interface TestBox {
  position: [number, number, number];
  /** width (x), height (y), length (z) — fed straight into boxGeometry's args. */
  size: [number, number, number];
  color: string;
}

// ~12 hand-placed static obstacles, 15-60 m from the origin, 1-2.5 m per side, kept clear
// of the ramp's footprint (roughly x in [-3,3], z in [20,30]). The last two entries are
// small "toppers" resting on top of boxes 0 and 3 — a couple of stacked crates for a bit
// of stunt fun — their Y already accounts for the box height underneath them.
const TEST_BOXES: TestBox[] = [
  { position: [18, 1.25, -10], size: [1.5, 2.5, 1.5], color: '#e0533d' },
  { position: [-20, 0.6, 5], size: [2.0, 1.2, 2.0], color: '#4f83cc' },
  { position: [30, 0.9, 15], size: [1.0, 1.8, 2.5], color: '#3fae7d' },
  { position: [-15, 0.5, -15], size: [2.5, 1.0, 1.5], color: '#c9a227' },
  { position: [10, 1.1, -25], size: [1.2, 2.2, 1.2], color: '#8858c8' },
  { position: [-35, 0.75, 20], size: [1.8, 1.5, 2.0], color: '#d97b29' },
  { position: [45, 1.25, -10], size: [1.0, 2.5, 1.0], color: '#5ec1c8' },
  { position: [-10, 0.65, 40], size: [2.2, 1.3, 1.8], color: '#b5495b' },
  { position: [25, 0.95, -35], size: [1.5, 1.9, 1.3], color: '#7a8b99' },
  { position: [-45, 0.8, -20], size: [2.0, 1.6, 2.2], color: '#e0a63d' },
  { position: [18, 2.9, -10], size: [0.8, 0.8, 0.8], color: '#f2f2f2' }, // topper on box 0
  { position: [-15, 1.5, -15], size: [1.0, 1.0, 1.0], color: '#ff6f91' }, // topper on box 3
];

// Ramp: 6 m wide x 10 m long, 15 deg incline. The negative rotation raises the +Z (far)
// edge; the Y position is solved so the near/low edge's *top* face sits flush with the
// ground (y=0) — no lip to catch a wheel on approach — while the bottom face embeds
// harmlessly into the ground slab. Far edge tops out around y=2.6 m: a launch ramp, not
// just a climb. Center sits ~25 m out along +Z, approachable head-on from the flat slab.
const RAMP_INCLINE_DEG = 15;
const RAMP_INCLINE_RAD = (-RAMP_INCLINE_DEG * Math.PI) / 180;
const RAMP_POSITION: [number, number, number] = [0, 1.05, 25];
const RAMP_SIZE: [number, number, number] = [6, 0.5, 10];

export function TestPlane() {
  return (
    <>
      {/* Phase 2 lighting, unchanged (real lighting rig is Phase 5). */}
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
          300 x 300 m slab, same as Phase 2. */}
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

      {/* Static obstacle scatter: PROP_STATIC group, fixed bodies, collider shape
          inferred from each box's own mesh geometry. */}
      {TEST_BOXES.map((box, i) => (
        <RigidBody
          key={i}
          type="fixed"
          position={box.position}
          colliders="cuboid"
          collisionGroups={interactionGroups('PROP_STATIC')}
        >
          <mesh castShadow>
            <boxGeometry args={box.size} />
            <meshStandardMaterial color={box.color} />
          </mesh>
        </RigidBody>
      ))}

      {/* Drivable ramp: fixed, rotated cuboid, same PROP_STATIC group as the scatter. */}
      <RigidBody
        type="fixed"
        position={RAMP_POSITION}
        rotation={[RAMP_INCLINE_RAD, 0, 0]}
        colliders="cuboid"
        collisionGroups={interactionGroups('PROP_STATIC')}
      >
        <mesh castShadow receiveShadow>
          <boxGeometry args={RAMP_SIZE} />
          <meshStandardMaterial color="#647089" />
        </mesh>
      </RigidBody>
    </>
  );
}
