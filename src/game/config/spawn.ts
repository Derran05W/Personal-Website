// Type-only import (erased at compile time — no runtime config→ai coupling): lets the
// composition table below be typed against the pursuit-unit kind union so a Part 4 author
// adding e.g. `{ kind: 'armored', weight: 2 }` is typo-checked by the compiler. The union
// itself is owned by the ai layer (the seam), config just references it.
import type { UnitKind } from '../ai/pursuitTypes';

// Spawn director + helicopter tunables. TDD §5.6 (spawn director, enemy caps),
// §5.7 (helicopters).
export const SPAWN = {
  // Max concurrent pursuit units per tier ★0..★5. TDD §5.5 table "Max concurrent (total)".
  // Index = wanted tier; the director maintains this many *pursuing* units (wrecked debris
  // lingering as trophies is excluded — see SPAWN.wreckLingerSec). Length also fixes the
  // director's pool size (max = caps[5] = 10).
  caps: [0, 4, 6, 8, 9, 10],
  // TDD §5.5: ★5 caps tanks at 2 even though the total cap is 10.
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
}

/**
 * Per-tier unit-kind mix the spawn director draws from when filling a slot (TDD §5.5/§5.6).
 *
 * The director reads `tiers[tier]`, rolls one kind weighted by `weight`, then spawns via
 * that kind's registered factory. ★0 is empty (peaceful — no pursuit).
 *
 * This shape is the extension point for all of Part 4: an escalation phase adds its unit by
 * APPENDING an entry to the tiers where it appears — e.g. ★5 gains `{ kind: 'tank', … }`
 * (concurrent tanks separately capped by SPAWN.maxTanks in the director). No director code
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
    [{ kind: 'police', weight: 1 }], // ★4 — Part 4: + { kind: 'gunTruck', … }
    [{ kind: 'police', weight: 1 }], // ★5 — Part 4: + { kind: 'tank', … } (maxTanks capped)
  ],
  minPreferred: [
    [], // ★0
    [], // ★1
    [], // ★2 — no minimum; armored is a weighted extra, not a guaranteed presence
    [{ kind: 'swat', count: 2 }], // ★3 — squad.ts's flank slots need bodies to claim them;
    // without a floor, an unlucky weighted roll could leave ★3 with zero SWAT for a while.
    [], // ★4
    [], // ★5
  ],
} as const satisfies SpawnComposition;

export const HELI = {
  // Orbit radius/altitude around the player. TDD §5.7.
  orbitRadius: 40,
  altitude: 35,
  // Helicopters per tier ★0..★5. TDD §5.7: one heli per tier >= ★2 (police/SWAT/
  // military livery by tier), ★5 adds a second military heli. Ambient only, no
  // gameplay effect in v1.
  perTier: [0, 0, 1, 1, 1, 2],
} as const;
