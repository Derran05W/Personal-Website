// Type-only import (erased at compile time — no runtime config→ai coupling): lets the
// composition table below be typed against the pursuit-unit kind union so a Part 4 author
// adding e.g. `{ kind: 'armored', weight: 2 }` is typo-checked by the compiler. The union
// itself is owned by the ai layer (the seam), config just references it.
import type { UnitKind } from '../ai/pursuitTypes';
// Same type-only-import discipline for the helicopter livery union (owned by ai/heliTypes.ts,
// the Phase 14 seam) — so HELI.liveryByTier below is typo-checked against it and erased at
// compile time (no runtime config→ai edge).
import type { HeliLivery } from '../ai/heliTypes';

// Spawn director + helicopter tunables. TDD §5.6 (spawn director, enemy caps),
// §5.7 (helicopters).
export const SPAWN = {
  // Max concurrent pursuit units per tier ★0..★5. TDD §5.5 table "Max concurrent (total)".
  // Index = wanted tier; the director maintains this many *pursuing* units (wrecked debris
  // lingering as trophies is excluded — see SPAWN.wreckLingerSec). Length also fixes the
  // director's pool size (max = caps[5] = 10).
  caps: [0, 4, 6, 8, 9, 10],
  // TDD §5.5: ★5 caps tanks at 2 even though the total cap is 10. Phase 12 unified this onto the
  // generic per-kind concurrency mechanism (SPAWN_COMPOSITION.maxOfKind[5]) — the director never
  // had a dedicated maxTanks input, so this field is now purely the NAMED VALUE SOURCE that the
  // ★5 maxOfKind entry references (`{ kind: 'tank', max: SPAWN.maxTanks }`). Retune here.
  maxTanks: 2,
  // Spawn ring around the player, off-screen. TDD §5.6.
  ringMin: 60,
  ringMax: 90,
  // Despawn distance for pursuit units. TDD §5.6.
  despawnAt: 140,
  // AI decision tick rate; forces still apply every physics step. TDD §5.6. The director
  // schedules each unit's think() so a unit thinks once per round(physicsHz / aiTickHz)
  // steps (= 6 steps at 60 Hz), round-robined by pool index so 4+ units never raycast the
  // same frame (10 Hz staggered thinking).
  aiTickHz: 10,
  // How often the director runs pool maintenance (despawn far/wrecked, top up to cap): a
  // ~2 Hz cadence (every 30 physics steps) rather than every step, since a road-tile ring
  // scan is the only non-trivial cost and the pool is tiny. tierChanged short-circuits this
  // and fills the new cap immediately (§5.5 "immediately fills the new cap"). TDD §5.6.
  maintainHz: 2,
  // A wrecked pursuit unit lingers as debris this long (from the step the director first
  // observes its 'wrecked' state) before it disposes back to the pool — the destruction
  // "trophy window" (mirrors TRAFFIC_CIV.wreckLingerSec for civilians). It still despawns
  // early if it drifts past despawnAt. Feel-tunable; not a TDD-given number.
  wreckLingerSec: 10,
  // Random offset (m, ±) applied to a chosen road-tile *center* when placing a spawn, so
  // units don't stack on exact tile centers. Kept under half a tile (WORLD.tileSize/2 = 5)
  // so a jittered point stays on its road tile. Forks the deterministic 'spawnDirector' rng
  // (SpawnDirectorMount seed prop).
  spawnJitterM: 2,
  // --- spawn-ring approach bias (Phase 16 Task 5; no-navmesh nav debt) -------------------------
  // The director still picks an off-screen road tile in the [ringMin, ringMax] ring behind the
  // camera, but among those candidates it now WEIGHTS the pick toward tiles a unit can actually
  // drive to the player from (phase-09..12 "organic BUSTED unreachable" debt). Per-candidate
  // weight = biasWeightFloor + roadProximity^roadProximityWeight × approachClearness^approach-
  // ClearnessWeight (ai/spawnDirector.scoreSpawnCandidate), then a WEIGHTED-RANDOM pick keeps
  // variety (spawns never become deterministic). Set both weights to 0 to fall back to the old
  // uniform behind-camera pick (each factor^0 = 1). Only pure city data (graph nodes + tiles) is
  // read, at spawn time (2 Hz maintenance / on tierChanged) — never per frame.
  //
  // roadProximity = 1 / (1 + nearestGraphNodeDist / roadProximityRefM): favours tiles ON the lane
  // network over disconnected road stubs. Ref ~ one tile, so a tile with a lane node on it ≈ 1.
  roadProximityRefM: 10,
  roadProximityWeight: 1,
  // approachClearness = fraction of approachClearnessSamples points sampled along candidate→player
  // that sit on drivable (road/park/parkingLot) tiles — a straight-shot "is there an open lane to
  // the player" proxy (no raycasts). Weighted higher than road proximity: clustering spawns where
  // the player is reachable is what lets the ★1+ swarm actually converge for a BUSTED.
  approachClearnessSamples: 8,
  approachClearnessWeight: 2,
  // Floor added to every candidate's weight so an all-zero-score ring still spawns *somewhere*
  // (degrades to uniform) and never divides by zero — the ring's off-screen guarantee is preserved.
  biasWeightFloor: 0.05,
} as const;

/** One weighted unit-kind option in a tier's spawn mix (SPAWN_COMPOSITION). */
export interface CompositionEntry {
  readonly kind: UnitKind;
  /** Relative weight; the director rolls one kind per spawn proportional to weight. */
  readonly weight: number;
}

/** A per-tier "guarantee at least N of this kind before the weighted roll gets a turn"
 * quota (SPAWN_COMPOSITION.minPreferred). See that field's doc comment for the fill-order
 * contract. */
export interface MinPreferredEntry {
  readonly kind: UnitKind;
  /** Minimum count of currently-pursuing (non-wrecked) units of `kind` the director tries
   * to maintain before spending any more of the tier's cap on weighted picks. */
  readonly count: number;
}

/** A per-tier "never more than N of this kind concurrently" cap (SPAWN_COMPOSITION.maxOfKind).
 * The generic form of the ★5 maxTanks rule (SPAWN.maxTanks), so any escalation unit can be
 * rarity-limited without a dedicated director field. See maxOfKind's doc comment below. */
export interface MaxOfKindEntry {
  readonly kind: UnitKind;
  /** Max concurrently-pursuing (non-wrecked) units of `kind` the director will keep alive at
   * this tier — it stops rolling/preferring the kind once this many exist, regardless of weight. */
  readonly max: number;
}

/** Shape of the per-tier spawn-composition table. */
export interface SpawnComposition {
  /** Indexed by wanted tier ★0..★5; each a weighted list of kinds to draw from. */
  readonly tiers: readonly (readonly CompositionEntry[])[];
  /**
   * Indexed by wanted tier ★0..★5 (same indexing as `tiers`); each tier's (possibly empty)
   * list of minimum-preferred-kind quotas. Optional at the table level — a tier with no
   * entry (or an empty array) has no minimum and is filled purely by `tiers[tier]`'s
   * weighted roll, same as before this field existed.
   */
  readonly minPreferred?: readonly (readonly MinPreferredEntry[])[];
  /**
   * Indexed by wanted tier ★0..★5 (same indexing as `tiers`); each tier's (possibly empty)
   * list of per-kind concurrency caps. Optional — a tier/kind with no entry is uncapped
   * (bounded only by the tier's total cap SPAWN.caps[tier]). The director excludes a kind from
   * BOTH the minPreferred fill and the weighted roll once its live count reaches the cap, so a
   * capped kind (e.g. ≤ 2 gun trucks at ★4) never exceeds it however the rolls fall. The generic
   * form of SPAWN.maxTanks (Phase 12 tanks can move onto this instead of a bespoke field).
   */
  readonly maxOfKind?: readonly (readonly MaxOfKindEntry[])[];
}

/**
 * Per-tier unit-kind mix the spawn director draws from when filling a slot (TDD §5.5/§5.6).
 *
 * The director reads `tiers[tier]`, rolls one kind weighted by `weight`, then spawns via
 * that kind's registered factory. ★0 is empty (peaceful — no pursuit).
 *
 * This shape is the extension point for all of Part 4: an escalation phase adds its unit by
 * APPENDING an entry to the tiers where it appears — e.g. ★5 gains `{ kind: 'tank', … }`
 * (concurrent tanks capped via `maxOfKind[5]`, sourced from SPAWN.maxTanks). No director code
 * changes: it reads this table generically and looks each kind up in the factory registry.
 * Weights are relative — only their ratios within a tier matter. A kind whose factory isn't
 * registered yet (e.g. mid-build, before its unit module's mesh mount imports and registers
 * it) is transparently excluded from the roll rather than stalling the fill — see
 * ai/spawnDirector.ts's `filterRegisteredEntries`.
 *
 * ★2/★3 rows (Phase 10, TDD §5.5 rows 2-3) are feel-tunable — these weights are a starting
 * point, not TDD-given exact numbers; retune here (and in `minPreferred` below) if the
 * fun-gate playtest wants a different mix.
 */
export const SPAWN_COMPOSITION = {
  tiers: [
    [], // ★0 — peaceful city, nothing spawns
    [{ kind: 'police', weight: 1 }], // ★1 — police sedans only
    [
      { kind: 'police', weight: 3 },
      { kind: 'armored', weight: 2 },
    ], // ★2 — armored joins; cap stays SPAWN.caps[2] (6), untouched by this table
    [
      { kind: 'police', weight: 3 },
      { kind: 'armored', weight: 2 },
      { kind: 'swat', weight: 3 },
    ], // ★3 — SWAT joins; minPreferred below guarantees flankers actually show up
    [
      { kind: 'police', weight: 3 },
      { kind: 'armored', weight: 2 },
      { kind: 'swat', weight: 2 },
      { kind: 'gunTruck', weight: 3 },
    ], // ★4 — gun trucks join (Phase 11); cap stays SPAWN.caps[4] (9), gun trucks maxOfKind-capped
    [
      { kind: 'police', weight: 3 },
      { kind: 'armored', weight: 2 },
      { kind: 'swat', weight: 2 },
      { kind: 'gunTruck', weight: 2 },
      { kind: 'tank', weight: 2 },
    ], // ★5 — full roster + tanks (Phase 12); cap stays SPAWN.caps[5] (10). tank + gunTruck are
    // maxOfKind-capped at 2 each below; minPreferred guarantees ≥1 tank actually shows up.
  ],
  minPreferred: [
    [], // ★0
    [], // ★1
    [], // ★2 — no minimum; armored is a weighted extra, not a guaranteed presence
    [{ kind: 'swat', count: 2 }], // ★3 — squad.ts's flank slots need bodies to claim them;
    // without a floor, an unlucky weighted roll could leave ★3 with zero SWAT for a while.
    [{ kind: 'gunTruck', count: 1 }], // ★4 — guarantee at least one truck standing off (capped at 2)
    [{ kind: 'tank', count: 1 }], // ★5 — guarantee at least one tank on the ground (capped at 2 below)
  ],
  maxOfKind: [
    [], // ★0
    [], // ★1
    [], // ★2
    [], // ★3
    [{ kind: 'gunTruck', max: 2 }], // ★4 — at most two gun trucks at once (TDD §5.6 / plan: ≤2)
    [
      // ★5 — the generic maxOfKind path now enforces the ★5 tank cap (Phase 12 unification), so the
      // bespoke SPAWN.maxTanks field is retired as a director input and lives on ONLY as the named
      // value source referenced here (TDD §5.5 "max 2 tanks"). Gun trucks stay capped at 2 as at ★4.
      { kind: 'tank', max: SPAWN.maxTanks },
      { kind: 'gunTruck', max: 2 },
    ],
  ],
} as const satisfies SpawnComposition;

export const HELI = {
  // Orbit radius/altitude around the player. TDD §5.7.
  orbitRadius: 40,
  altitude: 35,
  // Helicopters per tier ★0..★5. TDD §5.7: one heli per tier >= ★2 (police/SWAT/
  // military livery by tier), ★5 adds a second military heli. Ambient only, no
  // gameplay effect in v1. Index = wanted tier; also fixes the flight controller's
  // active-slot count for that tier (ai/helicopter.ts countForTier).
  perTier: [0, 0, 1, 1, 1, 2],
  // Livery flown at each tier ★0..★5 (index = wanted tier), or null where no heli flies.
  // TDD §5.7: ★2 police, ★3 SWAT, ★4/★5 military (★5 is TWO military — see perTier).
  // Type-checked against ai/heliTypes.ts's HeliLivery union (the seam).
  liveryByTier: [null, null, 'police', 'swat', 'military', 'military'] as const satisfies readonly (HeliLivery | null)[],
  // Orbit angular speed (rad/s). ~0.35 → ~18 s period at orbitRadius = a slow, cinematic
  // sweep (linear tangential speed ≈ orbitRadius·this ≈ 14 m/s). Feel-tunable (not a
  // TDD-given number).
  orbitAngularSpeed: 0.35,
  // Fly-in/out radius (m): the heli's orbit radius eases out to this while its presence
  // fades to 0 (departing) and in from this while presence fades up (arriving), so a livery
  // swap reads as the old heli spiralling off toward the map edge and the new one arriving
  // from it — never a teleport. Well beyond the ~452 m map half-diagonal's on-screen zone.
  edgeRadiusM: 280,
  // Banked lean: bank (rad) = clamp(bankGain · signed orbit angular velocity, ±bankMaxRad).
  // At orbitAngularSpeed this settles to ~0.315 rad (~18°), capped at bankMaxRad (~26°).
  bankGain: 0.9,
  bankMaxRad: 0.45,
  // Gentle altitude bob: y = altitude + bobAmpM·sin(bobFreq·t + seededPhase). Per-slot phase
  // is seeded off the slot index so the two ★5 helis never bob in lockstep.
  bobAmpM: 1.2,
  bobFreq: 0.6,
  // Main-rotor spin rate (rad/s) accumulated into HeliSlot.rotor (HeliMesh reads it).
  rotorSpeed: 40,
  // Presence fade rate (units/sec): a fly-in or fly-out takes ~1 / fadeRate seconds (~2 s).
  fadeRate: 0.5,
  // ★5 second heli's constant bearing offset from the lead (rad). π keeps the pair exactly
  // antipodal every frame — they can never share a bearing (TDD §5.7 "×2").
  dualPhaseOffset: Math.PI,
} as const;
