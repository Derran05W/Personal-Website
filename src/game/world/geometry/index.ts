// Barrel: single import point for the procedural geometry builders (Phase 5 Task 2). The
// instancing layer (Task 1) is the primary consumer — one BufferGeometry per archetype
// (buildings: one per variant key, see buildings.ts; everything else: exactly one, shared
// by every instance).
export * from './kit';
export * from './buildings';
export * from './streetProps';
export * from './parkedCar';
export * from './helicopter';
export * from './landmarks';
