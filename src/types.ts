export type Platform = "ios" | "android";
export type GrowthSignal = "breakout" | "strong" | "moderate" | "stable" | "declining";
export type Confidence = "high" | "medium" | "low";
export type Momentum = "above_median" | "below_median" | "at_median" | "unknown";

export interface AppSignal {
  app_id: string;         // iOS: numeric trackId | Android: package name
  platform: Platform;
  name: string;
  developer: string;
  category: string;
  rating: {
    score: number;
    total_count: number;
    velocity_30d: number | null;  // null until 2+ snapshots available
  };
  rank: {
    current: number | null;
    delta_30d: number | null;
    chart: string;
  };
  install_band: string | null;  // Android only — Google's own ground-truth labels
  growth_signal: GrowthSignal;
  competitive_context: {
    category_median_rating_velocity: number | null;
    relative_momentum: Momentum;
  };
  confidence: Confidence;       // high=top-200 + 30d data | medium=ranked | low=cold
  data_freshness: string;       // ISO 8601
}

export interface Snapshot {
  rating_count: number;
  rank: number | null;
  captured_at: number;  // unix ms
}

export interface ItunesResult {
  trackId: number;
  bundleId: string;
  trackName: string;
  sellerName: string;
  averageUserRating: number;
  userRatingCount: number;
  primaryGenreName: string;
  trackViewUrl: string;
}

export interface ItunesRssEntry {
  id: string;
  name: string;
  artistName: string;
  url: string;
  releaseDate: string;
  genres: Array<{ genreId: string; name: string }>;
}
