// Touch input tunables (Phase 18 Task 1; TDD §5.2 "On-screen ◀ ▶ buttons, auto-throttle
// (Smashy-style)" + CLAUDE.md's locked "Mobile v1: playable-basic — ◀ ▶ + brake,
// auto-throttle, low tier"). Kept as its own tiny config module — rather than reaching
// into VEHICLE_TUNING.steering — so the touch input seam (input/touch.ts) owns one
// clearly-scoped, live-tunable knob without touching the M1-signed-off vehicle-feel config.
export const TOUCH = {
  // The on-screen steer buttons are BINARY full-lock (±1), unlike a keyboard tap/release
  // which a player naturally times more crisply — a thumb held on a button tends to read
  // snappier/twitchier than the equivalent keyboard input. This scales the raw ±1 steer
  // VALUE fed into DrivingInput before the shared vehicle controller eases the wheel angle
  // toward it (VEHICLE_TUNING.steering.rateDegPerSec/highSpeedAngleDeg still govern the
  // actual chase rate/clamp — this knob only affects input magnitude). 1 = identical to a
  // keyboard full-lock tap; left at that TDD-neutral default until real-device
  // playtesting says a gentler value (e.g. 0.8) reads better (see phase-18 notes).
  touchSteerRateScale: 1,
} as const;
