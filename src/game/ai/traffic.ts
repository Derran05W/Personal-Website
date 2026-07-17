// Civilian traffic system (Phase 7, TDD §5.4 traffic network + §7 civilian cars). Kinematic
// cars flow along the lane graph around the player and convert to dynamic ragdoll-cars when
// the player rams one. This is the imperative core (pool, bodies, movement, conversion,
// wreck detection, registry wiring) — the R3F mount that drives it from the physics-step
// hooks lives in ai/Traffic.tsx, and the visual InstancedMesh (a sibling task) renders the
// pose slots this module publishes through ai/trafficTypes.ts's `trafficRef`.
//
// It mirrors world/propDynamics.ts's discipline: pure, framework-free helpers (unit-tested,
// no Rapier/three) up top; a controller class that owns the Rapier bodies below, taking the
// rapier namespace + world by injection (never importing @dimforge directly) so the same
// module stays importable in a plain vitest environment.
//
// --- lifecycle (per CivSlot) ---------------------------------------------------------------
//   null → 'driving'   spawn: kinematic body following the lane graph
//   'driving' → 'converted'  a player ram ≥ convertForceThreshold swaps it to a dynamic body,
//                            inheriting waypoint velocity + a kick; civHit fires once.
//   'converted' → 'wrecked'  sustained flip (up-dot < wreckUpDot) OR hp ≤ 0; civWrecked once.
//   any → null  despawn: drifted > despawnDistM, or the linger window elapsed → back to pool.
//
// --- registry contract ---------------------------------------------------------------------
// Each live car registers its collider handle as kind 'civilian' with hp (world/registry.ts).
// It carries NO archetype on purpose: combat/damage.ts drains entry.hp on impacts but, with
// no archetype, emits nothing on death — so THIS module is the sole emitter of civWrecked
// (from its own hp≤0 / flip check), never double-firing against the damage resolver. On
// conversion the kinematic collider handle is retired and the new dynamic handle re-registered
// carrying the current hp, so an airborne car stays damageable.

import { CAMERA, TRAFFIC_CIV, CollisionGroup, interactionGroups } from '../config';
import type { RapierContext, RapierRigidBody } from '@react-three/rapier';
import { gameEvents } from '../state/events';
import { getEntity, registerEntity, unregisterEntity } from '../world/registry';
import { propColliderBox } from '../world/worldCollidersLogic';
import { createRng, type Rng } from '../world/rng';
import { playerVehicle } from '../vehicles/playerRef';
import type { TrafficGraph, TrafficNode } from '../world/types';
import type { ImpactRecord } from '../combat/types';
import type { CivSlot, TrafficApi } from './trafficTypes';

type RapierWorld = RapierContext['world'];
type RapierNamespace = RapierContext['rapier'];

// Matches <Physics timeStep={1/60}> (game/index.tsx): both physics-step hooks fire once per
// fixed step, so a constant dt tracks simulation time exactly (and stops while paused).
const PHYSICS_STEP_SEC = 1 / 60;
// Block-ray origin height (m) — mid-body, clear of the ground slab (whose top is y=0) so a
// horizontal probe reads car/building/prop boxes rather than grazing the road.
const RAY_HEIGHT_M = 0.6;
// Safety cap on node transitions consumed in one movement step. At ≤ speedMaxMps a car covers
// < 0.2 m per 1/60 s and the shortest turn segment is several metres, so one transition per
// step is the norm; 8 only guards against a pathological huge dt or a degenerate segment.
const MAX_ADVANCE_ITERS = 8;
const EPS = 1e-4;

// Block ray must see BUILDING | PROP_STATIC | CIVILIAN | PLAYER and nothing else (never the
// ground/water/flying debris). Rapier's u32 interaction group: membership CIVILIAN (so every
// listed target — whose own filter includes VEHICLES — accepts the ray), filter = exactly the
// four target memberships. The AND-both-ways rule (config/collision.ts) then admits precisely
// those four. Self is excluded per-cast via filterExcludeRigidBody.
const BLOCK_RAY_GROUPS =
  (CollisionGroup.CIVILIAN << 16) |
  (CollisionGroup.BUILDING | CollisionGroup.PROP_STATIC | CollisionGroup.CIVILIAN | CollisionGroup.PLAYER);

const CIVILIAN_GROUPS = interactionGroups('CIVILIAN');

// ===========================================================================================
// Pure helpers (unit-tested; no Rapier/three side effects)
// ===========================================================================================

export interface Vec2 {
  x: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Yaw (rad) that faces a +Z-forward model down travel direction (dx,dz). Rotating +Z by θ
 * about Y gives (sinθ, cosθ), so θ = atan2(dx, dz). A zero delta yields 0 (caller keeps its
 * previous heading in practice). */
export function yawTo(dx: number, dz: number): number {
  if (dx === 0 && dz === 0) return 0;
  return Math.atan2(dx, dz);
}

/** Unit quaternion for a yaw rotation about +Y. */
export function quatFromYaw(yaw: number): Quat {
  const h = yaw * 0.5;
  return { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) };
}

/** How upright a body is: world +Y rotated by its quaternion, dotted with world +Y (1 = level,
 * 0 = on its side, −1 = fully inverted). That dot is 1 − 2(qx² + qz²), so only the x/z
 * components matter — callers pass just those. */
export function upDotFromQuat(qx: number, qz: number): number {
  return 1 - 2 * (qx * qx + qz * qz);
}

/** Shortest signed angle equivalent to `a`, wrapped to (−π, π]. */
export function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = a % twoPi;
  if (r > Math.PI) r -= twoPi;
  else if (r <= -Math.PI) r += twoPi;
  return r;
}

/** Slew `current` toward `target` by at most `maxDelta` rad, taking the shortest way round. */
export function stepYaw(current: number, target: number, maxDelta: number): number {
  const diff = wrapAngle(target - current);
  if (diff > maxDelta) return wrapAngle(current + maxDelta);
  if (diff < -maxDelta) return wrapAngle(current - maxDelta);
  return wrapAngle(target);
}

export interface HoldConfig {
  readonly holdCapSec: number;
  readonly creepSpeedMps: number;
}

/** Stop-if-blocked resolution for one step. Clear road → full cruise, blocked timer reset.
 * Blocked → hold at 0 until holdCapSec of accumulated block, then creep (anti-deadlock:
 * a car jams believably behind an obstacle but never forever). */
export function resolveHold(
  prevBlockedSec: number,
  isBlocked: boolean,
  dt: number,
  cruiseSpeed: number,
  cfg: HoldConfig,
): { blockedSec: number; speed: number } {
  if (!isBlocked) return { blockedSec: 0, speed: cruiseSpeed };
  const blockedSec = prevBlockedSec + dt;
  return { blockedSec, speed: blockedSec >= cfg.holdCapSec ? cfg.creepSpeedMps : 0 };
}

export interface WreckConfig {
  readonly wreckUpDot: number;
  readonly wreckFlipSustainSec: number;
}

export interface WreckState {
  readonly flipSec: number;
  readonly wrecked: boolean;
}

/** Wreck state machine step for a converted car. Accumulates flip time while the body is
 * rolled past wreckUpDot; wrecks (emit === true exactly on the transition) once the flip is
 * sustained OR hp has hit zero. Idempotent once wrecked — never re-emits. */
export function tickWreck(
  prev: WreckState,
  upDot: number,
  hp: number,
  dt: number,
  cfg: WreckConfig,
): { next: WreckState; emit: boolean } {
  if (prev.wrecked) return { next: prev, emit: false };
  const flipSec = upDot < cfg.wreckUpDot ? prev.flipSec + dt : 0;
  const shouldWreck = flipSec >= cfg.wreckFlipSustainSec || hp <= 0;
  if (shouldWreck) return { next: { flipSec, wrecked: true }, emit: true };
  return { next: { flipSec, wrecked: false }, emit: false };
}

/** Forward direction (XZ) the fixed follow camera looks, derived from CAMERA.yawDeg. The rig
 * sits at a fixed yaw/pitch offset SE of the player and looks back at it, so its forward in
 * XZ is (−sin yaw, −cos yaw) (pitch only tilts the Y component, irrelevant here). A node with
 * (node − player) · thisForward < 0 lies behind the camera (SE, out of frame) — preferred for
 * spawning so cars pop in unseen. */
export function cameraForwardXZ(yawDeg: number = CAMERA.yawDeg): Vec2 {
  const yaw = (yawDeg * Math.PI) / 180;
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

export interface RingConfig {
  readonly spawnRingMinM: number;
  readonly spawnRingMaxM: number;
}

/**
 * Choose a spawn node in the [min,max] ring around the player, preferring nodes behind the
 * camera. Two candidate pools are gathered in one pass — ring nodes that are also behind the
 * camera, and all ring nodes — and `pick` selects from the behind pool when non-empty, else
 * any ring node; −1 when the ring is empty (player off-map). Pure: `pick` is injected so tests
 * are deterministic and the live caller passes rng-backed selection.
 */
export function selectSpawnNode(
  nodes: readonly TrafficNode[],
  px: number,
  pz: number,
  camFwdX: number,
  camFwdZ: number,
  cfg: RingConfig,
  pick: (ids: readonly number[]) => number,
): number {
  const minSq = cfg.spawnRingMinM * cfg.spawnRingMinM;
  const maxSq = cfg.spawnRingMaxM * cfg.spawnRingMaxM;
  const behind: number[] = [];
  const anyRing: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const dx = n.x - px;
    const dz = n.z - pz;
    const d2 = dx * dx + dz * dz;
    if (d2 < minSq || d2 > maxSq) continue;
    anyRing.push(n.id);
    if (dx * camFwdX + dz * camFwdZ < 0) behind.push(n.id);
  }
  const pool = behind.length > 0 ? behind : anyRing;
  return pool.length > 0 ? pick(pool) : -1;
}

/** A car's position along the current directed edge. Mutated in place by advanceCursor. */
export interface PathCursor {
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  /** Node id at the far (to) end of the current edge. */
  toNodeId: number;
  segLenM: number;
  /** Distance travelled from the from-node along the current edge. */
  progressM: number;
}

/**
 * Advance a cursor `distance` metres along its path, rolling onto a fresh edge (chosen by
 * `pickEdge` from the arrived node's outEdges) each time it reaches a node and carrying the
 * overflow so fast cars don't stall at nodes. `pickEdge` returns one edge INDEX from the
 * given list (the graph's outEdges hold edge indices). Guards empty outEdges (the ring-road
 * graph has none) and degenerate zero-length segments; caps transitions per call.
 */
export function advanceCursor(
  c: PathCursor,
  distance: number,
  graph: TrafficGraph,
  pickEdge: (edgeIndices: readonly number[]) => number,
): void {
  c.progressM += distance;
  let iters = 0;
  while (c.progressM >= c.segLenM && iters < MAX_ADVANCE_ITERS) {
    iters++;
    const overflow = c.progressM - c.segLenM;
    const arrived = c.toNodeId;
    const outs = graph.outEdges[arrived];
    if (outs === undefined || outs.length === 0) {
      c.progressM = c.segLenM; // dead-end: park at the node (should never happen — no sinks)
      return;
    }
    const edge = graph.edges[pickEdge(outs)];
    const fromNode = graph.nodes[arrived];
    const toNode = graph.nodes[edge.to];
    c.fromX = fromNode.x;
    c.fromZ = fromNode.z;
    c.toX = toNode.x;
    c.toZ = toNode.z;
    c.toNodeId = edge.to;
    c.segLenM = Math.max(EPS, Math.hypot(c.toX - c.fromX, c.toZ - c.fromZ));
    c.progressM = overflow;
  }
  if (c.progressM > c.segLenM) c.progressM = c.segLenM; // clamp if the iter cap was hit
}

/** Interpolated point (fraction of the way along the current edge), written into `out`. */
export function cursorPoint(c: PathCursor, out: Vec2): Vec2 {
  const t = c.segLenM > EPS ? c.progressM / c.segLenM : 0;
  out.x = c.fromX + (c.toX - c.fromX) * t;
  out.z = c.fromZ + (c.toZ - c.fromZ) * t;
  return out;
}

/** The civilian collider handle a convertible impact refers to, or −1. An impact converts
 * when its force reaches convertForceThreshold and exactly one side is a live 'civilian'
 * (the only civilian-involving impacts that reach onImpact are player↔civ — see file header
 * / combat/contacts.ts). */
export function convertibleHandle(record: ImpactRecord, threshold: number): number {
  if (record.forceMag < threshold) return -1;
  if (record.a?.kind === 'civilian') return record.aHandle;
  if (record.b?.kind === 'civilian') return record.bHandle;
  return -1;
}

/**
 * Fixed-capacity slot allocator (pool accounting). Hands out each index at most once until
 * released; `acquire` returns undefined when full so a spawn simply no-ops rather than
 * exceeding the pool. Pure and Rapier-free so the accounting is unit-testable on its own.
 */
export class SlotBook {
  readonly size: number;
  private readonly freeStack: number[] = [];

  constructor(size: number) {
    this.size = size;
    for (let i = size - 1; i >= 0; i--) this.freeStack.push(i); // pop() hands out 0,1,2,… first
  }

  acquire(): number | undefined {
    return this.freeStack.pop();
  }

  release(id: number): void {
    this.freeStack.push(id);
  }

  get freeCount(): number {
    return this.freeStack.length;
  }

  get activeCount(): number {
    return this.size - this.freeStack.length;
  }
}

// ===========================================================================================
// Controller (Rapier + registry; owns the kinematic/dynamic bodies behind the pose slots)
// ===========================================================================================

/** Per-slot private state paralleling the public CivSlot (which carries only render/seam
 * data). Indexed by slot id. */
interface InternalCiv {
  body: RapierRigidBody | null;
  colliderHandle: number; // registry key; −1 when free
  cursor: PathCursor;
  cruiseSpeed: number;
  blockedSec: number;
  lastMoveSpeed: number; // effective speed last kinematic step (conversion inherits it)
  civHitEmitted: boolean;
  flipSec: number;
  wrecked: boolean;
  convertedAt: number;
  wreckedAt: number;
}

function freshCursor(): PathCursor {
  return { fromX: 0, fromZ: 0, toX: 0, toZ: 0, toNodeId: -1, segLenM: EPS, progressM: 0 };
}

function freshInternal(): InternalCiv {
  return {
    body: null,
    colliderHandle: -1,
    cursor: freshCursor(),
    cruiseSpeed: 0,
    blockedSec: 0,
    lastMoveSpeed: 0,
    civHitEmitted: false,
    flipSec: 0,
    wrecked: false,
    convertedAt: 0,
    wreckedAt: 0,
  };
}

function freshSlot(id: number): CivSlot {
  return {
    id,
    state: null,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    qx: 0,
    qy: 0,
    qz: 0,
    qw: 1,
    dynamic: false,
    tintIndex: 0,
    hp: TRAFFIC_CIV.hp,
  };
}

export class TrafficController {
  private readonly world: RapierWorld;
  private readonly rapier: RapierNamespace;
  private readonly graph: TrafficGraph;
  // Phase 17 monster-truck crush seam: when this returns true the civilian system YIELDS all
  // player↔civ conversion to combat/playerSpecials.ts's crush path (which converts AND wrecks
  // on contact). Injected (never a store import here — traffic stays civ-focused); defaults to
  // "never yield" so a controller built without it keeps the exact Phase-7 ram behaviour.
  private readonly crushActive: () => boolean;

  private readonly slots: CivSlot[];
  private readonly internal: InternalCiv[];
  private readonly book: SlotBook;
  private readonly handleToSlot = new Map<number, number>();
  private readonly rng: Rng;

  // Parked-car collider box (reused sizing, part-file requirement) + camera forward, both
  // constant for the controller's life.
  private readonly halfExtents: readonly [number, number, number];
  private readonly colliderCenterY: number;
  private readonly frontProbeM: number;
  private readonly camFwd: Vec2;

  private simTime = 0;

  // Hot-path scratch — a single reused Ray + its origin/dir vectors (Rapier reads .x/.y/.z at
  // cast time), and a point buffer, so movement/ray casts never allocate.
  private readonly rayOrigin = { x: 0, y: RAY_HEIGHT_M, z: 0 };
  private readonly rayDir = { x: 0, y: 0, z: 0 };
  private readonly ray: InstanceType<RapierNamespace['Ray']>;
  private readonly scratchPoint: Vec2 = { x: 0, z: 0 };

  readonly api: TrafficApi;

  constructor(
    world: RapierWorld,
    rapier: RapierNamespace,
    graph: TrafficGraph,
    seed: number,
    crushActive: () => boolean = () => false,
  ) {
    this.world = world;
    this.rapier = rapier;
    this.graph = graph;
    this.crushActive = crushActive;
    this.rng = createRng(seed).fork('traffic');

    const size = Math.max(0, Math.round(TRAFFIC_CIV.activeTarget));
    this.book = new SlotBook(size);
    this.slots = Array.from({ length: size }, (_, i) => freshSlot(i));
    this.internal = Array.from({ length: size }, () => freshInternal());

    const box = propColliderBox('parkedCar');
    this.halfExtents = box.halfExtents;
    this.colliderCenterY = box.centerY;
    this.frontProbeM = box.halfExtents[2]; // half the car length → ray starts at the bumper
    this.camFwd = cameraForwardXZ();

    this.ray = new rapier.Ray(this.rayOrigin, this.rayDir);

    this.api = {
      slots: this.slots,
      activeCount: () => this.book.activeCount,
      spawnAt: (x, z) => this.spawnNearest(x, z),
      crush: (handle) => this.crush(handle),
    };
  }

  // --- kinematic movement (useBeforePhysicsStep) -------------------------------------------

  /** Advance every driving car one kinematic step: block-ray hold, path advance, smooth yaw,
   * and push the result onto the body via setNextKinematic* so Rapier generates the contacts. */
  stepBefore(): void {
    const dt = PHYSICS_STEP_SEC;
    const maxYawDelta = TRAFFIC_CIV.turnRateRadPerSec * dt;
    for (let id = 0; id < this.slots.length; id++) {
      const slot = this.slots[id];
      if (slot.state !== 'driving') continue;
      const iv = this.internal[id];
      const body = iv.body;
      if (body === null) continue;

      // Probe ahead along the CURRENT heading (yaw), from the front bumper.
      const dirX = Math.sin(slot.yaw);
      const dirZ = Math.cos(slot.yaw);
      const blocked = this.castBlock(iv, slot.x, slot.z, dirX, dirZ);
      const hold = resolveHold(iv.blockedSec, blocked, dt, iv.cruiseSpeed, TRAFFIC_CIV);
      iv.blockedSec = hold.blockedSec;
      iv.lastMoveSpeed = hold.speed;

      advanceCursor(iv.cursor, hold.speed * dt, this.graph, this.pickEdge);
      cursorPoint(iv.cursor, this.scratchPoint);
      const targetYaw = yawTo(iv.cursor.toX - iv.cursor.fromX, iv.cursor.toZ - iv.cursor.fromZ);
      const yaw = stepYaw(slot.yaw, targetYaw, maxYawDelta);

      slot.x = this.scratchPoint.x;
      slot.y = 0;
      slot.z = this.scratchPoint.z;
      slot.yaw = yaw;
      const q = quatFromYaw(yaw);
      slot.qx = q.x;
      slot.qy = q.y;
      slot.qz = q.z;
      slot.qw = q.w;

      body.setNextKinematicTranslation({ x: slot.x, y: 0, z: slot.z });
      body.setNextKinematicRotation(q);
    }
  }

  // --- resolvers + maintenance (useAfterPhysicsStep) ---------------------------------------

  /** Post-step pass: copy dynamic-car poses into slots, run wreck detection, retire lingered
   * or distant cars, then top the pool back up to the live target around the player. */
  stepAfter(): void {
    this.simTime += PHYSICS_STEP_SEC;
    const player = playerVehicle.current?.readState();
    const px = player?.pose.position.x ?? 0;
    const pz = player?.pose.position.z ?? 0;
    const despawnSq = TRAFFIC_CIV.despawnDistM * TRAFFIC_CIV.despawnDistM;

    for (let id = 0; id < this.slots.length; id++) {
      const slot = this.slots[id];
      if (slot.state === null) continue;
      const iv = this.internal[id];

      if (slot.state === 'driving') {
        if (player && this.distSq(slot, px, pz) > despawnSq) this.despawnSlot(id);
        continue;
      }

      // converted / wrecked: dynamic body drives the slot pose.
      const body = iv.body;
      if (body === null) {
        this.despawnSlot(id);
        continue;
      }
      const rot = body.rotation();
      if (!body.isSleeping()) {
        const tr = body.translation();
        slot.x = tr.x;
        slot.y = tr.y;
        slot.z = tr.z;
        slot.qx = rot.x;
        slot.qy = rot.y;
        slot.qz = rot.z;
        slot.qw = rot.w;
      }

      if (slot.state === 'converted') {
        const hp = getEntity(iv.colliderHandle)?.hp ?? slot.hp;
        slot.hp = hp;
        const upDot = upDotFromQuat(rot.x, rot.z);
        const step = tickWreck({ flipSec: iv.flipSec, wrecked: iv.wrecked }, upDot, hp, PHYSICS_STEP_SEC, TRAFFIC_CIV);
        iv.flipSec = step.next.flipSec;
        if (step.emit) {
          iv.wrecked = true;
          iv.wreckedAt = this.simTime;
          slot.state = 'wrecked';
          gameEvents.emit('civWrecked', {});
        }
      }

      const lingerFrom = slot.state === 'wrecked' ? iv.wreckedAt : iv.convertedAt;
      if (this.simTime - lingerFrom >= TRAFFIC_CIV.wreckLingerSec) {
        this.despawnSlot(id);
        continue;
      }
      if (player && this.distSq(slot, px, pz) > despawnSq) this.despawnSlot(id);
    }

    if (player) {
      const target = Math.min(this.book.size, Math.max(0, Math.round(TRAFFIC_CIV.activeTarget)));
      let budget = TRAFFIC_CIV.maxSpawnPerStep;
      while (this.book.activeCount < target && budget > 0) {
        budget--;
        if (!this.spawnAroundPlayer(px, pz)) break; // no ring node this step — try again next
      }
    }
  }

  // --- conversion (onImpact) ---------------------------------------------------------------

  /** Contact-spine subscriber: convert the driving car a qualifying player ram refers to. */
  handleImpact(record: ImpactRecord): void {
    // Phase 17: while the monster-truck crush owns player↔civ contacts, the normal
    // force-thresholded ram conversion is suppressed here so the crush path (which converts AND
    // immediately wrecks, even below the ram threshold) is the SOLE converter — no nondeterministic
    // double-conversion between two independent onImpact subscribers. No-op yield for every other
    // car (crushActive defaults to false), so Phase-7 ram feel is byte-for-byte unchanged.
    if (this.crushActive()) return;
    const handle = convertibleHandle(record, TRAFFIC_CIV.convertForceThreshold);
    if (handle < 0) return;
    const slotId = this.handleToSlot.get(handle);
    if (slotId === undefined) return;
    if (this.slots[slotId].state !== 'driving') return; // already converted
    this.convert(slotId);
  }

  /**
   * Phase 17 monster-truck crush (see TrafficApi.crush). Force the live civilian at collider
   * `handle` through the SAME conversion + wreck path a fatal ram uses, regardless of ram force:
   * convert a still-driving civ (civHit once, kinematic→dynamic) then zero its hp so the next
   * stepAfter's tickWreck emits civWrecked once and darkens it — never emitting either event
   * twice. Returns true ONLY for a fresh crush (a civ that was still driving this call), so the
   * caller retains the truck's momentum exactly once per victim.
   *
   * Robust by construction: handleImpact yields to this path while a crush is active (see above),
   * so `handle` is always the still-registered KINEMATIC handle here — never one the normal ram
   * path already converted (which would have changed the handle out from under handleToSlot).
   */
  crush(handle: number): boolean {
    const slotId = this.handleToSlot.get(handle);
    if (slotId === undefined) return false; // not a live civ (unregistered / already despawned)
    if (this.slots[slotId].state !== 'driving') return false; // already converted or wrecked
    this.convert(slotId); // civHit once, kinematic → dynamic (handle changes to the new body)
    const iv = this.internal[slotId];
    const entry = getEntity(iv.colliderHandle);
    if (entry !== undefined) entry.hp = 0; // → tickWreck (stepAfter) emits civWrecked once
    this.slots[slotId].hp = 0;
    return true;
  }

  private convert(slotId: number): void {
    const iv = this.internal[slotId];
    const slot = this.slots[slotId];
    const oldBody = iv.body;
    if (oldBody === null) return;

    const tr = oldBody.translation();
    const rot = oldBody.rotation();
    const hp = getEntity(iv.colliderHandle)?.hp ?? TRAFFIC_CIV.hp;

    // Retire the kinematic body (its collider goes with it) + registry identity.
    this.handleToSlot.delete(iv.colliderHandle);
    unregisterEntity(iv.colliderHandle);
    this.world.removeRigidBody(oldBody);

    // Dynamic body at the same pose, mass = a real car.
    const bodyDesc = this.rapier.RigidBodyDesc.dynamic()
      .setTranslation(tr.x, tr.y, tr.z)
      .setRotation(rot)
      .setLinearDamping(TRAFFIC_CIV.dynamicLinDamping)
      .setAngularDamping(TRAFFIC_CIV.dynamicAngDamping)
      .setCanSleep(true);
    const body = this.world.createRigidBody(bodyDesc);
    const colDesc = this.rapier.ColliderDesc.cuboid(
      this.halfExtents[0],
      this.halfExtents[1],
      this.halfExtents[2],
    )
      .setTranslation(0, this.colliderCenterY, 0)
      .setMass(TRAFFIC_CIV.massKg)
      .setCollisionGroups(CIVILIAN_GROUPS);
    const collider = this.world.createCollider(colDesc, body);

    // Inherit waypoint velocity + a kick from the player's motion (else the hit feels bolted).
    const dx = iv.cursor.toX - iv.cursor.fromX;
    const dz = iv.cursor.toZ - iv.cursor.fromZ;
    const len = Math.hypot(dx, dz);
    let vx = 0;
    let vz = 0;
    if (len > EPS) {
      vx = (dx / len) * iv.lastMoveSpeed;
      vz = (dz / len) * iv.lastMoveSpeed;
    }
    let vy = 0;
    const pv = playerVehicle.current?.readState().velocity;
    if (pv) {
      const k = TRAFFIC_CIV.convertKickScale;
      vx += pv.x * k;
      vy += pv.y * k;
      vz += pv.z * k;
    }
    body.setLinvel({ x: vx, y: vy, z: vz }, true);

    registerEntity(collider.handle, { kind: 'civilian', districtId: -1, hp });
    this.handleToSlot.set(collider.handle, slotId);

    iv.body = body;
    iv.colliderHandle = collider.handle;
    iv.flipSec = 0;
    iv.wrecked = false;
    iv.convertedAt = this.simTime;
    slot.state = 'converted';
    slot.dynamic = true;
    slot.hp = hp;

    if (!iv.civHitEmitted) {
      iv.civHitEmitted = true;
      gameEvents.emit('civHit', {});
    }
  }

  // --- spawn / despawn ---------------------------------------------------------------------

  private spawnAroundPlayer(px: number, pz: number): boolean {
    const node = selectSpawnNode(
      this.graph.nodes,
      px,
      pz,
      this.camFwd.x,
      this.camFwd.z,
      TRAFFIC_CIV,
      this.pickId,
    );
    if (node < 0) return false;
    return this.spawn(node);
  }

  private spawnNearest(x: number, z: number): boolean {
    let best = -1;
    let bestD2 = Infinity;
    const nodes = this.graph.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const dx = nodes[i].x - x;
      const dz = nodes[i].z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = nodes[i].id;
      }
    }
    if (best < 0) return false;
    return this.spawn(best);
  }

  /** Spawn a driving car at graph node `nodeId`, heading down a random outEdge. */
  private spawn(nodeId: number): boolean {
    const outs = this.graph.outEdges[nodeId];
    if (outs === undefined || outs.length === 0) return false;
    const id = this.book.acquire();
    if (id === undefined) return false;

    const startNode = this.graph.nodes[nodeId];
    const edge = this.graph.edges[this.pickEdge(outs)];
    const toNode = this.graph.nodes[edge.to];

    const iv = this.internal[id];
    const slot = this.slots[id];
    const c = iv.cursor;
    c.fromX = startNode.x;
    c.fromZ = startNode.z;
    c.toX = toNode.x;
    c.toZ = toNode.z;
    c.toNodeId = edge.to;
    c.segLenM = Math.max(EPS, Math.hypot(c.toX - c.fromX, c.toZ - c.fromZ));
    c.progressM = 0;

    iv.cruiseSpeed =
      TRAFFIC_CIV.speedMinMps + this.rng.next() * (TRAFFIC_CIV.speedMaxMps - TRAFFIC_CIV.speedMinMps);
    iv.blockedSec = 0;
    iv.lastMoveSpeed = iv.cruiseSpeed;
    iv.civHitEmitted = false;
    iv.flipSec = 0;
    iv.wrecked = false;
    iv.convertedAt = 0;
    iv.wreckedAt = 0;

    const yaw = yawTo(c.toX - c.fromX, c.toZ - c.fromZ);
    const q = quatFromYaw(yaw);

    // Kinematic body sits base-on-ground (y=0), collider lifted to its centre (parked-car box).
    const bodyDesc = this.rapier.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(startNode.x, 0, startNode.z)
      .setRotation(q);
    const body = this.world.createRigidBody(bodyDesc);
    const colDesc = this.rapier.ColliderDesc.cuboid(
      this.halfExtents[0],
      this.halfExtents[1],
      this.halfExtents[2],
    )
      .setTranslation(0, this.colliderCenterY, 0)
      .setCollisionGroups(CIVILIAN_GROUPS);
    const collider = this.world.createCollider(colDesc, body);

    registerEntity(collider.handle, { kind: 'civilian', districtId: -1, hp: TRAFFIC_CIV.hp });
    this.handleToSlot.set(collider.handle, id);

    iv.body = body;
    iv.colliderHandle = collider.handle;
    slot.state = 'driving';
    slot.dynamic = false;
    slot.tintIndex = this.rng.int(0, TRAFFIC_CIV.tints.length - 1);
    slot.hp = TRAFFIC_CIV.hp;
    slot.x = startNode.x;
    slot.y = 0;
    slot.z = startNode.z;
    slot.yaw = yaw;
    slot.qx = q.x;
    slot.qy = q.y;
    slot.qz = q.z;
    slot.qw = q.w;
    return true;
  }

  private despawnSlot(id: number): void {
    const slot = this.slots[id];
    if (slot.state === null) return; // already free (guards a double release)
    const iv = this.internal[id];
    if (iv.body !== null) {
      if (iv.colliderHandle >= 0) {
        this.handleToSlot.delete(iv.colliderHandle);
        unregisterEntity(iv.colliderHandle);
      }
      this.world.removeRigidBody(iv.body); // removes the attached collider too
    }
    iv.body = null;
    iv.colliderHandle = -1;
    slot.state = null;
    slot.dynamic = false;
    this.book.release(id);
  }

  /** Remove every body + registry entry (mount unmount / city teardown). */
  dispose(): void {
    for (let id = 0; id < this.slots.length; id++) {
      const slot = this.slots[id];
      if (slot.state === null) continue;
      const iv = this.internal[id];
      if (iv.body !== null) {
        if (iv.colliderHandle >= 0) unregisterEntity(iv.colliderHandle);
        this.world.removeRigidBody(iv.body);
        iv.body = null;
        iv.colliderHandle = -1;
      }
      slot.state = null;
      slot.dynamic = false;
    }
    this.handleToSlot.clear();
  }

  // --- small bound helpers -----------------------------------------------------------------

  private readonly pickEdge = (ids: readonly number[]): number => this.rng.pick(ids);
  private readonly pickId = (ids: readonly number[]): number => this.rng.pick(ids);

  private distSq(slot: CivSlot, px: number, pz: number): number {
    const dx = slot.x - px;
    const dz = slot.z - pz;
    return dx * dx + dz * dz;
  }

  private castBlock(iv: InternalCiv, x: number, z: number, dirX: number, dirZ: number): boolean {
    this.rayOrigin.x = x + dirX * this.frontProbeM;
    this.rayOrigin.y = RAY_HEIGHT_M;
    this.rayOrigin.z = z + dirZ * this.frontProbeM;
    this.rayDir.x = dirX;
    this.rayDir.y = 0;
    this.rayDir.z = dirZ;
    const hit = this.world.castRay(
      this.ray,
      TRAFFIC_CIV.blockRayLengthM,
      true,
      undefined,
      BLOCK_RAY_GROUPS,
      undefined,
      iv.body ?? undefined,
    );
    return hit !== null;
  }
}
