/**
 * Phase 46 (Part 11) — THE SEAM's own tests: the registry, the resolver, the FALLBACK-IDENTITY
 * proof, the claim/collider contracts and the shared wordmark mesh.
 *
 * The load-bearing one is the fallback proof. `namedGeometryBuilders` exists so a landmark can
 * grow bespoke geometry WITHOUT the other twelve named placements taking a different code path —
 * the whole design premise is that "no builder" means "no map entry", not "a branch". If that ever
 * stops being true, every one of Phases 24–25's shipped facades is silently at risk, so the test
 * reconstructs the pre-seam render plan (box list + `${id}#${i}` texture keys) from the raw
 * placements and demands byte-equality for every builder-less id.
 */
import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import { overlaps, type Aabb } from './claimIndex';
import { buildNamedBuildings, type NamedPlacement } from './namedBuildings';
import {
  buildBespokeRenderMeshes,
  buildNamedSignGeometry,
  CIVIC_HEART_RENDER_GROUP,
  namedBespokeClaims,
  namedGeometryBuilders,
  namedGeometryCtx,
  namedRenderBoxDataIndex,
  namedRenderBoxForDataIndex,
  resolveNamedBespoke,
  resolveNamedRenderBoxes,
  type NamedBespoke,
} from './namedGeometry';
import { NAMED_SIGN_ATLAS, NAMED_SIGN_GLYPHS, namedSignCellAspect, namedSignCellUv, type NamedSignCellId } from './namedSignage';
import { buildStreets } from './streets';

const named = buildNamedBuildings();
const bespokes = resolveNamedBespoke(named.placements);

function attr(geometry: BufferGeometry, name: string): Float32Array {
  const a = geometry.getAttribute(name);
  expect(a, `geometry is missing the "${name}" attribute`).toBeTruthy();
  return a.array as Float32Array;
}

/** The render plan EXACTLY as `NamedBuildingsLayer` computed it from Phase 24 until Phase 46. */
function preSeamRenderPlan(placements: readonly NamedPlacement[]) {
  return placements.flatMap((p) => p.boxes.map((box, i) => ({ placementId: p.id, box, key: `${p.id}#${i}` })));
}

// -------------------------------------------------------------------------------------------------
// registry + resolution
// -------------------------------------------------------------------------------------------------

describe('namedGeometry — the registry', () => {
  it('registers exactly the ids Phase 46 ships bespoke geometry for', () => {
    expect([...namedGeometryBuilders.keys()].sort()).toEqual([
      'fairmont-royal-york',
      'new-city-hall',
      'old-city-hall',
      'osgoode-hall',
      'union-station',
    ]);
  });

  it('every registered id is a real named placement (a typo would silently do nothing)', () => {
    const placementIds = new Set(named.placements.map((p) => p.id));
    for (const id of namedGeometryBuilders.keys()) expect(placementIds.has(id), id).toBe(true);
  });

  it('resolves entries ONLY for registered ids', () => {
    expect([...bespokes.keys()].sort()).toEqual([...namedGeometryBuilders.keys()].sort());
    for (const p of named.placements) {
      expect(bespokes.has(p.id), p.id).toBe(namedGeometryBuilders.has(p.id));
    }
  });

  it('is deterministic — two resolutions agree on every placement number and on the geometry itself', () => {
    const again = resolveNamedBespoke(named.placements);
    for (const [id, a] of bespokes) {
      const b = again.get(id);
      expect(b, id).toBeDefined();
      expect(b?.renderBoxes).toEqual(a.renderBoxes);
      expect(b?.signQuads).toEqual(a.signQuads);
      expect(b?.extraClaims).toEqual(a.extraClaims);
      expect(b?.extraColliders).toEqual(a.extraColliders);
      expect(b?.meta).toEqual(a.meta);
      expect(Array.from(attr(b!.buildGeometry().geometry, 'position'))).toEqual(
        Array.from(attr(a.buildGeometry().geometry, 'position')),
      );
    }
  });

  it('passing the street table explicitly resolves the same context as the memo-free default', () => {
    const streets = buildStreets().streets;
    expect(namedGeometryCtx(streets)).toEqual(namedGeometryCtx());
    expect(resolveNamedBespoke(named.placements, streets).get('union-station')?.meta).toEqual(
      bespokes.get('union-station')?.meta,
    );
  });
});

// -------------------------------------------------------------------------------------------------
// THE FALLBACK PROOF
// -------------------------------------------------------------------------------------------------

describe('namedGeometry — the box fallback is structural', () => {
  it('every builder-LESS placement renders the exact pre-seam plan (same boxes, same texture keys)', () => {
    const plan = resolveNamedRenderBoxes(named.placements, bespokes);
    const before = preSeamRenderPlan(named.placements);
    const untouched = (entry: { placementId: string }) => !namedGeometryBuilders.has(entry.placementId);
    // The placement COUNT is pinned so a future builder that accidentally swallowed a placement
    // can't make this comparison vacuously pass; the untouched count is then derived, so adding a
    // builder is a one-number change here and never silently narrows the proof.
    const untouchedIds = named.placements.filter((p) => !namedGeometryBuilders.has(p.id)).map((p) => p.id);
    expect(named.placements).toHaveLength(17);
    expect(untouchedIds).toHaveLength(named.placements.length - namedGeometryBuilders.size);
    expect(plan.filter(untouched)).toEqual(before.filter(untouched));
  });

  it('the plan is a SUBSEQUENCE of the pre-seam plan — order and keys preserved, drops declared', () => {
    const plan = resolveNamedRenderBoxes(named.placements, bespokes);
    const before = preSeamRenderPlan(named.placements);
    const beforeKeys = before.map((e) => e.key);
    const planKeys = plan.map((e) => e.key);
    // A subset render plan (P47: City Hall's tower boxes become bespoke geometry) may REMOVE
    // entries. It may never reorder or rename the survivors: those keys seed the facade textures
    // and are the Phase-36 occlusion fade keys, which the P36 law requires to be item-derived.
    expect(planKeys).toEqual(beforeKeys.filter((k) => planKeys.includes(k)));
    for (const entry of plan) {
      const match = before.find((e) => e.key === entry.key);
      expect(match, entry.key).toBeDefined();
      expect(entry.placementId).toBe(match?.placementId);
    }
    // The drop list is pinned, so a builder that swallows a box by accident fails here loudly
    // rather than quietly rendering one fewer facade.
    expect(beforeKeys.filter((k) => !planKeys.includes(k))).toEqual(['new-city-hall#0', 'new-city-hall#1']);
  });

  it('an EMPTY bespoke map reproduces the pre-seam plan for every id (the disable-the-seam control)', () => {
    expect(resolveNamedRenderBoxes(named.placements, new Map())).toEqual(preSeamRenderPlan(named.placements));
  });

  it('a built id renders a footprint-matched SUBSET of its data boxes — only the height may shrink', () => {
    for (const [id, bespoke] of bespokes) {
      const placement = named.placements.find((p) => p.id === id)!;
      expect(bespoke.renderBoxes.length).toBeLessThanOrEqual(placement.boxes.length);
      const indices = bespoke.renderBoxes.map((_, i) => namedRenderBoxDataIndex(bespoke, i));
      // Strictly increasing and in range: the mapping is a real subsequence, so the plan can never
      // reorder, and two render boxes can never claim the same data box (which would duplicate a
      // facade key and hand two meshes one fade key).
      indices.forEach((dataIndex, n) => {
        expect(Number.isInteger(dataIndex), `${id}[${n}]`).toBe(true);
        expect(dataIndex, `${id}[${n}]`).toBeGreaterThanOrEqual(0);
        expect(dataIndex, `${id}[${n}]`).toBeLessThan(placement.boxes.length);
        if (n > 0) expect(dataIndex, `${id}[${n}]`).toBeGreaterThan(indices[n - 1]);
      });
      bespoke.renderBoxes.forEach((box, i) => {
        const data = placement.boxes[indices[i]];
        expect({ cx: box.cx, cz: box.cz, hx: box.hx, hz: box.hz }).toEqual({
          cx: data.cx,
          cz: data.cz,
          hx: data.hx,
          hz: data.hz,
        });
        expect(box.look).toEqual(data.look);
        expect(box.hy).toBeLessThanOrEqual(data.hy);
      });
    }
  });

  // These two accessors are the whole defence against a subset render plan renumbering the things
  // that are keyed by DATA index. The decal consumer (TorontoScene) is unreachable today — no built
  // id carries a CROWN — so it is proven here directly rather than left to the day one does.
  it('maps identity for a whole-plan builder and the declared index for a subset builder', () => {
    const union = bespokes.get('union-station')!;
    union.renderBoxes.forEach((_, i) => expect(namedRenderBoxDataIndex(union, i)).toBe(i));
    expect(namedRenderBoxDataIndex(bespokes.get('new-city-hall')!, 0)).toBe(2);
  });

  it('finds a surviving box by DATA index and reports a dropped one as undefined', () => {
    const hall = bespokes.get('new-city-hall')!;
    const boxes = named.placements.find((p) => p.id === 'new-city-hall')!.boxes;
    const podium = namedRenderBoxForDataIndex(hall, 2);
    expect([podium?.cx, podium?.cz]).toEqual([boxes[2].cx, boxes[2].cz]);
    // The dropped tower boxes report their absence — that `undefined` is what makes the decal path
    // fall back to the DATA box instead of silently hanging a CROWN on the podium.
    expect(namedRenderBoxForDataIndex(hall, 0)).toBeUndefined();
    expect(namedRenderBoxForDataIndex(hall, 1)).toBeUndefined();
  });
});

// -------------------------------------------------------------------------------------------------
// pooled render meshes (P47)
// -------------------------------------------------------------------------------------------------

describe('namedGeometry — pooled render meshes', () => {
  const meshes = buildBespokeRenderMeshes(bespokes);

  /** A bespoke's world-space centre, from its own built geometry. */
  function centreOf(id: string): { x: number; z: number } {
    const geometry = bespokes.get(id)!.buildGeometry().geometry;
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    return { x: (box.min.x + box.max.x) / 2, z: (box.min.z + box.max.z) / 2 };
  }

  it('pools the civic block into ONE mesh and leaves the ungrouped landmarks alone', () => {
    const byKey = new Map(meshes.map((m) => [m.key, [...m.ids].sort()]));
    expect(byKey.get(CIVIC_HEART_RENDER_GROUP)).toEqual(['new-city-hall', 'old-city-hall', 'osgoode-hall']);
    expect(byKey.get('union-station')).toEqual(['union-station']);
    expect(byKey.get('fairmont-royal-york')).toEqual(['fairmont-royal-york']);
    // THE BUDGET CLAIM, pinned: five bespoke ids resolve to three scene meshes. Those two saved
    // draw calls are what put the LOW tier back inside its 90-call budget (measured 91 unpooled,
    // 89 pooled) — un-pooling this without finding the calls elsewhere breaks the mobile gate.
    expect(bespokes.size).toBe(5);
    expect(meshes).toHaveLength(3);
  });

  it('pooling conserves geometry — not one triangle gained or lost', () => {
    const perId = new Map([...bespokes].map(([id, b]) => [id, b.buildGeometry().triangles]));
    for (const mesh of meshes) {
      expect(mesh.triangles, mesh.key).toBe(mesh.ids.reduce((n, id) => n + perId.get(id)!, 0));
      // Non-indexed, 3 vertices per triangle: the merged buffers are exactly the sum of the parts,
      // which is what proves the concatenation neither truncated nor double-counted a member.
      for (const name of ['position', 'normal', 'color']) {
        expect(mesh.geometry.getAttribute(name).count, `${mesh.key}.${name}`).toBe(mesh.triangles * 3);
      }
    }
  });

  it('a merged group gets its bounding volume computed (the A.5 occlusion raycast reads it)', () => {
    for (const mesh of meshes.filter((m) => m.ids.length > 1)) {
      expect(mesh.geometry.boundingBox, mesh.key).not.toBeNull();
      expect(mesh.geometry.boundingSphere?.radius ?? 0, mesh.key).toBeGreaterThan(0);
    }
  });

  it('a group never spans more than one city block — the fade-together trade is block-LOCAL', () => {
    // THE LAW behind `NamedBespoke.renderGroup`'s warning: a pooled mesh fades as a unit, so its
    // members must be close enough that one fading reads as "that block is fading". The civic trio
    // spans ~110 wu (Osgoode at University to Old City Hall east of Bay). Front Street is ~500 wu
    // away — this is what fails if someone ever pools across blocks to buy a cheap draw call.
    const MAX_GROUP_SPAN_WU = 200;
    for (const mesh of meshes.filter((m) => m.ids.length > 1)) {
      const centres = mesh.ids.map(centreOf);
      let span = 0;
      for (const a of centres) {
        for (const b of centres) span = Math.max(span, Math.hypot(a.x - b.x, a.z - b.z));
      }
      expect(span, `${mesh.key} span`).toBeGreaterThan(0); // non-vacuous
      expect(span, `${mesh.key} span`).toBeLessThanOrEqual(MAX_GROUP_SPAN_WU);
    }
  });
});

// -------------------------------------------------------------------------------------------------
// claims + colliders
// -------------------------------------------------------------------------------------------------

describe('namedGeometry — extra claims', () => {
  const claims = namedBespokeClaims(named.placements);

  it('mints one namespaced, owned claim per bespoke extra claim', () => {
    const expected = [...bespokes.values()].flatMap((b) => b.extraClaims.map((c) => `named-bespoke:${b.id}:${c.id}`));
    expect(claims.map((c) => c.id)).toEqual(expected);
    for (const claim of claims) {
      expect(claim.owner.startsWith('named:'), claim.id).toBe(true);
      expect(claim.id.startsWith(`named-bespoke:${claim.owner.slice('named:'.length)}:`), claim.id).toBe(true);
    }
  });

  it('claim ids are unique (the index throws on a duplicate — catch it here instead)', () => {
    expect(new Set(claims.map((c) => c.id)).size).toBe(claims.length);
  });

  it('building-class claims carry fadeKey null (the material-opacity path), decor carries none', () => {
    for (const claim of claims) {
      if (claim.kind === 'namedBuilding') expect(claim.fadeKey, claim.id).toBeNull();
      else expect(claim.fadeKey, claim.id).toBeUndefined();
    }
  });

  it('every claim is a well-formed, non-degenerate AABB standing on the ground', () => {
    for (const claim of claims) {
      expect(claim.aabb.maxX, claim.id).toBeGreaterThan(claim.aabb.minX);
      expect(claim.aabb.maxZ, claim.id).toBeGreaterThan(claim.aabb.minZ);
      expect(claim.yRange[0], claim.id).toBe(0);
      expect(claim.yRange[1], claim.id).toBeGreaterThan(0);
    }
  });

  it('no bespoke claim interior-overlaps its own placement DATA box (the collider stays the truth)', () => {
    for (const [id, bespoke] of bespokes) {
      const placement = named.placements.find((p) => p.id === id)!;
      const dataBoxes: Aabb[] = placement.boxes.map((b) => ({
        minX: b.cx - b.hx,
        maxX: b.cx + b.hx,
        minZ: b.cz - b.hz,
        maxZ: b.cz + b.hz,
      }));
      for (const claim of bespoke.extraClaims) {
        for (const data of dataBoxes) {
          expect(overlaps(claim.aabb, data), `${id}:${claim.id}`).toBe(false);
        }
      }
    }
  });
});

describe('namedGeometry — extra colliders', () => {
  it('every extra collider is a positive-extent cuboid floored at y = 0 and matched by a claim', () => {
    for (const [id, bespoke] of bespokes) {
      for (const collider of bespoke.extraColliders) {
        for (const h of [collider.hx, collider.hy, collider.hz]) expect(h, `${id}:${collider.id}`).toBeGreaterThan(0);
        expect(collider.cy, `${id}:${collider.id}`).toBeCloseTo(collider.hy, 9);
        const claim = bespoke.extraClaims.find((c) => c.id === collider.id);
        expect(claim, `${id}:${collider.id} has no matching claim`).toBeDefined();
        expect(claim?.kind).toBe('namedBuilding');
        expect(claim?.aabb).toEqual({
          minX: collider.cx - collider.hx,
          maxX: collider.cx + collider.hx,
          minZ: collider.cz - collider.hz,
          maxZ: collider.cz + collider.hz,
        });
        expect(claim?.yRange[1]).toBeCloseTo(2 * collider.hy, 9);
      }
    }
  });
});

// -------------------------------------------------------------------------------------------------
// geometry contract + the shared wordmark mesh
// -------------------------------------------------------------------------------------------------

describe('namedGeometry — the merged mesh contract', () => {
  it('every bespoke mesh is non-indexed, vertex-coloured, and reports its own triangle count', () => {
    for (const [id, bespoke] of bespokes) {
      const built = bespoke.buildGeometry();
      expect(built.geometry.index, id).toBeNull();
      expect(attr(built.geometry, 'position').length / 9, id).toBe(built.triangles);
      expect(attr(built.geometry, 'color').length / 9, id).toBe(built.triangles);
      expect(attr(built.geometry, 'normal').length / 9, id).toBe(built.triangles);
      expect(built.parts.reduce((n, p) => n + p.triangles, 0), id).toBe(built.triangles);
    }
  });

  it("meta.topY is the mesh's real top (no bespoke silently outgrows the height it publishes)", () => {
    for (const [id, bespoke] of bespokes) {
      const built = bespoke.buildGeometry();
      built.geometry.computeBoundingBox();
      expect(built.geometry.boundingBox!.max.y, id).toBeLessThanOrEqual(bespoke.meta.topY + 1e-3);
    }
  });
});

describe('namedGeometry — the shared wordmark mesh', () => {
  const signs = buildNamedSignGeometry(bespokes);
  const allQuads = [...bespokes.values()].flatMap((b: NamedBespoke) => b.signQuads);

  it('merges every builder\'s quads into ONE geometry (+1 draw call for the whole seam)', () => {
    expect(signs.count).toBe(allQuads.length);
    expect(attr(signs.geometry, 'position').length / 9).toBe(2 * allQuads.length);
    expect(signs.geometry.getAttribute('uv')).toBeTruthy();
  });

  it('every quad derives its height from its cell aspect (never hand-typed)', () => {
    for (const quad of allQuads) {
      expect(quad.heightWu, quad.id).toBeCloseTo(quad.widthWu * namedSignCellAspect(quad.cell), 9);
    }
  });

  it('every builder WITH wordmarks puts at least one on a CAMERA-VISIBLE face (south/east)', () => {
    // The guard's target (P46) is a builder whose ONLY wordmark faces north — lettering the fixed
    // rig can never show. A builder with NO atlas wordmark at all is legal (P47: the civic trio —
    // the TORONTO sign is in-mesh 3D lettering, and Old City Hall/Osgoode carry no signage), so
    // the law binds only where signQuads exist.
    for (const [id, bespoke] of bespokes) {
      if (bespoke.signQuads.length === 0) continue;
      const visible = bespoke.signQuads.filter((q) => q.face === 'south' || q.face === 'east');
      expect(visible.length, `${id} has no camera-visible wordmark`).toBeGreaterThan(0);
    }
  });

  it('quad ids are unique across builders (a merged mesh has one namespace)', () => {
    expect(new Set(allQuads.map((q) => q.id)).size).toBe(allQuads.length);
  });

  it('every quad faces outward along its own face normal', () => {
    const normals = attr(signs.geometry, 'normal');
    const expected = new Set<string>(
      allQuads.map((q) => (q.face === 'south' ? '0,0,1' : q.face === 'east' ? '1,0,0' : '0,0,-1')),
    );
    for (let i = 0; i < normals.length; i += 3) {
      const key = `${Math.round(normals[i])},${Math.round(normals[i + 1])},${Math.round(normals[i + 2])}`;
      expect(expected.has(key), `unexpected sign normal ${key}`).toBe(true);
    }
  });
});

describe('namedSignage — the atlas', () => {
  const cellIds = Object.keys(NAMED_SIGN_ATLAS.cells) as NamedSignCellId[];

  it('every cell is inside the canvas and every wordmark is drawable in the shipped font', () => {
    for (const id of cellIds) {
      const c = NAMED_SIGN_ATLAS.cells[id];
      expect(c.x + c.w, id).toBeLessThanOrEqual(NAMED_SIGN_ATLAS.width);
      expect(c.y + c.h, id).toBeLessThanOrEqual(NAMED_SIGN_ATLAS.height);
      for (const ch of c.text) expect(NAMED_SIGN_GLYPHS, `${id}: no glyph for "${ch}"`).toContain(ch);
    }
  });

  it('no two cells overlap on the canvas', () => {
    for (let i = 0; i < cellIds.length; i++) {
      for (let j = i + 1; j < cellIds.length; j++) {
        const a = NAMED_SIGN_ATLAS.cells[cellIds[i]];
        const b = NAMED_SIGN_ATLAS.cells[cellIds[j]];
        const disjoint = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(disjoint, `${cellIds[i]} overlaps ${cellIds[j]}`).toBe(true);
      }
    }
  });

  it('UVs are the flipY-corrected cell rect (the logoAtlas/railLands convention)', () => {
    for (const id of cellIds) {
      const c = NAMED_SIGN_ATLAS.cells[id];
      const uv = namedSignCellUv(id);
      expect(uv.u0).toBeCloseTo(c.x / NAMED_SIGN_ATLAS.width, 9);
      expect(uv.u1).toBeCloseTo((c.x + c.w) / NAMED_SIGN_ATLAS.width, 9);
      expect(uv.v1).toBeCloseTo(1 - c.y / NAMED_SIGN_ATLAS.height, 9);
      expect(uv.v0).toBeCloseTo(1 - (c.y + c.h) / NAMED_SIGN_ATLAS.height, 9);
      expect(uv.u1).toBeGreaterThan(uv.u0);
      expect(uv.v1).toBeGreaterThan(uv.v0);
    }
  });
});
