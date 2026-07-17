// Pursuit-unit contracts (Phase 9 seam, orchestrator-authored). The spawn director
// (ai/spawnDirector.ts) owns WHEN units exist; unit modules (ai/units/*) own WHAT a unit
// is (body, steering params, mesh); consumers (BUSTED proximity, debug overlay, sirens)
// read through `unitsRef`. Part 4's armored/SWAT/gun-truck/tank units extend UnitKind and
// register their own factories — the director never hardcodes a unit type.

export type UnitKind = 'police' | 'armored' | 'swat' | 'gunTruck' | 'tank';

export type UnitState = 'pursuing' | 'wrecked';

export interface UnitSlot {
  readonly id: number;
  /** null = free pool slot. */
  kind: UnitKind | null;
  state: UnitState;
  /** World pose, written per step by the unit's own tick (render + proximity reads). */
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  hp: number;
  /** Debug overlay: current steering behavior ('pursue' | 'ram' | 'avoid' | 'stuck'…). */
  behaviorLabel: string;
}

/** A live unit the director manages. Implementations wrap a pursuit vehicle + steering. */
export interface UnitHandle {
  readonly slot: UnitSlot;
  /** 10 Hz decision tick (staggered by the director); cheap cached-force application
   * happens inside the unit's own physics-step hook, not here. */
  think(): void;
  /** Full teardown: body/controller/registry/mesh-slot release. */
  dispose(): void;
}

/** Creates one unit at a pose. Registered per UnitKind with the director. */
export type UnitFactory = (pose: {
  x: number;
  z: number;
  yaw: number;
}) => UnitHandle | null;

export interface PursuitApi {
  readonly slots: readonly UnitSlot[];
  activeCount(): number;
  /** Debug: force-spawn one unit of `kind` near the player (ignores caps). */
  forceSpawn(kind: UnitKind): boolean;
  /** Run teardown: despawn everything, drain the pool (retry/reset path). */
  despawnAll(): void;
}

/** Set by the spawn director's mount; null before it mounts. */
export const unitsRef: { current: PursuitApi | null } = { current: null };
