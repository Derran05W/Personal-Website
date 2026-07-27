/**
 * Phase 40 — THE OVERLAP INVARIANT SWEEP: the phase's acceptance test. The whole point of the
 * global placement arbiter (`.planning/part-10-placement-integrity.md`'s audit) was that no two
 * physical objects in the composed Toronto world should interpenetrate, and that nobody could
 * assert that map-wide until every placer registered into ONE index.
 *
 * HISTORY — the first run of this sweep (mid-Phase 40) found ~230-330 unsanctioned pairs/seed
 * BEYOND the seven named audit gaps (which always closed cleanly). Every category was traced,
 * decided, and resolved the same session; the decisions live where the plan says policy lives —
 * `claimIndex.isSanctionedOverlap` / `isOnRoadSanctioned` / `RIBBON_OVERLAP_EXCEPTION_IDS`, each
 * with its own rationale block — and the fixes in the placers. The ledger:
 *
 *   • backdropBox × frontageSlot/cornerFill (85-103/seed) → SANCTIONED, rule (d): frontage's
 *     backdrop towers stand in the block interior BEHIND the street skin by construction since
 *     P23; the wall occludes every tower base from the locked camera, and rejecting them would
 *     thin the shipped skyline by ~a third for zero visible gain. Scoped to 'frontage'-sourced
 *     pairs — infill backdrop boxes still gate and still fail here if they ever overlap.
 *   • decor stand-in gates (laneway clutter + deep-scatter piles gated on a 0.6 wu stand-in but
 *     CLAIMED their real model footprint) → FIXED in infill.ts: pick+spin draw first (rng-neutral
 *     — per-candidate forks), gate on the exact rotated footprint the claim registers. Cost at
 *     seed 416: one pile (13→12, pinned in composeWorld.test.ts).
 *   • construction decor × its own site's fixtures → SANCTIONED, rule (e): scatterInRect throws
 *     decor inside its own site among that site's fence/dumpster by design; shared-prefix owners
 *     (`infill:construction*`). Cross-site pairs are geometrically impossible.
 *   • furniture-mast × furniture-power-box (60-64/seed, the only furniture pairing) → SANCTIONED
 *     via a shared `furniture:corner` owner in composeWorld: furniture.ts's documented
 *     "intersection-rule furniture claims but isn't gated" tradeoff (dropping a mast breaks
 *     lampClock/LightPool; dropping a power box breaks the blackout-chain invariant).
 *   • deep-scatter tree × parking fence (seed 7) → FIXED in infill.ts: the parking/construction
 *     GATE lists now carry the sites' real fixture footprints, not just the lot rects (a
 *     perimeter fence straddles its rect edge).
 *   • row furniture footprints poking into a CROSS street's ribbon (seed-dependent trash-can/
 *     hydrant catches) → FIXED in furniture.ts's buildRow: the candidate's point-in-ribbon check
 *     gains a footprint-vs-ribbon companion.
 *   • queue blobs at the kerb (Konjiki/Uncle Tetsu), Eaton Centre's researched footprint, the
 *     McDonald's pizza-corner overhang → ACCEPTED as authored/researched geometry, pinned
 *     EXACTLY in RIBBON_OVERLAP_EXCEPTION_IDS (the zone test asserts observed == pinned, so a
 *     stale entry fails as loudly as a new intrusion).
 *   • lane-closure road plates (deliberately on-asphalt, kind 'decor') → covered by
 *     `isOnRoadSanctioned`'s owner-scoped exception, NOT a kind-wide widening (which would also
 *     sanction laneway clutter standing in a roadway).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RIBBON_OVERLAP_EXCEPTION_IDS, isOnRoadSanctioned, isSanctionedOverlap, type Claim, type ClaimKind } from './claimIndex';
import { composeWorld } from './composeWorld';
import { resolveVenueClaimsSequential, type VenueClaimLookupFactory } from './frontage';
import type { FrontageCandidate, VenueAuthor } from './venues';

const world416 = composeWorld(416);

/** The compact, JSON-friendly identity of a claim for a failure message — never the full Aabb-and-
 * everything Claim object, which would bury the one fact (kind/source/id) a human needs first. */
function claimIdentity(c: Claim): { readonly id: string; readonly kind: ClaimKind; readonly source: string } {
  return { id: c.id, kind: c.kind, source: c.source };
}

/** Render up to the first 10 violations as pretty JSON — readable failures are a plan requirement
 * (§Verification: "readable failures"), not a nice-to-have. */
function renderViolations(label: string, violations: readonly unknown[]): string | undefined {
  if (violations.length === 0) return undefined;
  return `${label}: ${violations.length} violation(s), first 10:\n${JSON.stringify(violations.slice(0, 10), null, 1)}`;
}

// -------------------------------------------------------------------------------------------------
// THE SWEEP — LIVE (the phase's acceptance test). Every blocking claim vs every other, 3 seeds;
// the whitelist is claimIndex.isSanctionedOverlap and NOTHING in this file — a new unsanctioned
// pair fails here and must be fixed by placement or by a RECORDED sanction decision there.
// -------------------------------------------------------------------------------------------------

const SEEDS: readonly number[] = [416, 7, 1337];
const worlds = new Map(SEEDS.map((seed) => [seed, seed === 416 ? world416 : composeWorld(seed)] as const));

interface OverlapViolation {
  readonly seed: number;
  readonly a: ReturnType<typeof claimIdentity>;
  readonly b: ReturnType<typeof claimIdentity>;
  readonly aabbs: { readonly a: Claim['aabb']; readonly b: Claim['aabb'] };
}

describe('overlap invariant — THE SWEEP (every blocking claim vs every other, 3 seeds)', () => {
  it.each(SEEDS)('seed %d: zero unsanctioned blocking-claim overlaps', (seed) => {
    const world = worlds.get(seed)!;
    const blockingClaims = world.index.allClaims().filter((c) => c.blocking);
    expect(blockingClaims.length).toBeGreaterThan(1000);

    const violations: OverlapViolation[] = [];
    for (const a of blockingClaims) {
      const hits = world.index.queryRect(a.aabb, { blocking: true });
      for (const b of hits) {
        // String-compare dedupe: overlap is symmetric, so a's query hits b and b's hits a.
        // Keeping only b.id > a.id keeps exactly one direction of each unordered pair and drops
        // the self-hit (a claim's own footprint always "overlaps" itself under this predicate).
        if (!(b.id > a.id)) continue;
        if (isSanctionedOverlap(a, b)) continue;
        violations.push({ seed, a: claimIdentity(a), b: claimIdentity(b), aabbs: { a: a.aabb, b: b.aabb } });
      }
    }
    expect(violations, renderViolations(`seed ${seed}`, violations)).toEqual([]);
  });
});

describe('overlap invariant — directional zone rule (street ribbons host only on-road claims)', () => {
  it.each(SEEDS)('seed %d: every blocking claim on a ribbon is on-road-sanctioned or a pinned exception', (seed) => {
    const world = worlds.get(seed)!;
    const ribbons = world.index.allClaims().filter((c) => c.kind === 'streetRibbon');
    expect(ribbons.length).toBeGreaterThan(0);

    const violations: { readonly seed: number; readonly ribbon: string; readonly hit: ReturnType<typeof claimIdentity> }[] = [];
    const observedExceptions = new Set<string>();
    for (const ribbon of ribbons) {
      for (const hit of world.index.queryRect(ribbon.aabb, { blocking: true })) {
        if (isOnRoadSanctioned(hit)) continue;
        if (RIBBON_OVERLAP_EXCEPTION_IDS.has(hit.id)) {
          observedExceptions.add(hit.id);
          continue;
        }
        violations.push({ seed, ribbon: ribbon.id, hit: claimIdentity(hit) });
      }
    }
    expect(violations, renderViolations(`seed ${seed} zone rule`, violations)).toEqual([]);
    // The exception list must stay EXACT: all three exception families (venue claims, named
    // boxes, queue blobs) are seed-independent placements, so every pinned id must actually be
    // observed at every seed — a stale entry (e.g. after a building-specs.json or venue change)
    // fails here instead of silently widening the law.
    expect([...observedExceptions].sort()).toEqual([...RIBBON_OVERLAP_EXCEPTION_IDS].sort());
  });
});

// -------------------------------------------------------------------------------------------------
// the seven audit-gap regressions (seed 416) — LIVE. Unaffected by the disabled sections above.
// -------------------------------------------------------------------------------------------------

/** Shared shape for the gap 1/2/4/5 "no claim of set X overlaps any claim of kinds Y" checks —
 * every one of those gaps is the SAME query pattern (queryRect + a target-kinds filter) applied to
 * a different probe population, so one helper keeps the four tests from re-deriving the loop. */
function findOverlapViolations(
  probes: readonly Claim[],
  targetKinds: ReadonlySet<ClaimKind>,
): { readonly probe: ReturnType<typeof claimIdentity>; readonly hit: ReturnType<typeof claimIdentity> }[] {
  const violations: { readonly probe: ReturnType<typeof claimIdentity>; readonly hit: ReturnType<typeof claimIdentity> }[] = [];
  for (const probe of probes) {
    const hits = world416.index.queryRect(probe.aabb, { kinds: targetKinds });
    for (const hit of hits) violations.push({ probe: claimIdentity(probe), hit: claimIdentity(hit) });
  }
  return violations;
}

describe('overlap invariant — gap regressions (seed 416)', () => {
  it('(gap 1) no furniture-kind claim interior-overlaps any frontageSlot or cornerFill claim', () => {
    const furnitureClaims = world416.index.allClaims().filter((c) => c.kind === 'furniture');
    expect(furnitureClaims.length).toBeGreaterThan(0);
    const violations = findOverlapViolations(furnitureClaims, new Set<ClaimKind>(['frontageSlot', 'cornerFill']));
    expect(violations, renderViolations('gap 1', violations)).toEqual([]);
  });

  it('(gap 2) no furniture-kind claim overlaps any backlotBuilding/lotFixture/lotCar/scatterProp/decor/backdropBox claim', () => {
    const furnitureClaims = world416.index.allClaims().filter((c) => c.kind === 'furniture');
    expect(furnitureClaims.length).toBeGreaterThan(0);
    const targetKinds = new Set<ClaimKind>(['backlotBuilding', 'lotFixture', 'lotCar', 'scatterProp', 'decor', 'backdropBox']);
    const violations = findOverlapViolations(furnitureClaims, targetKinds);
    expect(violations, renderViolations('gap 2', violations)).toEqual([]);
  });

  it('(gap 3) zero furniture.trees.items positions land strictly inside any parkRect zone claim', () => {
    expect(world416.furniture.trees.items.length).toBeGreaterThan(0);
    const violations: { readonly tree: readonly [number, number, number]; readonly park: ReturnType<typeof claimIdentity> }[] = [];
    for (const tree of world416.furniture.trees.items) {
      const hits = world416.index.queryPoint(tree.position[0], tree.position[2], { kinds: new Set<ClaimKind>(['parkRect']) });
      for (const hit of hits) violations.push({ tree: tree.position, park: claimIdentity(hit) });
    }
    expect(violations, renderViolations('gap 3', violations)).toEqual([]);
  });

  it('(gap 4) no claim owned by infill:laneClosure overlaps any parkedCar/manhole/crosswalkBand claim', () => {
    const laneClosureClaims = world416.index.allClaims().filter((c) => c.owner === 'infill:laneClosure');
    expect(laneClosureClaims.length).toBeGreaterThan(0);
    const violations = findOverlapViolations(laneClosureClaims, new Set<ClaimKind>(['parkedCar', 'manhole', 'crosswalkBand']));
    expect(violations, renderViolations('gap 4', violations)).toEqual([]);
  });

  it('(gap 5) no furniture-kind claim overlaps any venueProp or queueProp claim', () => {
    const furnitureClaims = world416.index.allClaims().filter((c) => c.kind === 'furniture');
    expect(furnitureClaims.length).toBeGreaterThan(0);
    const violations = findOverlapViolations(furnitureClaims, new Set<ClaimKind>(['venueProp', 'queueProp']));
    expect(violations, renderViolations('gap 5', violations)).toEqual([]);
  });

  // (gap 6) — the mechanism test: "two authors forced onto one nearest slot -> second falls to
  // next-nearest, no throw". Exercises `frontage.ts`'s extracted `resolveVenueClaimsSequential`
  // directly with a synthetic two-candidate lattice, independent of the real street/candidate data
  // (the real lattice has zero collisions today — see composeWorld.test.ts/frontage.test.ts — so a
  // real-data test could never actually exercise the fall-through branch).
  it('(gap 6) two authors forced onto one nearest slot: second falls to next-nearest, nothing throws', () => {
    // A REAL street id ('yonge') for refStreetId — buildVenueClaims (inside
    // resolveVenueClaimsSequential) resolves `author.along(c)` through the real built street
    // table, so an unknown street id would throw before the dedupe logic under test even runs.
    // Both authors ignore the `c` callback and return a fixed target instead (a valid AlongFn —
    // the type only requires using `c`, never mandates it), so no street-table lookup happens.
    const c1: FrontageCandidate = { slotId: 'yonge:p:0', streetId: 'yonge', side: 1, along: 100, isCorner: false };
    const c2: FrontageCandidate = { slotId: 'yonge:p:1', streetId: 'yonge', side: 1, along: 200, isCorner: false };

    const makeAuthor = (id: string): VenueAuthor => ({
      id,
      name: `GAP6 ${id}`,
      brand: 'warehouse',
      category: 'bar_cheap_eats',
      kitId: 'grocery',
      brandColor: '#123456',
      refStreetId: 'yonge',
      side: 'E',
      along: () => 100, // both authors target c1 — without dedupe, both would resolve to it
      sourceName: `gap6 synthetic (${id})`,
    });
    const authorA = makeAuthor('gap6-a');
    const authorB = makeAuthor('gap6-b');

    // The SAME two candidates for every author, filtered by whatever `taken` already excludes —
    // the exact "two authors, one shared candidate pool" scenario the dedupe exists to resolve.
    const lookupFor: VenueClaimLookupFactory = (_author, taken) => (streetId, side) => {
      if (streetId !== 'yonge' || side !== 1) return [];
      return [c1, c2].filter((c) => !taken.has(c.slotId));
    };

    let claims: readonly { readonly slotId: string }[] = [];
    expect(() => {
      claims = resolveVenueClaimsSequential([authorA, authorB], lookupFor);
    }).not.toThrow();
    expect(claims.map((c) => c.slotId)).toEqual(['yonge:p:0', 'yonge:p:1']);
  });

  // (gap 7) — the three retired hand-maintained exclusion compositions must never come back. Same
  // source-scan idiom as config/layeringGuard.test.ts: read the files as text, skip comment lines
  // (a doc comment mentioning these function names for historical context is not a regression —
  // furniture.ts's own header comment does exactly that), and grep for a literal call.
  it('(gap 7) frontage/furniture/infill never call buildNamedBuildings(), buildPlacesLayer() or buildParks() directly', () => {
    const SCANNED_FILES = [
      'src/game/world/toronto/frontage.ts',
      'src/game/world/toronto/furniture.ts',
      'src/game/world/toronto/infill.ts',
    ];
    const FORBIDDEN_CALLS = ['buildNamedBuildings(', 'buildPlacesLayer(', 'buildParks('];
    const isCommentLine = (line: string): boolean => {
      const trimmed = line.trim();
      return trimmed.startsWith('//') || trimmed.startsWith('*');
    };
    const offenses: { readonly file: string; readonly lineNo: number; readonly text: string }[] = [];
    for (const relPath of SCANNED_FILES) {
      const abs = resolve(process.cwd(), relPath);
      const lines = readFileSync(abs, 'utf-8').split('\n');
      lines.forEach((rawLine, index) => {
        if (isCommentLine(rawLine)) return;
        if (FORBIDDEN_CALLS.some((needle) => rawLine.includes(needle))) {
          offenses.push({ file: relPath, lineNo: index + 1, text: rawLine.trim() });
        }
      });
    }
    expect(offenses, renderViolations('gap 7', offenses)).toEqual([]);
  });
});
