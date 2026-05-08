import type { AppSignal, Confidence, GrowthSignal, Momentum } from "./types.js";

export function classifySignal(
  velocity: number | null,
  rankDelta: number | null,
  rank: number | null
): GrowthSignal {
  // When we have both signals, use the combined rule from the spec
  if (velocity !== null && rankDelta !== null) {
    if (velocity > 500 && rankDelta > 10) return "breakout";
    if (velocity > 200 || rankDelta > 5) return "strong";
    if (velocity > 50) return "moderate";
    if (velocity < 0) return "declining";
    return "stable";
  }

  // Velocity only
  if (velocity !== null) {
    if (velocity > 500) return "breakout";
    if (velocity > 200) return "strong";
    if (velocity > 50) return "moderate";
    if (velocity < 0) return "declining";
    return "stable";
  }

  // Rank-only heuristic (cold start — low confidence)
  if (rank !== null) {
    if (rank <= 10) return "strong";
    if (rank <= 50) return "moderate";
  }

  return "stable";
}

export function classifyConfidence(
  rank: number | null,
  hasVelocity: boolean
): Confidence {
  if (rank !== null && rank <= 200 && hasVelocity) return "high";
  if (rank !== null && rank <= 2000) return "medium";
  return "low";
}

// ── Competitive Context ────────────────────────────────────────────────────

export function computeMomentum(
  velocity: number | null,
  medianVelocity: number | null
): Momentum {
  if (velocity === null || medianVelocity === null) return "unknown";
  if (velocity > medianVelocity * 1.1) return "above_median";
  if (velocity < medianVelocity * 0.9) return "below_median";
  return "at_median";
}

export function categoryMedian(velocities: (number | null)[]): number | null {
  const valid = velocities.filter((v): v is number => v !== null);
  if (valid.length === 0) return null;
  valid.sort((a, b) => a - b);
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 !== 0 ? valid[mid] : Math.round((valid[mid - 1] + valid[mid]) / 2);
}

// ── Filter helpers used by get_breakout_apps ──────────────────────────────

const SIGNAL_RANK: Record<GrowthSignal, number> = {
  breakout: 4,
  strong: 3,
  moderate: 2,
  stable: 1,
  declining: 0,
};

export function meetsSignalThreshold(
  signal: GrowthSignal,
  threshold: GrowthSignal
): boolean {
  return SIGNAL_RANK[signal] >= SIGNAL_RANK[threshold];
}

export function rankBySignal(apps: AppSignal[]): AppSignal[] {
  return [...apps].sort(
    (a, b) =>
      SIGNAL_RANK[b.growth_signal] - SIGNAL_RANK[a.growth_signal] ||
      (b.rating.velocity_30d ?? 0) - (a.rating.velocity_30d ?? 0)
  );
}
