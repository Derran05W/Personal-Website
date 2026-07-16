// Typed, dependency-free event emitter. TDD §6: "tiny emitter ... HUD, audio, and FX
// subscribe; systems stay decoupled." This is the ONLY cross-system event channel —
// gameplay systems must emit through `gameEvents`, never reach into HUD/audio/FX state
// directly, and vice versa.
//
// Payloads below are intentionally minimal stubs for Phase 2; later phases extend
// fields (e.g. `unitWrecked` gaining a position) but must not bypass the emitter or
// add ad-hoc side channels.
export interface GameEventMap {
  heatChanged: { heat: number; delta: number };
  tierChanged: { tier: number; prevTier: number };
  transformerDestroyed: { districtId: number };
  unitWrecked: { unitKind: string };
  civHit: Record<string, never>;
  civWrecked: Record<string, never>;
  propDestroyed: { archetype: string };
  playerDamaged: { hp: number; amount: number };
  playerWrecked: Record<string, never>;
  busted: Record<string, never>;
  runStarted: { seed: number };
  runEnded: { score: number; reason: 'wrecked' | 'busted' | 'quit' };
  darkCity: Record<string, never>;
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
