// Phase 30 (T2 debt-1) — the Toronto equivalent of world/instancing.ts's archetype-handle
// registry (CLAUDE.md instancing note: "every collider handle maps to one EntityEntry ... in
// one registry"), scoped to the launchable street-furniture BatchedMeshes. Legacy's registry
// maps an archetype NAME to its InstancedMesh handles because one archetype is exactly one
// draw-call family; Toronto's launchable categories are already 1:1 with a pack MODEL id (one
// BatchedMesh per category — StreetFurniture in cityPack/CityDress.tsx builds exactly one per
// furniture type), so this registry keys by that same modelId string instead.
//
// SCOPING (why this can't just key by modelId globally): a modelId can be rendered by MORE
// THAN ONE CityPackBatched mount in the same scene — e.g. 'tree' is used both by
// StreetFurniture (street trees, launchable) AND TorontoScene's park-tree layer (decorative,
// NOT launchable, deliberately out of this phase's scope). Only StreetFurniture's launchable
// categories ever call registerBatchedFurniture (CityPackBatched.tsx's optional `onMesh`
// prop is opt-in per call site), so a collision can only happen if a SECOND launchable call
// site is added for the same modelId later — a lint-by-convention risk, not a runtime one
// today (asserted by furnitureDynamics.test.ts's category-uniqueness check).
//
// LIFECYCLE: registered when a CityPackBatched instance finishes populating (its `onMesh`
// callback), unregistered on that same effect's cleanup (remount / seed change / toggle-off).
// The furniture-launch controller (furnitureDynamics.ts) looks entries up LAZILY at swap time
// — never at construction — so mount ordering between StreetFurniture and the controller's own
// mount never matters.

import type { BatchedMesh } from 'three';

export interface BatchedFurnitureHandle {
  readonly mesh: BatchedMesh;
}

const registry = new Map<string, BatchedFurnitureHandle>();

/** Register (or replace) the live BatchedMesh for a launchable furniture category, keyed by
 * its pack model id (e.g. 'fire-hydrant', 'tree', 'power-box'). */
export function registerBatchedFurniture(modelId: string, handle: BatchedFurnitureHandle): void {
  registry.set(modelId, handle);
}

/** Drop a category's registration (component unmount / repopulate). React's effect-cleanup
 * ordering guarantees the OLD registration's cleanup runs to completion before a replacement's
 * effect body registers the new one (CityPackBatched's onMesh contract: cleanup fires with
 * `null` before the next populate fires with the fresh mesh), so an unconditional delete is
 * safe here — no stale-clobbers-live race to guard against. */
export function unregisterBatchedFurniture(modelId: string): void {
  registry.delete(modelId);
}

/** The live handle for a launchable category, or undefined if it hasn't mounted (or isn't a
 * launchable category at all) this run. */
export function getBatchedFurniture(modelId: string): BatchedFurnitureHandle | undefined {
  return registry.get(modelId);
}

/** Test/debug: drop every registration (mirrors world/registry.ts's clearRegistry). */
export function clearBatchedFurnitureRegistry(): void {
  registry.clear();
}

/** Test/debug: every currently-registered category key + its mesh's live instanceCount
 * (Phase 30 T2 live verification — proves the onMesh wiring actually ran). */
export function debugRegisteredCategories(): readonly { modelId: string; instanceCount: number }[] {
  return Array.from(registry.entries()).map(([modelId, handle]) => ({
    modelId,
    instanceCount: handle.mesh.instanceCount,
  }));
}
