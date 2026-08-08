// Follow-camera tunables. TDD §5.3.
//
// THE RIG IS LAW (Phase 34, user pick 2026-07-26): yaw 45 / pitch 58 / baseDist 26 / FOV 38 —
// the Phase 33 lab's candidate E, chosen at that phase's USER GATE and pinned field-for-field in
// config/camera.law.test.ts. It supersedes the TDD §5.3 numbers (45/50/18) and the feel pass's
// baseDist 24; the fixed-bearing MODEL is unchanged (no player rotation control, so exactly two
// faces — south + east — of every box are ever visible).
//
// THE CONSTRAINT THAT PICKED IT — the corridor-airspace law, measured live in Phase 33: under the
// 45° yaw the eye only stays inside a street's own airspace while its HORIZONTAL RADIUS
// hr = dist·cos(pitch) stays under a ceiling the STREET sets. Rigs that "clear" by rising above
// the roofline didn't exist when this was written — downtown facades were far taller than any sane
// eye height. E holds hr = 26·cos58 = 13.78 wu; runner-up B sat at 14.84 and went eye-inside on 1
// of 4 measured drives when a wedge angled it into the frontage. Every change to
// pitch/baseDist/speedZoom/tierZoom below is a change to that margin — the law test asserts the
// bound so feel churn can never silently re-break the corridor.
//
// PHASE 76 CORRECTED THIS PARAGRAPH TWICE, and the corrections matter more than the original text:
//   • The ceiling was written here as "~14.8 wu" sourced to the dieted spine's "~10.7 wu" facade
//     offset. Both figures were stale AND mutually inconsistent (10.7·√2 = 15.13, not 14.8). The
//     15.4 wu spine they came from was superseded by Phase 27's road diet SIX PHASES before the
//     Phase 33 lab ran; the width actually live then gave a ceiling of 12.02 wu, so 14.8 was ~23 %
//     MORE PERMISSIVE than the geometry it claimed to state, not conservative. What 14.8 really
//     was: preset B's own hr (28·cos58 = 14.838) rounded down — an EMPIRICAL discriminator fitted
//     to the battery, i.e. the largest bound that still rejects the one rig measured failing.
//   • The bound now lives in world/toronto/corridorLaw.ts, DERIVED per road class from
//     Street.halfWidth + SIDEWALK.widthWu, so a road re-grade moves it. Read that module's header
//     before reasoning about corridor margin here; the excursions the shipped rig knowingly carries
//     are pinned in corridorLaw.test.ts rather than hidden.
//   • FINDING 3 there is the one that reframes this whole block: since Phase 35 capped ordinary
//     streetwall below the resting eye (STREETWALL_MAX_HEIGHT_WU), the eye clears ordinary facades
//     outright and the corridor is a SECONDARY constraint — the eye line is the primary one.
export const CAMERA = {
  // Fixed yaw/pitch — no player rotation control; key to the Smashy look. TDD §5.3.
  yawDeg: 45,
  pitchDeg: 58,
  // Base follow distance (m): 18 (TDD) -> 24 (feel pass) -> 26 (Phase 34 / rig E). Total distance
  // = baseDist + speedZoom·ease + tierZoom·tier; resting eye = 26·sin58 = 22.05 wu.
  baseDist: 26,
  // Vertical field of view (deg). Phase 33 moved this INTO config: it previously existed only as
  // a literal on the <Canvas camera> prop (game/index.tsx), which made a camera candidate
  // impossible to express as data. game/index.tsx now reads CAMERA.fov for the boot camera — but
  // that prop is INITIAL-ONLY, so a live change (this leaf via leva, or a CAMERA_PRESETS apply)
  // must additionally write camera.fov + updateProjectionMatrix() AND relatch fx/cameraRig's
  // FOV-kick base (resetBaseFov). fx/cameraLab.ts's applyCameraPreset is the one path that does
  // all three; tuning this leaf alone in leva changes config without moving the live lens.
  // 38° is rig E's flatten: it buys back the on-screen size the longer follow distance would
  // otherwise cost (26·tan19° = 8.95 of half-frame at the car vs the old rig's 24·tan22.5° =
  // 9.94, so the car actually reads a touch LARGER than before) while compressing canyon depth.
  fov: 38,
  // --- speed/tier framing ramp -------------------------------------------------------------
  // The ramp used to be pure DISTANCE (+10 m eased in with speed). Phase 33 measured what that
  // costs under the corridor law: distance alone grows hr, so the old +10 put the eye at
  // 36·cos58 = 19.08 wu of horizontal radius — inside the streetwall every time the player was
  // fast, which on the spine is most of the time. Phase 34 splits the ramp into a distance term
  // AND a PITCH term, because lifting the eye SHORTENS hr at the same follow distance: the frame
  // still opens up with speed and heat, but it opens upward-and-back instead of purely outward.
  // Both terms ride eases the rig already had (easeSpeedZoom's smoothstep for speed, linear per
  // tier), so nothing about the ramp's continuity changed — only where the extra framing goes.
  // Measured envelope (fx/cameraRig.ts's cameraDistance + cameraPitchOffsetDeg are the two
  // consumers): hr 13.78 at rest/★0, 13.62 at top speed/★0, 14.42 at rest/★5, 13.13 at top
  // speed/★5 — all inside the empirical bound, worst absolute pitch 69.5° at ★5 + top speed (the
  // ~70° vertigo ceiling is the other side of this trade).
  //
  // PHASE 76: those four corners are NOT the envelope's extremes. A dense sweep (201 speeds × 6
  // tiers, pinned in world/toronto/corridorLaw.test.ts) puts the worst hr at 14.4281 — REST at ★4,
  // not the ★5 corner enumerated above (14.4221). hr peaks at ★4 and comes back DOWN at ★5, where
  // tierPitchDeg's shortening finally out-runs tierZoom's lengthening. The magnitude is trivial
  // (0.006 wu) but the shape is not: this ramp is non-monotonic in tier, so anything reasoning
  // about the envelope must SWEEP it rather than sample the ends.
  speedZoom: 4,
  speedPitchDeg: 5,
  tierZoom: 1.5,
  tierPitchDeg: 1.3,
  // Position damped-lerp factor per frame @60fps.
  lerp: 0.08,
  // Look-target leads this many meters along velocity.
  lookAhead: 4,
  // Camera shake (fx/cameraRig.ts). TDD §5.3 ("decaying noise, capped") + §8 (juice pass).
  // Phase 16 evolved the single-bucket trauma model into a PER-SOURCE one: addShake() tags
  // every hit with a source, each source accumulates into its own bucket (capped by
  // sourceCaps below) and decays independently, and the APPLIED amplitude each frame is
  // min(maxAmplitude, sum of the live per-source buckets) — so the overall cap still holds,
  // but each source has its OWN ceiling on how violent it can feel. A frequent, gentle
  // source (a spray of ram nudges) is held well under the budget so it can never build up to
  // feel like a real crash, while a big, rare one (a hard impact, an explosion) is allowed to
  // fill it. Values are feel placeholders, live-tunable via leva.
  shake: {
    // Master kill-switch (feel-tuning pass): false disables ALL applied shake — both the
    // positional jitter offset and the FOV micro-kick — at the application point in
    // fx/cameraRig.ts's updateCameraRig (`suppress`), same gate as reducedShake/death-beat.
    // Trauma still accumulates/decays underneath (untouched), so flipping this back to true
    // resumes exactly where the pre-existing math left off. All other shake values below are
    // left intact so the effect is fully reversible.
    enabled: false,
    // Hard ceiling on the applied jitter (m of peak offset). Unchanged from Phase 3.
    maxAmplitude: 0.5,
    // Linear trauma decay (per second), applied to every per-source bucket.
    decayPerSec: 3,
    // Oscillation rate of the jitter (Hz).
    frequencyHz: 24,
    // Per-source trauma caps (m), each ≤ maxAmplitude. `impact` and `explosion` — the game's
    // headline hits (a hard crash, a blast) — may saturate the FULL budget, matching the
    // pre-Phase-16 single-bucket feel for the common damage-shake path (combat/damage.ts
    // relies on a threshold-band impact reaching its raw trauma un-clamped up to the cap).
    // `ram` and `generic` sit lower so those gentler, more frequent sources LAYER onto a hit
    // rather than dominate it or stack up into crash-grade shake on their own.
    sourceCaps: {
      impact: 0.5,
      explosion: 0.5,
      ram: 0.3,
      generic: 0.4,
    },
    // FOV micro-kick on hard impacts (§8 "punch"): a hard collision briefly widens the FOV
    // a few degrees, snapping back over ~150 ms — a cheap, readable "hit" flourish the
    // positional jitter alone can't give. Armed ONLY by addShake(..., 'impact') at/above
    // minStrength (so light taps and non-impact sources never kick the lens). Suppressed
    // wholesale under reducedShake and during the death beat (fx/cameraRig.ts), same as the
    // positional shake. All degrees of FOV, not meters.
    fovKick: {
      // Impact trauma below this doesn't kick the lens at all (skip trivial contacts).
      minStrength: 0.3,
      // Degrees of FOV kick added per unit of impact strength (before the maxDeg cap).
      strengthToDeg: 5,
      // Cap on the FOV kick (deg) — "a few degrees", TDD §8.
      maxDeg: 4,
      // Linear decay (deg/sec). 4 / 27 ≈ 0.148 s from a full kick back to rest (~150 ms).
      decayPerSec: 27,
    },
  },
  // WRECKED death beat (combat/runLoop.ts calls fx/cameraRig.ts's setDeathPullback(true),
  // TDD §5.10 "brief ... camera pull-back"): extra follow-distance (m) added on top of the
  // normal base/speed/tier zoom while the lock window is active. 6 (Phase 9) -> 8 (Phase 16,
  // a more deliberate move once the beat's shake was suppressed) -> 5 (Phase 34): at pitch 58
  // the corridor law left only ~2 m of pure-distance headroom (14.8/cos58 = 27.93 vs a base
  // of 26), so the old +8 pushed hr to 16.48 wu and put the eye in the streetwall for the one
  // moment the player is guaranteed to be watching. 5 m paired with the +4° lift below lands
  // hr 14.56 — the beat still steps visibly back, it just steps UP as it does.
  //   PHASE 76 — THE ARITHMETIC ABOVE IS STALE, THE VALUE IS KEPT ANYWAY. `14.8/cos58` divided the
  //   empirical discriminator (preset B's hr, not a street measurement) by the base pitch, so the
  //   "~2 m of headroom" was never the geometric statement it reads as. Under the Phase 75 widths
  //   the centreline ceiling of the class the grid is mostly made of (major) is 16.69 wu, i.e.
  //   16.69/cos58 = 31.5 of distance — the old +8 would clear it now. The value stays 5 because it
  //   was ALSO tuned on how the beat reads (a step back that steps up), not on margin alone; if a
  //   later phase wants the bigger pull-back back, it is a feel decision with room to make it, and
  //   corridorLaw.ts is where the real margin is computed.
  deathPullback: 5,
  // Cinematic death-beat framing (Phase 16, fx/cameraRig.ts). The beat eases in over
  // `easeInSec`; WRECKED pulls BACK and lifts slightly, BUSTED converges IN and LOWER
  // toward the arrest — two distinct, deliberate camera moves off the same lock window.
  // The gentle yaw drift is the fixed-yaw model's one sanctioned exception, and only during
  // the death beat. These are OFFSETS on the live framing, so they compose on top of the
  // speed/tier ramp above — a death at ★4 is already pitched up before the beat adds its own.
  cinematic: {
    // Seconds to ease the orbit/pitch offsets to full (the pull-back distance itself is
    // smoothed by the normal position lerp, so it needs no separate ease here).
    easeInSec: 0.9,
    // Gentle orbit (deg of yaw drift) eased in over the beat — a slight drift, not a spin.
    // 8 -> 10 in Phase 34: the swept WORLD arc is dist·cos(pitch)·Δyaw, and the higher pitch
    // shrinks that cos term ~11% against the old rig, so the drift needed a couple more degrees
    // to sweep the same amount of city.
    orbitYawDeg: 10,
    // WRECKED: a touch of extra downward look (deg of pitch, + = higher/more top-down) as
    // the camera pulls back — reads as "stepping back to survey the wreck". 3 -> 4 buys the
    // shortened pull-back (above) its corridor margin without tipping toward top-down flat.
    wreckedPitchOffsetDeg: 4,
    // BUSTED: pull the camera IN (negative = closer than the WRECKED pull-back — a tighter
    // frame) and LOWER (negative pitch = nearer the horizon) toward the surrounded car.
    // The -14 was sized against pitch 50 to land the arrest at ~36° absolute; from 58 it landed
    // at 44° and the low-angle identity was gone, so Phase 34 deepened it to -22 — 36° at ★0,
    // 38.6-39.9° at the ★2-★3 tiers a bust actually happens on. A low angle is inherently
    // wide (hr = dist·cos(36°) is 0.81·dist), so the converge was deepened -4 -> -8 to buy
    // back what the pitch spends: ★0 lands hr 14.56, inside the corridor. Higher tiers add
    // distance faster than the arrest angle can absorb (★2 16.4, ★5 18.8) — a deliberate,
    // measured cinematic excursion, and Phase 36's anti-clip is where it gets covered.
    bustedPullback: -8,
    bustedPitchOffsetDeg: -22,
  },
  // --- Phase 36: occlusion v2 boresight probe ------------------------------------------------
  // The occlusion pass no longer casts ONE ray at the car's centre. A single centre ray answers
  // "is the car's origin hidden?", but the failure players actually see is a wall grazing the
  // FRAME — the car's near corner disappearing behind a streetwall corner while its centre stays
  // clear (P35's census: 187/1268 frames had exactly that shape). So the pass casts five segments
  // from the eye: one to the car centre and four to the corners of a small box around the car.
  //
  // The box is deliberately YAW-INVARIANT (a square in XZ, not the car's oriented footprint):
  // reading the chassis' heading every frame would make the probe rotate — and therefore make a
  // grazing wall pop in and out of the hit set — as the car drifts, which is the strobe the
  // hysteresis hold exists to kill. A circumscribed square costs a few false positives at 45°
  // headings, and a false positive fades a wall that was nearly occluding anyway; a false negative
  // hides the car, which A.5 forbids. The asymmetry decides the trade.
  //
  // Values are the Rusty-Sedan reference chassis (config/vehicles.ts VEHICLE_TUNING.chassis:
  // halfWidth 0.9 / halfHeight 0.35 / halfLength 2.0) rather than a live read of the selected
  // car — a probe that changed size per garage pick would make the occlusion battery
  // un-comparable between runs, and the six cars differ by well under a metre.
  occlusionProbe: {
    /** XZ half-extent (m) of the yaw-invariant square whose corners are probed = chassis halfLength. */
    xzM: 2,
    /** Lower probe height (m, relative to the car's render origin) = the collider floor / sill line. */
    lowM: -0.35,
    /** Upper probe height (m, relative to the car's render origin) ≈ a pack car's roofline. The
     * collider box stops at +0.35, but the visible body (and therefore what a wall can hide) goes
     * higher; under a 58° pitch the high corners are the ones a streetwall crosses first. */
    highM: 0.9,
  },
  // --- Phase 36: camera anti-clip (last-resort eye guard) --------------------------------------
  // The primary defences against "the camera phases through a building" are the eye-line law
  // (CAMERA_EYE_MIN_WU below + config/cityPackScale.ts's streetwall cap) and the corridor-airspace
  // margin the rig itself was picked on. Both are STATIC guarantees about normal play. This block
  // covers what they deliberately do not: the death beat's measured excursions (BUSTED drops the
  // eye below EYE_MIN by design — see `cinematic` above), a respawn beside a tower, and any future
  // geometry that slips past the law. world/toronto/cameraAntiClip.ts is the solver; it pulls the
  // eye along the boresight TOWARD the car until it is clear, and never pushes it back out (the
  // rig's own damping does that, smoothly, for free).
  antiClip: {
    /** How far (m) outside every building volume the eye must be before it counts as clear. A
     * lens flush with a facade already looks broken, so the guard trips slightly early. */
    marginWu: 0.5,
    /** Hard cap (m) on the pull. Sized to cover the deepest ESCAPE the shipped map can demand,
     * not to keep the frame wide: the fattest street-facing towers (Aura's face sits ON Yonge)
     * can swallow the eye ~8–9 wu deep on an ordinary drive-by, and the boresight's exit from
     * such a box runs ~23–25 m (the Phase 36 drive census caught exactly this: 44 frames of
     * eye-inside-Aura with near-plane slicing under an earlier 14 m cap — the solver found no
     * clear point within the cap and declined, which read far worse than the resulting close-up
     * does). 25 keeps the law-pinned `maxPullM < baseDist` headroom; a deep pull is a brief
     * spring-arm close-up the rig's own lerp releases smoothly. The residual (a slice so deep
     * even 25 m finds no clear point — solver returns 0, eye stays put) is documented in the
     * Phase 36 notes for Phase 38's debt sweep. */
    maxPullM: 25,
    /** Rate cap (m/s) on how fast the pull may GROW. A wall the eye enters side-on can need most
     * of maxPullM in a single frame; ramping it over ~0.5 s reads as a spring arm, not a cut.
     * (The release direction is rate-limited too — by the rig's own position lerp, since this
     * guard never pushes outward.) */
    slewMPerSec: 30,
    /** Sample spacing (m) along the boresight when searching for the first clear point. 0.5 m is
     * well under the smallest indexed building footprint, so the search cannot step over a whole
     * volume, and caps the search at maxPullM/0.5 = 28 point queries — paid ONLY on frames the
     * eye is actually inside something (the clear fast path is a single query). */
    probeStepM: 0.5,
  },
} as const;

// --- THE ONE TRUE EYE LINE (Phase 35) ---------------------------------------------------------
// Every "how tall may a building be before the camera phases through it?" question in the codebase
// resolves HERE, and nowhere else. Phases 19-25.7 all cited a "~13.8/15 wu camera wall" — that
// number was derived from the long-dead baseDist 18 of the TDD rig, survived two retunes by being
// copied between comments rather than computed, and was still being quoted (placesLayer.ts, the
// notes) after the feel pass had already moved the eye to 20+ wu. It is now DELETED, not corrected:
// the two constants below are computed from the CAMERA leaves above, so a rig change moves them and
// no comment can go stale again.
//
// WHAT THEY MEAN. The eye rides a sphere of radius `dist` around the car at absolute pitch θ, so
// its height above the car's ground plane is dist·sin(θ) — nothing more subtle than that. EYE_MIN
// is the RESTING height (parked, ★0: the lowest the eye ever sits in normal play, since both halves
// of the framing ramp only ever ADD distance and pitch); EYE_MAX is the top of that envelope
// (top speed, ★5). Together they bracket the band that ordinary geometry must stay out of.
//
// HOW THE WORLD USES THEM (the eye-line law, pinned in world/toronto/heightLaw.test.ts): ordinary
// streetwall/filler stays BELOW EYE_MIN, so the eye clears its roofline at every point in the
// envelope; only a counted, listed intentional-tall set (the three tower districts' filler, the
// backdrop-tower row, the named landmark towers, the heroes) is allowed to cross. Crossing is not
// forbidden — it is the skyline — it just makes a mesh an occluder, which is why that list is
// Phase 36's occlusion work order rather than a bug list. config/cityPackScale.ts enforces the same
// bound on pack building scale (STREETWALL_MAX_HEIGHT_WU) so an art-scale change can't smuggle a
// 24 wu facade into the streetwall the way brown-building did before this phase.
//
// WHAT THEY ARE NOT:
//  • NOT the death-beat envelope. The cinematic offsets (esp. BUSTED's -22° pitch, which LOWERS the
//    eye toward an arrest angle) drop below EYE_MIN by design. Those are documented, measured
//    excursions on a 1-2 s scripted beat, covered by Phase 36's anti-clip — the streetwall law is
//    about normal play and deliberately does not try to also be the beat's law.
//  • NOT rig E's 13.78 wu HORIZONTAL RADIUS (dist·cos θ, the corridor-airspace quantity in
//    camera.law.test.ts). The coincidence that the stale wall number and the corridor radius are
//    both "13.8" is exactly how the stale doctrine survived so long. Different axis, different law.
const DEG2RAD = Math.PI / 180;

/** Resting camera-eye height above the car (wu): parked, ★0 — the LOWEST eye in normal play, and
 * therefore the ceiling ordinary streetwall must stay under. 26·sin58° = 22.05. */
export const CAMERA_EYE_MIN_WU = CAMERA.baseDist * Math.sin(CAMERA.pitchDeg * DEG2RAD);

/** The top wanted tier (★5) — how many tier steps the framing ramp can add. Hoisted at Phase 75 so
 * the two "both halves of the ramp saturated" expressions below share one statement of it, and
 * EXPORTED at Phase 76 so the lab's per-candidate saturated-pose arithmetic (fx/cameraLab.ts's
 * presetPitchMaxDeg) evaluates the ramp at the same top-of-envelope tier the constants below do,
 * rather than restating a 5. */
export const MAX_WANTED_TIER = 5;

/** Absolute camera pitch (deg) at the TOP of the normal-play framing ramp — top speed at ★5, i.e.
 * the same pose CAMERA_EYE_MAX_WU is measured at. 58 + 5 + 5·1.3 = 69.5. */
export const CAMERA_PITCH_MAX_DEG = CAMERA.pitchDeg + CAMERA.speedPitchDeg + MAX_WANTED_TIER * CAMERA.tierPitchDeg;

/** Top of the normal-play eye envelope (wu): top speed at ★5, i.e. both halves of the framing ramp
 * saturated — distance (baseDist + speedZoom + 5·tierZoom) at pitch (pitchDeg + speedPitchDeg +
 * 5·tierPitchDeg). 37.5·sin69.5° = 35.13. Anything between EYE_MIN and this is inside the band the
 * eye sweeps as the player gets fast and hot. */
export const CAMERA_EYE_MAX_WU =
  (CAMERA.baseDist + CAMERA.speedZoom + MAX_WANTED_TIER * CAMERA.tierZoom) * Math.sin(CAMERA_PITCH_MAX_DEG * DEG2RAD);

/**
 * PHASE 75 — THE VISIBLE GROUND BAND, made computable.
 *
 * Depth (wu, measured ALONG the camera's boresight on the ground plane) of the strip of ground the
 * frame actually shows, for an eye `eyeWu` above the car's ground plane at absolute pitch
 * `absPitchDeg`: where the frustum's TOP edge meets y = 0, less where its BOTTOM edge does. Both
 * edges are below the horizon at every legal pose (the shallowest is pitchDeg − fov/2 = 39°), which
 * is Phase 38's measured finding stated as geometry: **no sky, no horizon, ever in frame**, so the
 * band is finite and the arithmetic below never divides through zero.
 *
 * Phase 38 measured this band at 27–29 wu in play and filed it as a verbal law ("the visible-band
 * law"). It is a pure function of the CAMERA leaves, so it is expressed here instead — a rig change
 * moves it and no comment can go stale.
 */
export function cameraGroundBandWu(eyeWu: number, absPitchDeg: number): number {
  const top = (absPitchDeg - CAMERA.fov / 2) * DEG2RAD;
  const bottom = (absPitchDeg + CAMERA.fov / 2) * DEG2RAD;
  return eyeWu / Math.tan(top) - eyeWu / Math.tan(bottom);
}

/**
 * The DEEPEST that band ever gets inside the normal-play eye envelope (wu) — 28.04, at top
 * speed/★5. Evaluated at both ENDS of the envelope rather than assumed monotonic: the ramp raises
 * the eye (deeper band) and steepens the pitch (shallower band) at the same time, so which end wins
 * is a fact about the tuned leaves, not a given. Rest = 22.14, saturated = 28.04.
 *
 * Consumers use it as "how much ground is on screen at once" — Phase 75's median planting derives
 * its pitch from it so no two planters can share a frame (config/torontoDress.ts's MEDIAN_PLANTING).
 */
export const CAMERA_GROUND_BAND_MAX_WU = Math.max(
  cameraGroundBandWu(CAMERA_EYE_MIN_WU, CAMERA.pitchDeg),
  cameraGroundBandWu(CAMERA_EYE_MAX_WU, CAMERA_PITCH_MAX_DEG),
);

// --- Camera lab: candidate rigs (kept for re-comparison, NOT re-applied on boot) ---------------
// Rows A-E are Phase 33's; rows F-L are Phase 76's (see their own block below). The table is
// APPEND-ONLY so a historic id keeps meaning what it meant in the evidence tree that used it.
//
// The Part-9 user directive re-opened the "Camera bearing: FIXED" lock: the camera phased through
// buildings (pack streetwall facades ≈ 19.4 wu vs the old rig's resting eye of 24·sin50° =
// 18.39 wu). Those five candidates were the evidence apparatus for that decision, applied LIVE by
// fx/cameraLab.ts (dev-only) and judged at the Phase 33 USER GATE. Phase 34 promoted the pick (E)
// into CAMERA above and pinned it as §5.3 law — the identity invariant lives on preset E
// (cameraLab.test.ts), not on this table being touched. The table itself STAYS: it's the lab's
// re-comparison harness for P35 (height re-grade) and P36 (occlusion v2), both of which may want
// to re-run the gate against a changed city. Nothing here changes a shipped frame on its own —
// CAMERA is untouched until applyCameraPreset() writes into it.
//
// Every preset keeps the fixed-bearing MODEL (no player rotation control): yaw may take a
// different VALUE, but it never tracks the car during play. Presets deliberately carry only the
// four geometry leaves that define a rig — yaw/pitch/distance/lens; speedZoom, tierZoom,
// speedPitchDeg, tierPitchDeg, lerp and lookAhead stay SHARED (they are feel, not framing, and
// Phase 34 retuned them once — including splitting the ramp into distance AND pitch terms —
// against the winning geometry, rather than five times here).
//
// PHASE 76 AMENDS THAT, narrowly. Sharing the ramp is still the DEFAULT and still the reason
// A-E are comparable at all, but it stopped being expressible: a candidate whose BASE pitch is
// 66-68 saturates the shipped +11.5° pitch ramp at 77.5-79.5° absolute, well past the ~70°
// vertigo ceiling this file records at `speedPitchDeg` — i.e. that candidate cannot legally be
// DRIVEN, and a battery that drives it anyway is shooting footage of a rig nobody would ship.
// So a preset may now declare `shared: {…}` overrides on exactly those leaves. Absent fields are
// not "left alone" — fx/cameraLab.ts's applyCameraPreset writes a FULLY RESOLVED leaf set every
// time (override ?? CAMERA_SHARED_LEAF_DEFAULTS), so switching off an overriding candidate
// restores the shipped ramp by construction rather than by remembering to. The alternative — a
// restore list maintained alongside the override list — is the single defect that would silently
// invalidate the whole phase's evidence, so it is designed out rather than tested for.

/** The leaves a preset does NOT define as geometry: the speed/tier framing ramp, the look-target
 * lead, and the damping. Ordinarily shared across every candidate (see the block above); a
 * candidate may override any subset via `CameraPreset.shared`. This tuple is the single key set —
 * both the override vocabulary AND the write loop's iteration order — so a leaf can never be
 * overridable-but-unrestored. */
export const CAMERA_SHARED_LEAF_KEYS = [
  'speedZoom',
  'speedPitchDeg',
  'tierZoom',
  'tierPitchDeg',
  'lookAhead',
  'lerp',
] as const;

export type CameraSharedLeaf = (typeof CAMERA_SHARED_LEAF_KEYS)[number];

/** The shipped value of every shared leaf, snapshotted at MODULE INIT — before any preset apply
 * or leva write can reach the runtime-mutable CAMERA block. This is what a non-overriding preset
 * restores. Typed `Record<CameraSharedLeaf, number>` on purpose: adding a key to the tuple above
 * without adding it here is a compile error, and a key that isn't a real CAMERA leaf can't be
 * initialised at all — the two failure modes a hand-maintained restore list has.
 *
 * KNOWN, DELIBERATE BEHAVIOUR CHANGE: before Phase 76 a preset apply never touched these, so a
 * leva tweak to (say) speedZoom survived a preset switch. It no longer does — the preset defines
 * the whole rig. Determinism across a battery beats preserving a mid-session slider. */
export const CAMERA_SHARED_LEAF_DEFAULTS: Readonly<Record<CameraSharedLeaf, number>> = {
  speedZoom: CAMERA.speedZoom,
  speedPitchDeg: CAMERA.speedPitchDeg,
  tierZoom: CAMERA.tierZoom,
  tierPitchDeg: CAMERA.tierPitchDeg,
  lookAhead: CAMERA.lookAhead,
  lerp: CAMERA.lerp,
};

/** A candidate's per-preset overrides of the shared leaves. Every field optional; an absent field
 * resolves to CAMERA_SHARED_LEAF_DEFAULTS, never to "whatever the last preset left behind". */
export type CameraSharedOverrides = { readonly [K in CameraSharedLeaf]?: number };

/** Preset D's spring-arm ("canyon-aware") tunables. The arm reads the Phase-33 static building
 * AABB index (world/toronto/cameraClipIndex.ts) rather than physics raycasts — deterministic, no
 * physics cost, and the same index the clip instrumentation samples. */
export interface CameraSpringArmConfig {
  /** Max pitch the arm may ADD (deg, + = higher/more top-down) when the near field is blocked. */
  readonly maxPitchLiftDeg: number;
  /** Max follow distance the arm may REMOVE (m) when the near field is blocked. */
  readonly maxPullInM: number;
  /** Seconds for a full 0 → cap traversal (both axes rate-limit at cap/easeSec per second). */
  readonly easeSec: number;
  /** The near field must read CLEAR continuously for this long before the arm releases —
   * hysteresis, so grazing a corner can't strobe the framing (the flashing complaint reborn). */
  readonly clearHoldSec: number;
  /** Length (m) of the boresight probe ahead of the eye. Only occluders THIS close to the lens
   * count as "near field" — the whole eye→car segment is blocked constantly in a dense streetwall
   * (a corner building between camera and car is the normal case), which would leave the arm
   * permanently lifted and stop being a canyon RESPONSE. */
  readonly probeAheadM: number;
}

export interface CameraPreset {
  readonly id: string;
  readonly label: string;
  readonly yawDeg: number;
  readonly pitchDeg: number;
  readonly baseDist: number;
  readonly fov: number;
  /** Present only on candidates that run a dynamic arm (D). */
  readonly springArm?: CameraSpringArmConfig;
  /** Phase 76: per-preset overrides of the otherwise-shared ramp/lead/damping leaves. Present only
   * on candidates whose base geometry forces a ramp re-grade (H/I/J) or that exist to isolate one
   * of these leaves (K). Absent = the shipped values, restored on every apply. */
  readonly shared?: CameraSharedOverrides;
}

export const CAMERA_PRESETS = [
  {
    // The Phase-33 lab's baseline CONTROL — the pre-P34 shipped rig (45/50/24/45), kept exactly
    // as it was so P35/P36 can still ask "does the new geometry read better than what shipped
    // before adoption?". It no longer equals CAMERA above (that identity moved to preset E at
    // adoption — see E's comment below) and carries no test-locked invariant of its own; it's
    // history, not a fallback.
    id: 'A',
    label: 'A · pre-P34 status quo',
    yawDeg: 45,
    pitchDeg: 50,
    baseDist: 24,
    fov: 45,
  },
  {
    // More top-down (closer to actual Smashy Road): the resting eye rises 18.39 → 23.75 wu, which
    // clears the 19.4 wu pack streetwall outright. Costs facade obliqueness — fascia/CROWN decals
    // are read at a steeper angle.
    id: 'B',
    label: 'B · high table',
    yawDeg: 45,
    pitchDeg: 58,
    baseDist: 28,
    fov: 45,
  },
  {
    // Telephoto flatten: distance buys the clearance (eye 26.81 wu) and the narrow lens keeps the
    // car the same size on screen. Compresses canyon depth — the city reads flatter/more diorama.
    id: 'C',
    label: 'C · long lens',
    yawDeg: 45,
    pitchDeg: 50,
    baseDist: 35,
    fov: 31,
  },
  {
    // A's framing in the open, with an arm that lifts/pulls in only when the near field is
    // blocked. Prototype-grade this phase: the most complex to tune and the easiest to make
    // strobe, but the only candidate that costs nothing in the 90% of the map that is open road.
    id: 'D',
    label: 'D · canyon-aware',
    yawDeg: 45,
    pitchDeg: 50,
    baseDist: 24,
    fov: 45,
    springArm: {
      maxPitchLiftDeg: 12,
      maxPullInM: 6,
      easeSec: 0.25,
      clearHoldSec: 0.3,
      // 8 m ≈ the distance the lens closes in ~0.2 s of hard cornering, so the arm starts moving
      // before a facade reaches the near plane, while ordinary streetwall 20 m out never trips it.
      probeAheadM: 8,
    },
  },
  {
    // THIS IS THE SHIPPED RIG (Phase 33 USER GATE pick, 2026-07-26; promoted into CAMERA above at
    // Phase 34 — that block is the LAW copy, this row is kept only so the table stays a complete,
    // re-runnable comparison set for P35/P36). Discovered live in the Phase 33 lab session. The
    // part file's worked example (54/28/38, eye 22.65) AND a 56° variant both FAILED the
    // fold-corridor rest test on the boresight counter (eye outside the flanking building, car
    // 100% hidden behind the streetwall). Root geometry, AS RECORDED that session: on the dieted
    // spine (15.4 road + 3 sidewalk) the streetwall face plane sits ~10.7 wu off the centreline,
    // so any rig with horizontal radius dist·cos(pitch) > ~14.8 (i.e. >10.7 per axis under the
    // 45° yaw) parks the eye inside or behind the east frontage — B clears NOT by seeing over
    // roofs but by keeping its eye inside the canyon airspace.
    //   [P76 ANNOTATION — the sentence above is preserved as the historical record and is WRONG on
    //   its numbers. 15.4 was the Phase 25.6 spine; Phase 27's diet had already cut it to 11.0 six
    //   phases earlier, giving a real ceiling of 12.02 wu — which E's 13.78 EXCEEDED while measuring
    //   0.0 % eye-inside, and that contradiction is what led Phase 76 to the actual explanation
    //   (Phase 35's streetwall cap, corridorLaw.ts FINDING 3). The DECISION E records is unaffected:
    //   it was made on measured battery evidence, not on this arithmetic.]
    // E adopts B's corridor-safe envelope
    // one step tighter (58/26 → eye 22.05, horizontal 13.78 — ~1 wu of extra margin) and keeps its
    // narrower 38° lens as the flatten. Identity vs B: closer, calmer perspective; same clearance
    // class. CAMERA_PRESETS's own identity test (cameraLab.test.ts) pins this row against CAMERA
    // field-for-field — if the two ever diverge, the test catches it, not this comment.
    id: 'E',
    label: 'E · combo (shipped)',
    yawDeg: 45,
    pitchDeg: 58,
    baseDist: 26,
    fov: 38,
  },

  // === PHASE 76 CANDIDATES (F-L) ================================================================
  // Phase 75 doubled every road width, which re-opens the decision Phase 33/34 settled: the
  // corridor-airspace ceiling that ELIMINATED every rig above hr ~14.8 is a property of the street,
  // and the street changed. CLAUDE.md's camera block schedules this re-open explicitly. These seven
  // rows (plus E as the control) are the evidence apparatus; the shipped CAMERA is untouched until
  // the user picks at the Phase 76 USER GATE.
  //
  // YAW IS NOT A FREE VARIABLE IN ANY OF THEM — a DECISION, not an oversight. The visible-face pin
  // (south + east) is a pure function of yaw and is baked into six placement sites map-wide
  // (namedBuildings.ts, venueDress.ts, frontage.ts, infill.ts, TorontoScene's SignBoard,
  // routeBoardAtlas.ts). Moving it would re-cut every decal on the map for zero readability gain.
  //
  // REST GEOMETRY, for the table below (eye = dist·sin p, hr = dist·cos p; half-frame at the car =
  // dist·tan(fov/2), i.e. how big the car reads):
  //   id  pitch dist fov |  eye     hr    half-frame | streetwall cap (eye − 1.0) | cap binds?
  //   E     58   26   38 | 22.05  13.78     8.95     |        21.05               | YES
  //   F     58   34   38 | 28.83  18.02    11.71     |        27.83               | no
  //   G     58   26   50 | 22.05  13.78    12.12     |        21.05               | YES
  //   H     66   32   44 | 29.23  13.02    12.93     |        28.23               | no
  //   I     68   36   44 | 33.38  13.49    14.54     |        32.38               | no
  //   J     66   32   44 | 29.23  13.02    12.93     |        28.23               | no
  //   K     58   26   38 | 22.05  13.78     8.95     |        21.05               | YES
  //   L     52   30   46 | 23.64  18.47    12.73     |        22.64               | YES
  //
  // THE CAP COLUMN IS A HEADLINE, NOT A FOOTNOTE (plan §3c). config/cityPackScale.ts's
  // STREETWALL_MAX_HEIGHT_WU is DERIVED from the resting eye (eye − STREETWALL_EYE_MARGIN_WU) and
  // today binds on `brown-building` alone, pulling its natural 24.19 wu frontage-target height down
  // to 21.05 as ordinary streetwall in 12 of 15 districts. Any candidate whose cap clears 24.19
  // UN-BINDS it and the streetwall grows ~3.1 wu across most of the city — plausibly the fix for
  // "there is no city in the frame", and definitely a re-massing the user must be told about before
  // choosing. F/H/I/J un-bind it; E/G/K/L do not (L raises the cap 1.59 wu but still binds).
  // fx/cameraLab.ts's presetStreetwallCap() computes this per preset off the live manifest.
  {
    // PURE DISTANCE — the obvious way to spend the new headroom, and the control for "did the
    // corridor actually open?". Identical to E in every other respect, so any difference is
    // attributable to the 8 m. hr 13.78 → 18.02 is the largest single-step radius increase in the
    // table; on the centreline-referenced post-P75 ceilings that is legal on spine (19.80) and
    // artery (18.24) and illegal on major (16.69) / minor (13.58) — pre-P75 it would have been
    // illegal on all four, which IS the headroom, stated as a candidate.
    id: 'F',
    label: 'F · pulled-back E',
    yawDeg: 45,
    pitchDeg: 58,
    baseDist: 34,
    fov: 38,
  },
  {
    // FOV IS FREE. The lens changes NOTHING about where the eye sits — hr and eye are identical to
    // E to the last digit — so G costs exactly zero corridor margin while taking the visible ground
    // band from 22.14 to 31.25 wu at rest (+41%). If the phase's complaint is "no city in frame",
    // this is the cheapest possible answer and the one candidate that cannot be wrong for
    // geometric reasons. Its risk is a rendering one, not a camera one: fov 50 pulls the largest
    // frustum ever measured on this map, so T4's low-tier bench (98-99.5% of budget at P47) is the
    // gate it has to clear, ×3 runs.
    id: 'G',
    label: 'G · wide-lens E',
    yawDeg: 45,
    pitchDeg: 58,
    baseDist: 26,
    fov: 50,
  },
  {
    // THE "PITCH BUYS DISTANCE" THESIS, and the headline candidate. 23% more follow distance than E
    // at a SHORTER horizontal radius (13.02 vs 13.78) — strictly safer on every road class
    // including minors, while the eye rises 22.05 → 29.23 and the ground band 22.14 → 29.25 wu.
    //
    // RAMP OVERRIDE — FORCED, and the reason CameraPreset.shared exists. The shipped ramp adds
    // speedPitchDeg 5 + 5·tierPitchDeg 1.3 = +11.5° at the top of the envelope; from a base of 66
    // that saturates at 77.5° absolute, 7.5° past the ~70° vertigo ceiling. H is therefore
    // UNDRIVEABLE on the shipped ramp and its drive/chase evidence would be footage of a pose no
    // shipped rig could hold. The override re-grades the PITCH terms only and leaves the DISTANCE
    // terms (speedZoom 4, tierZoom 1.5) exactly as shipped, so H-vs-E stays a single-variable
    // comparison of base geometry rather than a second, confounded ramp change.
    //   ARITHMETIC. Target the saturated absolute pitch at 69.5° — the shipped rig's OWN saturated
    //   pose (58 + 5 + 6.5), so every candidate in the table tops out at the same vertigo-adjacent
    //   pitch and pitch differences between candidates are purely differences of BASE.
    //     headroom = 69.5 − 66 = 3.5°, split in the shipped 5 : 6.5 speed:tier ratio
    //     → speed 3.5·(5/11.5) = 1.52 ≈ 1.5 ; tier 3.5·(6.5/11.5) = 1.98 over 5 steps ≈ 0.4
    //     → 66 + 1.5 + 5·0.4 = 69.5 EXACTLY.
    //   MEASURED COST, reported not tuned away: with the distance ramp intact H saturates at
    //   dist 43.5 / hr 15.23 — WIDER than it rests, the opposite of E (which saturates at 13.13,
    //   narrower than its 13.78 rest, because E's pitch ramp is huge relative to its distance
    //   ramp). E is the all-class-legal rig at saturation; H is spine/artery/major. That is a real
    //   trade the battery should measure, not a number to pre-empt in config.
    id: 'H',
    label: 'H · high table',
    yawDeg: 45,
    pitchDeg: 66,
    baseDist: 32,
    fov: 44,
    shared: { speedPitchDeg: 1.5, tierPitchDeg: 0.4 },
  },
  {
    // H PUSHED TO THE VERTIGO EDGE: base pitch 68 is 2° off the ceiling before the ramp adds
    // anything, and the eye reaches 33.38 wu — higher than the shipped rig's SATURATED eye (35.13)
    // sits at rest. Included to bracket H from above: if I reads as a map screen rather than a
    // driving game, H is the right side of the line; if it doesn't, the ceiling is soft and worth
    // re-opening. Same forced ramp re-grade as H, same 69.5° target:
    //     headroom = 69.5 − 68 = 1.5°, in the 5 : 6.5 ratio → speed 0.65 ≈ 0.6 ; tier 0.85/5 = 0.17
    //     → rounded to 0.18 so it lands exact: 68 + 0.6 + 5·0.18 = 69.5 EXACTLY.
    // Saturated: dist 47.5 / hr 16.63 (spine/artery/major legal, minor not).
    id: 'I',
    label: 'I · high table, far',
    yawDeg: 45,
    pitchDeg: 68,
    baseDist: 36,
    fov: 44,
    shared: { speedPitchDeg: 0.6, tierPitchDeg: 0.18 },
  },
  {
    // SPEED-ADAPTIVE H — H's geometry with a DOUBLED distance ramp, and nothing else changed. The
    // pitch overrides are byte-identical to H's, so H-vs-J isolates exactly one leaf: how much the
    // frame opens when you are moving. That is the question a 60-second drive answers and a still
    // cannot.
    //   speedZoom 4 → 8. The pre-Phase-34 ramp was +10 m of PURE distance and Phase 34 cut it to 4
    //   because at base pitch 58 the extra radius put the eye in the streetwall (36·cos58 = 19.08).
    //   From base pitch 66 the same metres cost far less radius, which is the point: saturated
    //   dist 47.5 at pitch 69.5 → hr 16.63, the same radius I reaches from a much longer base.
    //   8 rather than 10 keeps the car readable — half-frame at the car grows 12.93 → 19.19 wu at
    //   saturation, already a ~33% shrink on screen; +10 would make it ~40%.
    id: 'J',
    label: 'J · speed-adaptive H',
    yawDeg: 45,
    pitchDeg: 66,
    baseDist: 32,
    fov: 44,
    shared: { speedZoom: 8, speedPitchDeg: 1.5, tierPitchDeg: 0.4 },
  },
  {
    // THE RIG-INDEPENDENT AXIS. Geometrically E to the last digit — same eye, same hr, same lens,
    // same streetwall cap — so anything K reads differently is attributable to the look TARGET,
    // not the rig. `lookAhead` 4 → 8 (exactly double, so the delta is one crisp statement) is the
    // whole change; fx/cameraRig.ts's computeLookTarget already scales the lead by
    // easeSpeedZoom(speed), so this needed ZERO rig code.
    //   WHAT 8 m COSTS ON SCREEN: the lead is along the horizontal velocity, and a horizontal
    //   metre aligned with the boresight projects onto the view plane at sin(58°) = 0.848, so at
    //   top speed the car sits 8·0.848 = 6.8 wu below frame centre against a half-frame of 8.95 —
    //   ~76% of the way to the bottom edge, and ~49% at a realistic 60%-of-top-speed cruise
    //   (smoothstep ease = 0.648). Deliberately near the limit: a candidate whose effect is subtle
    //   teaches the gate nothing, and the answer "the axis works, dial it to 6" is available.
    //   MEASUREMENT-VALIDITY WARNING for T4: computeLookTarget collapses the lead below
    //   SPEED_EPSILON, so K IS BIT-IDENTICAL TO E ON EVERY STILL. It must be judged on drives, and
    //   the contact sheet has to say so or the user will read identical stills as "no effect".
    id: 'K',
    label: 'K · E + look-ahead',
    yawDeg: 45,
    pitchDeg: 58,
    baseDist: 26,
    fov: 38,
    shared: { lookAhead: 8 },
  },
  {
    // THE DELIBERATE COUNTER-EXAMPLE, included BECAUSE it is expected to fail. Buying maximum
    // city-in-frame the naive way — drop the pitch, widen the lens, add distance — gives the
    // biggest resting ground band in the table by a distance (36.31 wu, +64% on E) and the most
    // oblique, most "city-like" facades. It also puts hr at 18.47 at REST, legal on the spine
    // (19.80) and nothing else, and its low pitch means the ramp barely helps (saturating at
    // 63.5° / hr 18.52). If the user is going to trade corridor safety for city, they should see
    // the trade photographed rather than be told it exists.
    // Note it does NOT un-bind the streetwall cap (22.64 vs brown-building's 24.19) — a lower,
    // wider rig raises the cap far less than a higher one, so "more city in frame" and "taller
    // streetwall allowed" pull in opposite directions here. That tension is worth showing.
    id: 'L',
    label: 'L · low-and-wide',
    yawDeg: 45,
    pitchDeg: 52,
    baseDist: 30,
    fov: 46,
  },
] as const satisfies readonly CameraPreset[];

export type CameraPresetId = (typeof CAMERA_PRESETS)[number]['id'];
