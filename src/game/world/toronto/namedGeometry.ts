// Phase 46 (Part 11) — THE `namedGeometryBuilders` SEAM.
//
// Every named landmark in this city has shipped as an extruded BOX since Phase 24: a §3c height, a
// §4 material look, a baked per-facade window texture and (for the banks) a CROWN decal. That is
// exactly right for a bank tower — Addendum A.3 says so in as many words ("their identity is
// colour + height + logo, not silhouette") — and exactly wrong for a building whose identity IS
// its silhouette: Union Station's colonnade, the Royal York's chateau roof, City Hall's curved
// twins, the Gooderham flatiron. Phases 25/45 solved that case twice by hand (heroes.ts,
// railLands.ts), each time by pulling the building OUT of namedBuildings.ts's placement list and
// giving it a private module, a private lot and a private mount.
//
// This module is the general form, and the reason those two exclusions stop growing: a spec row
// keeps its placement, its exclusion rect, its claims and its collider — everything
// `namedBuildings.ts` already computes stays BYTE-IDENTICAL — and gains, optionally, a BUILDER that
// returns a render plan:
//
//   • `renderBoxes`  — replaces `placement.boxes` for RENDERING only (still through the existing
//                      facade-texture path). Union shrinks its box to the WING height so a bespoke
//                      attic can top out at the data height.
//   • `buildGeometry()` — one merged, non-indexed, vertex-coloured mesh (bespokeMesh.ts's toolkit):
//                      the sculpted part. One draw call per landmark.
//   • `signQuads`    — wordmark quads; ALL builders' quads merge into ONE mesh sharing the
//                      namedSignage.ts atlas, so lettering costs +1 draw call for the whole seam.
//   • `extraClaims`  — claims for volumes the DATA box does not describe (Union's GO shed, its
//                      moat strip). Registered by worldContext.ts in the seed-independent prefix,
//                      next to the named boxes, so every later placer rejects against them.
//   • `extraColliders` — extra BUILDING cuboids (the shed). The DATA-box colliders are untouched
//                      for every id, builder or not.
//
// THE FALLBACK IS STRUCTURAL, NOT POLITE: an id without a builder simply has no entry in the
// resolved map, and `resolveNamedRenderBoxes` falls through to `placement.boxes` with the same
// `${id}#${i}` texture key it has used since Phase 24. There is no second code path to drift —
// namedGeometry.test.ts proves the 12 builder-less placements produce today's exact render plan.
//
// WHY `buildGeometry` IS A THUNK RATHER THAN A FIELD: `worldContext.ts` (the composition root)
// resolves every bespoke on every world build to collect its claims, and that root must stay free
// of three objects (the rule railLands.ts's header states and this seam inherits). A lazy builder
// keeps the placement half pure arithmetic; the scene layer and the tri-budget tests are the only
// callers that ever allocate a buffer.

import { BufferGeometry, Float32BufferAttribute } from 'three';
import { addFace, createAccum, toGeometry, type Quad, type Uv, type Vec3 } from './bespokeMesh';
import type { Aabb } from './claimIndex';
import {
  buildCibcSquareBespoke,
  buildCommerceCourtBespoke,
  buildFirstCanadianPlaceBespoke,
  buildRoyalBankPlazaBespoke,
  buildScotiaPlazaBespoke,
  buildTdBankTowerBespoke,
} from './financialTowers';
import { buildHockeyHallOfFameBespoke } from './hockeyHallOfFame';
import type { NamedBox, NamedPlacement } from './namedBuildings';
import { namedSignCellUv, type NamedSignCellId } from './namedSignage';
import { buildNewCityHallBespoke } from './newCityHall';
import { buildOldCityHallBespoke } from './oldCityHall';
import { buildOsgoodeHallBespoke } from './osgoodeHall';
import { railLandsStrip } from './railLands';
import { buildRoyalYorkBespoke } from './royalYork';
import { buildStreets, type MapRect, type Street } from './streets';
import { buildUnionStationBespoke } from './unionStation';

// --- the seam's shapes ------------------------------------------------------------------------

/** What a builder is handed besides its own placement: the resolved world skeleton it may
 * reference. Street-referenced by construction (CLAUDE.md's "no literal world coordinates"), and
 * the rail-lands strip because two Front Street landmarks legitimately build INTO the corridor
 * Phase 45 reserved (Union's GO shed is the first tenant of that reserved room). */
export interface NamedGeometryCtx {
  readonly streets: readonly Street[];
  readonly strip: MapRect;
}

/** A blocking claim a bespoke adds beyond its DATA box. `kind` stays inside the existing taxonomy
 * (claimIndex.ts): a real building volume is `namedBuilding` (building-class → it projects into the
 * camera clip index for free), a colliderless surface object is `decor`. */
export interface NamedExtraClaim {
  /** Builder-local, stable id. worldContext namespaces it as `named-bespoke:{placementId}:{id}`. */
  readonly id: string;
  readonly kind: 'namedBuilding' | 'decor';
  readonly aabb: Aabb;
  readonly yRange: readonly [number, number];
}

/** An extra axis-aligned BUILDING cuboid the scene mounts alongside the DATA-box colliders. */
export interface NamedExtraCollider {
  readonly id: string;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
}

/**
 * Which face a wordmark quad sits on. SOUTH and EAST are the camera-visible pair (pinned since
 * Phase 24, re-derived at Phase 34). NORTH is legal and deliberate for a TRUE facade the fixed rig
 * can never show — Union's colonnade frieze faces Front Street, i.e. north — exactly like the
 * Rogers Centre's north hotel strip (Phase 45): it is truth, it pays off in the off-rig postcard,
 * and it costs 2 triangles. A builder that puts its ONLY wordmark on north is the defect the test
 * guards against, not the north face itself.
 */
export type NamedSignFace = 'south' | 'east' | 'north';

/** One wordmark quad in world space. `heightWu` is derived from `widthWu` × the cell aspect. */
export interface NamedSignQuad {
  readonly id: string;
  readonly cell: NamedSignCellId;
  readonly face: NamedSignFace;
  readonly position: Vec3;
  readonly widthWu: number;
  readonly heightWu: number;
}

/** Probe numbers a builder publishes for its own tests (heights, counts, edges). Numbers only —
 * that keeps the seam type-safe without an `any`, and without a union every new builder must edit. */
export interface NamedBespokeMeta {
  /** Highest point of the bespoke geometry (wu) — the eye-line law's subject. */
  readonly topY: number;
  readonly probes: Readonly<Record<string, number>>;
}

/** The merged mesh a builder produces, with per-part triangle counts (each part has its own
 * budget: Union's headhouse and its GO shed are pinned separately). */
export interface NamedBespokeGeometry {
  readonly geometry: BufferGeometry;
  readonly triangles: number;
  readonly parts: readonly { readonly id: string; readonly triangles: number }[];
}

export interface NamedBespoke {
  readonly id: string;
  /** Replaces `placement.boxes` for RENDERING only (facade textures still apply). May be a SUBSET
   * of the data boxes (P47): a box fully superseded by bespoke geometry is DROPPED, not stubbed —
   * an invisible stub still costs a whole draw call on the per-box facade-texture path, which is
   * exactly what broke the low-tier call budget when City Hall's tower slabs shipped as buried
   * 0.1 wu pads. Every rendered box must still MATCH a data box's footprint (the law test). */
  readonly renderBoxes: readonly NamedBox[];
  /**
   * For each `renderBoxes` entry, the index of the DATA box it stands in for. Omit for the
   * identity mapping (the whole-plan case — four of the five builders).
   *
   * WHY THIS EXISTS RATHER THAN LETTING ARRAY POSITION SPEAK: two consumers key off the DATA
   * index, and a subset silently renumbers both. (1) The Phase-24 facade-texture / Phase-36
   * occlusion key is `${id}#${i}` — P36's law is that fade keys are ITEM-derived, never array
   * positions, and dropping City Hall's two tower boxes would rename the podium `#2`→`#0`.
   * (2) `placement.decals[].boxIndex` indexes the data boxes, so `renderBoxes[boxIndex]` would
   * hang a CROWN on the wrong box (no built id carries a crown yet — this keeps it correct for
   * the day one does). Both are resolved through `namedRenderBoxDataIndex` below.
   */
  readonly renderBoxDataIndices?: readonly number[];
  readonly signQuads: readonly NamedSignQuad[];
  readonly extraClaims: readonly NamedExtraClaim[];
  readonly extraColliders: readonly NamedExtraCollider[];
  readonly meta: NamedBespokeMeta;
  /** Build the merged mesh. Lazy — see this file's header. */
  readonly buildGeometry: () => NamedBespokeGeometry;
  /**
   * Draw-call pooling (P47): bespokes sharing a `renderGroup` are merged into ONE scene mesh
   * (identical materials by construction — every builder ships vertex-coloured non-indexed
   * position/normal/color from bespokeMesh.toGeometry). THE TRADE, eyes open: the A.5 occlusion
   * fade's material path fades a MESH, so a group fades TOGETHER. Group only landmarks that share
   * one city block (the civic trio spans ~110 wu): a transient drive-by fade of one member ghosts
   * its block-mates, which reads as one plaza fading — acceptable; grouping across blocks would
   * ghost unrelated skyline and is the mistake this comment exists to prevent.
   */
  readonly renderGroup?: string;
}

export type NamedGeometryBuilder = (placement: NamedPlacement, ctx: NamedGeometryCtx) => NamedBespoke;

/**
 * THE REGISTRY. One entry per spec row that has earned bespoke geometry; every other named
 * placement keeps the Phase-24 box path untouched.
 *
 * Phase 46: `union-station` (T1) and `fairmont-royal-york` (T2). Phase 47: the civic heart —
 * `new-city-hall` (+ Nathan Phillips Square, carried by the same builder), `old-city-hall`,
 * `osgoode-hall`. Phase 48: the six Bay Street bank towers (financialTowers.ts — the first
 * MULTI-BUILDING builder module, sharing one street-level vocabulary across six ids) and the
 * `hockey-hall-of-fame`. Part 12 appends the flatiron, Convocation Hall and the rest.
 */
export const namedGeometryBuilders: ReadonlyMap<string, NamedGeometryBuilder> = new Map<string, NamedGeometryBuilder>([
  ['union-station', buildUnionStationBespoke],
  ['fairmont-royal-york', buildRoyalYorkBespoke],
  ['new-city-hall', buildNewCityHallBespoke],
  ['old-city-hall', buildOldCityHallBespoke],
  ['osgoode-hall', buildOsgoodeHallBespoke],
  ['first-canadian-place', buildFirstCanadianPlaceBespoke],
  ['scotia-plaza', buildScotiaPlazaBespoke],
  ['td-bank-tower', buildTdBankTowerBespoke],
  ['commerce-court-west', buildCommerceCourtBespoke],
  ['royal-bank-plaza', buildRoyalBankPlazaBespoke],
  ['cibc-square', buildCibcSquareBespoke],
  ['hockey-hall-of-fame', buildHockeyHallOfFameBespoke],
]);

// --- resolution --------------------------------------------------------------------------------

/** Resolve the builder context once (the strip lookup walks the street table). */
export function namedGeometryCtx(streets: readonly Street[] = buildStreets().streets): NamedGeometryCtx {
  return { streets, strip: railLandsStrip(streets) };
}

/**
 * Every bespoke for the given placements, keyed by placement id. Entries exist ONLY for registered
 * ids — that IS the fallback: an unregistered placement never appears here, so every consumer's
 * `?? placement.boxes` branch is the Phase-24 path verbatim.
 */
export function resolveNamedBespoke(
  placements: readonly NamedPlacement[],
  streets?: readonly Street[],
): ReadonlyMap<string, NamedBespoke> {
  const ctx = namedGeometryCtx(streets);
  const out = new Map<string, NamedBespoke>();
  for (const placement of placements) {
    const builder = namedGeometryBuilders.get(placement.id);
    if (builder === undefined) continue;
    out.set(placement.id, builder(placement, ctx));
  }
  return out;
}

/** A bespoke claim with its namespaced id + owner already minted — the shape worldContext feeds
 * straight into `index.register`. Minting here (rather than in the composition root) keeps the id
 * scheme and the owner scheme in ONE place, which is what makes the same-owner sanction rule
 * (claimIndex.isSanctionedOverlap rule (a)) reliable for every future builder. */
export interface ResolvedNamedClaim {
  readonly id: string;
  readonly kind: 'namedBuilding' | 'decor';
  readonly owner: string;
  readonly aabb: Aabb;
  readonly yRange: readonly [number, number];
  /** `null` on building-class claims: named volumes fade through occlusionFade.ts's material
   * -opacity path and the Phase-36 dither pass must skip them. `undefined` on decor (not a
   * building-class kind — it never reaches the clip index at all). */
  readonly fadeKey: string | null | undefined;
}

/**
 * Every bespoke's extra claims, namespaced and owned. PURE — no three object is allocated
 * (`buildGeometry` is never called), which is what lets the composition root consume this.
 */
export function namedBespokeClaims(
  placements: readonly NamedPlacement[],
  streets?: readonly Street[],
): readonly ResolvedNamedClaim[] {
  const out: ResolvedNamedClaim[] = [];
  for (const [placementId, bespoke] of resolveNamedBespoke(placements, streets)) {
    for (const claim of bespoke.extraClaims) {
      out.push({
        id: `named-bespoke:${placementId}:${claim.id}`,
        kind: claim.kind,
        owner: `named:${placementId}`,
        aabb: claim.aabb,
        yRange: claim.yRange,
        fadeKey: claim.kind === 'namedBuilding' ? null : undefined,
      });
    }
  }
  return out;
}

/** One box the named layer renders, with the texture seed key it has carried since Phase 24. */
export interface NamedRenderBox {
  readonly placementId: string;
  readonly box: NamedBox;
  readonly key: string;
}

/**
 * The named layer's render plan: `renderBoxes` for built ids, `placement.boxes` for everyone else,
 * with the `${placementId}#${index}` key unchanged in both branches. One function so the scene and
 * the fallback-identity test read the same rule.
 */
export function resolveNamedRenderBoxes(
  placements: readonly NamedPlacement[],
  bespokes: ReadonlyMap<string, NamedBespoke>,
): readonly NamedRenderBox[] {
  const out: NamedRenderBox[] = [];
  for (const placement of placements) {
    const bespoke = bespokes.get(placement.id);
    const boxes = bespoke?.renderBoxes ?? placement.boxes;
    boxes.forEach((box, i) =>
      out.push({
        placementId: placement.id,
        box,
        // The DATA index, never the render index — see `renderBoxDataIndices`. A dropped box takes
        // its key out of the plan with it; the surviving boxes keep the keys they have had since
        // Phase 24, so the plan is a SUBSEQUENCE of the pre-seam plan.
        key: `${placement.id}#${bespoke === undefined ? i : namedRenderBoxDataIndex(bespoke, i)}`,
      }),
    );
  }
  return out;
}

/**
 * Which DATA box the `i`th render box of `bespoke` stands in for. Identity unless the builder
 * declared a subset mapping. The law test proves the declared mapping is strictly increasing,
 * in range, and footprint-matched, so this is a lookup and never a guess.
 */
export function namedRenderBoxDataIndex(bespoke: NamedBespoke, i: number): number {
  return bespoke.renderBoxDataIndices?.[i] ?? i;
}

/** The render box standing in for DATA box `dataIndex`, or `undefined` if the builder dropped it. */
export function namedRenderBoxForDataIndex(bespoke: NamedBespoke, dataIndex: number): NamedBox | undefined {
  const at = bespoke.renderBoxes.findIndex((_, i) => namedRenderBoxDataIndex(bespoke, i) === dataIndex);
  return at === -1 ? undefined : bespoke.renderBoxes[at];
}

// --- the shared wordmark mesh --------------------------------------------------------------------

/**
 * Face basis: `outward` is the face normal, `right` the direction text READS toward for a viewer
 * standing off that face. Derived, not guessed — for a viewer looking along −normal with +Y up,
 * right = normal × up:  south (0,0,1) → (+X);  east (1,0,0) → (−Z);  north (0,0,−1) → (−X).
 */
const SIGN_FACE_BASIS: Readonly<Record<NamedSignFace, { readonly outward: Vec3; readonly right: Vec3 }>> = {
  south: { outward: [0, 0, 1], right: [1, 0, 0] },
  east: { outward: [1, 0, 0], right: [0, 0, -1] },
  north: { outward: [0, 0, -1], right: [-1, 0, 0] },
};

function signQuadCorners(quad: NamedSignQuad): Quad {
  const { right } = SIGN_FACE_BASIS[quad.face];
  const [cx, cy, cz] = quad.position;
  const hw = quad.widthWu / 2;
  const hh = quad.heightWu / 2;
  const rx = right[0] * hw;
  const rz = right[2] * hw;
  return [
    [cx - rx, cy - hh, cz - rz],
    [cx + rx, cy - hh, cz + rz],
    [cx + rx, cy + hh, cz + rz],
    [cx - rx, cy + hh, cz - rz],
  ];
}

// --- the pooled landmark meshes (P47) ------------------------------------------------------------

/**
 * THE ONE GROUP THAT EXISTS. Nathan Phillips Square's three landmarks (City Hall + the square,
 * Old City Hall across Bay, Osgoode Hall across University) share one civic block, so they pool
 * into a single mesh — the two calls that buys are what keeps the LOW tier inside its 90-call
 * budget (measured: 91 unpooled, 89 pooled). Read `NamedBespoke.renderGroup` before adding a
 * second group; the fade-together trade is only acceptable within one block.
 */
export const CIVIC_HEART_RENDER_GROUP = 'civic-heart';

/** One scene mesh: a whole `renderGroup`, or a single ungrouped bespoke. */
export interface BespokeRenderMesh {
  readonly key: string;
  readonly ids: readonly string[];
  readonly geometry: BufferGeometry;
  readonly triangles: number;
}

/** Concatenate one named Float32 attribute across already-built part geometries. Every builder
 * emits through bespokeMesh.toGeometry (non-indexed position/normal/color, no uv), so the
 * attribute sets agree by construction — asserted, not assumed. */
function concatAttribute(parts: readonly BufferGeometry[], name: string, itemSize: number): Float32BufferAttribute {
  let total = 0;
  for (const p of parts) {
    const a = p.getAttribute(name);
    if (a === undefined) throw new Error(`namedGeometry: group member is missing attribute "${name}"`);
    total += a.count;
  }
  const out = new Float32Array(total * itemSize);
  let offset = 0;
  for (const p of parts) {
    const a = p.getAttribute(name);
    out.set(a.array as Float32Array, offset);
    offset += a.count * itemSize;
  }
  return new Float32BufferAttribute(out, itemSize);
}

/**
 * The scene's landmark mesh list: `buildGeometry()` every bespoke, then pool by
 * `renderGroup ?? id`. A single-member group reuses its part geometry untouched (the Union/Royal
 * York path is byte-identical to pre-P47); a real group concatenates into one geometry — one draw
 * call for the whole block (the trade documented on `NamedBespoke.renderGroup`).
 */
export function buildBespokeRenderMeshes(bespokes: ReadonlyMap<string, NamedBespoke>): readonly BespokeRenderMesh[] {
  const order: string[] = [];
  const groups = new Map<string, { ids: string[]; parts: BufferGeometry[]; triangles: number }>();
  for (const bespoke of bespokes.values()) {
    const key = bespoke.renderGroup ?? bespoke.id;
    let g = groups.get(key);
    if (g === undefined) {
      g = { ids: [], parts: [], triangles: 0 };
      groups.set(key, g);
      order.push(key);
    }
    const built = bespoke.buildGeometry();
    g.ids.push(bespoke.id);
    g.parts.push(built.geometry);
    g.triangles += built.triangles;
  }
  return order.map((key) => {
    const g = groups.get(key)!;
    if (g.parts.length === 1) return { key, ids: g.ids, geometry: g.parts[0], triangles: g.triangles };
    const merged = new BufferGeometry();
    merged.setAttribute('position', concatAttribute(g.parts, 'position', 3));
    merged.setAttribute('normal', concatAttribute(g.parts, 'normal', 3));
    merged.setAttribute('color', concatAttribute(g.parts, 'color', 3));
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    for (const p of g.parts) p.dispose();
    return { key, ids: g.ids, geometry: merged, triangles: g.triangles };
  });
}

/**
 * Every builder's wordmark quads as ONE merged geometry with atlas UVs — the whole seam's
 * lettering in a single draw call. Full-bright (`unshaded`): the texture carries its own light.
 */
export function buildNamedSignGeometry(bespokes: ReadonlyMap<string, NamedBespoke>): {
  readonly geometry: BufferGeometry;
  readonly count: number;
} {
  const acc = createAccum();
  let count = 0;
  for (const bespoke of bespokes.values()) {
    for (const quad of bespoke.signQuads) {
      const uv = namedSignCellUv(quad.cell);
      const uvs: readonly Uv[] = [
        [uv.u0, uv.v0],
        [uv.u1, uv.v0],
        [uv.u1, uv.v1],
        [uv.u0, uv.v1],
      ];
      addFace(acc, signQuadCorners(quad), SIGN_FACE_BASIS[quad.face].outward, '#ffffff', {
        unshaded: true,
        uv: uvs,
      });
      count++;
    }
  }
  return { geometry: toGeometry(acc, true), count };
}
