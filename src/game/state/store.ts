import { create } from 'zustand';
import { type GameState, assertTransition, canTransition } from './machine';
import { gameEvents } from './events';
import { loadProgress } from './persistence';
import {
  HEAT,
  PLAYER_CARS,
  WORLD_GEN,
  UNLOCKS,
  unlockedCarIdsForScore,
  type PlayerCarId,
} from '../config';

/** The selected car's full HP (Phase 17): the store's single source for what "full
 * health" means on run start/reset. Reads PLAYER_CARS directly (not
 * vehicles/definitions.ts's getSelectedCarDef) to keep this module free of a
 * state->vehicles import cycle — hp is authored in PLAYER_CARS either way. */
function selectedCarHp(carId: PlayerCarId): number {
  return PLAYER_CARS[carId].hp;
}

// Store rule (TDD §6 `game/state/`): this is the ONLY zustand store, and it holds ONLY
// machine state, meta-progression numbers, and HUD-visible values. Per-frame hot data —
// vehicle positions/velocities/wheel contact state, AI steering intermediates, camera
// rig transforms — NEVER lives here: subscribing React components to a store that
// writes at physics rate (60 Hz+) forces a re-render every tick and defeats R3F's
// imperative render loop. That data lives in module-scope / R3F refs instead, and only
// surfaces here at HUD-relevant granularity (e.g. `heat`, never "car #3's velocity").

export interface Settings {
  quality: 'high' | 'med' | 'low';
  /**
   * Provenance of `quality` (Phase 18). `'user'` means the player picked it explicitly in the
   * pause menu — a choice the auto FPS probe (core/quality.ts) must NEVER override. `'auto'`
   * means it was written by the first-load heuristic or the probe, so the probe is free to
   * re-measure and demote it. Added additively (defaults `'auto'`, like `reducedShake` defaults
   * false) so an envelope persisted before this field existed still hydrates — see
   * loadSettings/isValidSettings: a missing `qualitySource` is normalised to `'auto'`, which
   * preserves the pre-Phase-18 behaviour (persisted settings block auto-DETECTION either way,
   * but now the probe additionally respects an explicit user pick).
   */
  qualitySource: 'auto' | 'user';
  muted: boolean;
  /**
   * Accessibility: when true, fx/cameraRig.ts zeroes the positional camera shake AND the
   * hard-impact FOV kick (trauma still accumulates and decays — it just isn't applied), so
   * motion-sensitive players get a stable frame. Persisted like every other setting. Phase
   * 18 surfaces the UI toggle; until then the store setter (setReducedShake) is the only
   * surface — a dev debug-bridge switch drives it. Added additively (defaults false) so
   * pre-Phase-16 persisted settings still hydrate — see loadSettings/isValidSettings.
   */
  reducedShake: boolean;
}

// Exported for game/core/quality.ts: the auto quality-tier detection must check whether
// the user already has a *persisted* settings choice (which always wins) by reading this
// exact key — the store's own `settings` field can't distinguish "persisted" from
// "in-memory default", so the raw key is the source of truth. (Task C export exception.)
export const SETTINGS_STORAGE_KEY = 'smashy6ix:settings';

const DEFAULT_SETTINGS: Settings = {
  quality: 'high',
  qualitySource: 'auto',
  muted: false,
  reducedShake: false,
};

// Phase 8: wired to the real config (was a local literal mirror while game/config was
// authored in parallel — see git history). Ascending, index = tier, thresholds[0] must be
// 0 so heat 0 always resolves to tier 0 (asserted by config/config.test.ts).
const TIER_THRESHOLDS = HEAT.tierThresholds;

/**
 * Highest tier index `i` such that `heat >= thresholds[i]`. `thresholds` must be
 * ascending; heat below `thresholds[0]` (expected to be 0) resolves to tier 0.
 */
export function tierForHeat(heat: number, thresholds: readonly number[]): number {
  let tier = 0;
  for (let i = 0; i < thresholds.length; i++) {
    if (heat < thresholds[i]) break; // ascending thresholds: nothing later can match either
    tier = i;
  }
  return tier;
}

// `reducedShake` is validated as OPTIONAL (undefined | boolean), exactly the additive,
// version-safe extension idiom state/persistence.ts uses for `darkCityUnlocked`: an
// envelope written before this field existed is simply missing the key, and loadSettings
// normalises that absence to the `false` default rather than rejecting the whole (otherwise
// valid) stored quality/muted choice.
function isValidSettings(
  value: unknown,
): value is {
  quality: Settings['quality'];
  qualitySource?: Settings['qualitySource'];
  muted: boolean;
  reducedShake?: boolean;
} {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.quality === 'high' || candidate.quality === 'med' || candidate.quality === 'low') &&
    typeof candidate.muted === 'boolean' &&
    (candidate.reducedShake === undefined || typeof candidate.reducedShake === 'boolean') &&
    (candidate.qualitySource === undefined ||
      candidate.qualitySource === 'auto' ||
      candidate.qualitySource === 'user')
  );
}

// Both localStorage calls are try/catch-wrapped: private/incognito browsing and
// storage-quota exhaustion can make localStorage throw on read *or* write, and losing
// settings persistence must never be a hard failure.
function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    if (!isValidSettings(parsed)) return DEFAULT_SETTINGS;
    // Normalise the additive fields: absent (older envelope) -> defaults. `reducedShake` -> false;
    // `qualitySource` -> 'auto' (a pre-Phase-18 persisted quality is treated as auto-provenance,
    // so the FPS probe may still re-measure it — matching the intent that only an explicit menu
    // pick locks the tier).
    return {
      quality: parsed.quality,
      qualitySource: parsed.qualitySource ?? 'auto',
      muted: parsed.muted,
      reducedShake: parsed.reducedShake ?? false,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Swallow: settings simply won't persist this session.
  }
}

/**
 * Phase 17 unlock-slice hydration: every PlayerCarId unlocked at store-creation time,
 * computed from the persisted `lifetimeScore` (config/unlocks.ts's threshold rule) UNIONED
 * with whatever was already explicitly persisted in `unlockedCarIds` (state/persistence.ts's
 * monotonic set — see that file's Progress.unlockedCarIds doc comment). The union matters
 * if UNLOCKS' thresholds are ever retuned after a save already crossed one: a car earned
 * under looser thresholds must not silently re-lock. `id in UNLOCKS` is a second, cheap
 * validation pass on top of persistence.ts's own `sanitizeUnlockedCarIds` — belt-and-
 * suspenders against a garbage/foreign id ever reaching the store.
 */
function hydrateUnlockedCarIds(): PlayerCarId[] {
  const progress = loadProgress();
  const fromThresholds = unlockedCarIdsForScore(progress.lifetimeScore);
  const persisted = (progress.unlockedCarIds ?? []).filter((id): id is PlayerCarId => id in UNLOCKS);
  return Array.from(new Set([...fromThresholds, ...persisted]));
}

/** Phase 17: resume a returning visitor's last city (state/persistence.ts's `lastSeed`,
 * written on every `runStarted` and by the garage's "New city" control) instead of always
 * defaulting to WORLD_GEN.defaultSeed. A fresh/never-played save has no `lastSeed` yet, so
 * it falls back to the default exactly as before this field existed. */
function hydrateSeed(): number {
  return loadProgress().lastSeed ?? WORLD_GEN.defaultSeed;
}

export interface GameStoreState {
  machine: GameState;
  heat: number;
  tier: number;
  score: number;
  playerHp: number;
  /** Phase 17 seam: which PLAYER_CARS entry the next/current run drives. Selection UI,
   * unlock gating, and persistence land with the garage task; the field lives here first
   * so the vehicle/mesh/param layers can read one source of truth from day one. Changing
   * cars mid-run is impossible by construction — the garage is only reachable outside
   * PLAYING, and index.tsx keys the player mount on car+run. */
  selectedCarId: PlayerCarId;
  /** Phase 17 unlock slice: every PlayerCarId currently unlocked (hydrated once at store
   * creation from persisted lifetimeScore + config/unlocks.ts's thresholds — see
   * `hydrateUnlockedCarIds` — and extended, never shrunk, by the module-scope
   * `carUnlocked` subscription below as thresholds are crossed). rustySedan is always
   * present, even on a brand-new save (its threshold is 0). The garage UI is this
   * field's only real reader; `selectCar` is its only writer-adjacent gate. */
  unlockedCarIds: PlayerCarId[];
  seed: number;
  /** Increments on every retry (runReset) — game/index.tsx keys the physical world on
   * `${seed}-${runId}` so a same-seed retry still gets a FULL remount: fresh props,
   * drained pools, respawned player (part-file "full clean reset" requirement). */
  runId: number;
  settings: Settings;

  /** Validates against machine.ts's TRANSITIONS table before applying. */
  transition: (to: GameState) => void;
  /** Monotonic: negative deltas are clamped to 0 (heat never decays — locked design decision). */
  addHeat: (delta: number) => void;
  addScore: (points: number) => void;
  setPlayerHp: (hp: number) => void;
  setSeed: (seed: number) => void;
  /** Phase 17 seam: pick the car for the next run. The garage task layers unlock
   * validation on top; this raw setter stays dev-bridge/garage-internal. */
  setSelectedCar: (carId: PlayerCarId) => void;
  /** Phase 17: the garage's real car picker. A no-op (dev-only console warning) if
   * `carId` isn't in `unlockedCarIds` — everywhere else that just needs to set the car
   * without re-validating an already-known-unlocked id (dev bridge, tests) can keep using
   * the raw `setSelectedCar` above. */
  selectCar: (carId: PlayerCarId) => void;
  /**
   * Set the quality tier and stamp its provenance (Phase 18). `source` defaults to `'user'` so
   * the pause-menu selector's plain `setQuality(q)` call records an explicit, probe-proof pick;
   * the auto heuristic (core/quality.ts's applyDetectedQuality) and the FPS probe pass `'auto'`.
   */
  setQuality: (quality: Settings['quality'], source?: Settings['qualitySource']) => void;
  toggleMuted: () => void;
  /** A11y (Phase 16): persist the reduced-camera-shake preference. Read from non-React
   * code (fx/cameraRig.ts) via the `getReducedShake` getter below, not this action. */
  setReducedShake: (reducedShake: boolean) => void;
  /** Out-of-band reset (route-change/unmount teardown) — NOT a table transition. */
  hardReset: () => void;
  /**
   * Run-scoped reset for the retry path (Phase 9 combat/runLoop.ts): zeroes heat/tier/
   * score and restores playerHp to full, but — unlike hardReset — leaves `machine`
   * completely untouched. The retry flow calls this alongside a GAMEOVER->PLAYING
   * transition (a real TRANSITIONS edge, machine.ts) so a fresh run starts clean without
   * tearing the whole game tree down to BOOT. Settings and seed survive, same as
   * hardReset (seed survives deliberately — retry replays the SAME seed).
   */
  runReset: () => void;
}

export const useGameStore = create<GameStoreState>((set, get) => ({
  machine: 'BOOT',
  heat: 0,
  tier: 0,
  score: 0,
  playerHp: 100,
  selectedCarId: 'rustySedan',
  unlockedCarIds: hydrateUnlockedCarIds(),
  seed: hydrateSeed(),
  runId: 0,
  settings: loadSettings(),

  transition: (to) => {
    const from = get().machine;
    // Throws in dev on an invalid transition (fail loud at the call site); in prod
    // this only warns, so the canTransition check below is what actually guards the
    // `set` call in that environment.
    assertTransition(from, to);
    if (canTransition(from, to)) {
      // Phase 17: a FRESH run (garage -> playing) starts at the SELECTED car's full HP —
      // 60 for the racer, 260 for the streetcar. Only this edge refills: PAUSED->PLAYING
      // is a resume (damage must survive a pause), and the GAMEOVER->PLAYING retry edge
      // is refilled by runReset() below (combat/runLoop.ts calls it alongside the
      // transition), which reads the same per-car source.
      if (to === 'PLAYING' && from === 'GARAGE') {
        set({ machine: to, playerHp: selectedCarHp(get().selectedCarId) });
      } else {
        set({ machine: to });
      }
    }
  },

  addHeat: (delta) => {
    let clampedDelta = delta;
    if (delta < 0) {
      if (import.meta.env.DEV) {
        console.warn(
          `[store] addHeat received a negative delta (${delta}); heat is monotonic and never decays — clamping to 0.`,
        );
      }
      clampedDelta = 0;
    }

    const { heat: prevHeat, tier: prevTier } = get();
    const heat = prevHeat + clampedDelta;
    const tier = tierForHeat(heat, TIER_THRESHOLDS);
    set({ heat, tier });

    gameEvents.emit('heatChanged', { heat, delta: clampedDelta });

    // Emit tierChanged once PER crossing, in ascending order, on a multi-tier jump (e.g.
    // a +200 event from heat 10 crosses tiers 1, 2, and 3 in the same call — each must
    // fire its own tierChanged so tier-up consumers (stinger audio, HUD star flare, spawn
    // director's "immediately fill the new cap") see every intermediate tier, not just the
    // final one). Heat only ever increases (monotonic, asserted above) and thresholds are
    // ascending, so tier can only climb here — a plain ascending loop from prevTier+1 to
    // tier is sufficient; no descending case to handle.
    for (let t = prevTier + 1; t <= tier; t++) {
      gameEvents.emit('tierChanged', { tier: t, prevTier: t - 1 });
    }
  },

  addScore: (points) => set((state) => ({ score: state.score + points })),
  setPlayerHp: (hp) => set({ playerHp: hp }),
  setSeed: (seed) => set({ seed }),

  setSelectedCar: (carId) => set({ selectedCarId: carId }),

  selectCar: (carId) => {
    if (!get().unlockedCarIds.includes(carId)) {
      if (import.meta.env.DEV) {
        console.warn(`[store] selectCar("${carId}") rejected — not yet unlocked.`);
      }
      return;
    }
    set({ selectedCarId: carId });
  },

  setQuality: (quality, source = 'user') => {
    set((state) => {
      const settings = { ...state.settings, quality, qualitySource: source };
      saveSettings(settings);
      return { settings };
    });
  },

  toggleMuted: () => {
    set((state) => {
      const settings = { ...state.settings, muted: !state.settings.muted };
      saveSettings(settings);
      return { settings };
    });
  },

  setReducedShake: (reducedShake) => {
    set((state) => {
      const settings = { ...state.settings, reducedShake };
      saveSettings(settings);
      return { settings };
    });
  },

  hardReset: () => {
    // BOOT has no predecessor in TRANSITIONS, so this intentionally bypasses
    // assertTransition rather than going through `transition`. Settings and seed are
    // meta-progression (not run state) and survive — as does the car selection, so the
    // hp refill reads the selected car (Phase 17), not a hardcoded 100.
    set((s) => ({
      machine: 'BOOT',
      heat: 0,
      tier: 0,
      score: 0,
      playerHp: selectedCarHp(s.selectedCarId),
    }));
  },

  runReset: () => {
    // No `machine` key here at all — the retry flow's own transition('PLAYING') call
    // (a real GAMEOVER->PLAYING edge) is what moves the machine; this action only ever
    // touches run-scoped numbers. runId++ drives the full-remount retry contract (see
    // the field's doc comment). See the GameStoreState doc comment above.
    set((s) => ({
      heat: 0,
      tier: 0,
      score: 0,
      playerHp: selectedCarHp(s.selectedCarId),
      runId: s.runId + 1,
    }));
  },
}));

// Phase 17: extends `unlockedCarIds` as `carUnlocked` events arrive (state/persistence.ts's
// recordRunEnd emits one per NEWLY crossed threshold when a run's score folds into
// lifetimeScore). Subscribed once at MODULE-EVALUATION time — mirrors hud/gameOverRunEnd.ts's
// "listen before the first run can ever end" reasoning — rather than a store action
// persistence.ts calls directly, so the two modules stay decoupled through the typed event
// catalog (CLAUDE.md: "systems stay decoupled") instead of persistence.ts reaching into the
// store. Append-only and dedup-guarded; never removes an id.
gameEvents.on('carUnlocked', ({ carId }) => {
  const { unlockedCarIds } = useGameStore.getState();
  if (unlockedCarIds.includes(carId)) return;
  useGameStore.setState({ unlockedCarIds: [...unlockedCarIds, carId] });
});

// Convenience for non-React systems (AI, physics callbacks, etc.) that need a one-shot
// read without subscribing.
export const getGameState = useGameStore.getState;

/**
 * Plain getter for the reduced-camera-shake accessibility preference, for non-React hot-path
 * code (fx/cameraRig.ts runs in a per-frame useFrame and must NOT subscribe to the store —
 * see this file's header rule on per-frame reads). Reads the live settings value each call.
 */
export function getReducedShake(): boolean {
  return getGameState().settings.reducedShake;
}
