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

import type { BufferGeometry } from 'three';
import { addFace, createAccum, toGeometry, type Quad, type Uv, type Vec3 } from './bespokeMesh';
import type { Aabb } from './claimIndex';
import type { NamedBox, NamedPlacement } from './namedBuildings';
import { namedSignCellUv, type NamedSignCellId } from './namedSignage';
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
  /** Replaces `placement.boxes` for RENDERING only (facade textures still apply). */
  readonly renderBoxes: readonly NamedBox[];
  readonly signQuads: readonly NamedSignQuad[];
  readonly extraClaims: readonly NamedExtraClaim[];
  readonly extraColliders: readonly NamedExtraCollider[];
  readonly meta: NamedBespokeMeta;
  /** Build the merged mesh. Lazy — see this file's header. */
  readonly buildGeometry: () => NamedBespokeGeometry;
}

export type NamedGeometryBuilder = (placement: NamedPlacement, ctx: NamedGeometryCtx) => NamedBespoke;

/**
 * THE REGISTRY. One entry per spec row that has earned bespoke geometry; every other named
 * placement keeps the Phase-24 box path untouched.
 *
 * Phase 46: `union-station` (T1) and `fairmont-royal-york` (T2). Parts 11–12 append City Hall,
 * the flatiron, Convocation Hall and the rest.
 */
export const namedGeometryBuilders: ReadonlyMap<string, NamedGeometryBuilder> = new Map<string, NamedGeometryBuilder>([
  ['union-station', buildUnionStationBespoke],
  ['fairmont-royal-york', buildRoyalYorkBespoke],
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
    const boxes = bespokes.get(placement.id)?.renderBoxes ?? placement.boxes;
    boxes.forEach((box, i) => out.push({ placementId: placement.id, box, key: `${placement.id}#${i}` }));
  }
  return out;
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
