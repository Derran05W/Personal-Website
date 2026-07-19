// Phase 30 (T2 debt-1) — the Toronto street-furniture launch pool. Closes the Phase 29 gap
// documented in torontoColliders.ts's header: a Toronto propStatic hit (hydrant/bench/tree/
// traffic-light-mast/trash-can/stop-sign/bus-stop) previously no-op'd because
// world/propDynamics.ts's swap needs `getArchetypeHandles(archetype)` — the legacy
// world/instancing.ts InstancedMesh registry, which Toronto never builds (its static furniture
// renders through BatchedMesh, cityPack/CityPackBatched.tsx).
//
// MECHANISM (mirrors world/propDynamics.ts's PropSwapController exactly in SHAPE, adapted for
// BatchedMesh + real GLB geometry):
//   1. Hide the struck static instance: BatchedMesh.setVisibleAt(instanceId, false) — the
//      native per-instance visibility API (three r0.185+), simpler and cheaper than legacy's
//      zero-scale-matrix hack (InstancedMesh has no visibility flag, only a matrix to fake one
//      with) — BatchedMesh doesn't need the workaround.
//   2. Disable (never remove — same Rapier-lifecycle reasoning as propDynamics.ts's own header)
//      the fixed collider and unregister its registry entry — EXCEPT for the 'tree' archetype:
//      the plan's explicit rule is "trunk collider stays registered" (a car ramming the spot
//      where a tree WAS should still catch on the stump), so a tree skips this one step only.
//   3. Acquire a pooled dynamic RigidBody + one slot in a per-modelId InstancedMesh built from
//      the SAME baked GLB geometry/material/scale the static BatchedMesh uses (cityPackBaked.ts
//      via the FurnitureDynamicsMount's Suspense-gated loader), apply the shared launch
//      impulse, and register it exactly like a legacy post-swap prop (`kind: 'propDynamic'`).
//
// TUNING REUSE (do NOT fork PropDynamics' thresholds/tuning — CLAUDE.md-adjacent instruction
// for this task): resolveSwapTarget/computeLaunchImpulse/selectEvictionIndex/isExpired/
// PHYSICS_STEP_SEC are IMPORTED VERBATIM from world/propDynamics.ts, so the threshold gate,
// launch-feel formula, eviction policy, and despawn-window math are the exact same functions
// (and hence the exact same PROPS.* config) legacy props use — never re-derived here. The
// per-archetype masses/forceThresholds themselves live in the SAME config/world.ts PROPS
// tables legacy reads (hydrant/bench/tree/trafficLight reuse the pre-existing legacy numbers
// verbatim; trashCan/stopSign/busStop are genuinely new archetypes with no legacy analog, so
// they get their own new entries in that same table — additions, not forks).
//
// POWER BOXES are NOT impact-driven (they're kind:'transformer', hp-based, killed by
// combat/damage.ts's damage resolver, never impulse-swapped) — see notifyPowerBoxDeath below
// for the separate death-driven path.
//
// One controller instance is live per mount (module-scope singleton, mirrors
// world/propDynamics.ts's `activeController`), constructed by FurnitureDynamicsMount.tsx.

import {
  Group,
  InstancedMesh,
  Matrix4,
  Object3D,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import type { RapierContext, RapierRigidBody } from '@react-three/rapier';
import { PROPS, interactionGroups } from '../../../config';
import { POWER_BOX } from '../../../config/torontoDress';
import { colliderHalfExtents } from '../../../config/cityPackScale';
import type { ArchetypeName } from '../../archetypes';
import {
  PHYSICS_STEP_SEC,
  computeLaunchImpulse,
  isExpired,
  resolveSwapTarget,
  selectEvictionIndex,
  type EvictionCandidate,
  type Quat,
  type Vec3,
} from '../../propDynamics';
import { allEntries, getEntity, registerEntity, unregisterEntity, type EntityEntry } from '../../registry';
import type { ImpactRecord } from '../../../combat/types';
import { gameEvents } from '../../../state/events';
import { getBatchedFurniture } from './batchedRegistry';

type RapierWorld = RapierContext['world'];
type RapierNamespace = RapierContext['rapier'];

const PROP_DYNAMIC_GROUPS = interactionGroups('PROP_DYNAMIC');
// Live-tunable reference (leva mutates the leaves in place, so indexing stays live) — same cast
// convention world/propDynamics.ts uses for the identical table, reused (not duplicated) here.
const MASSES = PROPS.masses as Partial<Record<ArchetypeName, number>>;
const DEFAULT_MASS_KG = 100;

/** Toronto archetype -> the pack model id its CityPackBatched/batchedRegistry entry is keyed
 * under. Exported so FurnitureDynamicsMount's loader knows exactly which models to bake. The
 * one archetype NOT in this map ('busStop' IS here; power boxes are handled entirely outside
 * resolveSwapTarget — see notifyPowerBoxDeath). */
export const ARCHETYPE_MODEL_ID: Partial<Record<ArchetypeName, string>> = {
  hydrant: 'fire-hydrant',
  bench: 'bench',
  tree: 'tree',
  trafficLight: 'traffic-light',
  trashCan: 'trash-can',
  stopSign: 'stop-sign',
  busStop: 'bus-stop',
};

/** The pack model id backing the power-box death-launch path (not reached through
 * ARCHETYPE_MODEL_ID — power boxes never resolveSwapTarget). */
export const POWER_BOX_MODEL_ID = 'power-box';

/** Every model id this controller ever needs baked geometry/material for. */
export function launchableModelIds(): readonly string[] {
  return [...new Set(Object.values(ARCHETYPE_MODEL_ID)), POWER_BOX_MODEL_ID];
}

/** Baked render data for one launchable model (supplied by FurnitureDynamicsMount, which loads
 * it via cityPackBaked.ts's useBakedCityPackModel — the SAME geometry/material/scale/lift the
 * static BatchedMesh renders, so the flying replica is visually identical to what was struck). */
export interface FurnitureModelData {
  readonly geometry: BufferGeometry;
  readonly material: Material;
  readonly scale: number;
  /** World-units the model must be lifted so its own floor lands at placement y (cityPackBaked
   * convention) — used only to derive the dynamic collider's LOCAL offset from the body origin
   * (see launch() below), never to place the body itself (the body sits at the exact visual
   * anchor read back off the struck BatchedMesh instance). */
  readonly lift: number;
}

/** One per-model dynamic InstancedMesh + its free-slot bookkeeping (mirrors
 * world/propDynamics.ts's DynamicArchetype, keyed by pack modelId instead of ArchetypeName). */
interface DynamicModel {
  readonly mesh: InstancedMesh;
  readonly free: number[];
  dirty: boolean;
}

/** One live launched prop occupying a global pool slot. */
interface PoolSlot {
  seq: number;
  spawnSimTime: number;
  modelId: string;
  instanceId: number;
  body: RapierRigidBody;
  colliderHandle: number;
}

const ZERO_MATRIX = new Matrix4().makeScale(0, 0, 0);

let activeController: FurniturePropSwapController | null = null;

function setActiveController(controller: FurniturePropSwapController | null): void {
  activeController = controller;
}

export class FurniturePropSwapController {
  private readonly world: RapierWorld;
  private readonly rapier: RapierNamespace;
  private readonly group: Group;
  private readonly poolCap: number;
  private readonly models: ReadonlyMap<string, FurnitureModelData>;

  private readonly dynamics = new Map<string, DynamicModel>();
  private readonly slots: PoolSlot[] = [];
  private seq = 0;
  private simTime = 0;

  private readonly scratchM4 = new Matrix4();
  private readonly scratchPos = new Vector3();
  private readonly scratchQuat = new Quaternion();
  private readonly scratchScale = new Vector3();
  private readonly dummy = new Object3D();

  constructor(
    world: RapierWorld,
    rapier: RapierNamespace,
    group: Group,
    models: ReadonlyMap<string, FurnitureModelData>,
    poolCap: number,
  ) {
    this.world = world;
    this.rapier = rapier;
    this.group = group;
    this.models = models;
    this.poolCap = Math.max(1, Math.floor(poolCap));
    setActiveController(this);
  }

  occupancy(): number {
    return this.slots.length;
  }

  getSimTime(): number {
    return this.simTime;
  }

  /** Impact-driven swap entry point (hydrant/bench/tree/trafficLight/trashCan/stopSign/
   * busStop) — mirrors world/propDynamics.ts's PropSwapController.handleImpact, but resolves
   * the visual side through the Toronto batched registry instead of getArchetypeHandles(). */
  handleImpact(record: ImpactRecord): void {
    const target = resolveSwapTarget(record);
    if (target === null) return;
    const modelId = ARCHETYPE_MODEL_ID[target.archetype];
    if (modelId === undefined) return; // not a Toronto launchable archetype (or legacy-only)

    const live = getEntity(target.handle);
    if (live === undefined || live.kind !== 'propStatic') return;

    this.launch({
      archetype: target.archetype,
      modelId,
      instanceId: target.instanceId,
      districtId: target.districtId,
      staticHandle: target.handle,
      keepStaticCollider: target.archetype === 'tree',
      impactPoint: record.point,
      forceMag: record.forceMag,
    });
  }

  /**
   * Death-driven swap for power boxes (Phase 30 T2 debt-1): transformerDestroyed only carries
   * a districtId (a district can hold several boxes), so this scans every registered
   * `kind: 'transformer'` entry in that district for the one whose hp just reached 0 and whose
   * batched instance is still visible (not yet launched) — "one death -> one box".
   */
  notifyPowerBoxDeath(districtId: number): void {
    const batched = getBatchedFurniture(POWER_BOX_MODEL_ID);
    if (batched === undefined) return;
    for (const [handle, entry] of allEntries()) {
      if (entry.kind !== 'transformer' || entry.districtId !== districtId) continue;
      if ((entry.hp ?? 1) > 0) continue;
      if (entry.instanceId === undefined) continue;
      if (batched.mesh.getVisibleAt(entry.instanceId) === false) continue; // already launched
      this.launch({
        archetype: undefined,
        modelId: POWER_BOX_MODEL_ID,
        instanceId: entry.instanceId,
        districtId,
        staticHandle: handle,
        keepStaticCollider: false,
        impactPoint: undefined,
        forceMag: POWER_BOX.deathLaunchForce,
        massKgOverride: POWER_BOX.launchMassKg,
      });
      return;
    }
  }

  /** Shared launch path: hide the static instance, (maybe) disable+unregister its fixed
   * collider, acquire a pooled dynamic body+mesh slot at the struck instance's exact transform,
   * apply the launch impulse, and register the new dynamic identity. */
  private launch(args: {
    readonly archetype: ArchetypeName | undefined;
    readonly modelId: string;
    readonly instanceId: number;
    readonly districtId: number;
    readonly staticHandle: number;
    readonly keepStaticCollider: boolean;
    readonly impactPoint: Vec3 | undefined;
    readonly forceMag: number;
    readonly massKgOverride?: number;
  }): void {
    const { archetype, modelId, instanceId, districtId, staticHandle, keepStaticCollider, impactPoint, forceMag, massKgOverride } = args;

    const batched = getBatchedFurniture(modelId);
    if (batched === undefined) return; // category not mounted this run
    const bm = batched.mesh;
    if (instanceId < 0 || instanceId >= bm.instanceCount) return;
    if (bm.getVisibleAt(instanceId) === false) return; // already launched — dedup

    const modelData = this.models.get(modelId);
    if (modelData === undefined) return; // geometry not loaded (shouldn't happen — preloaded)

    // (a) capture the struck instance's exact world transform BEFORE hiding it.
    bm.getMatrixAt(instanceId, this.scratchM4);
    this.scratchM4.decompose(this.scratchPos, this.scratchQuat, this.scratchScale);
    const position: Vec3 = { x: this.scratchPos.x, y: this.scratchPos.y, z: this.scratchPos.z };
    const quaternion: Quat = {
      x: this.scratchQuat.x,
      y: this.scratchQuat.y,
      z: this.scratchQuat.z,
      w: this.scratchQuat.w,
    };

    // (b) disable + unregister the fixed collider — EXCEPT trees (trunk stays a live obstacle).
    if (!keepStaticCollider) {
      this.world.getCollider(staticHandle)?.setEnabled(false);
      unregisterEntity(staticHandle);
    }
    // (c) hide the static batched instance.
    bm.setVisibleAt(instanceId, false);

    // (d) make room, then acquire a pooled dynamic body + mesh slot.
    this.ensureCapacity();
    const dyn = this.getOrCreateDynamic(modelId, modelData);
    const freeInstanceId = dyn.free.pop();
    if (freeInstanceId === undefined) return; // unreachable after ensureCapacity

    // (e) dynamic body + collider at the captured transform. The body origin IS the visual
    // anchor (matches how CityPackBatched placed it: groundY + lift); the collider is offset
    // locally so its CENTER sits at groundY + half.hy (half.hy - lift from the body origin).
    const half = colliderHalfExtents(modelId);
    const bodyDesc = this.rapier.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setRotation(quaternion)
      .setLinearDamping(PROPS.settleLinearDamping)
      .setAngularDamping(PROPS.settleAngularDamping)
      .setCanSleep(true);
    const body = this.world.createRigidBody(bodyDesc);
    const colliderDesc = this.rapier.ColliderDesc.cuboid(half.hx, half.hy, half.hz)
      .setTranslation(0, half.hy - modelData.lift, 0)
      .setMass(massKgOverride ?? (archetype ? MASSES[archetype] : undefined) ?? DEFAULT_MASS_KG)
      .setCollisionGroups(PROP_DYNAMIC_GROUPS);
    const collider = this.world.createCollider(colliderDesc, body);

    // (f) launch impulse at the contact point (or a degenerate self-point → pure upward kick,
    // per computeLaunchImpulse's own documented behavior — the power-box death path has no
    // real contact point).
    const impactPointResolved = impactPoint ?? position;
    const impulse = computeLaunchImpulse(position, impactPointResolved, forceMag);
    body.applyImpulseAtPoint(impulse, impactPointResolved, true);

    // (g) register the dynamic identity (mirrors the post-swap shape propDynamics.ts produces).
    const entry: EntityEntry = {
      kind: 'propDynamic',
      instanceId: freeInstanceId,
      districtId,
      ...(archetype ? { archetype } : {}),
    };
    registerEntity(collider.handle, entry);
    this.slots.push({
      seq: this.seq++,
      spawnSimTime: this.simTime,
      modelId,
      instanceId: freeInstanceId,
      body,
      colliderHandle: collider.handle,
    });

    // (h) seed the dynamic mesh instance at the launch transform.
    this.writeInstance(dyn, freeInstanceId, position, quaternion, modelData.scale);
    dyn.dirty = true;

    // (i) gameplay event (FX/score subscribe — combat/damage.ts / fx/eventFx.ts's convention:
    // hp-less props emit propDestroyed on launch). archetype is undefined for the power-box
    // path (it already emitted transformerDestroyed via combat/damage.ts) so it's skipped here
    // — never double-emit for the same death.
    if (archetype !== undefined) {
      gameEvents.emit('propDestroyed', { archetype, x: position.x, y: position.y, z: position.z });
    }
  }

  /** Per-fixed-step tick (useAfterPhysicsStep): advance the sim clock, copy awake bodies'
   * transforms into their mesh slots, despawn slots past PROPS.despawnAfterSec. Mirrors
   * world/propDynamics.ts's PropSwapController.update() exactly. */
  update(): void {
    this.simTime += PHYSICS_STEP_SEC;
    for (let i = this.slots.length - 1; i >= 0; i--) {
      const slot = this.slots[i];
      if (isExpired(slot.spawnSimTime, this.simTime, PROPS.despawnAfterSec)) {
        this.despawnSlot(i);
        continue;
      }
      if (!slot.body.isSleeping()) {
        const dyn = this.dynamics.get(slot.modelId);
        if (dyn !== undefined) {
          this.writeInstanceFromBody(dyn, slot.instanceId, slot.body, slot.modelId);
          dyn.dirty = true;
        }
      }
    }
    for (const dyn of this.dynamics.values()) {
      if (dyn.dirty) {
        dyn.mesh.instanceMatrix.needsUpdate = true;
        dyn.dirty = false;
      }
    }
  }

  /** Remove every dynamic body + mesh (mount unmount / city teardown). */
  dispose(): void {
    for (const slot of this.slots) {
      unregisterEntity(slot.colliderHandle);
      this.world.removeRigidBody(slot.body);
    }
    this.slots.length = 0;
    for (const dyn of this.dynamics.values()) {
      this.group.remove(dyn.mesh);
      dyn.mesh.dispose();
    }
    this.dynamics.clear();
    if (activeController === this) setActiveController(null);
  }

  private ensureCapacity(): void {
    if (this.slots.length < this.poolCap) return;
    const candidates: EvictionCandidate[] = this.slots.map((s) => ({
      seq: s.seq,
      sleeping: s.body.isSleeping(),
    }));
    this.despawnSlot(selectEvictionIndex(candidates));
  }

  private despawnSlot(index: number): void {
    const slot = this.slots[index];
    const last = this.slots.length - 1;
    if (index !== last) this.slots[index] = this.slots[last];
    this.slots.pop();

    unregisterEntity(slot.colliderHandle);
    this.world.removeRigidBody(slot.body);

    const dyn = this.dynamics.get(slot.modelId);
    if (dyn !== undefined) {
      dyn.mesh.setMatrixAt(slot.instanceId, ZERO_MATRIX);
      dyn.mesh.instanceMatrix.needsUpdate = true;
      dyn.free.push(slot.instanceId);
    }
  }

  /** Lazily build a model's dynamic InstancedMesh (one draw call per launchable model,
   * matching the static BatchedMesh's own material/geometry so a launched prop looks
   * identical to the one it replaced). */
  private getOrCreateDynamic(modelId: string, modelData: FurnitureModelData): DynamicModel {
    const existing = this.dynamics.get(modelId);
    if (existing !== undefined) return existing;

    const cap = this.poolCap;
    const mesh = new InstancedMesh(modelData.geometry, modelData.material, cap);
    mesh.frustumCulled = false; // small, moving, few — not worth a whole-mesh frustum test
    for (let i = 0; i < cap; i++) mesh.setMatrixAt(i, ZERO_MATRIX);
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);

    const free: number[] = [];
    for (let i = cap - 1; i >= 0; i--) free.push(i);
    const dyn: DynamicModel = { mesh, free, dirty: false };
    this.dynamics.set(modelId, dyn);
    return dyn;
  }

  private writeInstance(dyn: DynamicModel, instanceId: number, pos: Vec3, rot: Quat, scale: number): void {
    this.dummy.position.set(pos.x, pos.y, pos.z);
    this.dummy.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    this.dummy.scale.set(scale, scale, scale);
    this.dummy.updateMatrix();
    dyn.mesh.setMatrixAt(instanceId, this.dummy.matrix);
  }

  private writeInstanceFromBody(dyn: DynamicModel, instanceId: number, body: RapierRigidBody, modelId: string): void {
    const t = body.translation();
    const r = body.rotation();
    const scale = this.models.get(modelId)?.scale ?? 1;
    this.writeInstance(dyn, instanceId, t, r, scale);
  }
}

/** The live controller's furniture-impact handler, or a no-op when no mount is live (a bare
 * unit test with no city). Subscribed directly to combat/contacts.ts's onImpact by
 * FurnitureDynamicsMount — a SEPARATE subscription from world/propDynamics.ts's PropDynamics
 * mount (both may be live at once; each only acts on the impacts it recognizes). */
export function handleFurnitureImpact(record: ImpactRecord): void {
  activeController?.handleImpact(record);
}

/** Entry point for the transformerDestroyed subscription (FurnitureDynamicsMount wires this to
 * `gameEvents.on('transformerDestroyed', ({ districtId }) => notifyPowerBoxDeath(districtId))`).
 * No-op when no mount is live. */
export function notifyPowerBoxDeath(districtId: number): void {
  activeController?.notifyPowerBoxDeath(districtId);
}

/** Test-only: read the live controller (undefined outside a mounted scene). */
export function __getActiveFurnitureControllerForTest(): FurniturePropSwapController | null {
  return activeController;
}
