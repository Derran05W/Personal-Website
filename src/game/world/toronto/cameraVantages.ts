// Phase 33 camera lab — the standard vantage battery's anchor points.
//
// Seven named spots the Playwright battery teleports the car to, so every candidate rig is judged
// on the SAME six-plus-one framings (financial canyon, Yonge @ Dundas, the fold corridor, North
// York centre, Kensington, harbourfront, spawn). They are DERIVED, never authored: every point is
// a real street-centreline crossing out of world/toronto/streets.ts + roadGraph.ts's
// listIntersections, so a teleported car always lands on asphalt and the battery cannot drift out
// of sync with the map the way a hardcoded coordinate table would.
//
// Pure + deterministic (the street table is seed-independent), and consumed only by dev tooling
// (core/debugBridge.ts's `cameraVantages()`, core/devPanel.tsx's teleport buttons), so it never
// enters a production chunk.

import { TORONTO_SPAWN } from '../../config/torontoMap';
import { buildDistricts, type ResolvedDistrict } from './districts';
import { ZONE_BOUNDARIES } from './projection';
import { listIntersections, type Intersection } from './roadGraph';
import { buildStreets, type Street } from './streets';

/** One battery anchor. `x`/`z` are WORLD coordinates (map x → world x, map y → world z — the
 * identity swap every Toronto module uses). */
export interface CameraVantage {
  readonly id: string;
  readonly x: number;
  readonly z: number;
}

/** The district whose bounds the "kensington" vantage must land inside. */
const KENSINGTON_DISTRICT_ID = 'chinatownKensington';

function crossing(intersections: readonly Intersection[], nsId: string, ewId: string): Intersection {
  const hit = intersections.find((i) => i.nsId === nsId && i.ewId === ewId);
  if (!hit) {
    // Loud, not silent: a missing crossing means the street table moved and the vantage no longer
    // means what its name says — exactly the drift a derived battery exists to catch.
    throw new Error(`cameraVantages: no crossing of "${nsId}" and "${ewId}" in the street table`);
  }
  return hit;
}

function streetById(streets: readonly Street[], id: string): Street {
  const s = streets.find((st) => st.id === id);
  if (!s) throw new Error(`cameraVantages: street "${id}" is missing from the street table`);
  return s;
}

function districtById(id: string): ResolvedDistrict {
  const d = buildDistricts().find((rd) => rd.def.id === id);
  if (!d) throw new Error(`cameraVantages: district "${id}" is not in TORONTO_DISTRICTS`);
  return d;
}

/** The intersection inside `district`'s bounds nearest its centroid — a deterministic "somewhere
 * representative, and on a road" pick that needs no authored coordinate. */
function districtIntersection(district: ResolvedDistrict, intersections: readonly Intersection[]): Intersection {
  let cx = 0;
  let cz = 0;
  let area = 0;
  for (const r of district.rects) {
    const a = (r.maxX - r.minX) * (r.maxY - r.minY);
    cx += ((r.minX + r.maxX) / 2) * a;
    cz += ((r.minY + r.maxY) / 2) * a;
    area += a;
  }
  if (area > 0) {
    cx /= area;
    cz /= area;
  }
  const inside = intersections.filter((i) =>
    district.rects.some((r) => i.x >= r.minX && i.x <= r.maxX && i.y >= r.minY && i.y <= r.maxY),
  );
  if (inside.length === 0) {
    throw new Error(`cameraVantages: district "${district.def.id}" contains no street crossing`);
  }
  let best = inside[0];
  let bestDistSq = Infinity;
  for (const i of inside) {
    const d = (i.x - cx) ** 2 + (i.y - cz) ** 2;
    // listIntersections is sorted deterministically, so a strict < keeps the first of any tie.
    if (d < bestDistSq) {
      bestDistSq = d;
      best = i;
    }
  }
  return best;
}

/**
 * The seven battery anchors, in a stable order. Every one sits on a road surface:
 *   - the five crossings are street-centreline intersections;
 *   - `fold-corridor` sits on the Yonge spine (which spans the whole map) at the MIDPOINT of the
 *     fold band — the stem's narrowest, most clamp-stressed stretch, which no named EW street
 *     bisects exactly;
 *   - `spawn` is the shipped player spawn (config/torontoMap.ts's TORONTO_SPAWN, already
 *     lane-offset onto southbound Yonge).
 */
export function cameraVantages(): readonly CameraVantage[] {
  const { streets } = buildStreets();
  const intersections = listIntersections(streets);
  const yonge = streetById(streets, 'yonge');
  const bayKing = crossing(intersections, 'bay', 'king');
  const yongeDundas = crossing(intersections, 'yonge', 'dundas');
  const yongeSheppard = crossing(intersections, 'yonge', 'sheppard');
  const yongeQuay = crossing(intersections, 'yonge', 'queensquay');
  const kensington = districtIntersection(districtById(KENSINGTON_DISTRICT_ID), intersections);
  return [
    { id: 'financial-canyon', x: bayKing.x, z: bayKing.y },
    { id: 'yonge-dundas', x: yongeDundas.x, z: yongeDundas.y },
    { id: 'fold-corridor', x: yonge.centerline, z: (ZONE_BOUNDARIES[1] + ZONE_BOUNDARIES[2]) / 2 },
    { id: 'ny-centre', x: yongeSheppard.x, z: yongeSheppard.y },
    { id: 'kensington', x: kensington.x, z: kensington.y },
    { id: 'harbourfront', x: yongeQuay.x, z: yongeQuay.y },
    { id: 'spawn', x: TORONTO_SPAWN.x, z: TORONTO_SPAWN.y },
  ];
}

/** Every vantage id, in builder order — the devPanel's teleport buttons and the battery's row
 * order both read this. Kept in lockstep with the builder by cameraVantages.test.ts. */
export const CAMERA_VANTAGE_IDS: readonly string[] = [
  'financial-canyon',
  'yonge-dundas',
  'fold-corridor',
  'ny-centre',
  'kensington',
  'harbourfront',
  'spawn',
];
