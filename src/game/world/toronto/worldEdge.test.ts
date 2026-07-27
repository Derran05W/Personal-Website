import { describe, expect, it, vi } from 'vitest';
import { buildWorldEdge, type BarrierDressing, type BarrierEdge } from './worldEdge';
import { PLAYABLE_POLYGON, ZONE_X_EXTENTS, distanceToBoundary, pointInPolygon } from './polygon';
import { ZONE_BOUNDARIES } from './projection';
import { STREET_DEFS, buildStreets, type Street } from './streets';
import { BARRIER, EDGE_PAD_WU, ROAD_CLASSES } from '../../config/torontoMap';

const layout = buildWorldEdge();
const { streets } = buildStreets();

/** World (x,z) -> map (x,y): mapToWorld is the identity swap, so this is a pure rename. */
function toMap(p: { x: number; z: number }): { x: number; y: number } {
  return { x: p.x, y: p.z };
}

/** The four map-space corners of a collider box. */
function colliderCorners(c: { cx: number; cz: number; hx: number; hz: number }) {
  return [
    { x: c.cx - c.hx, y: c.cz - c.hz },
    { x: c.cx + c.hx, y: c.cz - c.hz },
    { x: c.cx + c.hx, y: c.cz + c.hz },
    { x: c.cx - c.hx, y: c.cz + c.hz },
  ];
}

function boxesOverlap(
  a: { cx: number; cz: number; hx: number; hz: number },
  b: { cx: number; cz: number; hx: number; hz: number },
): boolean {
  return Math.abs(a.cx - b.cx) < a.hx + b.hx - 1e-9 && Math.abs(a.cz - b.cz) < a.hz + b.hz - 1e-9;
}

/** Is a map point inside a street's ribbon rectangle (inclusive)? */
function inRibbon(p: { x: number; y: number }, s: Street): boolean {
  return (
    p.x >= s.ribbon.minX - 1e-9 &&
    p.x <= s.ribbon.maxX + 1e-9 &&
    p.y >= s.ribbon.minY - 1e-9 &&
    p.y <= s.ribbon.maxY + 1e-9
  );
}

const edgeDressing = layout.dressing.filter((d) => d.kind !== 'jerseyBarrier');
const jerseys = layout.dressing.filter((d) => d.kind === 'jerseyBarrier');

describe('worldEdge — the ring walks the polygon', () => {
  it('is deterministic across fresh module instances (no rng, no hidden input)', async () => {
    vi.resetModules();
    const a = (await import('./worldEdge')).buildWorldEdge();
    vi.resetModules();
    const b = (await import('./worldEdge')).buildWorldEdge();
    expect(a).not.toBe(b); // genuinely two builds, not the same memo
    expect(a).toEqual(b);
    expect(a).toEqual(layout);
  });

  it('barriers exactly 11 land edges — the south water edge is the only one skipped', () => {
    expect(PLAYABLE_POLYGON.length).toBe(12);
    expect(layout.edges).toHaveLength(11);
    expect(layout.colliders).toHaveLength(11);
    // The skipped edge is the lake's outer edge: both endpoints on the polygon's bottom boundary.
    expect(layout.waterEdge.start.z).toBeCloseTo(ZONE_BOUNDARIES[4], 9);
    expect(layout.waterEdge.end.z).toBeCloseTo(ZONE_BOUNDARIES[4], 9);
    // Every polygon edge index is accounted for exactly once.
    const covered = [...layout.edges.map((e) => e.index), layout.waterEdge.index].sort((a, b) => a - b);
    expect(covered).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('assigns the Phase 37 theme map: hoarding top, fence flanks, rail fold, notch step-ins', () => {
    /** The POLYGON coordinate this wall was offset from (the miter only moves the fixed axis by
     * inward x inset, since the two adjacent edges are perpendicular). */
    const polygonLine = (e: BarrierEdge): number =>
      e.runAxis === 'x' ? e.start.z - e.inward.z * e.insetWu : e.start.x - e.inward.x * e.insetWu;

    const [foldWest, foldEast] = ZONE_X_EXTENTS.fold;
    const expected = new Map<BarrierEdge, string>();
    for (const e of layout.edges) {
      const line = polygonLine(e);
      if (e.runAxis === 'x') {
        // Capsule top (ZB0) -> hoarding; the four step-ins (ZB1 capsule bottom, ZB2 downtown top)
        // -> notch. Nothing else is horizontal (the water edge, ZB4, has no wall).
        expect([ZONE_BOUNDARIES[0], ZONE_BOUNDARIES[1], ZONE_BOUNDARIES[2]]).toContainEqual(line);
        expected.set(e, line === ZONE_BOUNDARIES[0] ? 'hoarding' : 'notch');
      } else {
        const onFold = Math.abs(line - foldWest) < 1e-6 || Math.abs(line - foldEast) < 1e-6;
        expected.set(e, onFold ? 'rail' : 'fence');
      }
    }
    for (const [e, theme] of expected) expect(e.theme, `edge ${e.index}`).toBe(theme);
    const census = (t: string) => layout.edges.filter((e) => e.theme === t).length;
    expect({
      hoarding: census('hoarding'),
      notch: census('notch'),
      rail: census('rail'),
      fence: census('fence'),
    }).toEqual({ hoarding: 1, notch: 4, rail: 2, fence: 4 });
  });

  it('insets every clean edge by BARRIER.edgeInsetWu and only the flush-ribbon edges to the minimum', () => {
    for (const e of layout.edges) {
      expect([BARRIER.edgeInsetWu, BARRIER.minEdgeInsetWu]).toContain(e.insetWu);
    }
    // The four notch edges are exactly the ones Bloor/Sheppard lie flush against.
    const pulled = layout.edges.filter((e) => e.insetWu === BARRIER.minEdgeInsetWu);
    expect(pulled.map((e) => e.theme)).toEqual(['notch', 'notch', 'notch', 'notch']);
    expect(layout.edges.filter((e) => e.insetWu === BARRIER.edgeInsetWu)).toHaveLength(7);
  });

  it('places every collider box on its own inset line', () => {
    for (const c of layout.colliders) {
      const edge = layout.edges.find((e) => e.index === c.edgeIndex);
      expect(edge).toBeDefined();
      const centre = { x: c.cx, y: c.cz };
      // The box centre sits exactly `insetWu` off the polygon boundary...
      expect(distanceToBoundary(centre, PLAYABLE_POLYGON)).toBeCloseTo(edge!.insetWu, 6);
      // ...and the box is a thin wall: half-thickness across, long along its run.
      const across = edge!.runAxis === 'x' ? c.hz : c.hx;
      const along = edge!.runAxis === 'x' ? c.hx : c.hz;
      expect(across).toBeCloseTo(BARRIER.colliderThicknessWu / 2, 9);
      expect(along).toBeCloseTo(edge!.lengthWu / 2 + BARRIER.colliderThicknessWu / 2, 9);
    }
  });

  it('keeps every collider corner strictly inside the polygon', () => {
    for (const c of layout.colliders) {
      for (const corner of colliderCorners(c)) {
        expect(pointInPolygon(corner, PLAYABLE_POLYGON), `edge ${c.edgeIndex} ${JSON.stringify(corner)}`).toBe(
          true,
        );
      }
    }
  });

  it('seals every corner: each collider overlaps the next land edge around the ring', () => {
    const byIndex = new Map(layout.colliders.map((c) => [c.edgeIndex, c]));
    let seals = 0;
    for (const c of layout.colliders) {
      const next = byIndex.get((c.edgeIndex + 1) % PLAYABLE_POLYGON.length);
      if (!next) continue; // the water edge — its neighbours close the ring's ends instead
      expect(boxesOverlap(c, next), `edges ${c.edgeIndex}/${next.edgeIndex} do not seal`).toBe(true);
      seals += 1;
    }
    // 11 land edges, one of which is followed by the water edge -> 10 sealed corners.
    expect(seals).toBe(10);
  });

  it('closes the water gap at BOTH ends: the W/E walls run down to the ring south corners', () => {
    const southReach = ZONE_BOUNDARIES[4] - BARRIER.edgeInsetWu;
    const reaching = layout.colliders.filter((c) => c.cz + c.hz > southReach - 1e-6);
    expect(reaching).toHaveLength(2);
    for (const c of reaching) {
      const edge = layout.edges.find((e) => e.index === c.edgeIndex);
      expect(edge!.runAxis).toBe('z');
      expect(c.cz + c.hz).toBeCloseTo(southReach + BARRIER.colliderThicknessWu / 2, 9);
    }
    // ...and nothing at all spans the open south SIDE.
    const spansSouth = layout.colliders.some((c) => c.hx > 100 && c.cz > ZONE_BOUNDARIES[3]);
    expect(spansSouth).toBe(false);
  });
});

describe('worldEdge — dressing', () => {
  it('emits every documented kind, ordered by edge then by dead-end street', () => {
    const kinds = new Set(layout.dressing.map((d) => d.kind));
    expect([...kinds].sort()).toEqual(
      ['cone', 'fencePiece', 'hoardingPanel', 'jerseyBarrier', 'railPost'].sort(),
    );
    const edgeIndices = edgeDressing.map((d) => d.edgeIndex);
    expect([...edgeIndices].sort((a, b) => a - b)).toEqual(edgeIndices);
    expect(jerseys.every((d) => d.edgeIndex === -1 && d.streetId !== null)).toBe(true);
    expect(edgeDressing.every((d) => d.streetId === null)).toBe(true);
  });

  it('matches each theme to its recipe', () => {
    const kindsOn = (theme: string) => {
      const indices = new Set(layout.edges.filter((e) => e.theme === theme).map((e) => e.index));
      return new Set(edgeDressing.filter((d) => indices.has(d.edgeIndex)).map((d) => d.kind));
    };
    expect([...kindsOn('hoarding')]).toEqual(['hoardingPanel']);
    expect([...kindsOn('fence')]).toEqual(['fencePiece']);
    expect([...kindsOn('rail')].sort()).toEqual(['fencePiece', 'railPost']);
    expect([...kindsOn('notch')].sort()).toEqual(['cone', 'hoardingPanel']);
  });

  it('keeps every dressing placement inside the polygon and off the water', () => {
    for (const d of layout.dressing) {
      const p = toMap(d);
      expect(pointInPolygon(p, PLAYABLE_POLYGON), `${d.kind} ${JSON.stringify(p)}`).toBe(true);
      expect(p.y, `${d.kind} stands on the lake`).toBeLessThanOrEqual(
        ZONE_BOUNDARIES[3] - BARRIER.shoreClearanceWu + 1e-9,
      );
    }
  });

  it('faces every piece inward (local +Z toward the playable side)', () => {
    // The edge normals themselves point into the playable side — probed at the POLYGON edge's own
    // midpoint (corner-proof, unlike probing from a piece near a reflex step-in).
    for (const e of layout.edges) {
      const a = PLAYABLE_POLYGON[e.index];
      const b = PLAYABLE_POLYGON[(e.index + 1) % PLAYABLE_POLYGON.length];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const step = 0.5;
      expect(
        pointInPolygon({ x: mid.x + e.inward.x * step, y: mid.y + e.inward.z * step }, PLAYABLE_POLYGON),
        `edge ${e.index} inward`,
      ).toBe(true);
      expect(
        pointInPolygon({ x: mid.x - e.inward.x * step, y: mid.y - e.inward.z * step }, PLAYABLE_POLYGON),
        `edge ${e.index} outward`,
      ).toBe(false);
      expect(Math.hypot(e.inward.x, e.inward.z)).toBeCloseTo(1, 12);
    }
    // ...and every piece's yaw reproduces its edge's inward normal exactly.
    for (const d of edgeDressing) {
      const edge = layout.edges.find((e) => e.index === d.edgeIndex)!;
      expect(Math.sin(d.yawRad)).toBeCloseTo(edge.inward.x, 9);
      expect(Math.cos(d.yawRad)).toBeCloseTo(edge.inward.z, 9);
    }
  });

  it('never intrudes deeper than BARRIER.maxRibbonEncroachWu into any street ribbon', () => {
    // Depth measured from the ROAD'S OWN NEAREST CURB (not from the polygon boundary — at the
    // reflex step-in corners the nearest boundary point is the corner itself, which understates
    // nothing but overstates the intrusion). Edge dressing may only touch a ribbon where the road
    // is flush with the map edge (Bloor's north curb, Sheppard's south curb), and then only in
    // that road's outer sliver.
    const curbDepth = (p: { x: number; y: number }, s: Street): number => {
      const perp = s.axis === 'ew' ? p.y : p.x;
      const lo = s.axis === 'ew' ? s.ribbon.minY : s.ribbon.minX;
      const hi = s.axis === 'ew' ? s.ribbon.maxY : s.ribbon.maxX;
      return Math.min(perp - lo, hi - perp);
    };
    let intrusions = 0;
    for (const d of edgeDressing) {
      const p = toMap(d);
      for (const s of streets) {
        if (!inRibbon(p, s)) continue;
        intrusions += 1;
        expect(curbDepth(p, s), `${d.kind} on edge ${d.edgeIndex} sits deep inside ${s.id}`).toBeLessThanOrEqual(
          BARRIER.maxRibbonEncroachWu,
        );
      }
    }
    // Same rule for the walls themselves, measured at every corner of each box.
    for (const c of layout.colliders) {
      for (const corner of colliderCorners(c)) {
        for (const s of streets) {
          if (!inRibbon(corner, s)) continue;
          expect(curbDepth(corner, s), `wall ${c.edgeIndex} sits deep inside ${s.id}`).toBeLessThanOrEqual(
            BARRIER.maxRibbonEncroachWu,
          );
        }
      }
    }
    // The only roads the ring may stand on at all are the two boundary-nudged ones.
    const onRoads = new Set<string>();
    for (const d of edgeDressing) {
      const p = toMap(d);
      for (const s of streets) if (inRibbon(p, s)) onRoads.add(s.id);
    }
    expect([...onRoads].sort()).toEqual(['bloor', 'sheppard']);
    expect(intrusions).toBeGreaterThan(0); // the invariant above is not vacuous
  });

  it('leaves the traffic graph alone: nothing within 2 wu of a street terminal, 7.5 wu at the pads', () => {
    // Every resolved street endpoint (both ends of every street), in map space.
    const terminals: { id: string; zoneToken: boolean; p: { x: number; y: number } }[] = [];
    for (const s of streets) {
      const def = STREET_DEFS.find((d) => d.id === s.id)!;
      const zoneToken = def.span.some((t) => t.t === 'zone');
      terminals.push({ id: s.id, zoneToken, p: s.start });
      terminals.push({ id: s.id, zoneToken, p: s.end });
    }
    // The ring (walls + their dressing) never crowds a terminal. Jersey rows are exempt BY
    // DESIGN — a "road closed" row belongs on the last metre of asphalt.
    const clearance = (p: { x: number; y: number }, keep: (e: BarrierEdge) => boolean) => {
      const kept = new Set(layout.edges.filter(keep).map((e) => e.index));
      let min = Infinity;
      for (const c of layout.colliders) {
        if (!kept.has(c.edgeIndex)) continue;
        const dx = Math.max(Math.abs(p.x - c.cx) - c.hx, 0);
        const dz = Math.max(Math.abs(p.y - c.cz) - c.hz, 0);
        min = Math.min(min, Math.hypot(dx, dz));
      }
      for (const d of edgeDressing) {
        if (!kept.has(d.edgeIndex)) continue;
        min = Math.min(min, Math.hypot(p.x - d.x, p.y - d.z));
      }
      return min;
    };
    const all = () => true;
    for (const t of terminals) {
      expect(clearance(t.p, all), `${t.id} terminal`).toBeGreaterThanOrEqual(2);
    }
    // The pad-token ends (the ones that stop exactly EDGE_PAD_WU short of a zone edge) keep the
    // full designed gap to the wall they DRIVE INTO: EDGE_PAD - inset - half thickness. Walls
    // running PARALLEL to the street are the flush-ribbon case (Bloor's own north shoulder wall
    // sits 3.95 wu off its terminal by construction) and are measured by the >= 2 rule above.
    const padGap = EDGE_PAD_WU - BARRIER.edgeInsetWu - BARRIER.colliderThicknessWu / 2;
    expect(padGap).toBeCloseTo(7.5, 9);
    for (const t of terminals.filter((x) => x.zoneToken)) {
      const street = streets.find((s) => s.id === t.id)!;
      const facing = (e: BarrierEdge) => (street.axis === 'ew' ? e.runAxis === 'z' : e.runAxis === 'x');
      expect(clearance(t.p, facing), `${t.id} pad terminal`).toBeGreaterThanOrEqual(padGap - 1e-9);
    }
  });
});

describe('worldEdge — dead-end "road closed" rows', () => {
  it('rows exist for every zone-pad street end plus Yonge north, and none on the shore side', () => {
    const ids = [...new Set(layout.deadEnds.map((d) => d.streetId))].sort();
    expect(ids).toEqual(
      [
        'bloor',
        'college',
        'dundas',
        'eglinton',
        'finch',
        'king',
        'parkhome',
        'queen',
        'sheppard',
        'yonge',
      ].sort(),
    );
    // Both ends of every zone-spanned street, plus Yonge's single (north) dead end.
    expect(layout.deadEnds).toHaveLength(19);
    expect(layout.deadEnds.filter((d) => d.streetId === 'yonge')).toHaveLength(1);
    // NOTHING on the water side: no dead end sits south of the shoreline, and no street that ends
    // on the shore ('shore'/'shorePad' tokens: yonge south, spadina, bathurst, bay, church,
    // jarvis, york) gets a row there.
    for (const d of layout.deadEnds) {
      expect(d.z, `${d.streetId} dead end`).toBeLessThan(ZONE_BOUNDARIES[3]);
    }
    const yongeSouth = ZONE_BOUNDARIES[3] - EDGE_PAD_WU;
    expect(jerseys.some((j) => Math.abs(j.z - yongeSouth) < EDGE_PAD_WU)).toBe(false);
  });

  it('lays each row ACROSS the road at its cut end, inside the ribbon', () => {
    for (const dead of layout.deadEnds) {
      const street = streets.find((s) => s.id === dead.streetId)!;
      const row = jerseys.filter((j) => j.streetId === dead.streetId);
      expect(row.length).toBeGreaterThan(0);
      const near = row.filter(
        (j) => Math.hypot(j.x - dead.x, j.z - dead.z) < ROAD_CLASSES[street.cls],
      );
      expect(near.length, `${dead.streetId} row near its own end`).toBe(dead.barrierCount);
      for (const j of near) {
        // On the asphalt...
        expect(inRibbon(toMap(j), street), `${dead.streetId} jersey off-ribbon`).toBe(true);
        // ...just inside the cut, never past it.
        const along = street.axis === 'ns' ? j.z : j.x;
        const end = street.axis === 'ns' ? dead.z : dead.x;
        expect(Math.abs(along - end)).toBeCloseTo(BARRIER.jersey.rowInsetWu, 6);
        // ...and clear of the wall it faces.
        expect(distanceToBoundary(toMap(j), PLAYABLE_POLYGON)).toBeGreaterThanOrEqual(
          BARRIER.jersey.edgeClearanceWu,
        );
      }
      // A row spans most of the road: at least (width / pitch) - 1 barriers survive.
      const pitch = BARRIER.jersey.lengthWu + BARRIER.jersey.gapWu;
      expect(dead.barrierCount).toBeGreaterThanOrEqual(Math.floor(dead.roadWidthWu / pitch) - 1);
    }
  });

  it('points every jersey row back up its own street', () => {
    for (const dead of layout.deadEnds) {
      const street = streets.find((s) => s.id === dead.streetId)!;
      const row = jerseys.filter((j) => j.streetId === dead.streetId);
      for (const j of row) {
        const fx = Math.sin(j.yawRad);
        const fz = Math.cos(j.yawRad);
        // Forward is along the street axis (never across it).
        if (street.axis === 'ns') {
          expect(Math.abs(fx)).toBeLessThan(1e-9);
        } else {
          expect(Math.abs(fz)).toBeLessThan(1e-9);
        }
      }
    }
  });
});

describe('worldEdge — layer size (pinned so a spacing edit is a deliberate act)', () => {
  it('reports the ring census', () => {
    const count = (kind: BarrierDressing['kind']) =>
      layout.dressing.filter((d) => d.kind === kind).length;
    expect(layout.colliders).toHaveLength(11);
    // Per-kind counts are a pure function of the polygon perimeter / the BARRIER pitches. They
    // move only when someone edits a spacing constant (or the map itself re-scales) — which is
    // exactly when a human should look at this line.
    expect({
      fencePiece: count('fencePiece'),
      hoardingPanel: count('hoardingPanel'),
      railPost: count('railPost'),
      cone: count('cone'),
      jerseyBarrier: count('jerseyBarrier'),
    }).toEqual({
      fencePiece: 1460,
      hoardingPanel: 396,
      railPost: 166,
      cone: 200,
      jerseyBarrier: 73,
    });
    expect(layout.dressing).toHaveLength(2295);
  });
});
