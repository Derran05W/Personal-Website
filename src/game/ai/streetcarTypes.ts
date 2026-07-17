// Streetcar-traffic contracts (Phase 19 Task 3 seam, mirrors ai/trafficTypes.ts). Streetcars
// are a separate small system riding world.landmarks.streetcarAvenues (own controller, own
// tiny fixed-size roster, own registry entries — see ai/streetcarTraffic.ts's header) rather
// than an extension of ai/traffic.ts's CivSlot pool, so they publish their OWN slot/ref pair
// here instead of widening CivSlot with avenue-specific fields every regular car would carry
// for nothing (24 cars vs. a handful of streetcars).

/** Lifecycle: kinematic avenue-loop follower -> hit-converted dynamic -> wrecked (flipped/
 * hp<=0, still dynamic, darkened) -> recycled back onto its avenue loop. Unlike CivSlot there
 * is no `null` (free/pooled) state at rest — the roster is a small fixed size and every slot is
 * always one of these three once the controller has spawned it (see the controller's header:
 * no spawn-ring/despawn-by-distance, streetcars circulate regardless of player position). A
 * slot only reads as `state: null` for the single frame before its very first spawn (avenues
 * present but the constructor hasn't placed it yet — never observable outside a test that pokes
 * the controller directly).
 */
export type StreetcarState = 'driving' | 'converted' | 'wrecked';

export interface StreetcarSlot {
  /** Stable roster index — also the instance index in StreetcarMesh's InstancedMesh. */
  readonly id: number;
  state: StreetcarState | null;
  /** World pose for rendering, written every step by streetcarTraffic.ts (kinematic or dynamic). */
  x: number;
  y: number;
  z: number;
  /** Yaw (rad) while kinematic; full quaternion below is used once dynamic. */
  yaw: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  /** True once dynamic — StreetcarMesh composes from the quaternion instead of yaw. */
  dynamic: boolean;
  hp: number;
}

export interface StreetcarApi {
  readonly slots: readonly StreetcarSlot[];
  /** Active (non-null) count — debug/soak checks read this. Equal to the roster size on every
   * frame except the very first (see StreetcarSlot's doc comment). */
  activeCount(): number;
}

/** Set by ai/StreetcarMount.tsx's mount; null before the first PLAYING mount OR whenever the
 * live world has no valid streetcar avenues (Task 1's seam absent/empty — see
 * ai/streetcarTraffic.ts's getStreetcarAvenues header for the defensive-read contract). */
export const streetcarRef: { current: StreetcarApi | null } = { current: null };
