// Gameplay HUD (Phase 8 Task 2, TDD §9): wanted stars, score, HP silhouette, control
// hints, and a dev-only seed readout. Rendered as a plain DOM overlay OUTSIDE the r3f
// <Canvas> — same layer as GarageOverlay.tsx / hud/Minimap.tsx — so it never touches R3F's
// render loop, and reads the store via a throttled poll (useHudSnapshot.ts), not a
// zustand selector hook that would fire every physics step (CLAUDE.md: "HUD reads store
// selectors; ≤10 Hz updates").
//
// Layering & clickability: every element below sets `pointerEvents: 'none'` (root and
// descendants) — the site header (app/Header.css, z-index 50, pointer-events auto) is a
// SIBLING of game/index.tsx's whole subtree at the page root (app/GameCanvas.css's
// `.game-canvas-container` is itself z-index 0 and its own stacking context, per CSS
// stacking rules a positioned z-index:0 ancestor can never paint above a z-index:50
// sibling no matter what z-index its children use), so the header already always paints
// above this HUD — pointer-events:none is the actual, belt-and-suspenders guarantee that
// nothing here can ever intercept a click.
//
// Mount contract: game/index.tsx mounts <Hud /> unconditionally; this component decides
// whether to render anything (null outside PLAYING/PAUSED) — the same "owns its own
// visibility" pattern as hud/Minimap.tsx (dev-toggle-gated) and GarageOverlay.tsx
// (machine === 'GARAGE'-gated).
//
// Visual language (phase-08-plan.md T2 decision): minimal-clean matching the shell
// header's typography (dark translucent chips, muted body text) with exactly ONE chunky
// element — the score, set in the header's own display font (--font-display, index.css)
// at a much larger size/weight than anything else in the HUD.

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { gameEvents } from '../state/events';
import { useHudSnapshot } from './useHudSnapshot';
import { PLAYER_CARS } from '../config';
import { filledStarCount, formatScore, hpColor, hpFillPercent } from './hudFormat';
import { PauseMenu } from './PauseMenu';
import { TouchControls } from './touch/TouchControls';
import TunnelOverlay from './TunnelOverlay';
import './Hud.css';

const STAR_COUNT = 5;
const FLARE_MS = 600; // Must match Hud.css's hud-star-flare animation-duration.
const CONTROL_HINTS_MS = 8000;
// BUSTED wash (Phase 16 Task 4): how long the in-HUD red/blue arrest wash stays up after
// the `busted` event. In practice the HUD unmounts the instant machine flips to GAMEOVER
// (combat/runLoop.ts's ~1.2s BUSTED lock), at which point hud/GameOver.tsx's own busted
// backdrop wash takes over seamlessly — so this timeout is really just a self-clear safety
// net for the (edge) case where machine lingers in PLAYING. Kept a touch above the lock so
// the wash never blinks out before the panel arrives.
const BUSTED_WASH_MS = 2200;

// Below the fixed 64px site header (app/Header.css) with a small gap — same offset
// reasoning as core/PerfOverlay.tsx (top:70) and core/devPanel.tsx's Leva titleBar
// (y:70; also top-right). Stars sit lower still (112, not 76) to additionally clear
// Leva's own collapsed title bar, which is dev-only and also anchored top-right — the two
// never visually collide during a dev session. Production ships without Leva, so this is
// pure dev polish with no player-facing cost.
const HEADER_CLEARANCE = 76;
const STARS_TOP = 112;

// Damage hit-feedback (Phase 11 Task 3 / phase-11-plan.md): must match Hud.css's
// hud-damage-flash / hud-hp-flash animation-durations.
const DAMAGE_FLASH_MS = 260;

// hud/Minimap.tsx is fixed at left:12, bottom:12, 192x192 (dev-only, default-on toggle).
// The HP silhouette also wants bottom-left (TDD §9); rather than overlap the minimap in
// dev builds, it sits just above it instead. Production never renders the minimap, so
// this only costs a bit of extra bottom margin there.
const HP_BOTTOM = 12 + 192 + 12;

const rootStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'none',
  // Above the bare canvas/GarageOverlay (both effectively z-index 0/auto), below the
  // dev-only overlays that should always win legibility during debugging (Minimap z-40,
  // Leva's own high default z-index).
  zIndex: 20,
};

// Blue-hour-legible: a subtle dark translucent chip behind every text cluster (TDD §9 /
// task brief point 8), same treatment repeated per element rather than one big panel —
// keeps the "minimal-clean" language instead of a single HUD "frame".
const chipStyle: CSSProperties = {
  background: 'rgba(10, 14, 22, 0.55)',
  borderRadius: 8,
  padding: '0.35rem 0.7rem',
  pointerEvents: 'none',
};

/**
 * Shared hit-feedback pulse (Phase 11 Task 3): subscribes `playerDamaged` DIRECTLY —
 * local component state, NOT the 10 Hz useHudSnapshot poll — so a hit shows on the exact
 * frame the resolver (combat/damage.ts) emits it, same "event-driven, not derived from the
 * polled snapshot" reasoning WantedStars already uses for its tier-flare. `nonce` bumps on
 * every event (even a hit arriving mid-pulse), so a DamageVignette consumer can key off it
 * to force its CSS animation to restart rather than silently no-op while already active.
 */
function useDamageFlash(durationMs: number): { active: boolean; nonce: number } {
  const [active, setActive] = useState(false);
  const [nonce, setNonce] = useState(0);
  const timeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const off = gameEvents.on('playerDamaged', () => {
      window.clearTimeout(timeoutRef.current);
      setActive(true);
      setNonce((n) => n + 1);
      timeoutRef.current = window.setTimeout(() => setActive(false), durationMs);
    });
    return () => {
      off();
      window.clearTimeout(timeoutRef.current);
    };
  }, [durationMs]);

  return { active, nonce };
}

// Full-viewport red edge vignette (task brief: "brief red edge vignette ... Must read
// WITHOUT looking at the HP bar"). This is the PRIMARY hit-feedback signal — everything
// else (the HpSilhouette flash below) is reinforcement for a player who happens to already
// be looking at the gauge. `key={nonce}` forces a full remount on every hit so the CSS
// animation restarts cleanly even if a new hit lands mid-pulse (same "unmistakably resets"
// requirement as re-triggering a CSS keyframe on an unchanged class name would otherwise
// silently fail to do).
function DamageVignette() {
  const { active, nonce } = useDamageFlash(DAMAGE_FLASH_MS);
  return (
    <div
      key={nonce}
      className={active ? 'hud-damage-vignette hud-damage-vignette--flash' : 'hud-damage-vignette'}
      data-testid="hud-damage-vignette"
      aria-hidden="true"
    />
  );
}

function WantedStars({ tier }: { tier: number }) {
  const [flareTier, setFlareTier] = useState<number | null>(null);
  const timeoutRef = useRef<number | undefined>(undefined);

  // Event-driven (not derived from the polled snapshot) so the flare fires on the exact
  // tier-up frame rather than up to 100ms late, and so it can target precisely the
  // newly-lit star via the event payload's `tier`/`prevTier` (state/events.ts).
  useEffect(() => {
    const off = gameEvents.on('tierChanged', ({ tier: newTier, prevTier }) => {
      if (newTier <= prevTier) return; // heat is monotonic (never decays) so tier only
      // rises in practice — guard defensively anyway rather than assume that forever.
      window.clearTimeout(timeoutRef.current);
      setFlareTier(newTier);
      timeoutRef.current = window.setTimeout(() => setFlareTier(null), FLARE_MS);
    });
    return () => {
      off();
      window.clearTimeout(timeoutRef.current);
    };
  }, []);

  const filled = filledStarCount(tier);

  return (
    <div
      style={{ position: 'fixed', top: STARS_TOP, right: 16, display: 'flex', gap: 4, ...chipStyle }}
      data-testid="hud-stars"
    >
      {Array.from({ length: STAR_COUNT }, (_, i) => {
        const starTier = i + 1;
        const isFilled = starTier <= filled;
        return (
          <span
            key={starTier}
            className={starTier === flareTier ? 'hud-star hud-star--flare' : 'hud-star'}
            style={{
              fontSize: '1.35rem',
              lineHeight: 1,
              // Dimmed outline at tier 0 (all unfilled) rather than fully invisible, per
              // TDD §9 / task brief point 2.
              color: isFilled ? '#f59e0b' : 'rgba(245, 245, 245, 0.25)',
              textShadow: isFilled ? '0 0 8px rgba(245, 158, 11, 0.75)' : 'none',
            }}
            aria-hidden="true"
          >
            ★
          </span>
        );
      })}
    </div>
  );
}

function ScoreDisplay({ score }: { score: number }) {
  return (
    <div
      style={{
        position: 'fixed',
        top: HEADER_CLEARANCE,
        left: '50%',
        transform: 'translateX(-50%)',
        ...chipStyle,
      }}
      data-testid="hud-score"
    >
      {/* The ONE chunky element (T2 visual-language decision): the shell's display font
          (--font-display, index.css's self-hosted Fredoka Variable — that file's comment
          notes "the game HUD reuses this font later"), at ~3x the header wordmark's size
          and full 700 weight, everything else in the HUD stays at body-text scale. */}
      <span
        style={{
          display: 'block',
          fontFamily: 'var(--font-display)',
          fontWeight: 700,
          fontSize: 'clamp(1.75rem, 4vw, 2.75rem)',
          letterSpacing: '0.02em',
          color: '#f5f5f5',
          textShadow: '0 2px 16px rgba(0, 0, 0, 0.55)',
        }}
      >
        {formatScore(score)}
      </span>
    </div>
  );
}

// Simple low-poly sedan side profile, hand-drawn to a 120x48 viewBox (faceted
// roof/hood/trunk line + two wheel circles) — reused for both the always-visible dim
// "ghost" outline and the hp-clipped color fill below, same currentColor-free,
// fill-driven approach as app/icons.tsx's hand-authored SVGs.
const CAR_BODY_D = 'M8 34 L8 30 L14 30 L20 18 L46 18 L52 10 L74 10 L82 18 L104 18 L110 26 L112 34 Z';
const CAR_WHEELS: readonly { cx: number; cy: number; r: number }[] = [
  { cx: 26, cy: 36, r: 8 },
  { cx: 92, cy: 36, r: 8 },
];

function CarShape({ fill }: { fill: string }) {
  return (
    <>
      <path d={CAR_BODY_D} fill={fill} />
      {CAR_WHEELS.map((w) => (
        <circle key={`${w.cx}-${w.cy}`} cx={w.cx} cy={w.cy} r={w.r} fill={fill} />
      ))}
    </>
  );
}

function HpSilhouette({ hp, maxHp }: { hp: number; maxHp: number }) {
  // useId rather than a string literal clip-path id: keeps this component collision-safe
  // if it's ever rendered twice in the same DOM (tests, Storybook-style previews) — a
  // duplicate `id="hud-hp-clip"` would silently clip against the wrong instance.
  const clipId = useId();
  const pct = hpFillPercent(hp, maxHp);
  const fillHeight = (pct / 100) * 48;
  const color = hpColor(hp, maxHp);
  // Secondary hit reinforcement (task brief point: "HP silhouette flash (existing color
  // logic + a flash class)") — own event subscription, independent of WantedStars'/
  // DamageVignette's (each hit-feedback consumer owns its own tiny subscription, same
  // "cheap, decoupled" precedent as WantedStars' tierChanged listener).
  const { active: flashing } = useDamageFlash(DAMAGE_FLASH_MS);

  return (
    <div
      style={{ position: 'fixed', left: 16, bottom: HP_BOTTOM, ...chipStyle }}
      className={flashing ? 'hud-hp--flash' : undefined}
      data-testid="hud-hp"
    >
      <svg width={120} height={48} viewBox="0 0 120 48" aria-hidden="true" focusable="false">
        {/* Always-visible faint ghost of the full car, so the silhouette reads as "a car"
            even at 0 hp (an empty gauge with nothing to compare it against would just
            look broken). */}
        <g opacity={0.22}>
          <CarShape fill="#ffffff" />
        </g>
        <clipPath id={clipId}>
          {/* Vertical fill mask proportional to hp/100 (task brief point 4): a rect
              anchored to the bottom edge, growing upward as hp rises — a fuel-gauge-style
              fill rather than a horizontal wipe. */}
          <rect x={0} y={48 - fillHeight} width={120} height={fillHeight} />
        </clipPath>
        <g clipPath={`url(#${clipId})`} style={{ transition: 'fill 300ms ease' }}>
          <CarShape fill={color} />
        </g>
      </svg>
    </div>
  );
}

// DARK CITY (Phase 13 Task 2; TDD §5.8's "easter egg": all 16 districts dark). Two
// pieces sharing one subscription (useDarkCityState below): a dramatic ~5s centered
// banner on the `darkCity` event, and a subtle indicator near the wanted stars that
// persists for the rest of the run once triggered (districts only ever go lit->dark
// within a run — powergrid/grid.ts's PowerGridState doc comment — so once true this
// never has a reason to flip back off mid-run).
const DARKCITY_BANNER_MS = 5000;

/**
 * Owns the darkCity subscription. Lives in its own hook (not inlined in the default
 * export) so both DarkCityBanner and the persistent indicator share one listener instead
 * of each re-subscribing independently — same "one tiny subscription per concern, shared
 * where the concern is the same" precedent as useDamageFlash above.
 *
 * Reset note: <Hud/> mounts once for the whole game lifetime (this file's header "mount
 * contract" — it only conditionally renders null, it doesn't unmount between runs), so a
 * retried run needs an explicit reset or it would inherit the previous run's DARK CITY
 * state. `runStarted` (state/events.ts; emitted exactly once per run by
 * combat/runLoop.ts's beginRun, on both a fresh GARAGE->PLAYING run and a GAMEOVER->
 * PLAYING retry) is the correct signal for that — it fires strictly before any gameplay
 * (and therefore any transformerDestroyed) can happen in the new run.
 */
function useDarkCityState(): { bannerVisible: boolean; allDark: boolean } {
  const [bannerVisible, setBannerVisible] = useState(false);
  const [allDark, setAllDark] = useState(false);
  const timeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const offDark = gameEvents.on('darkCity', () => {
      setAllDark(true);
      window.clearTimeout(timeoutRef.current);
      setBannerVisible(true);
      timeoutRef.current = window.setTimeout(() => setBannerVisible(false), DARKCITY_BANNER_MS);
    });
    const offStart = gameEvents.on('runStarted', () => {
      window.clearTimeout(timeoutRef.current);
      setBannerVisible(false);
      setAllDark(false);
    });
    return () => {
      offDark();
      offStart();
      window.clearTimeout(timeoutRef.current);
    };
  }, []);

  return { bannerVisible, allDark };
}

// Dramatic centered banner, ~5s (DARKCITY_BANNER_MS). Always rendered (not conditionally
// mounted) — visibility toggles via the `--visible` class, same opacity+visibility
// transition-delay idiom as `.hud-control-hints`/`.hud-control-hints--hidden` above, so a
// player who somehow re-triggers it mid-fade-out gets a clean restart instead of a
// remount pop. The entrance flourish (Hud.css's `hud-darkcity-in` keyframe) layers on top
// of that transition and is disabled under prefers-reduced-motion (Hud.css), leaving the
// plain opacity fade intact — the banner is still unmissable, just not motion-heavy.
function DarkCityBanner({ visible }: { visible: boolean }) {
  return (
    <div
      className={visible ? 'hud-darkcity-banner hud-darkcity-banner--visible' : 'hud-darkcity-banner'}
      data-testid="hud-darkcity-banner"
      aria-hidden={!visible}
    >
      DARK CITY
    </div>
  );
}

// Subtle persistent indicator (task brief: "small text near stars, your judgment") — sits
// just below WantedStars' chip (STARS_TOP + its own ~44px height) in the same right-
// aligned column, dim enough to read as ambient flavor rather than another HUD readout
// competing with the stars/score for attention.
function DarkCityIndicator() {
  return (
    <div
      style={{
        position: 'fixed',
        top: STARS_TOP + 44,
        right: 16,
        fontSize: '0.65rem',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'rgba(245, 245, 245, 0.45)',
        ...chipStyle,
        padding: '0.2rem 0.55rem',
      }}
      data-testid="hud-darkcity-indicator"
      aria-hidden="true"
    >
      dark city
    </div>
  );
}

/**
 * BUSTED arrest wash (Phase 16 Task 4). Full-screen red/blue "police light" wash driven by
 * the `busted` event (state/events.ts) — combat/runLoop.ts emits it at the START of the
 * ~1.2s BUSTED lock window, while machine is still PLAYING, so this paints over the live
 * game for the arrest beat and then hands off to hud/GameOver.tsx's own busted backdrop the
 * moment the run flips to GAMEOVER (and this whole HUD unmounts). Same "one tiny
 * subscription per concern, self-resetting on runStarted" idiom as useDarkCityState above —
 * a retried run must not inherit the previous run's wash.
 */
function useBustedWash(): boolean {
  const [active, setActive] = useState(false);
  const timeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const offBusted = gameEvents.on('busted', () => {
      window.clearTimeout(timeoutRef.current);
      setActive(true);
      timeoutRef.current = window.setTimeout(() => setActive(false), BUSTED_WASH_MS);
    });
    const offStart = gameEvents.on('runStarted', () => {
      window.clearTimeout(timeoutRef.current);
      setActive(false);
    });
    return () => {
      offBusted();
      offStart();
      window.clearTimeout(timeoutRef.current);
    };
  }, []);

  return active;
}

// Always rendered (not conditionally mounted) so a re-trigger restarts cleanly via the
// `--active` class rather than a remount pop — same idiom as DarkCityBanner. The alternating
// red/blue steps animation + a static reduced-motion fallback both live in Hud.css.
function BustedWash({ active }: { active: boolean }) {
  return (
    <div
      className={active ? 'hud-busted-wash hud-busted-wash--active' : 'hud-busted-wash'}
      data-testid="hud-busted-wash"
      aria-hidden="true"
    />
  );
}

function ControlHints() {
  const [visible, setVisible] = useState(true);

  // Mount-only effect (empty deps): <Hud/> — and therefore this component — mounts fresh
  // exactly when PLAYING is (re)entered from GARAGE or GAMEOVER (see the visible-state
  // gate in the default export below) and then stays mounted across PLAYING<->PAUSED,
  // because pausing never unmounts the HUD (CLAUDE.md's pause model: the canvas/HUD stay
  // mounted, only <Physics paused> flips). So a plain mount effect already satisfies "show
  // on entry, not on pause/resume" with no machine-transition bookkeeping needed — a
  // resume from PAUSED can never re-run this effect because it never remounts the
  // component in the first place.
  //
  // The 8s fade is real (wall-clock) time — it does NOT pause alongside physics, so
  // pausing shortly after starting does not extend the hint's visible window. Documented
  // here per the task brief; revisit if playtesting shows this reads as unfair/confusing.
  useEffect(() => {
    const id = window.setTimeout(() => setVisible(false), CONTROL_HINTS_MS);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <div
      className={visible ? 'hud-control-hints' : 'hud-control-hints hud-control-hints--hidden'}
      style={{ position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)', ...chipStyle }}
      data-testid="hud-control-hints"
    >
      <span style={{ fontSize: '0.85rem', color: 'rgba(245, 245, 245, 0.85)' }}>
        WASD drive · Space handbrake · Esc pause
      </span>
    </div>
  );
}

// DEV-only (import.meta.env.DEV-gated by the caller below, same pattern as every other
// dev-only piece of this codebase) tiny corner readout of the active world seed. Placed
// bottom-right — the one corner nothing else in this HUD or the dev overlays (Minimap
// bottom-left, PerfOverlay/Leva top corners) already claims.
function SeedReadout({ seed }: { seed: number }) {
  return (
    <div
      style={{
        position: 'fixed',
        right: 8,
        bottom: 8,
        fontSize: '0.65rem',
        fontFamily: 'monospace',
        color: 'rgba(245, 245, 245, 0.4)',
      }}
      data-testid="hud-seed"
    >
      seed {seed}
    </div>
  );
}

export default function Hud() {
  const { machine, tier, score, playerHp, selectedCarId, seed } = useHudSnapshot();
  // Subscribed unconditionally, ABOVE the visibility early-return below (React's
  // rules-of-hooks: every hook here must run on every render regardless of what this
  // component ends up returning) — this is deliberate, not an oversight: it's what keeps
  // the darkCity/runStarted listeners alive for <Hud/>'s whole (game-lifetime) mount,
  // not just while machine happens to be PLAYING/PAUSED. See useDarkCityState's doc
  // comment for why that matters for the reset-on-retry behavior.
  const { bannerVisible, allDark } = useDarkCityState();
  const bustedWashActive = useBustedWash();
  // Task brief point 1: PLAYING + PAUSED only (not GAMEOVER-adjacent) — the game-over
  // screen is a separate future surface (Phase 9), and showing the run HUD underneath it
  // would just be visual noise once the run has ended.
  const visible = machine === 'PLAYING' || machine === 'PAUSED';

  return (
    <>
      {/* Mounted UNCONDITIONALLY (outside the `visible` gate below), so its `tunnelTransit`
          subscription (state/events.ts) is live for the whole game session, not just while
          machine is PLAYING/PAUSED — see hud/TunnelOverlay.tsx's own "mount contract" doc
          comment. It owns its own visibility (renders null with nothing to show), exactly
          like hud/ContextLossOverlay.tsx below it in game/index.tsx's mount list, so this
          costs nothing when idle. */}
      <TunnelOverlay />
      {visible ? (
        <div style={rootStyle} data-testid="hud-root">
          {/* First child: the BUSTED wash paints BEHIND every HUD chip (DOM order = paint
              order, no z-index) so the score/stars stay legible on top of the arrest strobe. */}
          <BustedWash active={bustedWashActive} />
          <WantedStars tier={tier} />
          {allDark ? <DarkCityIndicator /> : null}
          <ScoreDisplay score={score} />
          <HpSilhouette hp={playerHp} maxHp={PLAYER_CARS[selectedCarId].hp} />
          <ControlHints />
          {import.meta.env.DEV ? <SeedReadout seed={seed} /> : null}
          <DarkCityBanner visible={bannerVisible} />
          <DamageVignette />
          {/* Touch controls (Phase 18 Task 1): self-gates on coarse-pointer + PLAYING, so
              this is a no-op render on desktop / outside a run. Painted above every
              read-only chip above (it needs real pointer events — PauseMenu below is the
              only other exception to this tree's pointerEvents:'none' default), below the
              pause menu itself since the two are mutually exclusive machine states anyway. */}
          <TouchControls />
          {/* Very last child: the pause menu (Phase 17) paints above absolutely everything
              else in this tree, including the damage vignette — it's the one surface here
              that accepts pointer events (PauseMenu.tsx's own backdrop style). */}
          {machine === 'PAUSED' ? <PauseMenu /> : null}
        </div>
      ) : null}
    </>
  );
}
