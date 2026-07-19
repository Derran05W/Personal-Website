// Phase 31 T2 (D6) — structural proof for the 5 `<id>-player` GLB variants (scripts/lib/
// cityPackPlayerCar.mjs + scripts/city-pack.mjs). The manifest schema (cityPackManifest.test.ts)
// proves these exist/hash/categorize correctly; THIS file proves the thing that actually matters
// for vehicles/meshes/PackCarMesh.tsx — that each variant's wheel nodes survived the pipeline as
// separate, correctly-pivoted meshes rather than being joined into the usual single draw-call
// primitive. Reads the committed public/assets/city-pack/*.glb files directly via gltf-transform
// (same library the pipeline itself uses), never the gitignored raw source pack — self-contained
// in CI/a fresh clone, same discipline as every other cityPack*.test.ts.
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { getBounds } from '@gltf-transform/functions';
import { getCityPackModel } from './cityPackManifest';
import {
  PLAYER_CAR_IDS,
  PLAYER_NODE_NAMES,
  playerVariantId,
} from '../../../scripts/lib/cityPackPlayerCar.mjs';

await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

/** The 4 ids with separable front-wheel geometry (everything except 'bus' — see
 * cityPackPlayerCar.mjs's file header for why 'bus' is the one documented no-wheels exception). */
const WHEELED_IDS = PLAYER_CAR_IDS.filter((id) => id !== 'bus');

async function readPlayerDocument(id: string) {
  const entry = getCityPackModel(playerVariantId(id));
  const filePath = resolve(process.cwd(), 'public', entry.url.replace(/^\//, ''));
  return io.read(filePath);
}

describe.each(PLAYER_CAR_IDS)('%s-player — body node', (id) => {
  it('has a node named "body" with real geometry', async () => {
    const doc = await readPlayerDocument(id);
    const node = doc.getRoot().listNodes().find((n) => n.getName() === PLAYER_NODE_NAMES.body);
    expect(node, `${id}-player: no "body" node`).toBeTruthy();
    expect(node!.getMesh(), `${id}-player: "body" node has no mesh`).toBeTruthy();
  });
});

describe.each(WHEELED_IDS)('%s-player — wheel nodes (D6 wheel-node preservation)', (id) => {
  it('has wheel-front-left, wheel-front-right, and wheel-rear nodes, each with geometry', async () => {
    const doc = await readPlayerDocument(id);
    const nodes = doc.getRoot().listNodes();
    for (const name of [
      PLAYER_NODE_NAMES.wheelFrontLeft,
      PLAYER_NODE_NAMES.wheelFrontRight,
      PLAYER_NODE_NAMES.wheelRear,
    ]) {
      const node = nodes.find((n) => n.getName() === name);
      expect(node, `${id}-player: no "${name}" node`).toBeTruthy();
      expect(node!.getMesh(), `${id}-player: "${name}" node has no mesh`).toBeTruthy();
    }
  });

  it('wheel-front-left sits at negative X and wheel-front-right at positive X (engine convention: facing forward, -X is left, +X is right — RustySedanMesh.tsx WHEEL_SLOTS)', async () => {
    const doc = await readPlayerDocument(id);
    const nodes = doc.getRoot().listNodes();
    const left = nodes.find((n) => n.getName() === PLAYER_NODE_NAMES.wheelFrontLeft)!;
    const right = nodes.find((n) => n.getName() === PLAYER_NODE_NAMES.wheelFrontRight)!;
    expect(left.getTranslation()[0], `${id}-player: wheel-front-left.x`).toBeLessThan(0);
    expect(right.getTranslation()[0], `${id}-player: wheel-front-right.x`).toBeGreaterThan(0);
  });

  it('every wheel node has an identity rotation and a uniform (isotropic) scale — the "sane pivot" the runtime relies on to spin a wheel about its own hub with a plain rotation.x', async () => {
    const doc = await readPlayerDocument(id);
    const nodes = doc.getRoot().listNodes();
    for (const name of [
      PLAYER_NODE_NAMES.wheelFrontLeft,
      PLAYER_NODE_NAMES.wheelFrontRight,
      PLAYER_NODE_NAMES.wheelRear,
    ]) {
      const node = nodes.find((n) => n.getName() === name)!;
      const [rx, ry, rz, rw] = node.getRotation();
      expect([rx, ry, rz, rw], `${id}-player: "${name}" rotation`).toEqual([0, 0, 0, 1]);
      const [sx, sy, sz] = node.getScale();
      expect(sx, `${id}-player: "${name}" scale.x vs .y`).toBeCloseTo(sy, 4);
      expect(sx, `${id}-player: "${name}" scale.x vs .z`).toBeCloseTo(sz, 4);
    }
  });

  it('each front wheel is a compact, disc-like blob (axle-thickness axis « diameter) — proves the recentred geometry is a wheel, not a mis-centred chunk of the chassis', async () => {
    const doc = await readPlayerDocument(id);
    const nodes = doc.getRoot().listNodes();
    for (const name of [PLAYER_NODE_NAMES.wheelFrontLeft, PLAYER_NODE_NAMES.wheelFrontRight]) {
      const node = nodes.find((n) => n.getName() === name)!;
      const b = getBounds(node);
      const size = [0, 1, 2].map((k) => b.max[k] - b.min[k]);
      // axle axis (local X, world X here since rotation is identity) is the thin one.
      expect(size[0], `${id}-player: "${name}" x-extent (axle width)`).toBeLessThan(size[1]);
      expect(size[0], `${id}-player: "${name}" x-extent (axle width)`).toBeLessThan(size[2]);
      // diameter (y/z) roughly matches between the two horizontal-disc axes.
      expect(size[1]).toBeCloseTo(size[2], 1);
    }
  });
});

describe('bus-player — documented no-separable-wheels fallback', () => {
  it('has no wheel-front-left/right/rear nodes (single joined source mesh — see file header)', async () => {
    const doc = await readPlayerDocument('bus');
    const names = new Set(doc.getRoot().listNodes().map((n) => n.getName()));
    expect(names.has(PLAYER_NODE_NAMES.wheelFrontLeft)).toBe(false);
    expect(names.has(PLAYER_NODE_NAMES.wheelFrontRight)).toBe(false);
    expect(names.has(PLAYER_NODE_NAMES.wheelRear)).toBe(false);
  });
});
