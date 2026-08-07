// Toronto map v2 — road-class widths, render colours, graph tuning, and the spawn point.
// Single source of truth for the "thermometer" street grid. Consumed by world/toronto/streets.ts
// (street table + ribbons) and roadGraph.ts (traffic graph). Pure data, no three/react —
// deterministic.
//
// PHASE 25.6 SUPERSESSION (D1, CLAUDE.md CITY-PACK REAPPROACH rule 4): the spec's §3a width
// table (docs/map/TORONTO-MAP-SPEC-v2.md — see the addendum at that table) and its A.6
// "defer exact widths to playtest" note are formally superseded. Widths are now DERIVED from
// CAR_REF.widthWu (config/cityPackScale.ts — the same sedan-envelope reference the city-pack
// scale system uses), whole-car-graded so every class reads as an intuitive "N cars wide" and
// the class ordering (spine > artery > major > minor) still makes Yonge read first (§2). A.6's
// tune path survives in spirit: if the 3.5-car minor (7.7 wu) clips during drifts, widen it to
// 4 cars (8.8) and re-test before touching anything else — nothing downstream is hand-pinned
// (streets/districts/roadGraph/named/places/tunnel are all street-referenced, so a width edit
// here alone re-flows the whole map).
//
// PHASE 75 (feel overhaul): that tune path was exercised at full scale — every multiplier
// DOUBLED and the two widest classes gained a planted median (ROAD_MEDIAN below). The
// derivation, the "N cars wide" grading and the class ordering are untouched; only the car
// counts moved. See ROAD_CLASSES' own comment for the directive, the measured land trade and
// the reason the re-graded LANE_OFFSET_WU had to lose its cap in the same edit.

import { CAR_REF, resolveCityPackScale } from './cityPackScale';
import { getCityPackModel } from '../assets/cityPackManifest';

/**
 * Part-8 (D1, user directive 2026-07-18 — "density/life flip"): the whole map compacts ~0.6×
 * linearly so the city reads dense rather than empty. `scale` is the ONE knob — projection.ts
 * derives every live control-y / zone-boundary / EW_M_PER_WU from it, and polygon.ts /
 * torontoSceneHelpers.ts re-derive their rects from the same source via `scaleAboutYonge`. The
 * FOLD zone (Sheppard→Bloor, the midtown "made honest" corridor) is EXEMPT — its span stays the
 * spec's 660 wu untouched; only its START shifts to sit right after the compacted North York
 * zone. Absolute invariants that do NOT scale: the 80 wu camera-clamp padding (polygon.ts) and
 * spawn-ring metres (config/spawn.ts) — both re-anchor to the smaller polygon automatically.
 */
export const DENSITY = {
  scale: 0.6,
} as const;

/**
 * Part-8 (D4) height cut: named buildings (world/toronto/namedBuildings.ts) apply this AFTER
 * the §3c hGame() curve, so building-specs.json's expected_game_h_wu cross-check stays a pure
 * function of the curve (data.test.ts / heightCurve.test.ts untouched). Heroes (CN Tower, Rogers
 * Centre — world/toronto/heroes.ts) are exempt; district filler heights are scaled separately in
 * config/torontoDistricts.ts's heightRangeM table.
 */
export const NAMED_HEIGHT_SCALE = 0.6 as const;

/**
 * Part-8 (D3) road diet: multipliers dropped from 7/6/5/3.5 car-widths to 5/4.5/4/3 — narrower
 * streets read denser at the same CAR_REF.widthWu reference. Ordering (spine > artery > major >
 * minor) is unchanged so Yonge still reads first (§2). A.6's tune path survives: if the 3-car
 * minor (6.6 wu) clips during drifts, widen it and re-test — nothing downstream is hand-pinned.
 *
 * PHASE 75 RE-GRADE (feel overhaul, D1 — user directive 2026-08-04: "Lets make the roads double,
 * with a grass median or something", clarified the same day as "double the roads as in just
 * expand the current roads", i.e. WIDEN THE EXISTING RIBBONS IN PLACE — no new streets, no split
 * carriageways, no centreline/projection/YONGE_X change). Every Part-8 multiplier doubles:
 *
 *     spine 5 → 10 cars (11.0 → 22.0)   artery 4.5 → 9 (9.9 → 19.8)
 *     major 4 →  8 cars ( 8.8 → 17.6)   minor  3   → 6 (6.6 → 13.2)
 *
 * WHY (`.planning/feel-overhaul-overview.md` D2): the Part-8 diet multiplied with Part-8's
 * density into a functionally single-lane city — the Phase 74 telemetry baseline covered 92 m in
 * 60 s on `downtownDense` at a commanded 15 m/s (vs 454-581 m on the empty spine), a 6.6 wu minor
 * is closed by one immovable civilian, and the @20 turn-radius probe REFUSED before the car moved
 * (it needs 8.6 m of lateral room; the widest ribbon offered 8.5). Making turn radius measurable
 * again is this phase's own acceptance test.
 *
 * THE LAND TRADE, MEASURED (phase-75-plan.md, from the live street table + PLAYABLE_POLYGON —
 * stated rather than hidden, per the part file): net road area (intersection double-count removed)
 * 192,171 → 373,040 wu² inside a fixed 6,780,000 wu² polygon, i.e. 2.83 % → 5.50 % of the map, so
 * buildable land drops 2.75 %. The part file's alternative (widen spine/artery/major only, leave
 * minors intimate) was REJECTED on measurement: it saves 14,365 wu² — 8 % of the widening budget,
 * because the eight minor streets are short — while preserving the worst navigability offender.
 * Centrelines and spans do not move, so frontage LENGTH is unchanged; what shrinks is block-
 * interior depth (every frontage line steps out by 5.5 / 4.95 / 4.4 / 3.3 wu per class).
 *
 * Ordering (spine > artery > major > minor) is preserved and law-tested. Nothing downstream is
 * hand-pinned — a width edit here alone re-flows ribbons, paint, crosswalks, the traffic graph,
 * frontage, furniture and the world edge.
 */
export const ROAD_CLASSES = {
  spine: CAR_REF.widthWu * 10, // Yonge — 10 player-car widths = 22.0
  artery: CAR_REF.widthWu * 9, // University, Bloor, Spadina — 9 cars = 19.8
  major: CAR_REF.widthWu * 8, // King/Queen/Dundas/College/Front/Bay/Church/Jarvis/Bathurst/Finch/Sheppard/QueensQuay — 8 cars = 17.6
  minor: CAR_REF.widthWu * 6, // Richmond/Adelaide/John/Portland/York/Bremner/ParkHome — 6 cars = 13.2
} as const;

export type RoadClass = keyof typeof ROAD_CLASSES;

/**
 * THE CITY'S ONE KERB HEIGHT (wu) and its one kerb-face tone. Hoisted out of the blocks below
 * because two of them need it — the raised sidewalk band (SIDEWALK, Phase 25.8 D5) and the Phase
 * 75 median strip (ROAD_MEDIAN) — and an object literal cannot reference another's fields. Two
 * hand-typed 0.12s would be exactly the silent-drift class CLAUDE.md's "no magic numbers" rule
 * exists to prevent: a kerb is a kerb, and the median's kerb must step up by the same amount the
 * sidewalk's does or the two read as different materials.
 *
 * NOT A LADDER RUNG (config/layering.ts's "NOT A RUNG" note): this is a geometry HEIGHT the car
 * can see and (visually) climb, not a coplanarity epsilon. layeringGuard.test.ts exempts the
 * derivation by name.
 */
const CURB_HEIGHT_WU = 0.12;
const CURB_FACE_COLOR = '#3f454e';

/**
 * How a road class gets a median:
 *   • 'always' — every street of the class carries one (spine, artery).
 *   • 'optIn'  — only streets whose STREET_DEFS row sets `median: true` (major). The mechanism is
 *                wired and law-tested; NO street opts in as of Phase 75 (see ROAD_MEDIAN below).
 *   • 'never'  — no median, and an opt-in flag on such a street is a loud build error, not a
 *                silently-ignored field (minor).
 */
export type MedianPolicy = 'always' | 'optIn' | 'never';

/** Per-class median width (wu) — see ROAD_MEDIAN. Hoisted so LANE_OFFSET_WU (below) can derive
 * the carriageway centre from it; `minor` is 0 because a 'never' class has no width to give. */
const MEDIAN_WIDTH_WU = {
  spine: CAR_REF.widthWu,
  artery: CAR_REF.widthWu,
  major: CAR_REF.widthWu,
  minor: 0,
} as const satisfies Record<RoadClass, number>;

/** Per-class median policy — see ROAD_MEDIAN / MedianPolicy. Hoisted for the same reason. */
const MEDIAN_POLICY = {
  spine: 'always',
  artery: 'always',
  major: 'optIn',
  minor: 'never',
} as const satisfies Record<RoadClass, MedianPolicy>;

/**
 * PHASE 75 — the grass median (user directive 2026-08-04, "double the roads, with a grass
 * median or something"). A planted strip INSIDE the widened ribbon — never a second road, never
 * a gap between split carriageways (the part file's scope clarification). world/toronto/
 * streets.ts resolves the class policy + a street's own opt-in flag into ONE number per street
 * (`Street.medianWidth` / `medianHalfWidth`), so every downstream consumer reads a resolved width
 * instead of re-deriving the rule.
 *
 * WIDTH: exactly one player-car width (CAR_REF.widthWu, 2.2 wu) on every class that carries one —
 * the same reference the ribbons themselves are graded against, so "the median is one car wide"
 * is a fact the player can read off the road. Never a literal.
 *
 * WHICH CLASSES (D3): spine + artery only. `major` is 'optIn' — the mechanism exists so a future
 * phase can plant, say, University-grade boulevard treatment on a named major without touching
 * code, but nothing opts in this phase: a median on a 17.6 wu major would leave 7.7 wu
 * carriageways, re-creating the exact single-lane problem this phase exists to fix. `minor` never.
 *
 * GEOMETRY (T1 owns the emission): a raised band modelled on the sidewalk's — a flat grass top
 * face at `curbHeightWu` over a road-facing kerb chamfer in `curbFaceColor`. Deliberately NOT a
 * GROUND_STACK rung: the median sits inside the ribbon footprint, and the asphalt quad covers the
 * whole ribbon, so a flat quad on any rung BELOW `roadSurface` would be buried under its own road.
 * It rides the same "geometry HEIGHT, not a coplanarity epsilon" path the raised sidewalk band
 * already proves (config/layering.ts's "NOT A RUNG" note) — which is also why this phase adds no
 * rung and moves nobody else's.
 */
export const ROAD_MEDIAN = {
  /** Per-class median width (wu) — one car wide wherever a class carries one; 0 on 'never'. */
  widthWu: MEDIAN_WIDTH_WU,
  /** Per-class policy; the per-street override applies only where this reads 'optIn'. */
  policy: MEDIAN_POLICY,
  /** Raised top-face height above the asphalt (wu) — the city's one kerb step (see
   * CURB_HEIGHT_WU). Same height as the sidewalk band by design: same kerb, same material. */
  curbHeightWu: CURB_HEIGHT_WU,
  /** The vertical road-facing kerb FACE colour — the sidewalk's fake-AO seam tone, so both kerbs
   * in the frame read as one material (see CURB_FACE_COLOR). */
  curbFaceColor: CURB_FACE_COLOR,
  /** Grass top-face colour. Deliberately the same blue-hour green as the park grass
   * (TorontoScene's PARK_GRASS_COLOR) — the city has one grass tone. Not imported: config must
   * never depend on world/, so this is a documented mirror, re-checked whenever either moves. */
  grassColor: '#3f5236',
  /**
   * KILL-SWITCH, modelled on SIDEWALK.colliders: mount matching cuboid colliders under the raised
   * strip (top at curbHeightWu). false ⇒ visual-only — the car drives over the median with a
   * 0.12 wu visual sink, exactly as it already does on sidewalks.
   *
   * DRIVE-FEEL GATE VERDICT: **PENDING T5 MEASUREMENT.** Task T5 runs the Phase 37 curb-hop probe
   * trio (creep / ram at speed / drop) at candidate heights and writes the measured verdict here,
   * replacing this paragraph. Shipping `false` until then is not a guess — it is the value both
   * precedents predict:
   *   • SIDEWALK.colliders = false (Phase 25.8 drive-feel gate): a **0.12 wu** curb hit at ~19 m/s
   *     LAUNCHED the raycast vehicle ~0.8 wu on a perpendicular ram and, worse, launched-then-
   *     CAUGHT (stalled) it on a 45° approach.
   *   • Phase 37's **0.9 wu** jersey rows were simply CURB-HOPPED — the suspension rays hit the top
   *     face and lifted the chassis smoothly over — until the row collider was raised to the ring
   *     height (3 wu) that stops a car by chassis face-contact.
   * There is no height between "launches / hops" and "a wall down the middle of Yonge", and
   * Part-17's shared rule 3 governs: if a collider change hurts drive feel, the collider is wrong.
   *
   * SECOND, INDEPENDENT REASON (plan D4 — a hard acceptance risk, not a preference): a SOLID spine
   * median would cut dev/feelProbes.ts's corridor `clearHalfWidthM` (`spine.halfWidth +
   * SIDEWALK.widthWu`) from 14 m to one carriageway ≈ 4.95 + 3 = 7.95 m — BELOW the 8.6 m the @20
   * turn-radius probe already refused for — and `probeStartPose` starts the car on the spine
   * centreline, i.e. inside the median. Turn radius would stay permanently unmeasurable and
   * Phase 75 would fail its own acceptance test. Visual-only keeps the full 14 m.
   */
  colliders: false,
} as const;

/**
 * The median width a street of `cls` carries BY DEFAULT — the class width on an 'always' class,
 * 0 on 'optIn'/'never' (an opt-in street resolves its own width in streets.ts). Kept as a
 * function rather than a fifth table so the policy is stated exactly once.
 */
export function defaultMedianWidthWu(cls: RoadClass): number {
  return ROAD_MEDIAN.policy[cls] === 'always' ? ROAD_MEDIAN.widthWu[cls] : 0;
}

/**
 * THE LANE-OFFSET FORMULA (Phase 75 D6): the centre of one carriageway on a ribbon of `width`
 * with a `medianWidth` strip down its middle — i.e. the midpoint between the median edge and the
 * curb, measured from the centreline. Reduces to 0.25 x width when `medianWidth` is 0.
 *
 * Exported so per-street resolution (a 'optIn' major) and the traffic graph can use the SAME
 * formula the per-class LANE_OFFSET_WU table is built from, instead of re-deriving the rule.
 */
export function carriagewayCentreWu(width: number, medianWidth: number): number {
  return (medianWidth / 2 + width / 2) / 2;
}

/**
 * Phase 31 lane-offset fix (Part-8, live-diagnosed head-on jam): roadGraph.ts used to emit ONE
 * waypoint chain per street, with directed edges laid both ways over the SAME nodes — so
 * opposing civilian traffic met head-on in the same lane (proof: a 14-car jam wall on Yonge,
 * x=1500 z 247-285, both directions face-locked). The fix is two parallel waypoint chains per
 * street, one per travel direction, each offset perpendicular from the centreline toward its
 * right-hand side (right-hand traffic) so opposing lanes never share a node.
 *
 * Per-class offset, DERIVED (never hand-tuned per street). Phase 31 shipped this as
 * `min(0.25 x width, 2.2)`: a quarter-width lane centre, capped at one car-width (CAR_REF.widthWu)
 * so the offset could never push a lane's paint/waypoints outside its own ribbon even on the
 * narrowest minor street. Under the Part-8 diet spine/artery hit the cap (2.75 / 2.475 -> 2.2),
 * major landed exactly on it, and only minor stayed under (1.65).
 *
 * PHASE 75 RE-DERIVATION (D6) — THE CAP IS GONE, and its removal is a fix, not a relaxation. At
 * the doubled widths the 2.2 cap binds on EVERY class, so both travel directions would keep
 * hugging the centreline — straddling the new median on spine/artery — while 8+ wu of brand-new
 * asphalt sat unused and the whole navigability win was thrown away. The offset is now the
 * CARRIAGEWAY CENTRE: the midpoint between the median edge and the curb,
 *
 *     laneOffset = (medianHalfWidth + halfWidth) / 2   [carriagewayCentreWu]
 *
 * which reduces EXACTLY to the old 0.25 x width whenever a class has no median — so major (4.4)
 * and minor (3.3) are unchanged in form, and only the two median classes gain the extra push
 * (spine 6.05, artery 5.5). By construction a lane centre sits equidistant from the median edge
 * and the curb, so a car of any width clears both sides by the same margin.
 *
 * WHAT REPLACES THE CAP: a LAW TEST, not a clamp. `torontoMap.test.ts` asserts that for every
 * class the lane centre ± CAR_REF.widthWu / 2 lies strictly INSIDE the ribbon half-width and
 * strictly OUTSIDE the median half-width — the property the cap was a blunt proxy for. A clamp
 * silently produces a wrong-but-legal number; the law fails loudly and names the class.
 *
 * PER-STREET MEDIANS: this table is per CLASS, so it assumes the class DEFAULT median (a 'optIn'
 * class contributes 0). streets.test.ts pins the coupling — `carriagewayCentreWu(s.width,
 * s.medianWidth) === LANE_OFFSET_WU[s.cls]` for every built street — so the first street that ever
 * opts a major in fails that test loudly and forces the per-street lane offset to be derived
 * rather than silently inheriting a class number that no longer describes it.
 */
export const LANE_OFFSET_WU = {
  spine: carriagewayCentreWu(ROAD_CLASSES.spine, defaultMedianWidthWu('spine')),
  artery: carriagewayCentreWu(ROAD_CLASSES.artery, defaultMedianWidthWu('artery')),
  major: carriagewayCentreWu(ROAD_CLASSES.major, defaultMedianWidthWu('major')),
  minor: carriagewayCentreWu(ROAD_CLASSES.minor, defaultMedianWidthWu('minor')),
} as const satisfies Record<RoadClass, number>;

/**
 * Per-class asphalt colours. Tuned in the Phase 22 live pass. These render UNLIT with tone
 * mapping off (TorontoScene) — the hex below IS the on-screen colour, chosen on a strict
 * contrast ladder: canvas void (#121a2b, darkest) < asphalt (below) < ground (#454b54,
 * lightest) < curb strips (ROAD_EDGE). Spine lightest of the asphalts so Yonge reads
 * first; class grades downward from there.
 */
// Phase 25.8 (D3 L3) ladder brighten: each asphalt hex lifted ≈ +13% luminance (the D2 probe
// found the whole unlit palette clusters in a narrow dark band — the dominant "reads dark" cause,
// bigger than fog). Class ORDERING is preserved (spine lightest → minor darkest), and the whole
// ladder (void < asphalt < ground < sidewalk < curb < crosswalk) still holds. Pre-brighten values
// for the real-GPU retune: spine #343b46 / artery #303741 / major #2c323c / minor #282e37.
export const ROAD_COLORS = {
  spine: '#3b4350',
  artery: '#373f4a',
  major: '#323844',
  minor: '#2d343e',
} as const satisfies Record<RoadClass, string>;

/**
 * Light curb strips along each ribbon's long edges (Phase 22 live-pass finding, re-graded
 * Phase 25.6 D2 for the car-derived ribbon widths): even at the narrower 15.4 wu spine, ON the
 * road the frame is close to a single flat colour without edge lines. Rendered into the same
 * merged unlit geometry as the ribbons.
 *
 * D2 re-grain: curb 1.4 -> 0.8 and the dash proportionally thinner (0.4 wu wide total —
 * previously a full 1.1 wu, literally half a car) — both scaled down with the narrower
 * ribbons so the paint doesn't dominate a 7.7 wu minor the way it did a 36 wu spine.
 */
export const ROAD_EDGE = {
  widthWu: 0.8,
  // Phase 25.8 (D3 L3): curb lifted #7e8791 → #8b95a0 (+~10%), stays the brightest road-paint tone
  // right at the road/sidewalk seam (the curb-face read D5 leans on). Pre-brighten: #7e8791.
  color: '#8b95a0',
  // Centre-line dashes: the near-frame readability anchor — curbs sit at the frame edges
  // on the 36 wu spine, but the dashes stay dead-centre under the car at every speed.
  // 4/5 wu length/gap pattern, 0.4 wu total width (2 x halfWidthWu).
  dash: {
    lengthWu: 4,
    gapWu: 5,
    halfWidthWu: 0.2,
    color: '#b8a86a',
  },
} as const;

/**
 * Sidewalk band along every ribbon edge, OUTSIDE the curb strip (Phase 25.6 D2/D20 seam #2).
 * Not part of the road ribbon itself — a flat merged quad strip that gives pack-building
 * frontage rows (D6) and street furniture (D16) a surface to sit on, and the near-frame
 * readability the narrower re-grained ribbons need at street edges. Contrast ladder (unlit
 * palette, TorontoScene): canvas void (#121a2b) < asphalt (ROAD_COLORS) < ground (#454b54) <
 * sidewalk (below) < curb (ROAD_EDGE.color, brightest, right at the road/sidewalk seam).
 */
export const SIDEWALK = {
  // Part-8 (D3): 4 → 3 wu with the narrower road diet (SIDEWALK_ROW's kerb/facade offsets in
  // config/torontoDress.ts re-checked to fit inside this band).
  widthWu: 3,
  // Phase 25.8 (D3 L3): sidewalk lifted #565e68 → #616a75 (+~11%), staying between ground and
  // curb on the ladder. Pre-brighten: #565e68. curbHeightWu + curbFaceColor are the D5 raised-band
  // additions (a raised top face + a road-facing curb FACE = the "road depth" read); the band tops
  // out at curbHeightWu and everything that SITS on the sidewalk lifts by the same constant.
  color: '#616a75',
  /** D5: sidewalk raised-band top-face height above the asphalt (wu). One shared constant threaded
   * through furniture/venue-dress placement y + the optional GROUND colliders. 0.12 reads as a
   * real curb at the §5.3 camera without tripping the car. Phase 75: the literal moved up to the
   * hoisted CURB_HEIGHT_WU (unchanged value) so the median's kerb reads off the same number. */
  curbHeightWu: CURB_HEIGHT_WU,
  /** D5: the vertical road-facing curb FACE colour — a touch darker than the sidewalk top (fake AO
   * seam; THIS is the depth cue). Sits between asphalt and the sidewalk top on the ladder.
   * Phase 75: shared with the median kerb face via the hoisted CURB_FACE_COLOR (value unchanged). */
  curbFaceColor: CURB_FACE_COLOR,
  /** D5 kill-switch: mount matching GROUND-group cuboid colliders under the raised band (top at
   * curbHeightWu). false ⇒ visual-only band (the car visually sinks 0.12 wu on sidewalks, near-
   * invisible at this camera). DRIVE-FEEL GATE VERDICT (25.8): OFF. With colliders on, hitting the
   * 0.12 curb at ~19 m/s launched the raycast-vehicle ~0.8 wu into the air on a perpendicular ram
   * and, worse, LAUNCHED-then-CAUGHT (stalled) on a 45° approach — both degrade the signed-off
   * driving feel, which outranks the visual (§ curb collider risk row). The visual band + curb face
   * stay; the 0.12 wu visual sink on sidewalks is near-invisible at the §5.3 camera. Constant stays
   * wired for a Part-8 retune (softer step / bevel collider) if the feel is revisited. */
  colliders: false,
} as const;

/**
 * Painted crosswalk band across each SIGNALIZED intersection approach (Phase 25.6 D2, D20 seam
 * #1). This constant owns only the stripe geometry/colour numbers — placement is derived at
 * mount time from roadGraph.ts's `listIntersections` (the crossing point + both streets'
 * classes) by the road-paint builder, keyed the same way MegaKit's road-paint decal meshes
 * would eventually replace this quad emission. The band sits just outside the intersection box
 * (see the dash-skip rule below) and spans the full ribbon width of the approach it belongs to.
 */
export const CROSSWALK = {
  /**
   * Depth of the painted band along the direction of travel (wu).
   *
   * THIS NUMBER HAS MOVED TWICE, IN OPPOSITE DIRECTIONS, FOR THE SAME REASON — it is a PROPORTION
   * of the intersection box it paints across, and the box is a function of the road widths:
   *   • Phase 27 road diet (live-verification FIX 3): 3 -> 2.2. The widths were cut to 3-5 cars and
   *     a 3 wu band dominated the resulting tiny boxes.
   *   • Phase 75 road expansion (T1): 2.2 -> 3.0, restored. The widths doubled to 6-10 cars, which
   *     inverts Phase 27's rationale exactly: a 2.2 wu band read as a thin ribbon of paint across a
   *     17.6-22.0 wu crossing, well under the ~2.5-3 m depth a real zebra has. Nothing else about
   *     the stripes changed — `stripeWidthWu` / `stripeGapWu` are unaffected by how WIDE a road is
   *     (a doubled crossing simply gets twice as many stripes, which is how a real zebra scales)
   *     and they remain pinned against config/surfaces.ts's measured THIN_GEOMETRY law.
   * If the widths ever move again, move this with them — and say so here.
   *
   * Knock-on (deliberate): world/toronto/roadPaint.ts derives the median's crossing cut-out from
   * `setbackWu + bandWu`, so the grass strip automatically retreats far enough to keep the deeper
   * band on bare asphalt. Nothing re-types this number.
   */
  bandWu: 3.0,
  /** Individual stripe width, stripes run parallel to the direction of travel (wu). */
  stripeWidthWu: 0.5,
  /** Gap between adjacent stripes (wu). */
  stripeGapWu: 0.5,
  /** Gap left between the intersection box edge and the near edge of the band (wu). */
  setbackWu: 1,
  color: '#c7c4ba',
} as const;

/**
 * Dash-skip rule (Phase 25.6 D2): centre-line dashes are OMITTED inside every intersection box
 * — for a street being dashed, that's the region within the CROSS street's halfWidth of the
 * crossing point (`ROAD_CLASSES[crossStreet.cls] / 2` on each side). Deliberately not its own
 * constant: the box is derived from the same ROAD_CLASSES table the ribbons themselves use, so
 * there stays exactly one source for "how wide is an intersection". Applied by the road-paint
 * builder against roadGraph.ts's `listIntersections`.
 */

/** Target spacing (wu) between adjacent traffic-graph nodes along a street between crossings. */
export const WAYPOINT_SPACING_WU = 40;

/** How far a street's ends stop short of the polygon/zone edge it runs up against (wu). */
export const EDGE_PAD_WU = 14;

/** Collider thickness (wu) of one barrier-ring wall segment. Hoisted out of the BARRIER block
 * below only because `minEdgeInsetWu` is derived from it (an object literal cannot reference its
 * own fields). */
const BARRIER_COLLIDER_THICKNESS_WU = 1;

/** Gap between adjacent fence panels — hoisted for the same reason (`fence.pitchWu` needs it). */
const BARRIER_FENCE_GAP_WU = 0.2;

/** On-screen width (wu) of one pack `fence` panel: the manifest's native X extent x the model's
 * resolved runtime scale — MEASURED off the pack, never a copied literal, so a pack regen
 * (`pnpm assets:pack`) re-flows the fence pitch instead of silently opening gaps in the ring. */
const BARRIER_FENCE_PANEL_WIDTH_WU =
  getCityPackModel('fence').nativeDims.w * resolveCityPackScale('fence');

/**
 * Phase 37 — the diegetic world-edge barrier ring (part-9 §Phase 37; TDD §5.4 "no invisible
 * walls"). world/toronto/worldEdge.ts walks PLAYABLE_POLYGON's 11 LAND edges (the south water
 * edge is skipped — locked: no wall on the lake), insets them, and emits one long fixed cuboid
 * per edge plus per-theme visual dressing. EVERY number the builder uses lives here; worldEdge.ts
 * contains no tunables of its own.
 *
 * The ring is the diegetic primary; the universal out-of-bounds auto-WRECKED (world/toronto/
 * outOfBounds.ts) is the guaranteed backstop for anything that arcs over 3 wu of wall.
 */
export const BARRIER = {
  /**
   * How far INSIDE each land polygon edge the barrier centreline sits (wu).
   *
   * Deliberately NOT EDGE_PAD_WU (14), which is where the street table stops its ribbons: the
   * traffic graph's terminal NODES sit exactly on that pad line, so a ring at 14 would stand on
   * top of them (civilian block-rays latching onto a wall, pursuit spawn nodes in contact with
   * it). 6 wu instead:
   *   • stands on tiled ground by construction (GROUND_RECTS ∪ WATER_RECT tile the polygon
   *     exactly — proven in torontoSceneHelpers.test.ts's Phase 37 ground-truth gate);
   *   • leaves 14 − 6 − thickness/2 = 7.5 wu of clear road between a dead-end street's last
   *     asphalt and the wall it faces;
   *   • sits well inside polygon.ts's CAMERA_CLAMP_PADDING_WU (30) band, so the camera eye is
   *     already held further in than the ring — the ring never clips the lens.
   */
  edgeInsetWu: 6,
  /**
   * The floor `edgeInsetWu` collapses to on an edge that has a street ribbon lying FLUSH against
   * it. Two streets are boundary-nudged onto their zone edge by streets.ts (Bloor's north curb
   * IS the downtown block's north boundary at y=1362; Sheppard's south curb IS the capsule's
   * south boundary at y=702), so on those four step/notch edges a 6 wu inset would put a wall
   * down the middle of a live arterial. The builder detects any parallel ribbon in the inset band
   * and pulls that edge's inset back to this value — half the collider thickness, i.e. the wall's
   * outer face flush with the polygon edge and its inner face exactly `colliderThicknessWu`
   * inside. That reads as a hoarding on the road's outer shoulder (correct — the map genuinely
   * ends at that curb) and encroaches at most 1 wu of a 17.6-19.8 wu ribbon (Phase 75 widths;
   * pre-P75 these were 8.8-9.9), leaving both lane centres (LANE_OFFSET_WU ±4.4 on Sheppard's
   * major, ±5.5 on Bloor's artery) and their car half-widths clear by ≥ 3.3 wu.
   */
  minEdgeInsetWu: BARRIER_COLLIDER_THICKNESS_WU / 2,
  /**
   * Wall height (wu). Low on purpose: it stops a car, it does NOT try to stop a launched/airborne
   * one — arcing over the top is the out-of-bounds backstop's job ("bounce or WRECKED, never a
   * fall"), and a taller ring would be the one piece of world geometry guaranteed to sit inside
   * the camera's eye-line band (CAMERA_EYE_MIN_WU 22.05) at every map edge.
   */
  colliderHeightWu: 3,
  /** Wall thickness (wu). Also the corner-seal overlap: each edge's box is extended by half this
   * at both ends so adjacent boxes overlap at the mitred corners and the ring has no gaps
   * (overlapping FIXED cuboids are free — no solver work, no jitter). */
  colliderThicknessWu: BARRIER_COLLIDER_THICKNESS_WU,
  /**
   * Invariant ceiling (wu), asserted in worldEdge.test.ts: no collider box and no dressing piece
   * may sit deeper than this into ANY street ribbon. Only the four flush-ribbon edges above can
   * intrude at all, and only into the outer ~1-1.4 wu of Bloor/Sheppard. Raising this constant
   * without re-checking the lane-clearance arithmetic in `minEdgeInsetWu` above is a bug.
   */
  maxRibbonEncroachWu: 2,
  /**
   * Dressing (not colliders) stops this far north of the shoreline (wu). The two downtown W/E
   * edges run the full height of the polygon, which includes the 240 wu water band — the COLLIDER
   * must run all the way down to seal the ring's two south corners, but a fence standing in the
   * lake reads as a bug, so visual pieces are clipped at ZONE_BOUNDARIES[3] − this.
   */
  shoreClearanceWu: 4,
  /**
   * How far from a land edge a street endpoint may be and still count as a dead end that gets a
   * "road closed" jersey row (wu). EDGE_PAD_WU (14) + edgeInsetWu (6): every zone-token street end
   * sits exactly 14 out, and Yonge's north end — the one street that stops on a literal (y=12,
   * scaleBaseY(20)) rather than a pad token — sits 12 out. Both are caught; nothing else is
   * (the next-nearest endpoint to any land edge is 59 wu away).
   */
  deadEndProbeWu: 20,
  /**
   * City-pack model ids the dressing kinds render as (assets/cityPackManifest.ts). Only two kinds
   * have a pack model; 'hoardingPanel', 'jerseyBarrier' and 'railPost' have no pack equivalent and
   * are procedural boxes built by the scene (the same precedent as 25.7's procedural awnings).
   *
   * 'fencePiece' deliberately resolves to the pack's `fence`, NOT `fence-piece`: `fence-piece`
   * resolves to a 1.12 x 0.79 wu stub (a kerb rail), far too short to read against a 3 wu wall,
   * while `fence` resolves to a 3.19 x 2.5 wu panel that reads as a real barrier at the §5.3
   * camera. Both models' native long axis is X, matching the builder's yaw convention (local +X
   * runs ALONG the edge, local +Z faces INWARD).
   */
  packModelIds: {
    fencePiece: 'fence',
    cone: 'cone',
  },
  fence: {
    /** Gap between adjacent fence panels (wu) — small enough that the run reads continuous, big
     * enough that abutting panels never share a coincident face. It is also the ring's one tri
     * lever: `fence` is a 1,040-tri model and the fence/rail edges are ~5 km of ring, so widening
     * this gap is the first thing to try if an edge vantage ever threatens the tri budget
     * (BatchedMesh per-instance frustum culling means only the ~15-20 panels actually in frame
     * ever submit triangles). */
    gapWu: BARRIER_FENCE_GAP_WU,
    /** Measured panel width (wu) — see BARRIER_FENCE_PANEL_WIDTH_WU above. */
    panelWidthWu: BARRIER_FENCE_PANEL_WIDTH_WU,
    /** Centre-to-centre spacing of fence panels along an edge (wu). The builder rounds a segment
     * to a whole number of pitches and then spreads them evenly, so the run always starts and ends
     * flush with the segment (the realised pitch lands within a few % of this). */
    pitchWu: BARRIER_FENCE_PANEL_WIDTH_WU + BARRIER_FENCE_GAP_WU,
  },
  hoarding: {
    /** Construction-hoarding panel: a plywood board on the map's construction-site edges. Width
     * is a whole-panel proportion of the 4.2 wu pitch; height sits above a car and below the
     * pack's fence so the two themes read as different structures. */
    panelWidthWu: 4,
    panelHeightWu: 2.6,
    panelThicknessWu: 0.3,
    gapWu: 0.2,
  },
  rail: {
    /** Rail-corridor theme (the fold corridor's W/E flanks): pack fence + a taller procedural post
     * every `postSpacingWu`, so the fold reads as a rail right-of-way rather than a job site. */
    postSpacingWu: 8,
    postWidthWu: 0.35,
    postHeightWu: 1.2,
  },
  notch: {
    /** Cone scatter along the two step-in notch pairs (the hoarding-themed edges that are flush
     * with Bloor/Sheppard). Deterministic, no rng: cones alternate between the barrier centreline
     * and one lateral step INWARD of it. Inward-only — a lateral step outward would push a cone
     * off the polygon on a 0.5 wu inset edge. */
    conePitchWu: 6,
    coneLateralOffsetWu: 0.6,
  },
  jersey: {
    /** Concrete jersey barrier, procedural. Length runs ACROSS the road (local +X, per the yaw
     * convention); a row of them at a dead-end street's last asphalt reads "road closed". */
    lengthWu: 2,
    widthWu: 0.7,
    /**
     * VISUAL height only. The dead-end row's COLLIDER deliberately does NOT use this: a 0.9-tall
     * thin fixed box is a curb, not a wall, to the raycast vehicle — the suspension rays hit its
     * top face and lift the chassis smoothly over it, so a car at ANY speed climbs the row like a
     * speed bump (proven live in the Phase 37 battery: creep-speed pass-through, ram-speed vault,
     * and a drop test that beached the chassis dead on the box top). The row collider instead
     * reuses `BARRIER.colliderHeightWu` (3 — the same wall height the ring proves stops the car
     * by chassis face-contact); see TorontoScene.tsx's dead-end collider mount. The 2.1 wu of
     * unmarked wall above the visible row is diegetically covered by the row itself — a stop
     * there still reads as "the road closure stopped me" — and the ring stands 8 wu behind it
     * regardless.
     */
    heightWu: 0.9,
    gapWu: 0.2,
    /** How far back from the ribbon's cut end the row's centre sits (wu), so the barriers stand
     * fully ON the asphalt instead of straddling the cut. */
    rowInsetWu: 1,
    /** Jersey positions closer than this to the polygon boundary are dropped (wu). On the four
     * flush edges (Bloor/Sheppard) the ring itself already occupies the road's outer wu, and a
     * jersey there would interpenetrate the wall. */
    edgeClearanceWu: 1.5,
  },
} as const;

/**
 * Player spawn — a map-space point on Yonge, facing south. South is map +y, which maps to world
 * +Z (see projection.mapToWorld); in the codebase's `atan2(dx, dz)` yaw convention (world +Z is
 * forward) south is yaw 0. Task 4's scene converts this map point through mapToWorld and orients
 * the car to `heading`.
 *
 * Phase 32 (D3, cold-boot default): relocated from just-south-of-Finch (North York, the Phase 22
 * dev-slice pick) to downtown Yonge between Dundas and Queen — the densest, most legible block of
 * the shipped map, and on the SOUTHBOUND lane rather than dead-centre so the player starts aligned
 * with real traffic flow instead of straddling both lanes' shared centreline.
 *
 * `x`: spine centreline (1500) minus the southbound lane's own offset (LANE_OFFSET_WU.spine —
 * roadGraph.ts's right-hand-traffic rule: southbound offsets toward −x/west). Never hand-typed as
 * a second literal — re-derived from the same constant civilian/pursuit traffic lanes use, so the
 * player spawns in the exact lane AI southbound cars drive.
 *
 * `y`: the midpoint between Dundas St and Queen St's centrelines. Both are real-anchor-derived
 * (yonge-dundas / yonge-queen, data/toronto/anchors.json via streets.ts's positionRef lookup) —
 * not expressible as a closed-form BASE-y formula the way the old Finch spot was (that zone scales
 * uniformly from a shared origin; downtown's is an affine segment anchored at Bloor, and Dundas/
 * Queen sit at fixed anchor latitudes within it) — so this is a PINNED literal, verified against
 * streets.ts's buildStreets() output (dundas.centerline ≈ 1893.47, queen.centerline ≈ 2026.34,
 * midpoint ≈ 1959.9) and drift-guarded by torontoSceneHelpers.test.ts. No cross street falls
 * between Dundas and Queen on this map, so the spawn sits mid-block, clear of every intersection.
 *
 * PHASE 75: `x` moves with the widened spine — 1500 − 2.2 → 1500 − 6.05 — because it always was
 * the lane centre, and the lane centre is now the carriageway centre (LANE_OFFSET_WU's re-
 * derivation). The car still spawns wholly inside the southbound carriageway: 6.05 ± 1.1 sits
 * inside the 11.0 half-ribbon and outside the 1.1 median half-width, by 3.85 wu on both sides
 * (asserted in torontoSceneHelpers.test.ts). The Yonge ribbon widens from [1494.5, 1505.5] to
 * [1489, 1511]; whether any named/streetwall neighbour now reaches that edge is T3's placement
 * re-fit + arbiter sweep to measure, not an assumption to carry here.
 */
export const TORONTO_SPAWN = {
  x: 1500 - LANE_OFFSET_WU.spine,
  y: 1959.9,
  /** Unit heading in MAP space: +y = south. */
  heading: { x: 0, y: 1 },
} as const;

/** Phase 29 (D2): district-blackout ground-tint visual (world/toronto/groundTintBlackout.ts's
 * darkenColorRange). Toronto has no per-archetype emissive instance buffer to flip (see that
 * module's header) — the ground tint darkening by this factor on transformerDestroyed is the
 * substitute "district blackouts must read" signal. < 1 darkens; kept above 0 so a blacked-out
 * district reads as dead asphalt, not a rendering void. STARTING POINT, live-tunable. */
export const TORONTO_BLACKOUT = {
  groundTintDarkenFactor: 0.16,
} as const;
