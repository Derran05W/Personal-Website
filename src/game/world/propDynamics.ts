// Fixed → dynamic prop swap + dynamic body/mesh pool (Phase 6 Task 2; TDD §7). THE
// "everything is nailed down until you hit it" core — a street prop lives as a zero-cost
// FIXED collider (world/CityColliders.tsx) until an impact whose contact force reaches the
// prop's per-archetype threshold (config PROPS.forceThresholds) knocks it loose into a
// capped pool of DYNAMIC rigid bodies, inheriting a launch impulse so it flies and tumbles.
// Phase 12 tank explosions reuse this swap verbatim.
//
// Consumed input is the combat seam's ImpactRecord (combat/types.ts): the contact spine
// (combat/contacts.ts, sibling) drains Rapier contact-force events, resolves both collider
// handles through world/registry.ts, and dispatches typed records to subscribers. This
// module's controller subscribes (via the PropDynamics mount) and, for any record whose
// static side is a swappable prop above threshold, performs the swap. It never interprets a
// raw Rapier event itself.
//
// The pure helpers + the imperative PropSwapController live here (a component-free module so
// its many non-component exports don't trip react-refresh — same split as CityColliders.tsx
// vs worldCollidersLogic.ts); the R3F mount is world/PropDynamicsMount.tsx.
//
// --- Static-collider disable verdict (part-file gotcha: zero-scaling the instance does NOT
//     remove its collider) ----------------------------------------------------------------
// The fixed collider MUST stop colliding the instant we swap, but it was created
// DECLARATIVELY by CityColliders' <CuboidCollider> and its WASM lifecycle is owned by
// @react-three/rapier. Calling world.removeCollider() on it is unsafe: react-three-rapier
// still holds the handle and double-frees it on unmount (the exact panic class documented in
// CityColliders.tsx's header). So instead of REMOVING we DISABLE:
// world.getCollider(handle).setEnabled(false). A disabled collider leaves the broadphase
// (zero ongoing cost) but the object stays alive, so react-three-rapier's own cleanup path
// is untouched and its handle is never freed/reused out from under the registry. This is the
// part-file's recommended option (ii), and the one used here.

import {
  BufferGeometry,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import type { RapierContext, RapierRigidBody } from '@react-three/rapier';
import { PROPS, interactionGroups } from '../config';
import type { ArchetypeName } from './archetypes';
import { getArchetypeHandles } from './instancing';
import { getCityMaterial } from './palette';
import { getEntity, registerEntity, unregisterEntity, type EntityEntry } from './registry';
import { propColliderBox } from './worldCollidersLogic';
import type { ImpactRecord } from '../combat/types';
import { gameEvents } from '../state/events';

type RapierWorld = RapierContext['world'];
type RapierNamespace = RapierContext['rapier'];

// Matches <Physics timeStep={1/60}> (game/index.tsx): useAfterPhysicsStep fires once per
// fixed step (verified in @react-three/rapier's step loop), so accumulating this per call
// tracks simulation time exactly — and stops accumulating while paused, which is what
// despawn/eviction ageing wants.
export const PHYSICS_STEP_SEC = 1 / 60;

const PROP_DYNAMIC_GROUPS = interactionGroups('PROP_DYNAMIC');

// A single reusable hide matrix — zero scale collapses an instance to an invisible degenerate
// point (the established phase-05 "hide-a-prop" primitive). setMatrixAt copies it, so sharing
// one read-only instance is safe.
const ZERO_MATRIX = new Matrix4().makeScale(0, 0, 0);

// Live-tunable config objects captured by reference (leva mutates their number leaves in
// place, so indexing them stays live). Cast to Partial so a lookup for an archetype that
// isn't a swappable prop (e.g. a building, or transformerBox) is honestly `number | undefined`.
const MASSES = PROPS.masses as Partial<Record<ArchetypeName, number>>;
const THRESHOLDS = PROPS.forceThresholds as Partial<Record<ArchetypeName, number>>;
// Fallback mass if an archetype somehow reaches the pool without a configured mass (it can't:
// the swap gate already requires a configured threshold, and masses/thresholds share keys).
const DEFAULT_MASS_KG = 100;

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}
export interface Quat {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

// ===========================================================================================
// Pure helpers (unit-tested; no Rapier/three side effects)
// ===========================================================================================

/** The identity of a fixed prop the swap should act on, extracted from an ImpactRecord. */
export interface SwapTarget {
  readonly handle: number;
  readonly archetype: ArchetypeName;
  readonly instanceId: number;
  readonly districtId: number;
  /** Remaining hit points at swap time (parked cars) — carried into the dynamic entry so
   * an airborne prop stays damageable; undefined for hp-less props. */
  readonly hp?: number;
}

function staticPropSide(entry: EntityEntry | undefined, handle: number): SwapTarget | null {
  if (entry === undefined) return null;
  // Transformers are kind 'transformer' (HP-based, killed by the damage resolver) — they do
  // NOT swap on impulse, so only kind 'propStatic' passes here.
  if (entry.kind !== 'propStatic') return null;
  if (entry.archetype === undefined || entry.instanceId === undefined) return null;
  return {
    handle,
    archetype: entry.archetype,
    instanceId: entry.instanceId,
    districtId: entry.districtId,
    hp: entry.hp,
  };
}

/**
 * Decide whether an impact swaps a prop, and which one. Returns the static-prop side when:
 * one of the record's sides is a `propStatic` of a swappable archetype (present in
 * PROPS.forceThresholds), AND the record's force magnitude reaches that archetype's
 * threshold. Otherwise null (love-tap, non-prop contact, transformer, etc.).
 */
export function resolveSwapTarget(record: ImpactRecord): SwapTarget | null {
  const target =
    staticPropSide(record.a, record.aHandle) ?? staticPropSide(record.b, record.bHandle);
  if (target === null) return null;
  const threshold = THRESHOLDS[target.archetype];
  if (threshold === undefined) return null; // archetype not swappable
  if (record.forceMag < threshold) return null; // below threshold — stays nailed down
  return target;
}

/**
 * Launch impulse for a freshly-swapped prop:
 *   dir     = normalize(propPos − impactPoint), then dir.y += launchUpKick
 *   impulse = dir × min(forceMag, launchForceCap) × launchImpulseScale
 * Applied at the contact point by the caller so the prop also tumbles. A degenerate direction
 * (impact point essentially at the prop origin) collapses to a pure upward kick.
 */
export function computeLaunchImpulse(propPos: Vec3, impactPoint: Vec3, forceMag: number): Vec3 {
  let dx = propPos.x - impactPoint.x;
  let dy = propPos.y - impactPoint.y;
  let dz = propPos.z - impactPoint.z;
  const len = Math.hypot(dx, dy, dz);
  if (len > 1e-4) {
    dx /= len;
    dy /= len;
    dz /= len;
  } else {
    dx = 0;
    dy = 0;
    dz = 0;
  }
  dy += PROPS.launchUpKick;
  const mag = Math.min(forceMag, PROPS.launchForceCap) * PROPS.launchImpulseScale;
  return { x: dx * mag, y: dy * mag, z: dz * mag };
}

/** One candidate for the eviction policy: acquisition order + current sleep state. */
export interface EvictionCandidate {
  readonly seq: number;
  readonly sleeping: boolean;
}

/**
 * Pick the slot to recycle when the pool is full: the OLDEST SLEEPING slot (lowest seq among
 * sleepers); if none are sleeping, the globally oldest slot. Guarantees a slot is always
 * chosen so a new swap NEVER fails (part-file hard requirement). `slots` must be non-empty.
 */
export function selectEvictionIndex(slots: readonly EvictionCandidate[]): number {
  let oldestIdx = 0;
  let oldestSeq = Infinity;
  let sleepingIdx = -1;
  let sleepingSeq = Infinity;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (s.seq < oldestSeq) {
      oldestSeq = s.seq;
      oldestIdx = i;
    }
    if (s.sleeping && s.seq < sleepingSeq) {
      sleepingSeq = s.seq;
      sleepingIdx = i;
    }
  }
  return sleepingIdx >= 0 ? sleepingIdx : oldestIdx;
}

/** True once a slot has lived past its despawn window. */
export function isExpired(spawnSimTime: number, simTime: number, despawnAfterSec: number): boolean {
  return simTime - spawnSimTime >= despawnAfterSec;
}

/** Decompose an instance/world matrix into position + quaternion (scale discarded — props
 * spawn at unit scale). Reuses caller-provided scratch to stay allocation-free on the hot path. */
export function matrixToTransform(
  m: Matrix4,
  pos: Vector3,
  quat: Quaternion,
  scale: Vector3,
): { position: Vec3; quaternion: Quat } {
  m.decompose(pos, quat, scale);
  return {
    position: { x: pos.x, y: pos.y, z: pos.z },
    quaternion: { x: quat.x, y: quat.y, z: quat.z, w: quat.w },
  };
}

// ===========================================================================================
// Pool controller (Rapier + three; owns the dynamic bodies + per-archetype dynamic meshes)
// ===========================================================================================

/** One per-archetype dynamic InstancedMesh + its free-slot bookkeeping. */
interface DynamicArchetype {
  readonly mesh: InstancedMesh;
  readonly geometry: BufferGeometry; // cloned from the static archetype; disposed on teardown
  readonly free: number[]; // free instance indices (stack; pop to acquire)
  dirty: boolean; // instanceMatrix needs a GPU upload this step
}

/** One live dynamic prop occupying a global pool slot. */
interface PoolSlot {
  seq: number; // monotonic acquisition order (ageing / eviction)
  spawnSimTime: number; // sim clock at spawn (despawn window)
  archetype: ArchetypeName;
  instanceId: number; // index into the archetype's dynamic mesh
  body: RapierRigidBody;
  colliderHandle: number;
}

// Module-scope handle to the LIVE controller, so systems that cause a swap WITHOUT a Rapier
// contact event — combat/hitscan.ts gun-truck bullets (Phase 11), tank shell explosions
// (Phase 12) — can drive the exact same swap path via swapFromExternalHit() below. Set by the
// constructor, cleared by dispose() (guarded so a late teardown of an already-replaced controller
// can't null out the current one). Only one PropDynamics mount is ever live (keyed on the world
// seed in game/index.tsx), so this is a single, unambiguous instance.
let activeController: PropSwapController | null = null;

/** Publish/clear the live controller (a function so the constructor/dispose pass `this` as an
 * argument rather than aliasing it to a variable — keeps the no-this-alias lint happy). */
function setActiveController(controller: PropSwapController | null): void {
  activeController = controller;
}

export class PropSwapController {
  private readonly world: RapierWorld;
  private readonly rapier: RapierNamespace;
  private readonly group: Group;

  private readonly dynamics = new Map<ArchetypeName, DynamicArchetype>();
  private readonly slots: PoolSlot[] = [];
  private seq = 0;
  private simTime = 0;

  // Hot-path scratch (readState-style single-object reuse).
  private readonly scratchM4 = new Matrix4();
  private readonly scratchPos = new Vector3();
  private readonly scratchQuat = new Quaternion();
  private readonly scratchScale = new Vector3();
  private readonly dummy = new Object3D();

  constructor(world: RapierWorld, rapier: RapierNamespace, group: Group) {
    this.world = world;
    this.rapier = rapier;
    this.group = group;
    setActiveController(this); // publish as the external-hit target (see swapFromExternalHit)
  }

  /** Current number of live dynamic props (≤ PROPS.dynamicPoolCap). */
  occupancy(): number {
    return this.slots.length;
  }

  /** Accumulated simulation time (seconds). Debug/despawn polling. */
  getSimTime(): number {
    return this.simTime;
  }

  /**
   * Try to swap the prop referenced by an impact into the dynamic pool. No-op unless the
   * record's static side is a swappable prop at/over threshold and still live in the registry.
   * Order matters (part-file gotcha): capture transform → DISABLE collider → unregister →
   * hide instance → acquire pooled body → impulse → register dynamic.
   */
  handleImpact(record: ImpactRecord): void {
    const target = resolveSwapTarget(record);
    if (target === null) return;

    // Dedupe: the same prop can appear in two force events one step, or already be swapped —
    // the record's cached entry can be stale, so re-check the live registry.
    const live = getEntity(target.handle);
    if (live === undefined || live.kind !== 'propStatic') return;

    const handles = getArchetypeHandles(target.archetype);
    if (handles.length === 0) return; // archetype not built this run — cannot swap visually
    const staticMesh = handles[0].mesh;
    if (target.instanceId < 0 || target.instanceId >= staticMesh.count) return;

    // (a) capture the prop's world transform BEFORE hiding its instance.
    staticMesh.getMatrixAt(target.instanceId, this.scratchM4);
    const { position, quaternion } = matrixToTransform(
      this.scratchM4,
      this.scratchPos,
      this.scratchQuat,
      this.scratchScale,
    );

    // (b) disable (never remove — see file header) the fixed collider.
    this.world.getCollider(target.handle)?.setEnabled(false);
    // (c) unregister the fixed identity.
    unregisterEntity(target.handle);
    // (d) hide the static instance (its collider is already gone from the broadphase).
    staticMesh.setMatrixAt(target.instanceId, ZERO_MATRIX);
    staticMesh.instanceMatrix.needsUpdate = true;

    // (e) make room, then acquire a pooled dynamic body + mesh slot.
    this.ensureCapacity();
    const dyn = this.getOrCreateDynamic(target.archetype);
    const instanceId = dyn.free.pop();
    if (instanceId === undefined) return; // unreachable after ensureCapacity, but keep loud-safe

    // (f) create the dynamic body + collider at the captured transform.
    const box = propColliderBox(target.archetype);
    const bodyDesc = this.rapier.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setRotation(quaternion)
      .setLinearDamping(PROPS.settleLinearDamping)
      .setAngularDamping(PROPS.settleAngularDamping)
      .setCanSleep(true);
    const body = this.world.createRigidBody(bodyDesc);
    const colliderDesc = this.rapier.ColliderDesc.cuboid(
      box.halfExtents[0],
      box.halfExtents[1],
      box.halfExtents[2],
    )
      .setTranslation(0, box.centerY, 0) // box centered above the base, matching the fixed collider
      .setMass(MASSES[target.archetype] ?? DEFAULT_MASS_KG) // exact mass; COM at the box centroid
      .setCollisionGroups(PROP_DYNAMIC_GROUPS);
    const collider = this.world.createCollider(colliderDesc, body);

    // (g) inherit the launch impulse at the contact point → flight + tumble.
    const impactPoint = record.point ?? position;
    const impulse = computeLaunchImpulse(position, impactPoint, record.forceMag);
    body.applyImpulseAtPoint(impulse, impactPoint, true);

    // (h) register the dynamic identity + record the slot. hp (parked cars) carries over —
    // an airborne car stays damageable, and the resolver remains the single propDestroyed
    // emitter for hp-bearing entries (see (j)).
    const entry: EntityEntry = {
      kind: 'propDynamic',
      archetype: target.archetype,
      instanceId,
      districtId: target.districtId,
    };
    if (target.hp !== undefined) entry.hp = target.hp;
    registerEntity(collider.handle, entry);
    this.slots.push({
      seq: this.seq++,
      spawnSimTime: this.simTime,
      archetype: target.archetype,
      instanceId,
      body,
      colliderHandle: collider.handle,
    });

    // (i) seed the dynamic mesh instance at the prop's start transform.
    this.writeInstance(dyn, instanceId, position, quaternion);
    dyn.dirty = true;

    // (j) gameplay event (heat/score/HUD/FX subscribe — Phase 8/16). Emission contract
    // (combat/damage.ts is the other half): hp-LESS props emit here, on launch — being
    // knocked flying IS their destruction. hp-BEARING props (parked cars) emit ONLY from
    // the damage resolver when hp hits 0 (they can be launched and later wrecked, or
    // wrecked in place by accumulated sub-threshold rams) — never both, never twice.
    // `position` (this swap's own captured world transform, step (a) above) is always
    // defined here — unlike combat/damage.ts's propDestroyed path, this one never needs an
    // optional fallback — so fx/eventFx.ts's debrisChips burst always lands exactly where
    // the prop was standing.
    if (target.hp === undefined) {
      gameEvents.emit('propDestroyed', {
        archetype: target.archetype,
        x: position.x,
        y: position.y,
        z: position.z,
      });
    }
  }

  /**
   * Per-fixed-step tick (useAfterPhysicsStep): advance the sim clock, copy AWAKE bodies'
   * transforms into their mesh slots (sleeping bodies rest where they fell — no rewrite), and
   * despawn slots past the despawn window. Iterates in reverse so despawn's swap-pop is safe.
   */
  update(): void {
    this.simTime += PHYSICS_STEP_SEC;
    for (let i = this.slots.length - 1; i >= 0; i--) {
      const slot = this.slots[i];
      if (isExpired(slot.spawnSimTime, this.simTime, PROPS.despawnAfterSec)) {
        this.despawnSlot(i);
        continue;
      }
      if (!slot.body.isSleeping()) {
        const dyn = this.dynamics.get(slot.archetype);
        if (dyn !== undefined) {
          this.writeInstance(dyn, slot.instanceId, slot.body.translation(), slot.body.rotation());
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

  /** Remove every dynamic body + mesh (component unmount / city teardown). */
  dispose(): void {
    for (const slot of this.slots) {
      unregisterEntity(slot.colliderHandle);
      this.world.removeRigidBody(slot.body);
    }
    this.slots.length = 0;
    for (const dyn of this.dynamics.values()) {
      this.group.remove(dyn.mesh);
      dyn.mesh.dispose();
      dyn.geometry.dispose();
    }
    this.dynamics.clear();
    if (activeController === this) setActiveController(null);
  }

  /** Evict one slot when the global pool is full, so an incoming swap always fits. */
  private ensureCapacity(): void {
    if (this.slots.length < PROPS.dynamicPoolCap) return;
    const candidates: EvictionCandidate[] = this.slots.map((s) => ({
      seq: s.seq,
      sleeping: s.body.isSleeping(),
    }));
    this.despawnSlot(selectEvictionIndex(candidates));
  }

  /** Tear down one live slot: unregister, remove the body (its collider goes with it), hide
   * and free the mesh instance. Swap-pop keeps the active list dense (order held by `seq`). */
  private despawnSlot(index: number): void {
    const slot = this.slots[index];
    const last = this.slots.length - 1;
    if (index !== last) this.slots[index] = this.slots[last];
    this.slots.pop();

    unregisterEntity(slot.colliderHandle);
    this.world.removeRigidBody(slot.body); // removes the attached collider too

    const dyn = this.dynamics.get(slot.archetype);
    if (dyn !== undefined) {
      dyn.mesh.setMatrixAt(slot.instanceId, ZERO_MATRIX);
      dyn.mesh.instanceMatrix.needsUpdate = true;
      dyn.free.push(slot.instanceId);
    }
  }

  /** Lazily build an archetype's dynamic InstancedMesh (one draw call), reusing the static
   * archetype's geometry via a CLONE (its aEmissiveOn buffer is sized for the static count and
   * would alias — so the clone gets a fresh pool-sized all-zeros aEmissiveOn; dynamic props are
   * never lit, and the shared palette shader REQUIRES the attribute to exist). */
  private getOrCreateDynamic(archetype: ArchetypeName): DynamicArchetype {
    const existing = this.dynamics.get(archetype);
    if (existing !== undefined) return existing;

    const cap = PROPS.dynamicPoolCap;
    const geometry = getArchetypeHandles(archetype)[0].mesh.geometry.clone();
    const emissive = new InstancedBufferAttribute(new Float32Array(cap), 1);
    emissive.setUsage(DynamicDrawUsage); // never rewritten, but keep it dynamic-friendly
    geometry.setAttribute('aEmissiveOn', emissive);

    const mesh = new InstancedMesh(geometry, getCityMaterial(), cap);
    mesh.frustumCulled = false; // small, moving, few — a whole-mesh frustum test isn't worth it
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    for (let i = 0; i < cap; i++) mesh.setMatrixAt(i, ZERO_MATRIX); // all slots start hidden
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);

    const free: number[] = [];
    for (let i = cap - 1; i >= 0; i--) free.push(i); // pop() hands out 0,1,2,… first
    const dyn: DynamicArchetype = { mesh, geometry, free, dirty: false };
    this.dynamics.set(archetype, dyn);
    return dyn;
  }

  private writeInstance(dyn: DynamicArchetype, instanceId: number, pos: Vec3, rot: Quat): void {
    this.dummy.position.set(pos.x, pos.y, pos.z);
    this.dummy.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    this.dummy.scale.set(1, 1, 1);
    this.dummy.updateMatrix();
    dyn.mesh.setMatrixAt(instanceId, this.dummy.matrix);
  }
}

// ===========================================================================================
// External-hit swap entry point (Phase 11 gun-truck bullets; Phase 12 tank explosions reuse it)
// ===========================================================================================

/**
 * Launch a fixed prop into the dynamic pool from a NON-contact source — a hitscan bullet
 * (combat/hitscan.ts) or a tank shell's explosion (Phase 12) — WITHOUT a Rapier contact event.
 * It synthesizes the same one-sided ImpactRecord the contact spine would produce for this prop
 * and feeds it through the live controller's handleImpact(), so it walks the identical, fully
 * exercised swap path: threshold gate (below the archetype's forceThresholds → graceful no-op),
 * collider disable, registry unregister, pooled dynamic body, launch impulse at `point`, and the
 * propDestroyed event for hp-less props. `forceProxy` (N) is BOTH the threshold test and the
 * launch magnitude (min(forceProxy, PROPS.launchForceCap) × launchImpulseScale).
 *
 * Returns false when no PropDynamics mount is live (the pool doesn't exist yet — e.g. a unit test
 * with no city) or the handle isn't a swappable static prop; true when the swap path ran. Safe to
 * call every physics step.
 */
export function swapFromExternalHit(colliderHandle: number, point: Vec3, forceProxy: number): boolean {
  const controller = activeController;
  if (controller === null) return false;
  const entry = getEntity(colliderHandle);
  if (entry === undefined || entry.kind !== 'propStatic') return false;
  const record: ImpactRecord = {
    aHandle: colliderHandle,
    bHandle: -1,
    a: entry,
    b: undefined,
    forceMag: forceProxy,
    point,
  };
  controller.handleImpact(record);
  return true;
}
