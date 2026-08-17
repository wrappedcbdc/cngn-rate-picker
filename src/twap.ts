/** One observed price and the moment it was observed (ms since epoch). */
export interface PricePoint {
  price: number;
  at: number;
}

/**
 * Time-weighted average price: each point is weighted by how long it stood as
 * the most recent observation, with the newest weighted up to `nowMs`. This is
 * the average of the stepwise-constant price series the points describe, so a
 * single print or an unusually dense burst of them can't dominate the result.
 *
 * Returns null when there is nothing to average, letting each provider decide
 * whether that means "fall back" or "fail over".
 */
export function timeWeightedAverage(points: PricePoint[], nowMs: number): number | null {
  if (points.length === 0) return null;
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const first = sorted[0]!;
  if (sorted.length === 1) return first.price;

  let weightedSum = 0;
  let totalWeight = 0;
  for (let i = 0; i < sorted.length; i++) {
    const point = sorted[i]!;
    const until = i + 1 < sorted.length ? sorted[i + 1]!.at : nowMs;
    // Points sharing a timestamp (one order filling in several prints, say)
    // clamp to 1ms so each still counts rather than dropping out on a zero
    // weight. Same clamp guards a newest point stamped slightly in the future.
    const weight = Math.max(until - point.at, 1);
    weightedSum += point.price * weight;
    totalWeight += weight;
  }
  return weightedSum / totalWeight;
}

/** Points at or after `fromMs`, order preserved. */
export function withinWindow(points: PricePoint[], fromMs: number): PricePoint[] {
  return points.filter((p) => p.at >= fromMs);
}

/** The most recently observed point, or null when there are none. */
export function newestPoint(points: PricePoint[]): PricePoint | null {
  let newest: PricePoint | null = null;
  for (const point of points) {
    if (!newest || point.at > newest.at) newest = point;
  }
  return newest;
}
