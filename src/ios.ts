import type { AppSignal, ItunesResult, ItunesRssEntry } from "./types.js";
import { Cache, recordSnapshot, getVelocity, getRankDelta } from "./cache.js";
import { classifySignal, classifyConfidence, computeMomentum, categoryMedian } from "./signals.js";


const TTL_LOOKUP = 6 * 60 * 60 * 1000;
const TTL_CHARTS = 60 * 60 * 1000;

const lookupCache = new Cache<AppSignal>();
const chartCache  = new Cache<AppSignal[]>();

// ── Apple genre IDs for category-specific RSS feeds ────────────────────────

const GENRE_IDS: Record<string, string> = {
  "games":              "6014",
  "game":               "6014",
  "entertainment":      "6016",
  "education":          "6017",
  "photo & video":      "6008",
  "utilities":          "6002",
  "productivity":       "6007",
  "social networking":  "6005",
  "social":             "6005",
  "lifestyle":          "6012",
  "music":              "6011",
  "sports":             "6004",
  "health & fitness":   "6013",
  "health":             "6013",
  "finance":            "6015",
  "business":           "6000",
  "navigation":         "6010",
  "news":               "6009",
  "travel":             "6003",
  "food & drink":       "6023",
  "food":               "6023",
  "reference":          "6006",
  "shopping":           "6024",
  "medical":            "6020",
};

function genreIdForCategory(category: string): string | null {
  return GENRE_IDS[category.toLowerCase()] ?? null;
}

// ── iTunes API ─────────────────────────────────────────────────────────────

async function itunesLookup(params: string): Promise<ItunesResult | null> {
  const url = `https://itunes.apple.com/lookup?${params}&country=US&entity=software`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const data = await res.json() as { results: ItunesResult[] };
  return data.results?.[0] ?? null;
}

async function itunesSearch(term: string, limit: number): Promise<ItunesResult[]> {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=software&limit=${limit}&country=US`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const data = await res.json() as { results: ItunesResult[] };
  return data.results ?? [];
}

async function fetchTopChartRss(limit = 100, genreId?: string): Promise<ItunesRssEntry[]> {
  const genre = genreId ? `/genre=${genreId}` : "";
  const url = `https://rss.marketingtools.apple.com/api/v2/us/apps/top-free/${limit}/apps${genre}/apps.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const data = await res.json() as { feed: { results: ItunesRssEntry[] } };
  return data.feed?.results ?? [];
}

function extractTrackId(url: string): string | null {
  const match = url.match(/\/id(\d+)/);
  return match ? match[1] : null;
}

// ── Core builder ──────────────────────────────────────────────────────────

function buildAppSignal(result: ItunesResult, rank: number | null, cacheKey: string): AppSignal {
  const velocity   = getVelocity(cacheKey);
  const rankDelta  = getRankDelta(cacheKey);
  const signal     = classifySignal(velocity, rankDelta, rank);
  const confidence = classifyConfidence(rank, velocity !== null);

  return {
    app_id:    String(result.trackId ?? ""),
    platform:  "ios",
    name:      result.trackName ?? "",
    developer: result.sellerName ?? "",
    category:  result.primaryGenreName ?? "Unknown",
    rating: {
      score:        result.averageUserRating ?? 0,
      total_count:  result.userRatingCount ?? 0,
      velocity_30d: velocity,
    },
    rank: {
      current:   rank,
      delta_30d: rankDelta,
      chart:     "top-free",
    },
    install_band: null,
    growth_signal: signal,
    competitive_context: {
      category_median_rating_velocity: null,
      relative_momentum: "unknown",
    },
    confidence,
    data_freshness: new Date().toISOString(),
  };
}

// ── Chart builder (shared by top chart + category chart) ──────────────────

async function buildChartFromRss(limit: number, genreId?: string): Promise<AppSignal[]> {
  const entries = await fetchTopChartRss(limit, genreId);
  const trackIds = entries
    .map(e => extractTrackId(e.url))
    .filter((id): id is string => id !== null)
    .slice(0, limit);

  const BATCH = 100;
  const results: ItunesResult[] = [];
  for (let i = 0; i < trackIds.length; i += BATCH) {
    const batch = trackIds.slice(i, i + BATCH).join(",");
    const url = `https://itunes.apple.com/lookup?id=${batch}&country=US&entity=software`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json() as { results: ItunesResult[] };
      results.push(...(data.results ?? []));
    }
  }

  const rankMap = new Map<string, number>();
  trackIds.forEach((id, idx) => rankMap.set(id, idx + 1));

  const signals: AppSignal[] = results.map(r => {
    const key  = `ios:${r.trackId}`;
    const rank = rankMap.get(String(r.trackId)) ?? null;
    recordSnapshot(key, { rating_count: r.userRatingCount, rank, captured_at: Date.now() });
    const signal = buildAppSignal(r, rank, key);
    lookupCache.set(key, signal, TTL_LOOKUP);
    return signal;
  });

  signals.sort((a, b) => (a.rank.current ?? 999) - (b.rank.current ?? 999));
  enrichCategoryContext(signals);
  return signals;
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function iosLookup(appId: string): Promise<AppSignal | null> {
  const cacheKey = `ios:${appId}`;
  const cached = lookupCache.get(cacheKey);
  if (cached) return cached;

  const params = /^\d+$/.test(appId) ? `id=${appId}` : `bundleId=${appId}`;
  const result = await itunesLookup(params);
  if (!result) return null;

  const key = `ios:${result.trackId}`;
  recordSnapshot(key, { rating_count: result.userRatingCount, rank: null, captured_at: Date.now() });

  // If this app is already in the chart cache (from warm), use that version
  // so we preserve rank + velocity rather than overwriting with null
  const chartVersion = lookupCache.get(key);
  if (chartVersion) return chartVersion;

  const signal = buildAppSignal(result, null, key);
  lookupCache.set(cacheKey, signal, TTL_LOOKUP);
  lookupCache.set(key, signal, TTL_LOOKUP);
  return signal;
}

export async function iosSearch(term: string, limit: number): Promise<AppSignal[]> {
  const cacheKey = `ios:search:${term}:${limit}`;
  const cached = lookupCache.get(cacheKey) as unknown as AppSignal[] | null;
  if (cached) return cached as AppSignal[];

  const results = await itunesSearch(term, limit);
  const signals = results.map(r => {
    const key = `ios:${r.trackId}`;
    recordSnapshot(key, { rating_count: r.userRatingCount, rank: null, captured_at: Date.now() });

    // If this app is in the chart cache, use the enriched version (has rank + velocity)
    const chartVersion = lookupCache.get(key);
    if (chartVersion) return chartVersion;

    return buildAppSignal(r, null, key);
  });

  (lookupCache as Cache<unknown>).set(cacheKey, signals, TTL_LOOKUP);
  return signals;
}

export async function iosTopChart(limit = 100): Promise<AppSignal[]> {
  const cacheKey = `ios:chart:top-free:${limit}`;
  const cached = chartCache.get(cacheKey);
  if (cached) return cached;

  const signals = await buildChartFromRss(limit);
  chartCache.set(cacheKey, signals, TTL_CHARTS);
  return signals;
}

export async function iosCategoryChart(category: string, limit = 50): Promise<AppSignal[]> {
  const genreId = genreIdForCategory(category);
  if (!genreId) return [];

  const cacheKey = `ios:chart:${category.toLowerCase()}:${limit}`;
  const cached = chartCache.get(cacheKey);
  if (cached) return cached;

  const signals = await buildChartFromRss(limit, genreId);
  chartCache.set(cacheKey, signals, TTL_CHARTS);
  return signals;
}

// ── Enrich competitive context for a batch ────────────────────────────────

export function enrichCategoryContext(apps: AppSignal[]): void {
  const byCategory = new Map<string, AppSignal[]>();
  for (const app of apps) {
    const list = byCategory.get(app.category) ?? [];
    list.push(app);
    byCategory.set(app.category, list);
  }
  for (const [, group] of byCategory) {
    const velocities = group.map(a => a.rating.velocity_30d);
    const median = categoryMedian(velocities);
    for (const app of group) {
      app.competitive_context.category_median_rating_velocity = median;
      app.competitive_context.relative_momentum = computeMomentum(app.rating.velocity_30d, median);
    }
  }
}