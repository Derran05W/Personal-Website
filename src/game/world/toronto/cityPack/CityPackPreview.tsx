// Phase 25.5 (D14) — the city-pack proof-of-render cluster. Behind the `cityPackPreview` dev
// toggle (default off), this mounts a small cluster of pack models near the Toronto spawn so the
// loader (assets/cityPack.ts), the instancer (CityPackInstances.tsx), the scale config
// (config/cityPackScale.ts), and the collider math all get exercised through their REAL paths and
// judged under the REAL BlueHourRig — while the full world re-dress stays in 25.6. The `unlit`
// prop is the A/B material arm (D8), threaded from the `cityPackUnlit` toggle: true =
// MeshBasicMaterial + baked palette map (toneMapped=false), false = the GLB's real lit material.
//
// NOTE (Phase 32 flip): this cluster's fixed world coordinates (below) were authored relative to
// the Phase 22 Finch-area spawn; TORONTO_SPAWN moved to downtown (config/torontoMap.ts) and this
// cluster did NOT move with it — it now renders in the North York capsule, disconnected from the
// spawn, and may sit near/inside the deterministic seed-416 frontage there. Dev-only, default off,
// out of Part-8 scope; flagged as debt rather than silently left wrong.
//
// LAYOUT (dev-only — NO determinism contract; hand-nudged, comment-documented): the cluster sits in
// the Yonge spine corridor (x≈1482–1518, the drivable 36 wu road) just south of TORONTO_SPAWN
// (world 1500,220, car facing +Z south). That corridor is guaranteed clear of the seed-416 filler
// massing (massing rejects any footprint on a road ribbon + sidewalk margin), so the preview never
// interpenetrates the box-city regardless of seed. Buildings flank a drivable centre gap; a
// big-building sits dead-ahead as the collision target; a scale row (bench/hydrant/tree) sits beside
// the spawned car for a size reference against the ~4.5 wu sedan.

import { Suspense, useEffect } from 'react';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import { interactionGroups } from '../../../config';
import { colliderHalfExtents } from '../../../config/cityPackScale';
import { preloadCityPack } from '../../../assets/cityPack';
import { CityPackInstances, type CityPackPlacement } from './CityPackInstances';

const BUILDING_GROUPS = interactionGroups('BUILDING');

const HALF_PI = Math.PI / 2;

// --- placement data (world XZ; y=0 = ground, models grounded by the instancer) ----------------
// rb-blank ×3 with three near-white-down tints — the instanceColor proof (ONE draw call, three
// visibly distinct facades). West flank of the corridor, wide frontage rotated to face the road.
const RB_BLANK: readonly CityPackPlacement[] = [
  { position: [1489, 0, 250], rotationY: HALF_PI, tint: '#ffcf8f' }, // warm amber
  { position: [1489, 0, 266], rotationY: HALF_PI, tint: '#8fc8ff' }, // cool blue
  { position: [1489, 0, 282], rotationY: HALF_PI, tint: '#a8f0b8' }, // mint green
];

// building-red ×2 — east flank; untinted (baked palette shows through at 0xffffff).
const BUILDING_RED: readonly CityPackPlacement[] = [
  { position: [1511, 0, 250], rotationY: -HALF_PI },
  { position: [1511, 0, 266], rotationY: -HALF_PI },
];

// pizza-corner ×1 — east flank, a corner-piece cap on the red row.
const PIZZA_CORNER: readonly CityPackPlacement[] = [{ position: [1511, 0, 282], rotationY: -HALF_PI }];

// big-building ×1 — dead-ahead on Yonge; the car driving south crashes into it (collider proof).
const BIG_BUILDING: readonly CityPackPlacement[] = [{ position: [1500, 0, 306], rotationY: 0 }];

// traffic-light ×1 — arm reaches west over the road (native arm is on -x). East edge of corridor.
const TRAFFIC_LIGHT: readonly CityPackPlacement[] = [{ position: [1516, 0, 244], rotationY: 0 }];

// scale row — beside the spawned car (x≈1500, z=220) for a size read against the sedan.
const BENCH: readonly CityPackPlacement[] = [{ position: [1508, 0, 234], rotationY: -HALF_PI }];
const FIRE_HYDRANT: readonly CityPackPlacement[] = [{ position: [1512, 0, 234], rotationY: 0 }];
const TREE: readonly CityPackPlacement[] = [{ position: [1514, 0, 240], rotationY: 0 }];

/** Buildings that get a fixed BUILDING-group collider (structural pieces the car must crash into).
 * The scale-row props (bench/hydrant/tree) + the traffic light are cosmetic-only in the preview,
 * matching how the Toronto scene leaves small furniture collider-less. */
const COLLIDER_BUILDINGS: readonly { id: string; placements: readonly CityPackPlacement[] }[] = [
  { id: 'rb-blank', placements: RB_BLANK },
  { id: 'building-red', placements: BUILDING_RED },
  { id: 'pizza-corner', placements: PIZZA_CORNER },
  { id: 'big-building', placements: BIG_BUILDING },
];

const PREVIEW_MODEL_IDS = [
  'rb-blank',
  'building-red',
  'pizza-corner',
  'big-building',
  'traffic-light',
  'bench',
  'fire-hydrant',
  'tree',
] as const;

/** The proof cluster body — every useCityPackModel here suspends until its GLB streams, so this is
 * mounted under a <Suspense> boundary by CityPackPreview below. */
function PreviewCluster({ unlit }: { unlit: boolean }) {
  useEffect(() => {
    // useProgress proof (criterion 4): by the time this effect runs, every model's GLB has streamed
    // through drei's GLTFLoader via the DefaultLoadingManager (which useProgress observes). One log
    // so a live session can confirm the load happened + roughly when.
    console.info('[cityPack] preview cluster mounted — all models loaded via useGLTF/meshopt');
  }, []);

  return (
    <>
      {/* Instanced pack models — ONE InstancedMesh (1 draw call) per id. */}
      <CityPackInstances id="rb-blank" placements={RB_BLANK} unlit={unlit} />
      <CityPackInstances id="building-red" placements={BUILDING_RED} unlit={unlit} />
      <CityPackInstances id="pizza-corner" placements={PIZZA_CORNER} unlit={unlit} />
      <CityPackInstances id="big-building" placements={BIG_BUILDING} unlit={unlit} />
      <CityPackInstances id="traffic-light" placements={TRAFFIC_LIGHT} unlit={unlit} />
      <CityPackInstances id="bench" placements={BENCH} unlit={unlit} castShadow={false} />
      <CityPackInstances id="fire-hydrant" placements={FIRE_HYDRANT} unlit={unlit} castShadow={false} />
      <CityPackInstances id="tree" placements={TREE} unlit={unlit} castShadow={false} />

      {/* Fixed BUILDING colliders (D10) — one cuboid per building placement, oriented to its yaw so
          the ±90° rotated flank buildings collide as they render. Bottom face at y=0 (floor). */}
      <RigidBody type="fixed" colliders={false} collisionGroups={BUILDING_GROUPS}>
        {COLLIDER_BUILDINGS.flatMap(({ id, placements }) => {
          const half = colliderHalfExtents(id);
          return placements.map((p, i) => (
            <CuboidCollider
              key={`${id}-${i}`}
              args={[half.hx, half.hy, half.hz]}
              position={[p.position[0], half.hy, p.position[2]]}
              rotation={[0, p.rotationY ?? 0, 0]}
            />
          ));
        })}
      </RigidBody>
    </>
  );
}

/**
 * The city-pack proof-of-render (D14). Its own <Suspense fallback={null}> so a first mount (or a
 * live toggle flip) streams the GLBs WITHOUT blanking the rest of TorontoScene — only this subtree
 * suspends. `unlit` is the A/B arm.
 */
export function CityPackPreview({ unlit }: { unlit: boolean }) {
  // Preload only once the preview actually mounts (this component renders solely when the
  // `cityPackPreview` toggle is on — TorontoScene's conditional), so a legacy-mode or
  // preview-off game load never fetches the pack GLBs. Idempotent (drei caches per URL); safe to
  // call during render (drei's own examples preload this way).
  preloadCityPack(PREVIEW_MODEL_IDS);
  return (
    <Suspense fallback={null}>
      <PreviewCluster unlit={unlit} />
    </Suspense>
  );
}
