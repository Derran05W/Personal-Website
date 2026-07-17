// Streetcar civilian traffic tunables (Phase 19 Task 3; TDD §13 "Streetcars as heavy civilian
// traffic on two avenues"). A tiny, tier-scaled roster of extra-long, extra-slow, IMPLACABLE
// kinematic followers that ride world.landmarks.streetcarAvenues (Phase 19 Task 1's concurrent
// seam — see ai/streetcarTraffic.ts's header for the defensive-read contract: no avenue data,
// no streetcars) INSTEAD of the general lane graph ai/traffic.ts's civilian cars follow.
//
// Split into its own config module rather than folded into config/world.ts's TRAFFIC_CIV block
// because Phase 19 Task 1 (world generation + landmark slots) is a concurrent sibling that also
// edits config/world.ts (WORLD_GEN / landmark tunables) — a dedicated file avoids two agents
// racing edits into the same block. Registered in config/index.ts's CONFIG registry like every
// other block, so it is live-tunable via the leva dev panel for free (CLAUDE.md convention).
export const TRAFFIC_STREETCAR = {
  // Active-car target on the default (high) quality tier — tier-scaled via the SAME
  // trafficActiveTarget() helper TRAFFIC_CIV uses (config/quality.ts's trafficDensityModifier),
  // so lower tiers run fewer. Resolved (base 4): high 4, med 3, low 3.
  activeTarget: 4,
  // Flat cruise speed (m/s) — no per-car stagger. TRAFFIC_CIV randomizes speedMin/MaxMps for an
  // anti-convoy effect; a streetcar fleet should read as a slow, uniform, implacable procession
  // instead, so this is a single number, not a range.
  speedMps: 6,
  // Stop-if-blocked forward ray (m), cast from the front bumper (bodyLengthM/2 ahead of center —
  // same convention as ai/traffic.ts's frontProbeM). Longer than TRAFFIC_CIV's 7 m: the body is
  // ~2.5x the length, so it needs a proportionally bigger look-ahead buffer to read as "braking
  // in time" rather than nosing right up to an obstacle before stopping — kinematic bodies snap
  // straight to 0 speed once blocked (no real deceleration ramp to tune), so this is a visual
  // buffer, not a physical stopping distance.
  blockRayLengthM: 10,
  // UNLIKE TRAFFIC_CIV: no holdCapSec/creepSpeedMps here. Streetcars are IMPLACABLE — they stop
  // dead for a blocker and wait, full stop, however long it takes. The anti-deadlock escape
  // valve (creep-after-holdCap) stays exclusively a CAR behaviour (ai/traffic.ts's resolveHold,
  // unchanged) — see ai/streetcarTraffic.ts's resolveStreetcarHold + its header for why a
  // streetcar never needs its own escape valve.
  //
  // Kinematic→dynamic conversion threshold (N) — HIGHER than TRAFFIC_CIV's 900 N: a streetcar
  // should read as heavy and implacable, so only a real, committed ram budges it, not an
  // ordinary bump. Tuned value (the TDD gives no default for streetcars) — flag in phase notes
  // if it feels wrong in play.
  convertForceThreshold: 2200,
  // HP scaled up proportionally with massKg vs. TRAFFIC_CIV (30 hp @ 1200 kg -> 90 hp @ 3600 kg
  // keeps the SAME hp-per-kg ratio, so it takes a comparably sustained beating relative to its
  // size/weight rather than popping in one hit or soaking forever) — the "big prop payday"
  // should feel earned, not trivial.
  hp: 90,
  // Wreck detection — same shape/values as TRAFFIC_CIV (a flipped streetcar reads the same way a
  // flipped car does).
  wreckUpDot: 0.3,
  wreckFlipSustainSec: 1.5,
  // Wrecks linger visibly (trophies) before being recycled back onto their avenue loop — mirrors
  // TRAFFIC_CIV.wreckLingerSec's rationale (a converted-but-not-wrecked streetcar is recycled on
  // this same window too, measured from conversion, so the tiny fixed roster can't get stuck
  // "hit but not wrecked" forever).
  wreckLingerSec: 12,
  // Physical mass of a converted streetcar (kg) — 3.0x TRAFFIC_CIV.massKg (1200), matching
  // PLAYER_CARS.redRocket's massFactor 3.0 (config/vehicles.ts) so a rammed streetcar shoves and
  // gets shoved with the same heft the player's own Red Rocket carries.
  massKg: 3600,
  // Settling damping for the freshly-converted dynamic body — higher than TRAFFIC_CIV's 0.4/0.5:
  // a much longer, heavier body tumbling at TRAFFIC_CIV's damping would keep windmilling too
  // long to read as "settling", so this is tuned up for an 11 m slab to come to rest in a
  // believable few seconds instead of pirouetting. Flag in phase notes if it still feels loose.
  dynamicLinDamping: 0.6,
  dynamicAngDamping: 0.8,
  // Conversion kick — same fraction of the player's velocity as TRAFFIC_CIV.convertKickScale;
  // unchanged because the "bolted down" feel it guards against is mass-independent.
  convertKickScale: 0.6,
  // Kinematic yaw slew (rad/s) — much slower than TRAFFIC_CIV's 3.5: "turns like a boat" (TDD
  // §5.9's Red Rocket line) applies to the traffic variant too. A loop corner still resolves,
  // just with a wide, lumbering arc.
  turnRateRadPerSec: 0.9,
  // Warm-up throttle mirrors TRAFFIC_CIV's maxSpawnPerStep, but there are only ever a handful of
  // streetcars total, so this just guards the (rare) all-wrecked-at-once case.
  maxSpawnPerStep: 2,
} as const;
