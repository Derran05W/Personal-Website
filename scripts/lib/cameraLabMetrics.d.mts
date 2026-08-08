// Hand-written declaration file for cameraLabMetrics.mjs (plain executable JS — scripts/
// camera-lab.mjs runs it directly via `node`, so it can't be a .ts file). TypeScript's bundler
// module resolution pairs a `.mjs` import with a sibling `.d.mts` for typing purposes; this is
// that pairing, so world/toronto/cameraLabMetrics.test.ts's import type-checks cleanly — the same
// arrangement scripts/lib/cityPackNaming.d.mts already uses.

/** How a reported metric was derived from its source counter. */
export type CameraLabMetricKind = 'rate' | 'mean' | 'raw';

/** One reported metric: its display key, how it was derived, the raw field it came from, and the
 * field it was divided by (`null` for a raw passthrough). */
export interface CameraLabMetric {
  readonly key: string;
  readonly kind: CameraLabMetricKind;
  /** `number | null` — null whenever the denominator was 0/absent. NEVER coerced to 0. */
  readonly value: number | null;
  readonly source: string;
  readonly denomKey: string | null;
}

export type CameraLabMetricSpecEntry = Omit<CameraLabMetric, 'value'>;

export declare const SUM_DENOMINATORS: Readonly<Record<string, string>>;
export declare function ratio(n: unknown, denom: unknown): number | null;
export declare function collectMetrics(
  stats: unknown,
  prefix?: string,
  inheritedFrames?: number | null,
  out?: CameraLabMetric[],
): CameraLabMetric[];
export declare function metricValues(stats: unknown): Record<string, number | null>;
export declare function metricSpec(stats: unknown): CameraLabMetricSpecEntry[];
