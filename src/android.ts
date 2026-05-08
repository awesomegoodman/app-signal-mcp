import { createRequire } from "module";
import type { AppSignal } from "./types.js";
import { Cache, recordSnapshot, getVelocity, getRankDelta } from "./cache.js";
import { classifySignal, classifyConfidence } from "./signals.js";
import { enrichCategoryContext } from "./ios.js";

const _require = createRequire(import.meta.url);
const _raw     = _require("google-play-scraper");

// require() behaviour differs by environment:
//   CommonJS host → module exported directly (no .default)
//   ESM interop   → { __esModule: true, default: {...} }
const gplay = (_raw.default ?? _raw) as {
  app:    (opts: { appId: string; lang?: string; country?: string }) => Promise<GplayApp>;
  search: (opts: { term: string; num: number; lang?: string; country?: string }) => Promise<GplayApp[]>;
  list:   (opts: { collection: string; category?: string; num: number; country?: string }) => Promise<GplayApp[]>;
  collection: { TOP_FREE: string };
  category:   Record<string, string>;
};

// ── Genre name → Play Store category ID ──────────────────────────────────
// gplay.app() returns genre as a human label ("Health & Fitness").
// gplay.list() requires the internal category ID ("HEALTH_AND_FITNESS").

const GENRE_TO_CATEGORY_ID: Record<string, string> = {
  "health & fitness":     "HEALTH_AND_FITNESS",
  "health":               "HEALTH_AND_FITNESS",
  "medical":              "MEDICAL",
  "finance":              "FINANCE",
  "business":             "BUSINESS",
  "productivity":         "PRODUCTIVITY",
  "social":               "SOCIAL",
  "communication":        "COMMUNICATION",
  "entertainment":        "ENTERTAINMENT",
  "music & audio":        "MUSIC_AND_AUDIO",
  "music":                "MUSIC_AND_AUDIO",
  "games":                "GAME",
  "game":                 "GAME",
  "travel & local":       "TRAVEL_AND_LOCAL",
  "travel":               "TRAVEL_AND_LOCAL",
  "food & drink":         "FOOD_AND_DRINK",
  "food":                 "FOOD_AND_DRINK",
  "education":            "EDUCATION",
  "news & magazines":     "NEWS_AND_MAGAZINES",
  "news":                 "NEWS_AND_MAGAZINES",
  "sports":               "SPORTS",
  "shopping":             "SHOPPING",
  "lifestyle":            "LIFESTYLE",
  "tools":                "TOOLS",
  "utilities":            "TOOLS",
  "photography":          "PHOTOGRAPHY",
  "art & design":         "ART_AND_DESIGN",
  "maps & navigation":    "MAPS_AND_NAVIGATION",
  "navigation":           "MAPS_AND_NAVIGATION",
  "auto & vehicles":      "AUTO_AND_VEHICLES",
  "house & home":         "HOUSE_AND_HOME",
  "books & reference":    "BOOKS_AND_REFERENCE",
  "comics":               "COMICS",
  "dating":               "DATING",
  "events":               "EVENTS",
  "libraries & demo":     "LIBRARIES_AND_DEMO",
  "parenting":            "PARENTING",
  "personalization":      "PERSONALIZATION",
  "weather":              "WEATHER",
  "video players":        "VIDEO_PLAYERS",
};

function toCategoryId(genre: string): string {
  return GENRE_TO_CATEGORY_ID[genre.toLowerCase()] ?? genre.toUpperCase().replace(/ & /g, "_AND_").replace(/ /g, "_");
}
interface GplayApp {
  appId:     string;
  title:     string;
  developer: string;
  score:     number;
  ratings:   number;   // only populated by gplay.app()
  installs:  string;   // only populated by gplay.app()
  genre:     string;   // only populated by gplay.app()
  genreId:   string;
}

const TTL_LOOKUP = 6 * 60 * 60 * 1000;
const TTL_CHARTS = 60 * 60 * 1000;

const lookupCache = new Cache<AppSignal>();
const chartCache  = new Cache<AppSignal[]>();

// ── Rate limiter ──────────────────────────────────────────────────────────

let lastRequestMs = 0;
async function throttle(): Promise<void> {
  const wait = Math.max(0, 200 - (Date.now() - lastRequestMs));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestMs = Date.now();
}

// ── Batch enrichment ──────────────────────────────────────────────────────
// gplay.list() only returns title/score/developer — no ratings, installs, genre.
// We enrich by calling gplay.app() for each ID in parallel batches of 5.

async function enrichBatch(appIds: string[]): Promise<Map<string, GplayApp>> {
  const result = new Map<string, GplayApp>();
  const BATCH  = 5;

  for (let i = 0; i < appIds.length; i += BATCH) {
    const batch = appIds.slice(i, i + BATCH);
    await throttle();
    const settled = await Promise.allSettled(
      batch.map(appId => gplay.app({ appId, lang: "en", country: "us" }))
    );
    settled.forEach((r, idx) => {
      if (r.status === "fulfilled") result.set(batch[idx], r.value);
    });
  }

  return result;
}

// ── Core builder ──────────────────────────────────────────────────────────

function buildAppSignal(app: GplayApp, rank: number | null, cacheKey: string): AppSignal {
  const velocity   = getVelocity(cacheKey);
  const rankDelta  = getRankDelta(cacheKey);
  const signal     = classifySignal(velocity, rankDelta, rank);
  const confidence = classifyConfidence(rank, velocity !== null);

  return {
    app_id:    app.appId ?? "",
    platform:  "android",
    name:      app.title ?? "",
    developer: app.developer ?? "",
    category:  app.genre || app.genreId || "Unknown",
    rating: {
      score:        app.score ?? 0,
      total_count:  app.ratings ?? 0,
      velocity_30d: velocity,
    },
    rank: {
      current:   rank,
      delta_30d: rankDelta,
      chart:     "top-free",
    },
    install_band:  app.installs ?? null,
    growth_signal: signal,
    competitive_context: {
      category_median_rating_velocity: null,
      relative_momentum: "unknown",
    },
    confidence,
    data_freshness: new Date().toISOString(),
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function androidLookup(appId: string): Promise<AppSignal | null> {
  const cacheKey = `android:${appId}`;
  const cached = lookupCache.get(cacheKey);
  if (cached) return cached;

  try {
    await throttle();
    const app = await gplay.app({ appId, lang: "en", country: "us" });
    const key = `android:${app.appId}`;
    recordSnapshot(key, { rating_count: app.ratings, rank: null, captured_at: Date.now() });

    const chartVersion = lookupCache.get(key);
    if (chartVersion) return chartVersion;

    const signal = buildAppSignal(app, null, key);
    lookupCache.set(cacheKey, signal, TTL_LOOKUP);
    return signal;
  } catch (err) {
    console.error("[android] lookup failed:", appId, (err as Error).message);
    return null;
  }
}

export async function androidSearch(term: string, limit: number): Promise<AppSignal[]> {
  const cacheKey = `android:search:${term}:${limit}`;
  const cached = lookupCache.get(cacheKey) as unknown as AppSignal[] | null;
  if (cached) return cached as AppSignal[];

  try {
    await throttle();
    const partials = await gplay.search({ term, num: Math.min(limit, 30), lang: "en", country: "us" });

    // Enrich with full app data (ratings, installs, genre)
    const appIds  = partials.map(p => p.appId);
    const fullMap = await enrichBatch(appIds);

    const signals = partials.map((partial, idx) => {
      const full = fullMap.get(partial.appId) ?? partial;
      const key  = `android:${full.appId}`;
      recordSnapshot(key, { rating_count: full.ratings ?? 0, rank: null, captured_at: Date.now() });
      const chartVersion = lookupCache.get(key);
      if (chartVersion) return chartVersion;
      const signal = buildAppSignal(full, null, key);
      lookupCache.set(key, signal, TTL_LOOKUP);
      return signal;
    });

    enrichCategoryContext(signals);
    (lookupCache as Cache<unknown>).set(cacheKey, signals, TTL_LOOKUP);
    return signals;
  } catch (err) {
    console.error("[android] search failed:", term, (err as Error).message);
    return [];
  }
}

export async function androidTopChart(limit = 100): Promise<AppSignal[]> {
  const cacheKey = `android:chart:top-free:${limit}`;
  const cached = chartCache.get(cacheKey);
  if (cached) return cached;

  try {
    await throttle();
    const partials = await gplay.list({
      collection: gplay.collection.TOP_FREE,
      num: Math.min(limit, 200),
      country: "us",
    });

    // Build rank map from list order
    const rankMap = new Map(partials.map((p, i) => [p.appId, i + 1]));

    // Enrich with full app data
    const appIds  = partials.map(p => p.appId);
    const fullMap = await enrichBatch(appIds);

    const signals: AppSignal[] = partials.map(partial => {
      const full = fullMap.get(partial.appId) ?? partial;
      const rank = rankMap.get(full.appId) ?? null;
      const key  = `android:${full.appId}`;
      recordSnapshot(key, { rating_count: full.ratings ?? 0, rank, captured_at: Date.now() });
      const signal = buildAppSignal(full, rank, key);
      lookupCache.set(key, signal, TTL_LOOKUP);
      return signal;
    });

    signals.sort((a, b) => (a.rank.current ?? 999) - (b.rank.current ?? 999));
    enrichCategoryContext(signals);
    chartCache.set(cacheKey, signals, TTL_CHARTS);
    return signals;
  } catch (err) {
    console.error("[android] top chart failed:", (err as Error).message);
    return [];
  }
}

export async function androidCategoryChart(category: string, limit = 50): Promise<AppSignal[]> {
  const categoryId = toCategoryId(category);
  const cacheKey = `android:chart:${categoryId}:${limit}`;
  const cached = chartCache.get(cacheKey);
  if (cached) return cached;

  try {
    await throttle();
    const partials = await gplay.list({
      collection: gplay.collection.TOP_FREE,
      category: categoryId,
      num: Math.min(limit, 200),
      country: "us",
    });

    const rankMap = new Map(partials.map((p, i) => [p.appId, i + 1]));
    const appIds  = partials.map(p => p.appId);
    const fullMap = await enrichBatch(appIds);

    const signals: AppSignal[] = partials.map(partial => {
      const full = fullMap.get(partial.appId) ?? partial;
      const rank = rankMap.get(full.appId) ?? null;
      const key  = `android:${full.appId}`;
      recordSnapshot(key, { rating_count: full.ratings ?? 0, rank, captured_at: Date.now() });
      const signal = buildAppSignal(full, rank, key);
      lookupCache.set(key, signal, TTL_LOOKUP);
      return signal;
    });

    signals.sort((a, b) => (a.rank.current ?? 999) - (b.rank.current ?? 999));
    enrichCategoryContext(signals);
    chartCache.set(cacheKey, signals, TTL_CHARTS);
    return signals;
  } catch (err) {
    console.error("[android] category chart failed:", category, (err as Error).message);
    return [];
  }
}

// ── Google Play category ID mapping ───────────────────────────────────────
// gplay.list() requires Google Play category IDs (e.g. HEALTH_AND_FITNESS),
// not display names (e.g. "Health & Fitness"). This maps both display names
// and common aliases to their correct Play Store category ID.

const GPLAY_CATEGORY_IDS: Record<string, string> = {
  // by display name (lowercased)
  "art & design":           "ART_AND_DESIGN",
  "auto & vehicles":        "AUTO_AND_VEHICLES",
  "beauty":                 "BEAUTY",
  "books & reference":      "BOOKS_AND_REFERENCE",
  "business":               "BUSINESS",
  "comics":                 "COMICS",
  "communication":          "COMMUNICATION",
  "dating":                 "DATING",
  "education":              "EDUCATION",
  "entertainment":          "ENTERTAINMENT",
  "events":                 "EVENTS",
  "finance":                "FINANCE",
  "food & drink":           "FOOD_AND_DRINK",
  "health & fitness":       "HEALTH_AND_FITNESS",
  "house & home":           "HOUSE_AND_HOME",
  "lifestyle":              "LIFESTYLE",
  "maps & navigation":      "MAPS_AND_NAVIGATION",
  "medical":                "MEDICAL",
  "music & audio":          "MUSIC_AND_AUDIO",
  "news & magazines":       "NEWS_AND_MAGAZINES",
  "parenting":              "PARENTING",
  "personalization":        "PERSONALIZATION",
  "photography":            "PHOTOGRAPHY",
  "productivity":           "PRODUCTIVITY",
  "shopping":               "SHOPPING",
  "social":                 "SOCIAL",
  "sports":                 "SPORTS",
  "tools":                  "TOOLS",
  "travel & local":         "TRAVEL_AND_LOCAL",
  "video players":          "VIDEO_PLAYERS",
  "weather":                "WEATHER",
  "games":                  "GAME",
  "game":                   "GAME",
  // common aliases
  "health":                 "HEALTH_AND_FITNESS",
  "fitness":                "HEALTH_AND_FITNESS",
  "music":                  "MUSIC_AND_AUDIO",
  "travel":                 "TRAVEL_AND_LOCAL",
  "food":                   "FOOD_AND_DRINK",
  "books":                  "BOOKS_AND_REFERENCE",
  "news":                   "NEWS_AND_MAGAZINES",
  "maps":                   "MAPS_AND_NAVIGATION",
  "navigation":             "MAPS_AND_NAVIGATION",
  "video":                  "VIDEO_PLAYERS",
  "art":                    "ART_AND_DESIGN",
};

export function toGplayCategory(category: string): string {
  return GPLAY_CATEGORY_IDS[category.toLowerCase()] ?? category.toUpperCase().replace(/ & /g, "_AND_").replace(/ /g, "_");
}