// Phase 30 (T2 debt-1) — R3F mount for the Toronto street-furniture launch pool
// (furnitureDynamics.ts). Mirrors world/PropDynamicsMount.tsx's shape: owns a <group> that
// hosts the per-model dynamic InstancedMeshes the controller adds imperatively, subscribes it
// to the SAME contact spine (combat/contacts.ts's onImpact) legacy props use, wires the
// transformerDestroyed event for the power-box death-launch path, and drives the per-step tick
// from useAfterPhysicsStep.
//
// MUST live inside <Physics> (uses the Rapier context + the after-step hook) — mounted from
// world/toronto/cityPack/CityDress.tsx (T2-owned; avoids touching game/index.tsx entirely, per
// the phase-30 file-ownership split). Model geometry/material/scale/lift for every launchable
// category is loaded up front via the SAME cityPackBaked.ts hook the static BatchedMeshes use
// (so a launched prop is visually identical to what was struck), gated behind <Suspense> —
// these models are already being streamed by StreetFurniture/PowerBoxes in the same scene, so
// this Suspense boundary resolves instantly in practice (shared drei useGLTF cache).

import { Suspense, useEffect, useMemo, useRef } from 'react';
import { useAfterPhysicsStep, useRapier } from '@react-three/rapier';
import { Group } from 'three';
import { PROPS, dynamicPropPoolCap } from '../../../config';
import { getGameState } from '../../../state/store';
import { gameEvents } from '../../../state/events';
import { onImpact } from '../../../combat/contacts';
import { useBakedCityPackModel } from './cityPackBaked';
import { debugRegisteredCategories } from './batchedRegistry';
import { FurniturePropSwapController, type FurnitureModelData } from './furnitureDynamics';

/** Loads every launchable model's baked render data (Suspense-gated). Hook calls are written
 * out explicitly (not looped) so the Rules of Hooks stay trivially satisfied regardless of any
 * future reordering of furnitureDynamics.ts's model-id list. */
function useFurnitureModels(): ReadonlyMap<string, FurnitureModelData> {
  const hydrant = useBakedCityPackModel('fire-hydrant');
  const bench = useBakedCityPackModel('bench');
  const tree = useBakedCityPackModel('tree');
  const trafficLight = useBakedCityPackModel('traffic-light');
  const trashCan = useBakedCityPackModel('trash-can');
  const stopSign = useBakedCityPackModel('stop-sign');
  const busStop = useBakedCityPackModel('bus-stop');
  const powerBox = useBakedCityPackModel('power-box');

  return useMemo(
    () =>
      new Map<string, FurnitureModelData>([
        ['fire-hydrant', hydrant],
        ['bench', bench],
        ['tree', tree],
        ['traffic-light', trafficLight],
        ['trash-can', trashCan],
        ['stop-sign', stopSign],
        ['bus-stop', busStop],
        ['power-box', powerBox],
      ]),
    [hydrant, bench, tree, trafficLight, trashCan, stopSign, busStop, powerBox],
  );
}

function FurnitureDynamicsController() {
  const { world, rapier } = useRapier();
  const models = useFurnitureModels();
  const groupRef = useRef<Group>(null);
  const controllerRef = useRef<FurniturePropSwapController | null>(null);

  useEffect(() => {
    const group = groupRef.current;
    if (group === null) return;
    // Same tier-scaled pool-cap seam world/PropDynamicsMount.tsx uses (Phase 18) — a shared
    // budget concept (dynamicPropPoolCap), applied to this SEPARATE furniture pool rather than
    // borrowing legacy's live pool instance (BatchedMesh vs InstancedMesh precludes sharing the
    // literal object; the CAP NUMBER is still the same config, not forked).
    const poolCap = dynamicPropPoolCap(PROPS.dynamicPoolCap, getGameState().settings.quality);
    const controller = new FurniturePropSwapController(world, rapier, group, models, poolCap);
    controllerRef.current = controller;

    const unsubImpact = onImpact((record) => controllerRef.current?.handleImpact(record));
    const unsubDeath = gameEvents.on('transformerDestroyed', ({ districtId }) => {
      controllerRef.current?.notifyPowerBoxDeath(districtId);
    });
    const unsubDebug = import.meta.env.DEV ? installFurnitureDebugBridge(controller) : undefined;

    return () => {
      unsubImpact();
      unsubDeath();
      unsubDebug?.();
      controller.dispose();
      controllerRef.current = null;
    };
  }, [world, rapier, models]);

  useAfterPhysicsStep(() => {
    controllerRef.current?.update();
  });

  return <group ref={groupRef} />;
}

/**
 * Mount snippet (for reference — this component is already mounted directly inside
 * world/toronto/cityPack/CityDress.tsx's <CityDress>, gated on the same `showFurniture`
 * devToggle as StreetFurniture/PowerBoxes, so no index.tsx change is needed):
 *
 *   <FurnitureDynamicsMount />
 *
 * Must be a descendant of <Physics> (true for every existing CityDress mount site).
 */
export function FurnitureDynamicsMount() {
  return (
    <Suspense fallback={null}>
      <FurnitureDynamicsController />
    </Suspense>
  );
}

// ===========================================================================================
// DEV-only debug bridge (dead-code-eliminated from prod builds by the import.meta.env.DEV
// guard at the call site above) — mirrors world/PropDynamicsMount.tsx's window.__smashyProps
// so a scripted (Playwright) verification pass can read pool occupancy/simTime without
// watching pixels, the same convention every other Phase-6+ pool/system debug surface uses.
// ===========================================================================================

declare global {
  interface Window {
    /** DEV-only Toronto furniture-launch-pool debug surface. */
    __smashyFurniture?: {
      /** Live pool occupancy (≤ the tier-scaled cap). */
      occupancy: () => number;
      /** Accumulated sim seconds (despawn-window polling). */
      simTime: () => number;
      /** Every registered batched-furniture category + its live instance count — proves the
       * CityPackBatched onMesh wiring actually ran (live-verification diagnostic). */
      registeredCategories: () => readonly { modelId: string; instanceCount: number }[];
    };
  }
}

function installFurnitureDebugBridge(controller: FurniturePropSwapController): () => void {
  window.__smashyFurniture = {
    occupancy: () => controller.occupancy(),
    simTime: () => controller.getSimTime(),
    registeredCategories: () => debugRegisteredCategories(),
  };
  return () => {
    delete window.__smashyFurniture;
  };
}
