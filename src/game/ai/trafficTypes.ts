// Civilian-traffic contracts (Phase 7 seam, orchestrator-authored). ai/traffic.ts owns the
// pool and mutates slots; ai/TrafficMesh.tsx and debug tooling read them through
// `trafficRef` (module-scope handle, same pattern as vehicles/playerRef.ts).

/** Lifecycle: kinematic graph-follower → hit-converted dynamic → wrecked (flipped/hp≤0,
 * still dynamic, darkened) → despawned back to the pool. */
export type CivState = 'driving' | 'converted' | 'wrecked';

export interface CivSlot {
  /** Stable pool index — also the instance index in TrafficMesh's InstancedMesh. */
  readonly id: number;
  /** null = free slot (hidden instance). */
  state: CivState | null;
  /** World pose for rendering, written every step by traffic.ts (kinematic or dynamic). */
  x: number;
  y: number;
  z: number;
  /** Yaw (rad) while kinematic; full quaternion below is used once dynamic. */
  yaw: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  /** True once dynamic — TrafficMesh composes from the quaternion instead of yaw. */
  dynamic: boolean;
  /** Tint roll index into TRAFFIC_CIV's tint palette (stable per spawn). */
  tintIndex: number;
  hp: number;
}

export interface TrafficApi {
  readonly slots: readonly CivSlot[];
  /** Active (non-free) count — the debug monitor + soak checks read this. */
  activeCount(): number;
  /** Debug: force-spawn a civilian near the given world position (nearest graph node). */
  spawnAt(x: number, z: number): boolean;
  /**
   * Phase 17 monster-truck crush: force the LIVE civilian at collider `handle` through the
   * normal ram-conversion + wreck path — convert it if still driving (emitting civHit once,
   * swapping it to a dynamic body) then zero its hp so the existing tickWreck pass emits
   * civWrecked once, exactly like a fatal ram, regardless of the ram force. Returns true only
   * on a FRESH crush (a still-driving civ this call converted) so the caller applies its
   * momentum retention exactly once per victim; false for an unknown handle or an already-
   * converted/wrecked slot. combat/playerSpecials.ts is the sole caller.
   */
  crush(handle: number): boolean;
}

/** Set by ai/traffic.ts's mount; null before the first PLAYING mount. */
export const trafficRef: { current: TrafficApi | null } = { current: null };
