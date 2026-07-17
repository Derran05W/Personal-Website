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

/** Shape of the per-tier spawn-composition table. */
export interface SpawnComposition {
  /** Indexed by wanted tier ★0..★5; each a weighted list of kinds to draw from. */
  readonly tiers: readonly (readonly CompositionEntry[])[];
}

/**
 * Per-tier unit-kind mix the spawn director draws from when filling a slot (TDD §5.5/§5.6).
 *
 * The director reads `tiers[tier]`, rolls one kind weighted by `weight`, then spawns via
 * that kind's registered factory. ★0 is empty (peaceful — no pursuit). v1 ships ONLY the
 * police sedan, so every tier ≥ ★1 is a single-entry `[{ kind: 'police', weight: 1 }]`.
 *
 * This shape is the extension point for all of Part 4: an escalation phase adds its unit by
 * APPENDING an entry to the tiers where it appears — e.g. ★2 gains `{ kind: 'armored',
 * weight: … }` alongside police, ★5 gains `{ kind: 'tank', … }` (concurrent tanks separately
 * capped by SPAWN.maxTanks in the director). No director code changes: it reads this table
 * generically and looks each kind up in the factory registry. Weights are relative — only
 * their ratios within a tier matter.
 */
export const SPAWN_COMPOSITION = {
  tiers: [
    [], // ★0 — peaceful city, nothing spawns
    [{ kind: 'police', weight: 1 }], // ★1 — police sedans
    [{ kind: 'police', weight: 1 }], // ★2 — Part 4: + { kind: 'armored', … }
    [{ kind: 'police', weight: 1 }], // ★3 — Part 4: + { kind: 'swat', … }
    [{ kind: 'police', weight: 1 }], // ★4 — Part 4: + { kind: 'gunTruck', … }
    [{ kind: 'police', weight: 1 }], // ★5 — Part 4: + { kind: 'tank', … } (maxTanks capped)
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
