// Typed, dependency-free event emitter. TDD §6: "tiny emitter ... HUD, audio, and FX
// subscribe; systems stay decoupled." This is the ONLY cross-system event channel —
// gameplay systems must emit through `gameEvents`, never reach into HUD/audio/FX state
// directly, and vice versa.
//
// Payloads below are intentionally minimal stubs for Phase 2; later phases extend
// fields (e.g. `unitWrecked` gaining a position) but must not bypass the emitter or
// add ad-hoc side channels.
import type { PlayerCarId } from '../config/vehicles';
import type { FoldDirection } from '../world/toronto/tunnel';

export interface GameEventMap {
  heatChanged: { heat: number; delta: number };
  tierChanged: { tier: number; prevTier: number };
  /** Phase 16: `x`/`y`/`z` are the dead transformer's world position, when derivable — the
   * real damage-resolver kill (combat/damage.ts's handleTransformerDeath) always sets them,
   * read straight off the archetype's live InstancedMesh instance. The dev "blackout
   * district" debug shortcut (core/debugBridge.ts) has no single transformer instance to
   * point at and omits them. fx/eventFx.ts skips its spark burst when absent — see that
   * file for why this mirrors combat/types.ts's ImpactRecord.point optionality instead of a
   * fake (0,0,0) fallback. */
  transformerDestroyed: { districtId: number; x?: number; y?: number; z?: number };
  unitWrecked: { unitKind: string };
  civHit: Record<string, never>;
  civWrecked: Record<string, never>;
  /** Phase 16: `x`/`y`/`z` are the world position of the killing blow (contact point / bullet
   * hit / blast center — whichever resolver emitted this), when one was available. Optional
   * for the same reason as `transformerDestroyed` above: combat/types.ts's ImpactRecord.point
   * is itself optional (Rapier doesn't always report a contact point), and that's the source
   * for the ram-death path (combat/damage.ts). world/propDynamics.ts's swap-on-launch path
   * always has a position (the prop's own captured transform) and always sets it. */
  propDestroyed: { archetype: string; x?: number; y?: number; z?: number };
  playerDamaged: { hp: number; amount: number };
  playerWrecked: Record<string, never>;
  busted: Record<string, never>;
  runStarted: { seed: number };
  runEnded: { score: number; reason: 'wrecked' | 'busted' | 'quit' };
  darkCity: Record<string, never>;
  /** Player (or, once Phase 7/9 add them, any vehicle) entered the south lakefront WATER
   * sensor (world/CityScape.tsx). Logged only in Phase 4; Phase 9 wires instant WRECKED. */
  enteredWater: Record<string, never>;
  /** Phase 17: emitted once per NEWLY crossed lifetime-score unlock threshold
   * (config/unlocks.ts's UNLOCKS), exactly when a run's score folds into the persisted
   * `lifetimeScore` — state/persistence.ts's recordRunEnd (the `runEnded` handler) diffs
   * the before/after unlocked sets and emits one of these per newly-crossed id, in
   * ascending threshold order. Never re-emitted for a car that was already unlocked
   * (including rustySedan, whose threshold-0 is already met before any run ever ends).
   * state/store.ts's module-scope subscription folds these into `unlockedCarIds`;
   * hud/GameOver.tsx queues the car names for its "UNLOCKED: <name>" toast. */
  carUnlocked: { carId: PlayerCarId };
  /** Midtown fold "Line 1" transition (TORONTO-MAP-SPEC-v2.md §2): the player just crossed
   * INTO the fold band on Yonge (world/toronto/tunnel.ts's createFoldTrigger detects the
   * crossing; the Toronto driving scene owns calling `.step()` per frame and emitting this
   * — a separate task from this event/HUD wiring). Presentation-only: the car keeps
   * driving, nothing here ever moves it. hud/TunnelOverlay.tsx is the sole subscriber. */
  tunnelTransit: { direction: FoldDirection };
}

type Handler<K extends keyof GameEventMap> = (payload: GameEventMap[K]) => void;

// Erased handler type used for internal storage only. TypeScript can't prove a write
// through a generic key `K` into a `{ [K in keyof M]?: Set<Handler<K>> }`-shaped record
// is sound (a known mapped-type limitation), so storage is kept as a single erased Map
// and every public method restores the precise `Handler<K>` type at its boundary — the
// `never` parameter type makes the erased signature accept a cast from (and safely
// re-narrow back to) any `Handler<K>` without an explicit `any`.
type ErasedHandler = (payload: never) => void;

export class GameEventEmitter {
  private listeners = new Map<keyof GameEventMap, Set<ErasedHandler>>();

  on<K extends keyof GameEventMap>(event: K, handler: Handler<K>): () => void {
    let handlers = this.listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(event, handlers);
    }
    handlers.add(handler as ErasedHandler);
    return () => this.off(event, handler);
  }

  off<K extends keyof GameEventMap>(event: K, handler: Handler<K>): void {
    this.listeners.get(event)?.delete(handler as ErasedHandler);
  }

  emit<K extends keyof GameEventMap>(event: K, payload: GameEventMap[K]): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    // Copy to an array before iterating: a handler unsubscribing itself (or another
    // handler) mid-emit must not mutate the Set out from under this loop.
    for (const handler of Array.from(handlers)) {
      // One handler throwing must not stop sibling handlers (or the emitter) from
      // running — HUD/audio/FX are independent observers, a bug in one is not
      // allowed to silently drop e.g. the score update in another.
      try {
        (handler as Handler<K>)(payload);
      } catch (error) {
        console.error(`[gameEvents] handler for "${String(event)}" threw:`, error);
      }
    }
  }

  clearAllListeners(): void {
    this.listeners.clear();
  }
}

// Single shared instance — the project convention is "one store, one emitter."
export const gameEvents = new GameEventEmitter();
