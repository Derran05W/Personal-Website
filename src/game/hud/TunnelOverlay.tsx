// Line 1 subway "fold" transition overlay (TORONTO-MAP-SPEC-v2.md §2 "The fold, made
// honest"). Presentation only: a dark tunnel wash with the crossed stations flying past, in
// direction order, auto-dismissing after config/tunnel.ts's TUNNEL_OVERLAY.durationMs. The
// car never stops, slows, or teleports underneath this — the Toronto driving scene (a
// separate task from this file) keeps simulating exactly as normal and is the sole emitter
// of the `tunnelTransit` event (state/events.ts) this component listens for. Detection
// itself lives in world/toronto/tunnel.ts's createFoldTrigger; this file only reacts to the
// event it produces.
//
// Mount contract: hud/Hud.tsx mounts `<TunnelOverlay />` UNCONDITIONALLY (outside its own
// `visible` gate — see that file's header) so the `tunnelTransit` subscription below is live
// for the whole game session, not just while machine === PLAYING/PAUSED. This component owns
// its own visibility the same way hud/ContextLossOverlay.tsx does: it renders null until
// there's something to show, rather than the "always mounted, CSS class toggles visibility"
// idiom hud/Hud.tsx's DarkCityBanner/BustedWash use — a subway interstitial has nothing
// meaningful to show at rest, so there is no "inert" DOM to leave sitting around.
//
// aria-hidden/pointer-events:none throughout — same belt-and-suspenders reasoning as
// hud/Hud.tsx/GameOver.tsx: the site header must never be occludable regardless of stacking
// context, and every pixel here is decorative (nothing operable by assistive tech).
//
// Reduced motion — TWO independent signals, same static-fade outcome (grepped
// state/store.ts + config/fx.ts per the task brief; both patterns exist and neither alone
// covers everyone): (1) TunnelOverlay.css's `@media (prefers-reduced-motion: reduce)` block,
// the OS-level signal every other hud/*.css file already keys off (Hud.css/GameOver.css/
// PauseMenu.css/touch/TouchControls.css) — covers a player who never opens the pause menu;
// (2) `settings.reducedShake` (state/store.ts), this project's only in-game, UI-exposed
// motion toggle (PauseMenu.tsx labels it "Reduced camera shake", but it's the one lever a
// player actually has here — there is no separate "reduce UI motion" setting) — covers a
// player who DID turn it on but whose OS-level preference is untouched. Both collapse the
// "flying past" station ticker to a static, already-fully-visible list; the wash's opacity
// fade is unaffected either way (a plain crossfade, not the vestibular-motion concern).
import { useEffect, useRef, useState } from 'react';
import { gameEvents } from '../state/events';
import { useGameStore } from '../state/store';
import { TUNNEL_OVERLAY, LINE_1_STATIONS_SOUTHBOUND } from '../config/tunnel';
import type { FoldDirection } from '../world/toronto/tunnel';
import './TunnelOverlay.css';

// Northbound reads the same corridor in the opposite order (Rosedale first, York Mills
// last) — derived once here, not a second config constant (config/tunnel.ts's own doc
// comment: "northbound order is this array reversed").
const LINE_1_STATIONS_NORTHBOUND = [...LINE_1_STATIONS_SOUTHBOUND].reverse();

function stationsFor(direction: FoldDirection): readonly string[] {
  return direction === 'southbound' ? LINE_1_STATIONS_SOUTHBOUND : LINE_1_STATIONS_NORTHBOUND;
}

interface ActiveTransit {
  readonly direction: FoldDirection;
  /** Bumped on every event, even one arriving mid-overlay — used as the root's React `key`
   * so a re-trigger (fast back-and-forth fold crossing) restarts the CSS animation cleanly
   * via a full remount, same "unmistakably resets" need as hud/Hud.tsx's DamageVignette. */
  readonly nonce: number;
}

export default function TunnelOverlay() {
  const reducedMotion = useGameStore((s) => s.settings.reducedShake);
  const [transit, setTransit] = useState<ActiveTransit | null>(null);
  // Fade-out is a SEPARATE flag from unmount: the overlay stays mounted (and readable) for
  // the fadeOutMs tail instead of popping straight to nothing (Hud.css's
  // hud-control-hints opacity+visibility-delay idiom, expressed via two timers here since
  // this component fully unmounts at the end rather than toggling a class forever).
  const [leaving, setLeaving] = useState(false);
  const leaveTimer = useRef<number | undefined>(undefined);
  const dismissTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const off = gameEvents.on('tunnelTransit', ({ direction }) => {
      window.clearTimeout(leaveTimer.current);
      window.clearTimeout(dismissTimer.current);
      setLeaving(false);
      setTransit((prev) => ({ direction, nonce: (prev?.nonce ?? 0) + 1 }));

      leaveTimer.current = window.setTimeout(() => {
        setLeaving(true);
      }, TUNNEL_OVERLAY.durationMs - TUNNEL_OVERLAY.fadeOutMs);

      dismissTimer.current = window.setTimeout(() => {
        setTransit(null);
        setLeaving(false);
      }, TUNNEL_OVERLAY.durationMs);
    });
    return () => {
      off();
      window.clearTimeout(leaveTimer.current);
      window.clearTimeout(dismissTimer.current);
    };
  }, []);

  if (!transit) return null;

  const stations = stationsFor(transit.direction);
  const stationsClassName = reducedMotion
    ? 'tunnel-overlay__stations tunnel-overlay__stations--static'
    : 'tunnel-overlay__stations';

  return (
    <div
      key={transit.nonce}
      className={leaving ? 'tunnel-overlay tunnel-overlay--leaving' : 'tunnel-overlay tunnel-overlay--active'}
      data-testid="tunnel-overlay"
      data-direction={transit.direction}
      aria-hidden="true"
    >
      <div className="tunnel-overlay__wash" />
      <div className="tunnel-overlay__marquee">
        <span className="tunnel-overlay__badge">LINE 1</span>
        <ul className={stationsClassName} data-testid="tunnel-overlay-stations">
          {stations.map((name) => (
            <li key={name} className="tunnel-overlay__station">
              {name}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
