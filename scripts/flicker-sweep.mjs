#!/usr/bin/env node
// ============================================================================================
// FLICKER SWEEP — the standing two-frame flicker detector (Phase 42, Part 10).
// ============================================================================================
//
// WHAT IT DOES
//   Teleports the player car to every pose in `world/toronto/flickerVantages.ts` (183 of them: a
//   120 wu road-snapped polygon lattice + one pose per district + the pinned Phase 39-41
//   money-shot anchors + the camera battery's anchors), FREEZES the world, and photographs the
//   same frozen frame from two camera positions a fraction of a world-unit apart, alternating
//   A/B/A/B. Pixels that flip back and forth are counted; dense, THICK clusters of them that no
//   single image translation explains are z-fighting (or any other rasterization strobe) and get
//   reported with cropped evidence.
//
// WHY IT WORKS (the two halves)
//   1. FREEZE, DON'T MASK. `setFreezeWorld(true)` (core/simClock.ts's clock governor + the Rapier
//      pause + the migrated wall-clock painters) stops EVERYTHING that animates: physics, lamp
//      cycling, discs, screens, shimmer, lightbars. Phase 42 T1's freeze probe measured 0/921,600
//      changed pixels between two captures 500 ms apart at seven vantages, with a strobing police
//      unit in frame. So anything that changes between this harness's captures changed because the
//      CAMERA moved, not because the world did — no animation whitelist, no "ignore this
//      rectangle" list, nothing to keep in sync.
//   2. SUB-PIXEL STIMULUS. `setCameraJitter(0.05, 0)` translates the eye AND the look target by
//      0.05 wu (view direction unchanged — a pure translation, so the projection is the same
//      picture resampled on a shifted grid). MEASURED at the money-manhole vantage by tracking a
//      road dash across a jitter ladder: 0.05 wu moves near-ground geometry by ~3 px, 0.1 wu by
//      ~7 px. Ordinary geometry edges therefore repaint a THIN line of pixels; coplanar surfaces
//      instead swap which one wins across an AREA. Line vs area is the discriminator.
//
// THE TWO MEASURED FACTS THAT SHAPE THE THRESHOLDS
//   A. DETERMINISM. With the world frozen and the camera alternating between exactly two
//      positions, rendering is bit-deterministic: two captures at the same jitter state are
//      identical (T1's probe, and this harness re-measures it per vantage as
//      `stabilityChangedPx`). So a pixel that changes at one transition changes at EVERY
//      transition — toggle counts are effectively binary. K (`HOT_PIXEL_MIN_TOGGLES`) is
//      therefore a RESIDUAL-MOTION filter (an unconverged camera lerp, a stray unfrozen painter
//      → 1-2 toggles, discarded), not the flicker discriminator.
//   B. DENSITY ALONE CANNOT DISCRIMINATE. Sub-wu parallax does not only repaint edges: any FEATURE
//      thinner than the shift repaints ENTIRELY (a tapering park wedge, a curb sliver). Measured at
//      the four calibration vantages, such regions reach 100%-hot 8x8 tiles. What they never do is
//      get THICK: the largest disc that fits inside any parallax-only hot region was 3.67 px
//      (money-dash-far), 4.33 px (money-church-rainbow), 3.67 px (money-venue-fascia). Hence the
//      area gate below — the tile-space statement of "z-fighting covers an area, parallax is a
//      line".
//
// THE THIRD STAGE — REGISTRATION ("PARALLAX GATE"), added after the money-manhole triage
//   Fact B holds for GROUND parallax, which is what the calibration vantages sampled. It does NOT
//   hold for a silhouette near the CAMERA EYE PLANE. At money-manhole the surviving cluster was the
//   screen edge where a low pack building's flat ROOF meets the sidewalk (its west face is never
//   visible under the fixed camera's south+east face law, so the roof reads as a bare plane). That
//   roof sits at ~21 wu (the STREETWALL_MAX_HEIGHT_WU cap) against an eye at 22-35 wu, so the 0.05 wu
//   translation moves its silhouette ~5-10 px while the ground under it moves ~3 px. The difference
//   is a DISOCCLUSION band 8-12 px wide: a thick, area-like hot region that the radius gate cannot
//   tell from a z-fight (measured 8 px inscribed radius vs the positive control's 8.67 px — see the
//   evidence below; raising the size gates would have blinded the sweep to real defects).
//   THE DISCRIMINATOR IS REGISTRATION, NOT SIZE:
//     * A parallax band is ONE piece of image content that MOVED. There exists a single global 2-D
//       translation (dx, dy) such that B shifted by it reproduces A over the band.
//     * A z-fight is a WINNER SWAP. The losing surface's pattern exists in one frame ONLY; nothing
//       moved, so no translation reproduces it — the residual stays near 100% at EVERY shift,
//       including (0,0), because the frames genuinely differ there.
//   So every cluster that survives density + solid-block + radius gets an exhaustive integer shift
//   search over +/-PARALLAX_MAX_SHIFT_PX on the worst frame pair. If the best shift explains
//   >= 75% of the cluster's hot pixels AND is a real displacement (>= PARALLAX_MIN_SHIFT_PX), the
//   cluster is recorded in `parallaxRejected` with its shift and dropped from the verdict. The gate
//   only ever DISMISSES, so every ambiguity is resolved toward keeping the finding (out-of-frame
//   samples count as unexplained; ties resolve to the first shift in a fixed scan order).
//
// CALIBRATION EVIDENCE (2026-07-27, dev server, 1280x720, SwiftShader/ANGLE, MSAA 4, depth 24-bit,
// tier high; full instrument + images: .planning/tools/p42-calib-map.mjs →
// .planning/screenshots/phase-42/calib/)
//   * Whole-frame jitter noise at 0.05 wu (T1 probe): 22,084/921,600 px = 2.396% — scattered edges
//     across the entire frame. That is the noise floor these thresholds must survive.
//   * NEGATIVE CONTROL (untouched tree): money-dash-far 22,125 hot px (2.40%), 23 hot tiles,
//     max hot-region radius 3.67 px, ZERO hotspots; money-venue-fascia 26,957 hot px (2.93%),
//     max radius 3.67 px, ZERO hotspots. (At the plan's originally-proposed 25% tile floor with no
//     area gate, money-dash-far produced 588 hot tiles and 28 clusters — all of them 1-3 px-wide
//     edge runs. 25% is BELOW the coverage an anti-aliased diagonal edge puts in a tile
//     (~8 x 2.8 px / 64 ≈ 35%), so it cannot separate lines from areas. Raised to 62.5% and paired
//     with the 2x2-block area gate on this evidence, per the plan's "recalibrated only with
//     recorded evidence" clause.)
//   * POSITIVE CONTROL (scratch mutation: `GROUND_STACK.placesRoadArt` set equal to `roadSurface`,
//     making the Church rainbow crosswalk exactly coplanar with the road ribbon):
//     money-church-rainbow fired 3 hotspots / 3,203 hot px in the stripes, worst
//     (1000,352) 40x24 px with max radius 8.67 px. Reverted (git checkout) and re-run at the same
//     vantage: ZERO hotspots, max radius back to 4.33 px. The detector sees a real one-rung tie
//     and goes silent when it is gone.
//   * FADE-ACTIVE VANTAGE: money-tower-facade, occlusionV2Stats().fadedTargets = 4 while frozen →
//     ZERO hotspots. The Bayer screen-door dither is screen-space (gl_FragCoord) and its fade level
//     is latched by the freeze, so a pure translation does not restrobe it.
//   * DETERMINISM: a 12-vantage subset (all four sources) run x2 produced identical hotspot sets
//     and identical per-vantage hot-pixel counts.
//   * PARALLAX GATE (stage 3, added 2026-07-27 from the money-manhole triage; runs cal-negative4,
//     cal-positive2, cal-negative5 under .../sweep/).
//       THE FINDING. After the size gates were calibrated, ONE cluster survived the whole
//       five-vantage control set: money-manhole (x 1499, z 1933.5), rect (640,248) 464x472,
//       7,635 hot px, inscribed radius 8 px, mean 9 toggles (run cal-negative3). LAYER ABLATION
//       PROVED IT IS NOT A Z-FIGHT: setPackBuildings(false) deletes the toggling surface outright
//       (.planning/screenshots/phase-42/triage/p42-ablate-baseline.png — the brown roof plane
//       meeting the sidewalk on the right of frame; ...-setPackBuildings.png — plane gone, pack tree
//       canopies revealed behind it). It is the screen SILHOUETTE of a low pack building's flat roof
//       (its west face is never visible under the fixed camera's south+east face law, so the roof
//       reads as a bare plane), and the roof sits near the eye plane, so the stimulus slides it far
//       more than the ground under it: a disocclusion band ~8-12 px wide.
//       WHY SIZE CANNOT SEPARATE IT. The band's inscribed radius is 8 px; the POSITIVE CONTROL's
//       real z-fight measures 8.67 px. Any radius gate that dismisses the band blinds the sweep to
//       the coplanar tie it was built to find, so the thresholds above were left untouched and the
//       discriminator moved to registration.
//       MEASURED SEPARATION (identical in all three runs — the gate is stable):
//         - money-manhole band: best shift (-12,-6) = 13.42 px explains 87.2% of the cluster's
//           7,635 hot pixels (residual 979 = 12.8%, half the 25% ceiling). Residual at shift (0,0)
//           is 100.0% — the content did not stay put, it MOVED.
//         - Church rainbow z-fight (scratch mutation `GROUND_STACK.placesRoadArt` = `roadSurface`,
//           the same coplanar tie as the original positive control): both clusters SURVIVE the gate
//           by a wide margin — (176,536) 64x48, 989 px, r10, best shift (11,-11) leaves 92.6%
//           unexplained; (304,448) 48x40, 851 px, r9.33, best shift (12,-12) leaves 94.4%. A winner
//           swap is unexplainable by translation, exactly as designed. 12.8% vs 92.6% is a 7x
//           separation around a 25% gate.
//         - Same run: money-manhole is STILL parallax-rejected while the rainbow fires, so the gate
//           discriminates within a single sweep, not just between runs.
//       APERTURE NOTE (why the recorded dx,dy must not be read as "the" motion). The residual
//       landscape over the band (measured off the evidence crop across a wider +/-24 window) is a
//       VALLEY along dx + dy = -18, not a point minimum: the roof/sidewalk boundary is a ~45 degree
//       screen edge, so only the component PERPENDICULAR to it is observable (18/sqrt2 = 12.7 px);
//       every shift along the edge is equally good. The +/-12 box reaches that valley (its diagonal
//       reach is 12*sqrt2 = 17 px), which is why (-12,-6) wins and why an earlier run recorded
//       (-12,-7) at the same 12.8% residual. The z-fight landscape has no valley at all: 74-100%
//       everywhere in the same +/-24 window.
//       RUN LEDGER: cal-negative4 CLEAN exit 0 (0 hotspots, 1 parallax rejection); cal-positive2
//       HOTSPOTS exit 1 (2 hotspots, both rainbow, + the same 1 parallax rejection); cal-negative5
//       after `git checkout` of the scratch: CLEAN exit 0. Zero console errors, zero unstable
//       vantages, in all three.
//
// KNOWN LIMITS (deliberate, documented rather than tuned away)
//   * A z-fighting region THINNER than the area gate (a coplanar stripe under ~16 px on screen)
//     is not reported. The gate is what makes the sweep usable at all; thin coplanar art is the
//     P41 THIN_GEOMETRY law's territory.
//   * A hot region clipped by the frame edge measures thinner than it is (out-of-frame counts as
//     background in the distance transform). Conservative by choice — the neighbouring vantage
//     frames it properly.
//   * Findings are SwiftShader-rendered. Depth buffer is 24-bit here (verified), so the ground
//     ladder's 4-12 mm rungs are ~20+ depth quanta apart at play distances and precision is NOT
//     the artifact source — but a real GPU's rasterization can still differ in detail.
//   * The parallax gate's shift window is a FLOOR, not a bound: a disocclusion band whose
//     perpendicular motion exceeds the +/-12 box (content closer than ~4 wu to the eye — the
//     stimulus displaces a point at depth d by ~52.3/d px here) is NOT dismissed and comes back as a
//     hotspot to be triaged by hand. That is the safe direction: the gate only ever DISMISSES, so
//     every one of its blind spots costs a false alarm rather than a missed defect.
//   * A parallax rejection's recorded `shift` is only determined perpendicular to a straight-edged
//     band (see the APERTURE NOTE above). Read `residualFraction` for the verdict and the shift's
//     MAGNITUDE as "something moved by roughly this much"; do not treat dx/dy as a measurement of
//     that geometry's screen velocity.
//   * Registration is judged on the WORST frame pair only (the one the evidence crop shows), not on
//     all 9 transitions. With rendering deterministic and toggles binary (fact A), every transition
//     carries the same information, so the extra 8 evaluations would buy nothing.
//
// USAGE
//   pnpm flicker                               # full 183-vantage sweep
//   pnpm flicker -- --vantage=money-manhole    # triage subset (comma-separated ids)
//   pnpm flicker -- --run=after-fix            # writes to .../sweep/after-fix/
//   pnpm flicker -- --frames=10 --jitter=0.05  # override the frame count / stimulus
//   pnpm flicker -- --slice=3/8 --run=full-a-3 # contiguous block 3 of 8 of the vantage list —
//     lets the ~30 min full sweep run as short sequential invocations (per-vantage results are
//     independent: each vantage is teleport → settle → freeze → capture, so a chunked run
//     measures exactly what one monolithic run measures; same lattice + same n ⇒ same blocks).
//   Devcontainer: prefix LD_LIBRARY_PATH=$HOME/.cache/chromium-shim-libs (see the browser-shim
//   memory entry) — same as `pnpm smoke` / `pnpm bench:chaos`.
//
// OUTPUT  .planning/screenshots/phase-42/sweep/<run>/
//   results.json      — config echo (every threshold), per-vantage timings + counters, hotspot list
//                       sorted deterministically (vantage id, then tile y, then tile x), a
//                       worst-first severity ranking, `parallaxRejected` (every stage-3 dismissal
//                       with the shift that explained it) and `edgeCrawlRejected` (every stage-4
//                       dismissal with its persistent-edge hug fraction) — both run-level rollups
//                       mirrored per vantage.
//   hotspot-*.png     — padded crop of the worst frame PAIR for each hotspot, side by side.
//   parallax-*.png    — the same crop for a stage-3 dismissal. Photographed so a dismissal can be
//                       eyeballed, but it is NOT a finding: it is absent from the verdict, the exit
//                       code and the contact sheet.
//   crawl-*.png       — the same crop for a stage-4 dismissal (same non-finding status).
//   contact-sheet.png — labelled grid of the worst N hotspots.
//
// EXIT CODE  0 only when the sweep completed with ZERO surviving hotspots, zero console/page errors,
//   the vantage-count pin matched, and every vantage passed its stability self-check. Stage-3
//   parallax rejections and stage-4 edge-crawl rejections are NOT hotspots and never affect the
//   exit code (they are recorded and photographed so the dismissal can be challenged). Anything
//   else is 1 — this is a gate, like scripts/bench-chaos.mjs, and Parts 11-16 re-run it after
//   every visual phase.
//
// SERVER: boot-or-reuse on :5173 exactly like bench-chaos.mjs (the bridge is DEV-only, so this
//   cannot run against `pnpm preview`).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import sharp from 'sharp';

// ---------------------------------------------------------------------------------------------
// PINNED CONFIGURATION — every number the verdict depends on, with its derivation.
// ---------------------------------------------------------------------------------------------

const DEV_URL = 'http://localhost:5173';
// Node's fetch and Chromium's resolver disagree about bare "localhost" in this devcontainer
// (IPv6-only /etc/hosts) — probe every loopback form, navigate with the name. Same note as
// scripts/bench-chaos.mjs.
const PROBE_URLS = ['http://127.0.0.1:5173', 'http://[::1]:5173', 'http://localhost:5173'];
const SERVER_READY_TIMEOUT_MS = 30_000;
const SERVER_POLL_MS = 500;

/** Detector viewport. 1280x720 = 921,600 px, and 8 px tiles divide it exactly (160 x 90 tiles), so
 * there is no partial-tile coverage maths. Matches every Phase 33-41 battery's viewport, so their
 * measured pixel numbers stay directly comparable. */
const VIEWPORT = { width: 1280, height: 720 };

/** Camera stimulus, world units, +x only (pure translation of eye AND look target). 0.05 wu moves
 * near-ground geometry ~3 px here (measured on a road dash across a jitter ladder): big enough
 * that a coplanar pair definitely re-resolves, small enough that the framing is the same picture. */
const JITTER_WU = 0.05;

/** A pixel counts as "changed" between two frames when its max per-channel delta exceeds this.
 * 24/255 is the P41 continuity threshold (p41-matrix.mjs's cropDiffCount), kept identical so this
 * harness's numbers stay comparable with every Phase 39-41 measurement. */
const CHANNEL_DELTA = 24;

/** Frame counts. 10 frames = 9 transitions is the verdict sequence; 4 frames = 3 transitions is the
 * early-exit probe every vantage starts with (183 vantages x ~0.4 s per frame, so skipping 6 frames
 * at a clean vantage is most of the sweep's wall clock). */
const FRAMES_FULL = 10;
const FRAMES_PROBE = 4;

/** VERDICT thresholds (10-frame sequence). */
// Residual-motion filter (see fact A above): a hot pixel must alternate with the stimulus in at
// least 3 of the 9 transitions.
const HOT_PIXEL_MIN_TOGGLES = 3;
// Tile size for the density test. 8x8 = 64 px: small enough to localise a hotspot to one piece of
// geometry, big enough that a 1-3 px-wide parallax edge cannot fill it.
const TILE_PX = 8;
// Density floor. An anti-aliased diagonal edge deposits ~35% of a tile; a re-resolving coplanar
// patch flips essentially everything it covers. 62.5% = 40/64 px.
const TILE_HOT_FRACTION = 0.625;
// A candidate cluster is >= this many orthogonally-adjacent hot tiles.
const CLUSTER_MIN_TILES = 2;
// AREA GATE, part 1 (cheap, tile-space): the cluster must contain a SOLID 2x2 block of hot tiles —
// a >= 16x16 px core. This is also the early-exit probe's gate; without it every vantage escalates
// on ordinary edge chains (measured: 89 candidate clusters at a clean vantage).
const CLUSTER_REQUIRE_SOLID_BLOCK = true;
const CLUSTER_SOLID_BLOCK_TILES = 2;
// AREA GATE, part 2 (the real discriminator — fact B): the largest disc that fits inside the
// cluster's hot pixels must have this radius. Measured parallax ceiling across five calibration
// vantages: 2.67 / 3.67 / 3.67 / 4.33 px. 6 px is ~1.4x that ceiling and far under the positive
// control's z-fight (see the header). Tiles can be 62.5%-hot from a fat diagonal edge; only an
// AREA fits a disc.
const MIN_HOT_RADIUS_PX = 6;

/** STAGE 3 — THE REGISTRATION (PARALLAX) GATE. See "THE THIRD STAGE" in the header for the physics.
 * Applied only to clusters that already survived density + solid-block + radius, and only on the
 * 10-frame verdict path (never on the 4-frame probe — a parallax band is ALLOWED to escalate and
 * then be rejected here; the record shows both, which is the audit trail).
 *
 * Search window, px. The gate asks whether ONE global integer 2-D shift of the B frame reproduces
 * the cluster's hot pixels in A. MEASURED at money-manhole: the roofline silhouette band moves
 * ~5-10 px under the 0.05 wu stimulus (the roof sits near the camera eye plane — streetwall cap
 * ~21 wu vs eye 22-35 wu — so it parallaxes far more than the ~3 px the ground moves). 12 px is
 * ~1.2x the largest shift observed and keeps the search at 25x25 = 625 candidate shifts. */
const PARALLAX_MAX_SHIFT_PX = 12;
/** Minimum |shift| for a "parallax" verdict, px. A cluster "explained" by a near-zero shift is not
 * explained at all — it means the two frames barely differ there under the residual test, which is
 * exactly what a z-fight does NOT do but what a degenerate/flat-region match CAN do. Require
 * dx^2 + dy^2 >= 4 (i.e. |shift| >= 2 px), comfortably below the 5-10 px measured band motion and
 * comfortably above the 0 px a real winner-swap registers at. */
const PARALLAX_MIN_SHIFT_PX = 2;
/** Residual ceiling as a fraction of the cluster's hot pixels: a cluster is parallax iff the best
 * shift leaves <= 25% of its hot pixels unexplained (>= 75% explained). A translated silhouette is
 * not a PERFECT translation — the shift is integer, the true motion is sub-pixel and depth-varying
 * across the band, and anti-aliased fringes never match exactly — so a strict 0 residual is
 * unreachable. A z-fight has no explaining shift at all: the losing surface's pattern exists in one
 * frame only, so its residual stays near 100% at every shift (measured in the positive control —
 * see CALIBRATION EVIDENCE). */
const PARALLAX_EXPLAIN_FRACTION = 0.25;

/** STAGE 4 (edge-crawl gate) — applied only to clusters that survive stages 1-3. Discriminates
 * SUB-pixel re-rasterization of persistent high-contrast edges ("crawling jaggies" — the true
 * displacement is < 1 px, so no integer shift in stage 3's search can register it: measured 48.4%
 * best-shift residual at the lat-12-7 curb stripes, above the 25% ceiling from BOTH sides) from a
 * real winner swap. The discriminator is edge PERSISTENCE: a crawl's edges exist in BOTH frames
 * (displaced < 1 px, covered by the dilation below), while z-fight interference bands exist in
 * exactly ONE frame (the losing surface's pattern). A cluster is dismissed as edge-crawl iff
 * >= EDGE_CRAWL_HUG_FRACTION of its hot pixels lie within EDGE_CRAWL_HUG_DIST_PX of an edge
 * present in both frames of the worst pair.
 * MEASURED SEPARATION (triage pairs, .planning/screenshots/phase-42/triage/):
 *   - lat-12-7 curb-stripe crawl: hug fraction 0.990 (3,107 / 3,139 hot px within 2 px of a
 *     persistent edge). Zoom evidence: the sidewalk/asphalt boundary staircase re-phases ~1 px
 *     between jitter states; every static patch (building windows, car) registers at (-1,-1).
 *   - cam-kensington gate z-fight: hug fraction 0.051 — the swapped face's interference bands
 *     exist in one frame only, so they are nowhere near a PERSISTENT edge. 19x separation
 *     around the 0.9 gate, with margin on both sides.
 * FAILURE DIRECTION: unlike stages 1-3 this gate CAN in principle eat a defect — a z-fight
 * confined entirely to within 2 px of dense persistent edge structure (e.g. under a tight
 * window-mullion grid) would be dismissed. Accepted as residual risk because stage 2's radius
 * gate already guarantees surviving clusters are >= 12 px thick, and a thick region that is
 * ALSO everywhere edge-hugging requires pathological art; recorded here like the aperture note
 * rather than tuned around. Every dismissal is photographed (crawl-*.png) and recorded in
 * `edgeCrawlRejected` so it can be challenged. */
const EDGE_CRAWL_HUG_DIST_PX = 2;
/** Dilation applied to each frame's edge mask before the AND — covers the <= 1 px crawl
 * displacement so a persistent-but-crawling edge still intersects itself across frames. */
const EDGE_CRAWL_DILATE_PX = 1;
const EDGE_CRAWL_HUG_FRACTION = 0.9;

/** STAGE 4b (near-field stimulus parallax) — the OTHER benign sub-class stage 4a cannot reach.
 * The stimulus displaces STATIC geometry by ~52.3/d px (d = eye distance): sub-pixel at play
 * distances, but the nearest visible ground in the frame's BOTTOM band sits at d ~ 11-16 wu,
 * where the displacement is 3-5 px — enough to toggle a high-contrast curb/sidewalk stripe's
 * full width and pass every size gate. Measured to the bone at lat-12-7 (the one vantage in
 * 183 whose bottom corner stacks multiple parallel stripes):
 *   - displacement scales LINEARLY with jitter (0.0125/0.025/0.05/0.1 wu -> 1/2/3/7 px,
 *     triage/lat-12-7-scale) — geometry, not a winner swap;
 *   - the toggle band THICKENS toward the bottom frame corner (depth-graded, sweep/lat127-dump
 *     diffmask), which is why stage 3's single GLOBAL shift explains it only partially
 *     (51.6% / 68.1% / 75.9% across three settles — it straddles stage 3's 75% bar);
 *   - draw calls/triangles identical across jitter states (no culling pops), shadows are
 *     player-anchored (frozen), light pool player-anchored: every discrete mechanism ruled out.
 * DISMISSAL (both conditions, ANDed):
 *   1. the cluster's rect touches the frame's BOTTOM edge (within NEARFIELD_BOTTOM_PX) — the
 *      only region where the stimulus moves static content beyond stage 4a's tolerance;
 *   2. stage 3's best shift already explains >= NEARFIELD_MIN_EXPLAINED of its hot pixels —
 *      "mostly displacement": a real winner swap explains <= 12% (rainbow control, 3x margin),
 *      so majority-explained + near-field = the stimulus's own artifact.
 * The Kensington gate z-fight (explained 63%!) is NOT eaten: its rect bottom is y=416, nowhere
 * near the frame edge — condition 1 is what keeps partially-registered mid-frame defects. */
const NEARFIELD_BOTTOM_PX = 8;
const NEARFIELD_MIN_EXPLAINED = 0.4;

/** HAND-TRIAGED BENIGN LEDGER — the last resort, used only when a finding was triaged to the
 * bone, proven benign, and CANNOT be auto-dismissed without eating real defects. Each entry is
 * the durable form of a hand classification (the plan's "classify every hotspot"): a surviving
 * hotspot matching an entry (same vantage, cluster rect fully inside `within`, inscribed radius
 * <= radiusCapPx) is reported as `triagedBenign` — photographed, recorded, EXCLUDED from the
 * verdict. Anything at that vantage OUTSIDE the pinned region or BIGGER than the cap still
 * fails the gate, so the blind spot is exactly the classified instance, nothing more.
 *
 * cam-yonge-dundas (settle-dependent, fires when the vantage is measured on a fresh world
 * state): the toggling content is the Yonge curb-band / Dundas road-paint staircase NW of the
 * intersection re-rasterizing under the stimulus at a grazing alignment — displacement scales
 * with jitter (287/757/2738 changed px at 0.0125/0.025/0.05 wu, best shifts 0 to -3 px:
 * geometry, not a winner swap), layer ablation removes NO candidate producer (pack layers all
 * ruled out; the surfaces are the road/sidewalk ribbons themselves), and the A/B forms are
 * displaced/re-phased edges — categorically unlike the positive controls' interference bands
 * (rainbow: dense scanline banding, 88-94% unexplained at every shift; gate top-cap: solid
 * colour swap). Its registration residual (38-50%) numerically OVERLAPS the Kensington gate
 * z-fight's 37%, which is exactly why no threshold gate can separate them and this ledger
 * exists. Evidence: .planning/screenshots/phase-42/sweep/yd-triage-{1,2,3}/ +
 * .planning/screenshots/phase-42/triage/yd-scale/ + phase-42-notes.md. */
const TRIAGED_BENIGN = [
  {
    vantageId: 'cam-yonge-dundas',
    class: 'curb-band raster crawl (hand-triaged 2026-07-27)',
    within: { x: 400, y: 200, w: 220, h: 180 },
    radiusCapPx: 20,
  },
];

/** PROBE thresholds (4-frame early exit). Looser than the verdict on every axis it shares — min
 * toggles 2 of 3 (vs 3 of 9), density 40% (vs 62.5%), cluster >= 1 tile — so a vantage cannot
 * early-exit past something the 10-frame verdict would have reported. The area gate is kept
 * (without it every vantage escalates on ordinary edge chains: measured 89 candidate clusters at a
 * clean vantage, which would have made the early exit worthless). */
const PROBE_MIN_TOGGLES = 2;
const PROBE_TILE_HOT_FRACTION = 0.4;
const PROBE_CLUSTER_MIN_TILES = 1;

/** Per-frame wait after writing the jitter before the capture. The jitter ref is consumed by the
 * camera rig on the next rendered frame; SwiftShader paints in ~30-100 ms here, so 250 ms is
 * several frames of margin. VERIFIED PER VANTAGE, never assumed: `stimulusChangedPx` (frame 0 vs 1)
 * must be > 0 (the nudge landed) and `stabilityChangedPx` (frame 0 vs 2, the same jitter state)
 * must be 0 (it landed completely, and nothing else moved). Both are in results.json and a nonzero
 * stability reading fails the run. */
const FRAME_SETTLE_MS = 250;

/** Settle-to-quiescence after a teleport (wall-clock settles let knocked props scatter differently
 * run to run, which breaks the x2 determinism gate).
 * MIN is set by THE CAMERA RIG, not the car: the rig damps toward its ideal at `CAMERA.lerp` 0.08
 * per 60 fps frame (frame-rate independent), so the residual after t seconds is 0.92^(60t) of the
 * teleport distance — 4.8e-5 after 2 s (0.05 wu on a 1000 wu jump: comparable to the jitter itself)
 * but 3e-7 after 3 s (sub-milli-wu on any legal jump). MEASURED CONSEQUENCE: at a 2 s settle the
 * same vantage produced 22.1k hot px in one run and 34.1k in another; at >= 3 s repeated runs agree.
 * SPEED: a parked car does NOT read 0 — measured 0.0613 m/s at three of five calibration vantages
 * (suspension idle) and 0.0004 at the others, so the floor is 0.15 (2.4x the observed idle, ~40x
 * below a crawl); it exists to catch physics scatter (a knocked cone still rolling), not the rig.
 * The real guarantee is the per-vantage stability self-check above, which fails loudly if anything
 * was still moving when the frames were taken. */
const QUIESCENCE_MIN_MS = 3000;
const QUIESCENCE_MAX_MS = 7000;
const QUIESCENCE_POLL_MS = 120;
const QUIESCENCE_SPEED_MPS = 0.15;
const QUIESCENCE_CONSEC = 2;

/** Evidence crops: padding around the hotspot rect, and how many hotspots the contact sheet shows
 * (worst-first by hot-pixel count). */
const CROP_PAD_PX = 24;
const CONTACT_SHEET_MAX = 12;
const CONTACT_SHEET_COLS = 3;
const CONTACT_CELL = { width: 420, height: 260 };

/** The lattice size this harness was calibrated against. A change is not necessarily wrong (Parts
 * 11-16 may add money shots) but it invalidates run-to-run comparisons, so it is a loud gate rather
 * than a silent drift.
 *
 * PHASE 75: 183 -> 187. The gate did exactly its job and then became the problem — `results.verdict`
 * ANDs it, so once P75's widening grew the lattice every run printed "HOTSPOTS" and exited 1 even at
 * zero hotspots, making the sweep useless as a pass/fail gate. The +5 are all LATTICE poses, not
 * curated ones: the lattice is derived from drivable ground, and doubling the ribbons added drivable
 * ground (measured: ribbon union 192,796 -> 373,184 wu²), then -1 when the `money-dash-far` anchor
 * was re-targeted onto Eglinton and absorbed the lattice pose nearest its new spot (lattice yields
 * to curated). Attributed in flickerVantages.test.ts.
 * Re-pinned deliberately here after that audit — never bump this to silence a red run. */
const EXPECTED_VANTAGE_COUNT = 187;

/** Everything that paints OVER the scene canvas. The canvas is `position: fixed; inset: 0`
 * (GameCanvas.css), so a Playwright element screenshot is a viewport shot clipped to its box — every
 * overlay inside that box lands in the image (T1's probe failed its identity gate on exactly 142 px
 * of r3f-perf's CPU-ms readout before this existed). `visibility` and never `display`: the scene
 * canvas is two divs deep inside R3F's wrapper and display:none on an ancestor makes it
 * unscreenshottable, while visibility never reflows, so the canvas cannot resize. The app-shell
 * header/footer are hidden too — static (so they could not flicker), but they cover frame area the
 * sweep wants back. */
const CAPTURE_CHROME_CSS = `
  .game-canvas-container * { visibility: hidden !important; }
  .game-canvas-container canvas[aria-label="3D driving game canvas"] { visibility: visible !important; }
  .site-header, .site-footer, footer, #leva__root { visibility: hidden !important; }
`;

const OUT_ROOT = '.planning/screenshots/phase-42/sweep';

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { vantages: null, run: 'full', frames: FRAMES_FULL, jitter: JITTER_WU, slice: null, dumpFrames: false };
  for (const arg of argv) {
    const [key, ...rest] = arg.split('=');
    const value = rest.join('=');
    switch (key) {
      // pnpm >= 9 forwards the argument separator VERBATIM (`pnpm flicker -- --run=x` reaches this
      // script as ['--', '--run=x']), so the documented USAGE line only works if a bare `--` is
      // ignored rather than treated as an unknown flag.
      case '--':
        break;
      case '--vantage':
      case '--vantages':
        out.vantages = value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--run':
        out.run = value.trim();
        break;
      case '--dumpFrames':
        // Triage aid: write every captured full frame per vantage (frame-<vantage>-<i>.png) so a
        // finding's exact A/B scene state can be inspected offline at full resolution.
        out.dumpFrames = true;
        break;
      case '--slice': {
        const m = /^(\d+)\/(\d+)$/.exec(value.trim());
        const i = m ? Number.parseInt(m[1], 10) : NaN;
        const n = m ? Number.parseInt(m[2], 10) : NaN;
        if (!m || i < 1 || n < 1 || i > n) {
          console.error('[flicker] --slice must be i/n with 1 <= i <= n');
          process.exit(1);
        }
        out.slice = { i, n };
        break;
      }
      case '--frames':
        out.frames = Number.parseInt(value, 10);
        break;
      case '--jitter':
        out.jitter = Number.parseFloat(value);
        break;
      default:
        console.error(`[flicker] unknown arg: ${arg}`);
        process.exit(1);
    }
  }
  if (!Number.isFinite(out.frames) || out.frames < 3) {
    console.error('[flicker] --frames must be an integer >= 3 (the stability self-check needs three)');
    process.exit(1);
  }
  if (!Number.isFinite(out.jitter) || out.jitter <= 0) {
    console.error('[flicker] --jitter must be a positive number (world units)');
    process.exit(1);
  }
  if (!/^[\w.-]+$/.test(out.run)) {
    console.error('[flicker] --run must be a simple name ([A-Za-z0-9_.-])');
    process.exit(1);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// SERVER (boot-or-reuse — bench-chaos.mjs)
// ---------------------------------------------------------------------------------------------

async function isServerUp() {
  const results = await Promise.all(
    PROBE_URLS.map(async (url) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        return res.ok || res.status < 500;
      } catch {
        return false;
      }
    }),
  );
  return results.some(Boolean);
}

async function waitForServer(deadlineMs) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await isServerUp()) return;
    await new Promise((r) => setTimeout(r, SERVER_POLL_MS));
  }
  throw new Error(`dev server never came up at ${DEV_URL} within ${deadlineMs}ms`);
}

// ---------------------------------------------------------------------------------------------
// DETECTOR (pure functions over raw RGBA buffers)
// ---------------------------------------------------------------------------------------------

/** Adds one transition (frames a → b) into the running per-pixel toggle counts. RGB only: the
 * canvas is opaque, so the alpha channel is a constant 255 and comparing it is wasted work. */
function accumulateTransition(toggles, a, b, pixelCount, channels) {
  let changed = 0;
  for (let p = 0; p < pixelCount; p++) {
    const o = p * channels;
    const dr = a[o] - b[o];
    const dg = a[o + 1] - b[o + 1];
    const db = a[o + 2] - b[o + 2];
    const max = Math.max(dr < 0 ? -dr : dr, dg < 0 ? -dg : dg, db < 0 ? -db : db);
    if (max > CHANNEL_DELTA) {
      toggles[p]++;
      changed++;
    }
  }
  return changed;
}

/** Changed pixels between two frames inside a px rect (picks a hotspot's worst frame pair). */
function changedInRect(a, b, rect, width, channels) {
  let changed = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const o = (y * width + x) * channels;
      const dr = a[o] - b[o];
      const dg = a[o + 1] - b[o + 1];
      const db = a[o + 2] - b[o + 2];
      const max = Math.max(dr < 0 ? -dr : dr, dg < 0 ? -dg : dg, db < 0 ? -db : db);
      if (max > CHANNEL_DELTA) changed++;
    }
  }
  return changed;
}

/** Chamfer-(3,4) distance transform of the hot mask: for every hot pixel, 3x its distance to the
 * nearest cold pixel. The max inside a region is the radius of the largest disc that fits in it —
 * the THICKNESS number the area gate is a tile-space proxy for, reported per hotspot so triage can
 * rank "a fat patch" above "a fat line". Out-of-frame counts as COLD (a region clipped by the frame
 * edge under-reports rather than inheriting its own reflection: measured 8 px vs a mirrored 9 px at
 * money-manhole). */
function distanceTransform(toggles, minToggles, width, height) {
  const n = width * height;
  const dt = new Uint16Array(n);
  for (let i = 0; i < n; i++) dt[i] = toggles[i] >= minToggles ? 60000 : 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (dt[i] === 0) continue;
      const up = y > 0 ? dt[i - width] : 0;
      const left = x > 0 ? dt[i - 1] : 0;
      const upLeft = y > 0 && x > 0 ? dt[i - width - 1] : 0;
      const upRight = y > 0 && x < width - 1 ? dt[i - width + 1] : 0;
      const best = Math.min(dt[i], up + 3, left + 3, upLeft + 4, upRight + 4);
      dt[i] = best;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (dt[i] === 0) continue;
      const down = y < height - 1 ? dt[i + width] : 0;
      const right = x < width - 1 ? dt[i + 1] : 0;
      const downRight = y < height - 1 && x < width - 1 ? dt[i + width + 1] : 0;
      const downLeft = y < height - 1 && x > 0 ? dt[i + width - 1] : 0;
      const best = Math.min(dt[i], down + 3, right + 3, downRight + 4, downLeft + 4);
      dt[i] = best;
    }
  }
  return dt;
}

/** Tile-density + clustering + area gate. Returns the census and every surviving hotspot, sorted
 * deterministically (tile y, then tile x). */
function analyzeToggles(toggles, width, height, opts) {
  const { minToggles, tileHotFraction, minClusterTiles, requireSolidBlock, solidBlockTiles } = opts;
  const tilesX = Math.ceil(width / TILE_PX);
  const tilesY = Math.ceil(height / TILE_PX);
  const tileCount = tilesX * tilesY;
  const hotCount = new Int32Array(tileCount);
  const toggleSum = new Float64Array(tileCount);
  const toggleMax = new Int32Array(tileCount);
  let hotPixels = 0;

  for (let y = 0; y < height; y++) {
    const ty = (y / TILE_PX) | 0;
    const rowBase = y * width;
    for (let x = 0; x < width; x++) {
      const v = toggles[rowBase + x];
      if (v >= minToggles) {
        const ti = ty * tilesX + ((x / TILE_PX) | 0);
        hotCount[ti]++;
        toggleSum[ti] += v;
        if (v > toggleMax[ti]) toggleMax[ti] = v;
        hotPixels++;
      }
    }
  }

  const tileMinHotPixels = Math.ceil(TILE_PX * TILE_PX * tileHotFraction);
  const hot = new Uint8Array(tileCount);
  let hotTiles = 0;
  for (let i = 0; i < tileCount; i++) {
    if (hotCount[i] >= tileMinHotPixels) {
      hot[i] = 1;
      hotTiles++;
    }
  }

  const seen = new Uint8Array(tileCount);
  const clusters = [];
  const rejected = [];
  const stack = [];
  for (let start = 0; start < tileCount; start++) {
    if (!hot[start] || seen[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    const members = [];
    while (stack.length > 0) {
      const ti = stack.pop();
      members.push(ti);
      const cx = ti % tilesX;
      const cy = (ti / tilesX) | 0;
      const neighbours = [
        cx > 0 ? ti - 1 : -1,
        cx < tilesX - 1 ? ti + 1 : -1,
        cy > 0 ? ti - tilesX : -1,
        cy < tilesY - 1 ? ti + tilesX : -1,
      ];
      for (const ni of neighbours) {
        if (ni < 0 || !hot[ni] || seen[ni]) continue;
        seen[ni] = 1;
        stack.push(ni);
      }
    }
    if (members.length < minClusterTiles) continue;

    // Area gate: does the cluster contain a SOLID k x k block of hot tiles?
    let solidBlock = false;
    if (requireSolidBlock) {
      const k = solidBlockTiles;
      outer: for (const ti of members) {
        const cx = ti % tilesX;
        const cy = (ti / tilesX) | 0;
        if (cx + k > tilesX || cy + k > tilesY) continue;
        for (let dy = 0; dy < k; dy++) {
          for (let dx = 0; dx < k; dx++) {
            if (!hot[(cy + dy) * tilesX + cx + dx]) continue outer;
          }
        }
        solidBlock = true;
        break;
      }
    }

    let tx0 = tilesX;
    let ty0 = tilesY;
    let tx1 = 0;
    let ty1 = 0;
    let clusterHotPixels = 0;
    let clusterToggleSum = 0;
    let clusterToggleMax = 0;
    for (const ti of members) {
      const mx = ti % tilesX;
      const my = (ti / tilesX) | 0;
      if (mx < tx0) tx0 = mx;
      if (mx > tx1) tx1 = mx;
      if (my < ty0) ty0 = my;
      if (my > ty1) ty1 = my;
      clusterHotPixels += hotCount[ti];
      clusterToggleSum += toggleSum[ti];
      if (toggleMax[ti] > clusterToggleMax) clusterToggleMax = toggleMax[ti];
    }
    const entry = {
      tiles: members.length,
      tileRect: { x0: tx0, y0: ty0, x1: tx1, y1: ty1 },
      rect: { x: tx0 * TILE_PX, y: ty0 * TILE_PX, w: (tx1 - tx0 + 1) * TILE_PX, h: (ty1 - ty0 + 1) * TILE_PX },
      hotPixels: clusterHotPixels,
      meanToggles: clusterHotPixels === 0 ? 0 : +(clusterToggleSum / clusterHotPixels).toFixed(2),
      maxToggles: clusterToggleMax,
      solidBlock,
      // Tile membership, kept for stage 3 (the registration gate needs the cluster's actual hot
      // PIXELS, not its bounding rect — the rect of a sprawling band is mostly cold). Never
      // serialised: results.json entries are rebuilt field by field below.
      members,
    };
    if (requireSolidBlock && !solidBlock) rejected.push(entry);
    else clusters.push(entry);
  }

  const byPosition = (a, b) => a.tileRect.y0 - b.tileRect.y0 || a.tileRect.x0 - b.tileRect.x0;
  clusters.sort(byPosition);
  rejected.sort(byPosition);
  return { hotPixels, hotTiles, tileMinHotPixels, tilesX, tilesY, clusters, rejectedThinClusters: rejected.length };
}

/** The cluster's hot PIXEL indices (row-major), walked in a fixed order: tile index ascending, then
 * y, then x. Count matches the cluster's `hotPixels` by construction (same mask, same tiles). */
function clusterHotPixelIndices(toggles, minToggles, members, tilesX, width, height) {
  const sortedTiles = [...members].sort((a, b) => a - b);
  const out = [];
  for (const ti of sortedTiles) {
    const x0 = (ti % tilesX) * TILE_PX;
    const y0 = ((ti / tilesX) | 0) * TILE_PX;
    const x1 = Math.min(x0 + TILE_PX, width);
    const y1 = Math.min(y0 + TILE_PX, height);
    for (let y = y0; y < y1; y++) {
      const row = y * width;
      for (let x = x0; x < x1; x++) {
        if (toggles[row + x] >= minToggles) out.push(row + x);
      }
    }
  }
  return Int32Array.from(out);
}

/** STAGE 3's measurement: how many of the cluster's hot pixels ONE shift fails to explain.
 *
 * residual(shift) = |{ p in hotIdx : maxPerChannel|A(p) - B(p + shift)| > CHANNEL_DELTA }|, with a
 * pixel whose p+shift leaves the frame counted as UNEXPLAINED (conservative — the gate's job is to
 * DISMISS findings, so every ambiguity must push toward "keep it").
 *
 * `cap` is an exact early-out for the search below, not an approximation: the running residual only
 * grows, so once it reaches the incumbent best this shift can no longer win. A capped call returns a
 * value >= cap, which every caller treats as "not better". */
function registrationResidual(hotIdx, a, b, width, height, channels, dx, dy, cap = Number.POSITIVE_INFINITY) {
  let residual = 0;
  for (let i = 0; i < hotIdx.length; i++) {
    const p = hotIdx[i];
    const y = (p / width) | 0;
    const x = p - y * width;
    const sx = x + dx;
    const sy = y + dy;
    if (sx < 0 || sy < 0 || sx >= width || sy >= height) {
      residual++;
    } else {
      const oa = p * channels;
      const ob = (sy * width + sx) * channels;
      const dr = a[oa] - b[ob];
      const dg = a[oa + 1] - b[ob + 1];
      const db = a[oa + 2] - b[ob + 2];
      const max = Math.max(dr < 0 ? -dr : dr, dg < 0 ? -dg : dg, db < 0 ? -db : db);
      if (max > CHANNEL_DELTA) residual++;
    }
    if (residual >= cap) break;
  }
  return residual;
}

/** STAGE 3's core: the best single global integer shift (dx, dy) that registers frame B onto frame A
 * over the cluster's hot pixels.
 *
 * DETERMINISM: dy ascending outer, dx ascending inner, and only a STRICTLY smaller residual replaces
 * the incumbent — so ties resolve to the first shift in that fixed scan order and the result is
 * reproducible for a given pair of frames.
 *
 * COST: |hotIdx| (thousands) x 625 shifts, on the raw buffers with no cropping — the WHOLE analysis
 * pass at money-manhole (7.6k hot px, tiling + distance transform + this search) measured 86-108 ms
 * across the three control runs, against ~14 s of capture at that vantage. */
function bestRegistrationShift(hotIdx, a, b, width, height, channels) {
  let bestResidual = Number.POSITIVE_INFINITY;
  let bestDx = 0;
  let bestDy = 0;
  for (let dy = -PARALLAX_MAX_SHIFT_PX; dy <= PARALLAX_MAX_SHIFT_PX; dy++) {
    for (let dx = -PARALLAX_MAX_SHIFT_PX; dx <= PARALLAX_MAX_SHIFT_PX; dx++) {
      const residual = registrationResidual(hotIdx, a, b, width, height, channels, dx, dy, bestResidual);
      if (residual < bestResidual) {
        bestResidual = residual;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }
  return { dx: bestDx, dy: bestDy, residual: bestResidual === Number.POSITIVE_INFINITY ? hotIdx.length : bestResidual };
}

/** Verdict for one surviving cluster: parallax (a translated silhouette — dismissed with evidence)
 * or a real hotspot. Both conditions must hold: the shift explains >= 1 - PARALLAX_EXPLAIN_FRACTION
 * of the hot pixels, AND it is a real displacement (>= PARALLAX_MIN_SHIFT_PX).
 *
 * Also reports `residualZeroFraction` — the residual at shift (0,0), i.e. "nothing moved". It is not
 * a gate, it is the CONTRAST that makes every record self-auditable: a hot cluster is by definition
 * ~100% unexplained at zero shift, so a low best-shift residual next to it is the whole argument
 * ("this content moved") in two numbers. */
function classifyParallax(hotIdx, a, b, width, height, channels) {
  if (hotIdx.length === 0) {
    return { parallax: false, dx: 0, dy: 0, residual: 0, residualFraction: 1, residualZeroFraction: 1, shiftPx: 0 };
  }
  const { dx, dy, residual } = bestRegistrationShift(hotIdx, a, b, width, height, channels);
  const residualZero = registrationResidual(hotIdx, a, b, width, height, channels, 0, 0);
  const residualFraction = residual / hotIdx.length;
  const shiftSq = dx * dx + dy * dy;
  return {
    parallax: residualFraction <= PARALLAX_EXPLAIN_FRACTION && shiftSq >= PARALLAX_MIN_SHIFT_PX * PARALLAX_MIN_SHIFT_PX,
    dx,
    dy,
    residual,
    residualFraction: +residualFraction.toFixed(4),
    residualZeroFraction: +(residualZero / hotIdx.length).toFixed(4),
    shiftPx: +Math.sqrt(shiftSq).toFixed(2),
  };
}

/** STAGE 4's field: a chamfer (3-4) distance transform, in chamfer units (3 per px), to the
 * nearest PERSISTENT edge — a pixel whose 4-neighbour contrast exceeds CHANNEL_DELTA in frame a
 * AND (after dilating each frame's mask by EDGE_CRAWL_DILATE_PX) in frame b. Built once per
 * worst-pair and shared by every cluster judged against that pair. */
function persistentEdgeDistance(a, b, width, height, channels) {
  const edgeMask = (buf) => {
    const m = new Uint8Array(width * height);
    for (let y = 0; y < height - 1; y++) {
      for (let x = 0; x < width - 1; x++) {
        const i = (y * width + x) * channels;
        const r = i + channels;
        const d = i + width * channels;
        const gx = Math.max(Math.abs(buf[i] - buf[r]), Math.abs(buf[i + 1] - buf[r + 1]), Math.abs(buf[i + 2] - buf[r + 2]));
        const gy = Math.max(Math.abs(buf[i] - buf[d]), Math.abs(buf[i + 1] - buf[d + 1]), Math.abs(buf[i + 2] - buf[d + 2]));
        if (Math.max(gx, gy) > CHANNEL_DELTA) m[y * width + x] = 1;
      }
    }
    return m;
  };
  const dilate = (m) => {
    const o = new Uint8Array(width * height);
    const r = EDGE_CRAWL_DILATE_PX;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!m[y * width + x]) continue;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < width && ny < height) o[ny * width + nx] = 1;
          }
        }
      }
    }
    return o;
  };
  const ea = dilate(edgeMask(a));
  const eb = dilate(edgeMask(b));
  const INF = Number.POSITIVE_INFINITY;
  const dt = new Float64Array(width * height).fill(INF);
  for (let i = 0; i < width * height; i++) if (ea[i] && eb[i]) dt[i] = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (dt[i] === 0) continue;
      let v = dt[i];
      if (x > 0) v = Math.min(v, dt[i - 1] + 3);
      if (y > 0) v = Math.min(v, dt[i - width] + 3);
      if (x > 0 && y > 0) v = Math.min(v, dt[i - width - 1] + 4);
      if (x < width - 1 && y > 0) v = Math.min(v, dt[i - width + 1] + 4);
      dt[i] = v;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (dt[i] === 0) continue;
      let v = dt[i];
      if (x < width - 1) v = Math.min(v, dt[i + 1] + 3);
      if (y < height - 1) v = Math.min(v, dt[i + width] + 3);
      if (x < width - 1 && y < height - 1) v = Math.min(v, dt[i + width + 1] + 4);
      if (x > 0 && y < height - 1) v = Math.min(v, dt[i + width - 1] + 4);
      dt[i] = v;
    }
  }
  return dt;
}

/** STAGE 4's verdict for one cluster: what fraction of its hot pixels hug a persistent edge. */
function classifyEdgeCrawl(hotIdx, edgeDt) {
  if (hotIdx.length === 0) return { crawl: false, hugFraction: 0 };
  const maxChamfer = EDGE_CRAWL_HUG_DIST_PX * 3;
  let hug = 0;
  for (let i = 0; i < hotIdx.length; i++) {
    if (edgeDt[hotIdx[i]] <= maxChamfer) hug++;
  }
  const hugFraction = hug / hotIdx.length;
  return { crawl: hugFraction >= EDGE_CRAWL_HUG_FRACTION, hugFraction: +hugFraction.toFixed(4) };
}

// ---------------------------------------------------------------------------------------------
// EVIDENCE (crops + contact sheet)
// ---------------------------------------------------------------------------------------------

function padRect(rect, width, height) {
  const x = Math.max(0, rect.x - CROP_PAD_PX);
  const y = Math.max(0, rect.y - CROP_PAD_PX);
  const right = Math.min(width, rect.x + rect.w + CROP_PAD_PX);
  const bottom = Math.min(height, rect.y + rect.h + CROP_PAD_PX);
  return { left: x, top: y, width: right - x, height: bottom - y };
}

/** Side-by-side crop of the worst frame PAIR (A | B) — the two states the hotspot alternates
 * between, which is what makes the defect legible to a human. */
async function writeHotspotCrop(pngA, pngB, crop, outPath) {
  const [a, b] = await Promise.all([sharp(pngA).extract(crop).png().toBuffer(), sharp(pngB).extract(crop).png().toBuffer()]);
  const gap = 6;
  await sharp({
    create: { width: crop.width * 2 + gap, height: crop.height, channels: 3, background: { r: 255, g: 0, b: 128 } },
  })
    .composite([
      { input: a, left: 0, top: 0 },
      { input: b, left: crop.width + gap, top: 0 },
    ])
    .png()
    .toFile(outPath);
}

function labelSvg(text, width, height) {
  const esc = String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
  return Buffer.from(
    `<svg width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#0d0f12"/>` +
      `<text x="6" y="${height - 6}" font-family="monospace" font-size="13" fill="#e6edf3">${esc}</text></svg>`,
  );
}

async function writeContactSheet(hotspots, outDir, outPath) {
  if (hotspots.length === 0) return null;
  const shown = hotspots.slice(0, CONTACT_SHEET_MAX);
  const labelH = 22;
  const cols = Math.min(CONTACT_SHEET_COLS, shown.length);
  const rows = Math.ceil(shown.length / cols);
  const cellW = CONTACT_CELL.width;
  const cellH = CONTACT_CELL.height + labelH;
  const composites = [];
  for (let i = 0; i < shown.length; i++) {
    const h = shown[i];
    const col = i % cols;
    const row = (i / cols) | 0;
    const img = await sharp(join(outDir, h.crop))
      .resize({ width: cellW, height: CONTACT_CELL.height, fit: 'contain', background: { r: 13, g: 15, b: 18 } })
      .png()
      .toBuffer();
    composites.push({ input: img, left: col * cellW, top: row * cellH });
    composites.push({
      input: labelSvg(
        `${i + 1}. ${h.vantageId} ${h.rect.x},${h.rect.y} ${h.rect.w}x${h.rect.h} ${h.hotPixels}px r${h.maxRadiusPx}`,
        cellW,
        labelH,
      ),
      left: col * cellW,
      top: row * cellH + CONTACT_CELL.height,
    });
  }
  await sharp({ create: { width: cols * cellW, height: rows * cellH, channels: 3, background: { r: 13, g: 15, b: 18 } } })
    .composite(composites)
    .png()
    .toFile(outPath);
  return outPath;
}

// ---------------------------------------------------------------------------------------------
// PAGE HELPERS
// ---------------------------------------------------------------------------------------------

async function bootToPlaying(page) {
  await page.goto(DEV_URL, { waitUntil: 'load' });
  for (let i = 0; i < 150; i++) {
    const machine = await page.evaluate(() => window.__smashy?.getMachine?.() ?? null);
    if (machine === 'PLAYING') return true;
    if (machine === 'GARAGE') await page.getByTestId('garage-start').click({ timeout: 2000 }).catch(() => {});
    if (machine === 'GAMEOVER') await page.keyboard.press('r');
    await page.waitForTimeout(300);
  }
  return false;
}

async function teleport(page, x, z) {
  await page.evaluate(
    ([px, pz]) => {
      window.__smashy.reset({ position: { x: px, y: 0.85, z: pz }, rotation: { x: 0, y: 0, z: 0, w: 1 } });
    },
    [x, z],
  );
}

/** Wait for the world to stop moving on its own: a fixed floor (camera-rig lerp + occlusion
 * hysteresis + tunnel overlay), then the car's own speed under QUIESCENCE_SPEED_MPS twice in a row.
 * Returns what it saw so results.json can show why a vantage was slow. */
async function settleToQuiescence(page) {
  const start = Date.now();
  await page.waitForTimeout(QUIESCENCE_MIN_MS);
  let consec = 0;
  let speed = null;
  while (Date.now() - start < QUIESCENCE_MAX_MS) {
    speed = await page.evaluate(() => {
      const s = window.__smashy.readState();
      return s ? s.speed : null;
    });
    if (speed !== null && speed < QUIESCENCE_SPEED_MPS) {
      consec++;
      if (consec >= QUIESCENCE_CONSEC) break;
    } else {
      consec = 0;
    }
    await page.waitForTimeout(QUIESCENCE_POLL_MS);
  }
  return {
    ms: Date.now() - start,
    speed: speed === null ? null : +speed.toFixed(3),
    quiesced: consec >= QUIESCENCE_CONSEC,
  };
}

/** Capture one frame of the alternating A/B sequence (even index = shipped framing, odd = jittered)
 * and decode it to raw RGBA. */
async function captureFrame(page, canvas, index, jitterWu) {
  await page.evaluate((j) => window.__smashy.setCameraJitter(j, 0), index % 2 === 0 ? 0 : jitterWu);
  await page.waitForTimeout(FRAME_SETTLE_MS);
  const png = await canvas.screenshot();
  const raw = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { png, raw };
}

// ---------------------------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------------------------

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = join(OUT_ROOT, args.run);
  mkdirSync(outDir, { recursive: true });

  let devServer = null;
  if (!(await isServerUp())) {
    console.log(`[flicker] no dev server at ${DEV_URL} — starting one (pnpm exec vite)…`);
    devServer = spawn('pnpm', ['exec', 'vite', '--port', '5173', '--strictPort'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    devServer.stdout.on('data', () => {});
    devServer.stderr.on('data', (chunk) => process.stderr.write(chunk));
    await waitForServer(SERVER_READY_TIMEOUT_MS);
  } else {
    console.log(`[flicker] reusing existing dev server at ${DEV_URL}.`);
  }

  const runStart = Date.now();
  const consoleErrors = [];
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
  let exitCode;
  const probeFrames = Math.min(FRAMES_PROBE, args.frames);
  const results = {
    run: args.run,
    startedAt: new Date().toISOString(),
    config: {
      viewport: VIEWPORT,
      jitterWu: args.jitter,
      framesFull: args.frames,
      framesProbe: probeFrames,
      channelDelta: CHANNEL_DELTA,
      hotPixelMinToggles: HOT_PIXEL_MIN_TOGGLES,
      tilePx: TILE_PX,
      tileHotFraction: TILE_HOT_FRACTION,
      tileMinHotPixels: Math.ceil(TILE_PX * TILE_PX * TILE_HOT_FRACTION),
      clusterMinTiles: CLUSTER_MIN_TILES,
      clusterRequireSolidBlock: CLUSTER_REQUIRE_SOLID_BLOCK,
      clusterSolidBlockTiles: CLUSTER_SOLID_BLOCK_TILES,
      minHotRadiusPx: MIN_HOT_RADIUS_PX,
      parallaxMaxShiftPx: PARALLAX_MAX_SHIFT_PX,
      parallaxMinShiftPx: PARALLAX_MIN_SHIFT_PX,
      parallaxExplainFraction: PARALLAX_EXPLAIN_FRACTION,
      edgeCrawlHugDistPx: EDGE_CRAWL_HUG_DIST_PX,
      edgeCrawlDilatePx: EDGE_CRAWL_DILATE_PX,
      edgeCrawlHugFraction: EDGE_CRAWL_HUG_FRACTION,
      nearfieldBottomPx: NEARFIELD_BOTTOM_PX,
      nearfieldMinExplained: NEARFIELD_MIN_EXPLAINED,
      probeMinToggles: PROBE_MIN_TOGGLES,
      probeTileHotFraction: PROBE_TILE_HOT_FRACTION,
      probeTileMinHotPixels: Math.ceil(TILE_PX * TILE_PX * PROBE_TILE_HOT_FRACTION),
      probeClusterMinTiles: PROBE_CLUSTER_MIN_TILES,
      frameSettleMs: FRAME_SETTLE_MS,
      quiescence: {
        minMs: QUIESCENCE_MIN_MS,
        maxMs: QUIESCENCE_MAX_MS,
        pollMs: QUIESCENCE_POLL_MS,
        speedMps: QUIESCENCE_SPEED_MPS,
        consecutiveReads: QUIESCENCE_CONSEC,
      },
      cropPadPx: CROP_PAD_PX,
      expectedVantageCount: EXPECTED_VANTAGE_COUNT,
    },
    gates: {},
    vantages: [],
    hotspots: [],
    // Run-level rollups of stage-3/stage-4 dismissals (also mirrored per vantage). NOT hotspots:
    // the verdict, the exit code and the contact sheet all ignore both arrays.
    parallaxRejected: [],
    edgeCrawlRejected: [],
    triagedBenign: [],
    worstFirst: [],
  };

  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e)}`));
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });

    console.log('[flicker] booting the game…');
    if (!(await bootToPlaying(page))) {
      throw new Error('never reached PLAYING (is window.__smashy present? dev build only)');
    }
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.__smashy.setInvincible(true));
    await page.addStyleTag({ content: CAPTURE_CHROME_CSS });

    // Sweep configuration: no moving agents. Their poses are time-of-run dependent, so leaving them
    // live makes x2 determinism impossible — and they are not placement (plan decision 5).
    await page.evaluate(() => {
      window.__smashy.setCivTraffic(false);
      window.__smashy.setTransit(false);
    });
    await page.waitForTimeout(1500);
    const agents = await page.evaluate(() => {
      const t = window.__smashy.torontoTransitSlots();
      return { traffic: window.__smashy.trafficCount(), bus: t.bus.length, streetcar: t.streetcar.length };
    });
    results.gates.agentsCleared = { ...agents, pass: agents.traffic === 0 && agents.bus === 0 && agents.streetcar === 0 };
    if (!results.gates.agentsCleared.pass) {
      throw new Error(`moving agents still live: ${JSON.stringify(agents)} — the sweep cannot be deterministic`);
    }

    const allVantages = await page.evaluate(() => window.__smashy.flickerVantages());
    results.gates.vantageCount = {
      actual: allVantages.length,
      expected: EXPECTED_VANTAGE_COUNT,
      pass: allVantages.length === EXPECTED_VANTAGE_COUNT,
    };
    if (!results.gates.vantageCount.pass) {
      console.error(
        `[flicker] WARNING: flickerVantages() returned ${allVantages.length}, expected ${EXPECTED_VANTAGE_COUNT} — ` +
          'the lattice changed; comparisons against older results.json files are invalid.',
      );
    }

    let vantages = allVantages;
    if (args.vantages) {
      const wanted = new Set(args.vantages);
      vantages = allVantages.filter((v) => wanted.has(v.id));
      const missing = args.vantages.filter((id) => !allVantages.some((v) => v.id === id));
      if (missing.length > 0) throw new Error(`unknown vantage id(s): ${missing.join(', ')}`);
    }
    if (args.slice) {
      const { i, n } = args.slice;
      const start = Math.floor(((i - 1) * vantages.length) / n);
      const end = Math.floor((i * vantages.length) / n);
      vantages = vantages.slice(start, end);
      results.slice = { i, n, start, end };
    }
    console.log(`[flicker] sweeping ${vantages.length} vantage(s) — output: ${outDir}`);

    const canvas = page.locator('.game-canvas-container canvas[aria-label="3D driving game canvas"]');
    const cropJobs = [];

    for (let vi = 0; vi < vantages.length; vi++) {
      const v = vantages[vi];
      const vStart = Date.now();
      const record = { id: v.id, source: v.source, x: v.x, z: v.z };

      await page.evaluate(() => {
        window.__smashy.setFreezeWorld(false);
        window.__smashy.setCameraJitter(0, 0);
      });
      await teleport(page, v.x, v.z);
      record.settle = await settleToQuiescence(page);

      const machine = await page.evaluate(() => window.__smashy.getMachine());
      record.machine = machine;
      if (machine !== 'PLAYING') {
        // A vantage that ended the run (water sensor, out-of-bounds) cannot be measured — recover
        // rather than silently photographing a frozen GAMEOVER screen and calling it clean.
        await page.keyboard.press('r');
        await page.waitForTimeout(2500);
        await page.evaluate(() => window.__smashy.setInvincible(true));
        record.skipped = `machine=${machine}`;
        record.totalMs = Date.now() - vStart;
        results.vantages.push(record);
        console.log(`[flicker] ${vi + 1}/${vantages.length} ${v.id}: SKIPPED (${machine})`);
        continue;
      }

      await page.evaluate(() => window.__smashy.setFreezeWorld(true));
      record.occlusion = await page.evaluate(() => {
        const s = window.__smashy.occlusionV2Stats();
        return { fadedTargets: s.fadedTargets, minFade: s.minFade, antiClipPullM: s.antiClipPullM };
      });
      record.perf = await page.evaluate(() => window.__smashy.readPerf());

      // --- capture + accumulate ---------------------------------------------------------------
      let captureMs = 0;
      let analyzeMs = 0;
      const pngs = [];
      const raws = [];
      let toggles = null;
      let pixelCount = 0;
      let channels = 4;
      let width = VIEWPORT.width;
      let height = VIEWPORT.height;
      const changedPerTransition = [];
      let sizeError = null;

      const grab = async (index) => {
        const t0 = Date.now();
        const { png, raw } = await captureFrame(page, canvas, index, args.jitter);
        captureMs += Date.now() - t0;
        if (index === 0) {
          width = raw.info.width;
          height = raw.info.height;
          channels = raw.info.channels;
          pixelCount = width * height;
          if (width !== VIEWPORT.width || height !== VIEWPORT.height) {
            sizeError = `unexpected capture size ${width}x${height}`;
            return;
          }
          toggles = new Uint8Array(pixelCount);
        } else if (raw.info.width !== width || raw.info.height !== height) {
          sizeError = `capture size changed mid-sequence (${raw.info.width}x${raw.info.height})`;
          return;
        }
        pngs.push(png);
        raws.push(raw.data);
        if (index > 0) {
          const t1 = Date.now();
          changedPerTransition.push(accumulateTransition(toggles, raws[index - 1], raws[index], pixelCount, channels));
          analyzeMs += Date.now() - t1;
        }
      };

      for (let i = 0; i < probeFrames && !sizeError; i++) await grab(i);
      if (sizeError) {
        record.skipped = sizeError;
        record.totalMs = Date.now() - vStart;
        results.vantages.push(record);
        await page.evaluate(() => window.__smashy.setFreezeWorld(false));
        continue;
      }

      let t = Date.now();
      const probe = analyzeToggles(toggles, width, height, {
        minToggles: PROBE_MIN_TOGGLES,
        tileHotFraction: PROBE_TILE_HOT_FRACTION,
        minClusterTiles: PROBE_CLUSTER_MIN_TILES,
        requireSolidBlock: CLUSTER_REQUIRE_SOLID_BLOCK,
        solidBlockTiles: CLUSTER_SOLID_BLOCK_TILES,
      });
      analyzeMs += Date.now() - t;
      record.probe = {
        frames: pngs.length,
        hotPixels: probe.hotPixels,
        hotTiles: probe.hotTiles,
        candidates: probe.clusters.length,
        thinRejected: probe.rejectedThinClusters,
      };

      // Escalate to the full sequence ONLY when the (looser) probe saw a candidate.
      const escalate = probe.clusters.length > 0 && args.frames > probeFrames;
      record.escalated = escalate;
      if (escalate) {
        for (let i = probeFrames; i < args.frames && !sizeError; i++) await grab(i);
      }
      record.frames = pngs.length;
      record.captureMs = captureMs;

      // Self-check: the stimulus must land (frame 0 vs 1 changed) and land COMPLETELY (frame 0 vs 2
      // — the same jitter state — must be pixel-identical).
      record.stimulusChangedPx = changedPerTransition[0] ?? null;
      t = Date.now();
      record.stabilityChangedPx =
        raws.length >= 3 ? changedInRect(raws[0], raws[2], { x: 0, y: 0, w: width, h: height }, width, channels) : null;
      record.stable = record.stabilityChangedPx === 0;

      const verdict = analyzeToggles(toggles, width, height, {
        minToggles: HOT_PIXEL_MIN_TOGGLES,
        tileHotFraction: TILE_HOT_FRACTION,
        minClusterTiles: CLUSTER_MIN_TILES,
        requireSolidBlock: CLUSTER_REQUIRE_SOLID_BLOCK,
        solidBlockTiles: CLUSTER_SOLID_BLOCK_TILES,
      });
      record.hotPixels = verdict.hotPixels;
      record.hotTiles = verdict.hotTiles;
      record.thinClustersRejected = verdict.rejectedThinClusters;
      record.thinRadiusRejected = 0;
      record.hotspots = 0;
      // Stage-3/stage-4 dismissals for this vantage (full entries — a per-vantage read is
      // self-contained).
      record.parallaxRejected = [];
      record.edgeCrawlRejected = [];
      record.triagedBenign = [];

      if (verdict.clusters.length > 0) {
        const dt = distanceTransform(toggles, HOT_PIXEL_MIN_TOGGLES, width, height);
        // Stage 4's persistent-edge field, built lazily once per worst-pair index.
        const edgeDtCache = new Map();
        for (const cluster of verdict.clusters) {
          let maxDt = 0;
          for (let y = cluster.rect.y; y < cluster.rect.y + cluster.rect.h; y++) {
            for (let x = cluster.rect.x; x < cluster.rect.x + cluster.rect.w; x++) {
              const d = dt[y * width + x];
              if (d > maxDt) maxDt = d;
            }
          }
          const maxRadiusPx = +(maxDt / 3).toFixed(2);
          if (maxRadiusPx < MIN_HOT_RADIUS_PX) {
            // A fat EDGE, not an area: 62.5%-hot tiles can come from a thick anti-aliased diagonal,
            // but no disc of the gate's radius fits inside one. Counted, not reported.
            record.thinRadiusRejected++;
            continue;
          }
          // Worst frame pair = the transition with the most changed pixels inside the cluster. Also
          // the pair stage 3 registers, and the pair the evidence crop shows.
          let bestT = 0;
          let bestChanged = -1;
          for (let i = 0; i + 1 < raws.length; i++) {
            const c = changedInRect(raws[i], raws[i + 1], cluster.rect, width, channels);
            if (c > bestChanged) {
              bestChanged = c;
              bestT = i;
            }
          }

          // STAGE 3 — registration gate. A disocclusion-parallax band is one silhouette that MOVED:
          // a single global shift reproduces it. A z-fight is a WINNER SWAP: no shift reproduces it.
          const hotIdx = clusterHotPixelIndices(toggles, HOT_PIXEL_MIN_TOGGLES, cluster.members, verdict.tilesX, width, height);
          const reg = classifyParallax(hotIdx, raws[bestT], raws[bestT + 1], width, height, channels);

          // STAGE 4 — judged only when stage 3 keeps the cluster (a parallax dismissal already
          // wins). 4a: persistent-edge crawl; 4b: near-field stimulus parallax.
          let crawl = { crawl: false, hugFraction: 0 };
          let nearfield = false;
          if (!reg.parallax) {
            let edgeDt = edgeDtCache.get(bestT);
            if (!edgeDt) {
              edgeDt = persistentEdgeDistance(raws[bestT], raws[bestT + 1], width, height, channels);
              edgeDtCache.set(bestT, edgeDt);
            }
            crawl = classifyEdgeCrawl(hotIdx, edgeDt);
            if (!crawl.crawl) {
              nearfield =
                cluster.rect.y + cluster.rect.h >= height - NEARFIELD_BOTTOM_PX &&
                1 - reg.residualFraction >= NEARFIELD_MIN_EXPLAINED;
            }
          }

          // Hand-triaged ledger match (see TRIAGED_BENIGN): vantage + region + size must ALL fit.
          const ledger =
            !reg.parallax && !crawl.crawl && !nearfield
              ? TRIAGED_BENIGN.find(
                  (t) =>
                    t.vantageId === v.id &&
                    cluster.rect.x >= t.within.x &&
                    cluster.rect.y >= t.within.y &&
                    cluster.rect.x + cluster.rect.w <= t.within.x + t.within.w &&
                    cluster.rect.y + cluster.rect.h <= t.within.y + t.within.h &&
                    maxRadiusPx <= t.radiusCapPx,
                )
              : undefined;

          const crop = padRect(cluster.rect, width, height);
          const kind = reg.parallax ? 'parallax' : crawl.crawl ? 'crawl' : nearfield ? 'nearfield' : ledger ? 'triaged' : 'hotspot';
          const cropName = `${kind}-${v.id}-${cluster.rect.x}x${cluster.rect.y}.png`;
          cropJobs.push(writeHotspotCrop(pngs[bestT], pngs[bestT + 1], crop, join(outDir, cropName)));
          const entry = {
            vantageId: v.id,
            source: v.source,
            vantage: { x: v.x, z: v.z },
            tileRect: cluster.tileRect,
            rect: cluster.rect,
            tiles: cluster.tiles,
            hotPixels: cluster.hotPixels,
            maxRadiusPx,
            meanToggles: cluster.meanToggles,
            maxToggles: cluster.maxToggles,
            worstPair: { a: bestT, b: bestT + 1, changedInRect: bestChanged },
            cropRect: crop,
            crop: cropName,
            occlusion: record.occlusion,
          };
          if (reg.parallax) {
            // Explained by translation → NOT a flicker finding. Recorded (with its shift, so the
            // dismissal is auditable) and photographed, but it does not touch the verdict.
            const rejection = {
              ...entry,
              shift: { dx: reg.dx, dy: reg.dy },
              shiftPx: reg.shiftPx,
              residual: reg.residual,
              residualFraction: reg.residualFraction,
              residualZeroFraction: reg.residualZeroFraction,
            };
            record.parallaxRejected.push(rejection);
            results.parallaxRejected.push(rejection);
            continue;
          }
          if (crawl.crawl || nearfield) {
            // STAGE 4 dismissal. 4a: the cluster's hot pixels hug edges present in BOTH frames —
            // sub-pixel re-rasterization of persistent geometry. 4b: a bottom-edge cluster whose
            // hot pixels stage 3's shift already mostly explains — the stimulus's own near-field
            // displacement. Recorded (with the metric that dismissed it, so the dismissal is
            // auditable) and photographed, but neither touches the verdict.
            const rejection = {
              ...entry,
              subClass: crawl.crawl ? 'edge-crawl' : 'nearfield-parallax',
              hugFraction: crawl.hugFraction,
              shift: { dx: reg.dx, dy: reg.dy },
              shiftPx: reg.shiftPx,
              registrationResidualFraction: reg.residualFraction,
            };
            record.edgeCrawlRejected.push(rejection);
            results.edgeCrawlRejected.push(rejection);
            continue;
          }
          if (ledger) {
            const rejection = {
              ...entry,
              class: ledger.class,
              registrationResidualFraction: reg.residualFraction,
            };
            record.triagedBenign.push(rejection);
            results.triagedBenign.push(rejection);
            continue;
          }
          record.hotspots++;
          results.hotspots.push({
            ...entry,
            registration: {
              shift: { dx: reg.dx, dy: reg.dy },
              shiftPx: reg.shiftPx,
              residual: reg.residual,
              residualFraction: reg.residualFraction,
              residualZeroFraction: reg.residualZeroFraction,
            },
            edgeCrawl: { hugFraction: crawl.hugFraction },
          });
        }
      }
      analyzeMs += Date.now() - t;
      record.analyzeMs = analyzeMs;

      if (args.dumpFrames) {
        for (let i = 0; i < pngs.length; i++) {
          cropJobs.push(sharp(pngs[i]).png().toFile(join(outDir, `frame-${v.id}-${i}.png`)));
        }
      }

      await page.evaluate(() => window.__smashy.setFreezeWorld(false));
      record.totalMs = Date.now() - vStart;
      results.vantages.push(record);
      console.log(
        `[flicker] ${vi + 1}/${vantages.length} ${v.id} (${v.source}): ` +
          `hotPx ${record.hotPixels} · hotTiles ${record.hotTiles} · hotspots ${record.hotspots}` +
          `${record.parallaxRejected.length > 0 ? ` · parallax-rejected ${record.parallaxRejected.length}` : ''}` +
          `${record.edgeCrawlRejected.length > 0 ? ` · crawl-rejected ${record.edgeCrawlRejected.length}` : ''}` +
          `${escalate ? ' [escalated]' : ''}${record.stable ? '' : ` · UNSTABLE ${record.stabilityChangedPx}px`} · ${record.totalMs} ms`,
      );
    }

    await page.evaluate(() => {
      window.__smashy.setCameraJitter(0, 0);
      window.__smashy.setFreezeWorld(false);
      window.__smashy.setCivTraffic(true);
      window.__smashy.setTransit(true);
    });

    await Promise.all(cropJobs);

    // Deterministic report order: vantage id, then tile y, then tile x.
    const byVantageThenTile = (a, b) =>
      a.vantageId.localeCompare(b.vantageId) || a.tileRect.y0 - b.tileRect.y0 || a.tileRect.x0 - b.tileRect.x0;
    results.hotspots.sort(byVantageThenTile);
    results.parallaxRejected.sort(byVantageThenTile);
    results.edgeCrawlRejected.sort(byVantageThenTile);
    results.triagedBenign.sort(byVantageThenTile);
    // Severity ranking (what a human should look at first), with a deterministic tiebreak.
    results.worstFirst = [...results.hotspots]
      .sort(
        (a, b) =>
          b.hotPixels - a.hotPixels ||
          b.maxRadiusPx - a.maxRadiusPx ||
          b.tiles - a.tiles ||
          a.vantageId.localeCompare(b.vantageId) ||
          a.rect.y - b.rect.y ||
          a.rect.x - b.rect.x,
      )
      .map((h) => ({
        vantageId: h.vantageId,
        source: h.source,
        vantage: h.vantage,
        rect: h.rect,
        hotPixels: h.hotPixels,
        maxRadiusPx: h.maxRadiusPx,
        meanToggles: h.meanToggles,
        tiles: h.tiles,
        // Stage 3's numbers for a cluster that SURVIVED it: no shift explained it (see
        // classifyParallax) — carried into the ranking so triage can see the gate was applied.
        registration: h.registration,
        crop: h.crop,
      }));

    results.contactSheet = await writeContactSheet(results.worstFirst, outDir, join(outDir, 'contact-sheet.png'));

    const unstable = results.vantages.filter((r) => r.stable === false).map((r) => r.id);
    const skipped = results.vantages.filter((r) => r.skipped).map((r) => ({ id: r.id, reason: r.skipped }));
    results.totals = {
      vantagesRun: results.vantages.length,
      vantagesMeasured: results.vantages.filter((r) => !r.skipped).length,
      vantagesSkipped: skipped.length,
      vantagesEscalated: results.vantages.filter((r) => r.escalated).length,
      vantagesWithHotspots: results.vantages.filter((r) => (r.hotspots ?? 0) > 0).length,
      vantagesWithParallaxRejects: results.vantages.filter((r) => (r.parallaxRejected?.length ?? 0) > 0).length,
      vantagesWithCrawlRejects: results.vantages.filter((r) => (r.edgeCrawlRejected?.length ?? 0) > 0).length,
      hotspots: results.hotspots.length,
      parallaxRejected: results.parallaxRejected.length,
      edgeCrawlRejected: results.edgeCrawlRejected.length,
      triagedBenign: results.triagedBenign.length,
      unstableVantages: unstable,
      skipped,
      medianVantageMs: median(results.vantages.map((r) => r.totalMs ?? 0)),
      totalCaptureMs: results.vantages.reduce((s, r) => s + (r.captureMs ?? 0), 0),
      totalAnalyzeMs: results.vantages.reduce((s, r) => s + (r.analyzeMs ?? 0), 0),
      totalSettleMs: results.vantages.reduce((s, r) => s + (r.settle?.ms ?? 0), 0),
    };
    results.consoleErrors = consoleErrors;
    results.wallClockMs = Date.now() - runStart;
    results.finishedAt = new Date().toISOString();
    results.verdict =
      results.hotspots.length === 0 && consoleErrors.length === 0 && unstable.length === 0 && results.gates.vantageCount.pass
        ? 'CLEAN'
        : 'HOTSPOTS';

    writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));

    console.log('\n[flicker] ------------------------------------------------------------------');
    console.log(
      `[flicker] ${results.verdict}: ${results.hotspots.length} hotspot(s) across ` +
        `${results.totals.vantagesMeasured} measured vantage(s) in ${(results.wallClockMs / 1000).toFixed(1)} s ` +
        `(median ${results.totals.medianVantageMs} ms/vantage, ${results.totals.vantagesEscalated} escalated, ` +
        `${results.parallaxRejected.length} parallax-rejected, ${results.edgeCrawlRejected.length} crawl-rejected).`,
    );
    for (const w of results.worstFirst.slice(0, CONTACT_SHEET_MAX)) {
      console.log(
        `[flicker]   ${w.vantageId} @ (${w.rect.x},${w.rect.y}) ${w.rect.w}x${w.rect.h} — ` +
          `${w.hotPixels} hot px, r${w.maxRadiusPx}, ${w.tiles} tiles, mean ${w.meanToggles} toggles, ` +
          `best shift (${w.registration.shift.dx},${w.registration.shift.dy}) leaves ` +
          `${(w.registration.residualFraction * 100).toFixed(1)}% unexplained → ${w.crop}`,
      );
    }
    for (const p of results.parallaxRejected) {
      console.log(
        `[flicker]   parallax-rejected: ${p.vantageId} @ (${p.rect.x},${p.rect.y}) ${p.rect.w}x${p.rect.h} — ` +
          `${p.hotPixels} hot px, r${p.maxRadiusPx}, shift (${p.shift.dx},${p.shift.dy}) = ${p.shiftPx} px explains ` +
          `${((1 - p.residualFraction) * 100).toFixed(1)}% → ${p.crop}`,
      );
    }
    for (const cRej of results.edgeCrawlRejected) {
      console.log(
        `[flicker]   ${cRej.subClass}-rejected: ${cRej.vantageId} @ (${cRej.rect.x},${cRej.rect.y}) ${cRej.rect.w}x${cRej.rect.h} — ` +
          `${cRej.hotPixels} hot px, r${cRej.maxRadiusPx}, ` +
          `${cRej.subClass === 'edge-crawl' ? `${(cRej.hugFraction * 100).toFixed(1)}% edge-hugging` : `shift (${cRej.shift.dx},${cRej.shift.dy}) explains ${((1 - cRej.registrationResidualFraction) * 100).toFixed(1)}% at the bottom edge`} ` +
          `→ ${cRej.crop}`,
      );
    }
    for (const tRej of results.triagedBenign) {
      console.log(
        `[flicker]   triaged-benign: ${tRej.vantageId} @ (${tRej.rect.x},${tRej.rect.y}) ${tRej.rect.w}x${tRej.rect.h} — ` +
          `${tRej.hotPixels} hot px, r${tRej.maxRadiusPx} — ${tRej.class} → ${tRej.crop}`,
      );
    }
    if (unstable.length > 0) {
      console.error(`[flicker] FAIL: unstable vantage(s) (same-jitter frames differed): ${unstable.join(', ')}`);
    }
    if (skipped.length > 0) console.error(`[flicker] note: ${skipped.length} vantage(s) skipped: ${JSON.stringify(skipped)}`);
    if (consoleErrors.length > 0) {
      console.error(`[flicker] FAIL: ${consoleErrors.length} console/page error(s):`);
      for (const e of consoleErrors.slice(0, 20)) console.error(`  - ${e}`);
    }
    console.log(`[flicker] results: ${join(outDir, 'results.json')}`);

    exitCode = results.verdict === 'CLEAN' ? 0 : 1;
  } catch (err) {
    console.error('[flicker] FAIL:', err instanceof Error ? err.stack : err);
    results.error = String(err);
    results.consoleErrors = consoleErrors;
    results.wallClockMs = Date.now() - runStart;
    try {
      writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
    } catch {
      /* the thrown error above is the useful one */
    }
    exitCode = 1;
  } finally {
    await browser.close();
    if (devServer) devServer.kill();
  }

  process.exit(exitCode ?? 1);
}

main().catch((err) => {
  console.error('[flicker] unexpected failure:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
