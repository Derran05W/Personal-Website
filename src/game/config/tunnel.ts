// Line 1 subway "fold" transition — presentation config, PLUS (Phase 25.6 D3) the Yonge
// corridor x-gate half-width (TORONTO-MAP-SPEC-v2.md §2 "The fold, made honest"). Driving
// across the midtown fold boundary on Yonge plays a short dark-tunnel overlay with station
// names flying past; the car itself never stops or teleports — this is a canvas-overlay joke
// Torontonians are in on, not a loading screen.
//
// What does NOT live here: the fold's Y boundaries (1170/1830) and the Yonge corridor centre
// (x=1500) — those are geometry, owned by world/toronto (the projection/polygon module the
// spec's §1/§2 anchors come from). world/toronto/tunnel.ts's createFoldTrigger takes them as
// parameters at that layer. The corridor HALF-WIDTH, however, is now road-class-derived (D3)
// rather than a bare geometry literal, so it lives here alongside the rest of the fold's
// tuning — CLAUDE.md's "single source of truth" home for a derived config number, not a
// hand-placed one.

import { CAR_REF } from './cityPackScale';
import { ROAD_CLASSES } from './torontoMap';

/**
 * The Yonge-corridor x-gate half-width (map units), fed to `createFoldTrigger` (Phase 25.6
 * D3). Derived from the car-graded road-class widths: half the spine ribbon (Yonge, now 7
 * player-car-widths wide) plus half a car. At the old 36 wu spine the gate was generous enough
 * that a flat `spine / 2` was fine; at the re-graded 15.4 wu spine a car riding the ribbon's
 * curb edge sits with its CENTRE exactly at `spine / 2` — the extra half-car keeps an
 * edge-riding car counted as "on the corridor" without picking up traffic on the parallel
 * frontage one lane over. = 15.4/2 + 2.2/2 = 8.8.
 */
export const CORRIDOR_HALF_WIDTH_WU = ROAD_CLASSES.spine / 2 + CAR_REF.widthWu / 2;

/** Overlay lifecycle timing (ms). fadeInMs + fadeOutMs must both be comfortably less than
 * durationMs so there's a visible "held" middle, not just a crossfade. hud/TunnelOverlay.css
 * hardcodes matching literals (same "duration must match the JS constant" convention as
 * hud/Hud.css's FLARE_MS/DAMAGE_FLASH_MS/BUSTED_WASH_MS comments) — change both together. */
export const TUNNEL_OVERLAY = {
  /** Total time the overlay stays mounted before auto-dismissing. */
  durationMs: 2500,
  /** Opacity fade-in on mount. */
  fadeInMs: 300,
  /** Opacity fade-out immediately before unmount (starts at durationMs - fadeOutMs). */
  fadeOutMs: 400,
} as const;

/** Line 1 (Yonge-University) stations inside the fold band, in SOUTHBOUND order (Sheppard
 * -> Bloor, i.e. the direction of increasing map y — TDD/spec convention "y is DOWN=south")
 * — TORONTO-MAP-SPEC-v2.md §2's exact list. Northbound order is this array reversed;
 * hud/TunnelOverlay.tsx derives that itself rather than a second duplicated constant here. */
export const LINE_1_STATIONS_SOUTHBOUND = [
  'York Mills',
  'Lawrence',
  'Eglinton',
  'Davisville',
  'St Clair',
  'Summerhill',
  'Rosedale',
] as const;
