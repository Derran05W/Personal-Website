// Phase 31 T2 (D6) — the PLAYER-CAR variant transform for scripts/city-pack.mjs. Emits
// `<id>-player.glb` for the 5 pack models the player/garage swap targets (car-a, sports-car-a,
// sports-car-b, pickup-truck, bus): unlike every other pack output (which palette()+join()s the
// WHOLE document down to one draw call), these variants must keep each wheel as a SEPARATE named
// node with a sane rotation pivot — vehicles/meshes/PackCarMesh.tsx spins/steers wheels
// independently, the same wheel-sync contract vehicles/RustySedanMesh.tsx documents for the
// procedural cars.
//
// SOURCE NODE NAMES (measured directly off the raw GLBs — inconsistent per model, hence the
// explicit table rather than a name-pattern heuristic):
//   Car.glb                    body="NormalCar1_Cube.012"   L="NormalCar1_FrontLeftWheel_Cube.007"  R="NormalCar1_FrontRightWheel_Cube.008"  rear="NormalCar1_BackWheels_Cube.011"
//   Sports Car.glb             body="SportsCar2_Cube.006"   L="SportsCar2_FrontLeftWheel_Cylinder.017" R="SportsCar2_FrontRightWheel_Cylinder.018" rear="SportsCar2_BackWheels_Cylinder.002"
//   Sports Car-Gzj704DXdr.glb  body="Sports"                L="FrontWheel_L"  R="FrontWheel_R"  rear="BackWheels"
//   Pickup Truck.glb           body="Pickup"                L="FrontWheel_L"  R="FrontWheel_R"  rear="BackWheels"
//   Bus.glb                    body="Bus"                   NO separable wheel geometry (single joined mesh) — documented fallback: the
//                              consumer renders fake procedural hubcap discs at the physics wheel
//                              positions instead (see PackCarMesh.tsx).
//
// L/R NAMING GOTCHA (measured, not assumed): the pack's own "Left"/"Right" node names are the
// MIRROR of this engine's convention (RustySedanMesh.tsx WHEEL_SLOTS: facing forward, -X is the
// car's left, +X is its right). Every one of the 4 wheeled source models has its "Left" node at
// POSITIVE world X and "Right" at NEGATIVE world X. Rather than trust the source labels, this
// module derives canonical left/right from the RECENTERED node's own final translation.x sign
// after processing — positive X -> 'wheel-front-right', negative X -> 'wheel-front-left' — so a
// naming quirk in the source can never silently flip a wheel's steer direction.
//
// PIVOT MECHANICS: every wheel node in the raw GLBs has its geometry either offset from the
// node's local origin (zero node translation, vertex data holds the true position — Car.glb/
// Sports Car.glb) or has its own node translation/rotation/scale (Sports Car-Gzj704DXdr.glb/
// Pickup Truck.glb, which also carry a baked -90 deg-about-X axis-convention rotation + a x100
// authoring scale). Both cases are normalized identically:
//   1. clearNodeTransform(node) — bakes THIS node's own local T/R/S into its mesh vertex data,
//      resetting the node to identity. (gltf-transform utility; verified empirically — see
//      phase-31 notes — that composing with an outer identity-transform RootNode, which is what
//      every one of these 5 sources actually has, leaves the final baked world geometry exactly
//      equal to the pre-transform ground truth.)
//   2. Recompute the mesh's own (now world-equivalent) vertex bounding-box CENTER.
//   3. transformMesh() shifts the vertex data by -center, so the wheel's own hub sits at the
//      node's local origin.
//   4. node.setTranslation(center) restores the node's placement.
// Result: every wheel node ends up with rotation=identity, scale=identity, translation=hub
// center, and hub-centered geometry whose disc lies in the local Y-Z plane with the axle along
// local X — exactly the rotation.x-spins-in-place convention RustySedanMesh's cylinders use.
//
// MODULE SPLIT (important): the id/naming constants (PLAYER_SUFFIX, PLAYER_CAR_IDS,
// playerVariantId, basePlayerId, PLAYER_NODE_NAMES) live in the sibling zero-dependency
// cityPackPlayerCarNames.mjs, re-exported below, NOT defined here — this file's top-level
// @gltf-transform/functions + cityPackNeutralBody.mjs (-> lazy `sharp`) imports are Node-only and
// must never reach a browser bundle. src/ runtime code (assets/cityPack.ts, config/
// playerCarPack.ts) imports ONLY from cityPackPlayerCarNames.mjs; a vite client build was
// measured pulling @gltf-transform/core + sharp into the game chunk before this split existed.
import { clearNodeTransform, transformMesh } from '@gltf-transform/functions';
import { applyNeutralBody } from './cityPackNeutralBody.mjs';
import { PLAYER_SUFFIX, PLAYER_CAR_IDS, playerVariantId, basePlayerId, PLAYER_NODE_NAMES } from './cityPackPlayerCarNames.mjs';

export { PLAYER_SUFFIX, PLAYER_CAR_IDS, playerVariantId, basePlayerId, PLAYER_NODE_NAMES };

/** Per-id source node names (see file header). `wheelA`/`wheelB` are the pack's own (unreliable)
 * "left"/"right" nodes — canonicalized by geometry, not trusted by name. `rear` is null only for
 * 'bus' (no separable wheel geometry at all — the one documented fallback case). */
const SOURCE_NODES = {
  'car-a': {
    body: 'NormalCar1_Cube.012',
    wheelA: 'NormalCar1_FrontLeftWheel_Cube.007',
    wheelB: 'NormalCar1_FrontRightWheel_Cube.008',
    rear: 'NormalCar1_BackWheels_Cube.011',
  },
  'sports-car-a': {
    body: 'SportsCar2_Cube.006',
    wheelA: 'SportsCar2_FrontLeftWheel_Cylinder.017',
    wheelB: 'SportsCar2_FrontRightWheel_Cylinder.018',
    rear: 'SportsCar2_BackWheels_Cylinder.002',
  },
  'sports-car-b': { body: 'Sports', wheelA: 'FrontWheel_L', wheelB: 'FrontWheel_R', rear: 'BackWheels' },
  'pickup-truck': { body: 'Pickup', wheelA: 'FrontWheel_L', wheelB: 'FrontWheel_R', rear: 'BackWheels' },
  bus: { body: 'Bus', wheelA: null, wheelB: null, rear: null },
};

function findNodeByName(document, name) {
  return document.getRoot().listNodes().find((n) => n.getName() === name) ?? null;
}

/** Sum-free bounding-box center of a Mesh's raw POSITION attributes across all its primitives
 * (parent/node-relative space — called right after clearNodeTransform, before any ancestor
 * transform is folded in). */
function meshLocalBoundsCenter(mesh) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    if (!pos) continue;
    const arr = pos.getArray();
    for (let i = 0; i < arr.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (arr[i + k] < min[k]) min[k] = arr[i + k];
        if (arr[i + k] > max[k]) max[k] = arr[i + k];
      }
    }
  }
  return [0, 1, 2].map((k) => (min[k] + max[k]) / 2);
}

function translationMatrix(tx, ty, tz) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1];
}

/** Normalizes one wheel node in place: bake-then-recenter (see file header). Returns the node's
 * final [x, y, z] translation (hub center, node-local/pre-ancestor space). */
function recenterWheelNode(node) {
  const mesh = node.getMesh();
  clearNodeTransform(node);
  const center = meshLocalBoundsCenter(mesh);
  transformMesh(mesh, translationMatrix(-center[0], -center[1], -center[2]));
  node.setTranslation(center);
  return center;
}

function renameNodeAndMesh(node, name) {
  node.setName(name);
  const mesh = node.getMesh();
  if (mesh) mesh.setName(name);
}

/**
 * Restructures `document` (already read, BEFORE dedup/flatten/prune/join run) for the player-car
 * variant of `baseId`: renames the body node to 'body', recenters+renames each wheel node to its
 * canonical name. No-ops (beyond the body rename) for 'bus', which has no wheel nodes to find.
 * Returns a report row for the pipeline's console summary.
 */
export function applyPlayerWheelPivots(document, baseId) {
  const spec = SOURCE_NODES[baseId];
  if (!spec) throw new Error(`cityPackPlayerCar: no SOURCE_NODES entry for "${baseId}"`);

  const bodyNode = findNodeByName(document, spec.body);
  if (!bodyNode) throw new Error(`cityPackPlayerCar: ${baseId}: body node "${spec.body}" not found`);
  renameNodeAndMesh(bodyNode, PLAYER_NODE_NAMES.body);

  const found = { wheelA: null, wheelB: null, rear: null };
  for (const key of ['wheelA', 'wheelB', 'rear']) {
    const name = spec[key];
    if (!name) continue;
    const node = findNodeByName(document, name);
    if (!node) throw new Error(`cityPackPlayerCar: ${baseId}: wheel node "${name}" not found`);
    found[key] = { node, center: recenterWheelNode(node) };
  }

  let leftName = null;
  let rightName = null;
  for (const key of ['wheelA', 'wheelB']) {
    const w = found[key];
    if (!w) continue;
    const isRight = w.center[0] > 0;
    const canon = isRight ? PLAYER_NODE_NAMES.wheelFrontRight : PLAYER_NODE_NAMES.wheelFrontLeft;
    renameNodeAndMesh(w.node, canon);
    if (isRight) rightName = canon;
    else leftName = canon;
  }
  if (found.rear) renameNodeAndMesh(found.rear.node, PLAYER_NODE_NAMES.wheelRear);

  return {
    baseId,
    hasWheels: found.wheelA !== null,
    hasRear: found.rear !== null,
    left: leftName,
    right: rightName,
  };
}

/**
 * Combined pre-transform city-pack.mjs applies for the 5 `-player` variants: wheel-pivot
 * restructure (above) THEN the proven neutral-body recolour (cityPackNeutralBody.mjs, reused
 * as-is — it operates generically on any document's materials/textures, not just the
 * CIVILIAN_VEHICLE_IDS set that gets a `-neutral` sibling in the base pipeline). Runs BEFORE
 * dedup/flatten/prune/join, mirroring every other pre-transform in the pipeline.
 *
 * MEASURED DEVIATION (this task): vehicles/meshes/PackCarMesh.tsx does NOT actually consume this
 * recolour — it was the first fix attempt (tint the neutralized map), but a live headless-proof
 * screenshot caught the Red Rocket (sports-car-b) rendering near-black instead of red: the
 * textured donor models' baseColorTexture is a SHARED atlas ("Zombie_Atlas.png" — pickup-truck
 * and sports-car-b literally reference the same image file) whose region under this car's actual
 * UVs is mostly dark/unrelated texels that only a 3%-cluster neutralization pass barely touches,
 * so tint x mostly-black ~= still black regardless of tint colour. The real fix: PackCarMesh.tsx
 * never carries the pack's `map` for the player car at all — flat PLAYER_CAR_TINT only, matching
 * the retired procedural meshes' 100%-flat-colour look. This pre-transform is kept anyway (harmless,
 * and correct if a future consumer ever wants the textured look for a `-player` variant), but is
 * NOT load-bearing for the current renderer — see config/playerCarPack.ts's header for the tint
 * story that IS load-bearing.
 */
export async function applyPlayerVariant(document, baseId) {
  const wheels = applyPlayerWheelPivots(document, baseId);
  // Spread `neutral`'s { class, touched, fallback } at the top level (rather than nesting it)
  // so city-pack.mjs's existing "NEUTRAL-BODY (D5) report" console table — written for the plain
  // applyNeutralBody() return shape — prints these rows correctly with no special-casing; `wheels`
  // rides alongside as an extra field the existing display code simply never reads.
  const neutral = await applyNeutralBody(document, playerVariantId(baseId));
  return { ...neutral, wheels };
}
