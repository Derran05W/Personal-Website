// Line 1 subway "fold" transition — presentation config only (TORONTO-MAP-SPEC-v2.md §2
// "The fold, made honest"). Driving across the midtown fold boundary on Yonge plays a
// short dark-tunnel overlay with station names flying past; the car itself never stops or
// teleports — this is a canvas-overlay joke Torontonians are in on, not a loading screen.
//
// What does NOT live here: the fold's Y boundaries (1170/1830), the Yonge corridor centre
// (x=1500), and the drivable corridor half-width. Those are geometry, owned by
// world/toronto (the projection/polygon module the spec's §1/§2 anchors come from) and the
// road-class widths in the Toronto road config — world/toronto/tunnel.ts's
// createFoldTrigger takes them as parameters/constants at that layer, not this one. This
// file is purely "how long does the overlay stay up and what does it say."

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
