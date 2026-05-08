import { createRequire } from "module";
import type { AppSignal, GplayApp } from "./types.js";
import { Cache, recordSnapshot, getVelocity, getRankDelta } from "./cache.js";
import { classifySignal, classifyConfidence } from "./signals.js";
import { enrichCategoryContext } from "./ios.js";

const _require = createRequire(import.meta.url);
const _raw     = _require("google-play-scraper");


const gplay = (_raw.default ?? _raw) as {
  app:    (opts: { appId: string; lang?: string; country?: string }) => Promise<GplayApp>;
  search: (opts: { term: string; num: number; lang?: string; country?: string }) => Promise<GplayPartialApp[]>;
  list:   (opts: { collection: string; category?: string; num: number; country?: string }) => Promise<GplayPartialApp[]>;
  collection: { TOP_FREE: string };
  category:   Record<string, string>;
};

type GplayPartialApp = Partial<GplayApp> & {
  appId: string;
  title: string;
};

const TTL_LOOKUP = 6 * 60 * 60 * 1000;
const TTL_CHARTS = 60 * 60 * 1000;

const lookupCache = new Cache<AppSignal>();
const searchCache = new Cache<AppSignal[]>();
const chartCache  = new Cache<AppSignal[]>();

// ── Rate limiter ──────────────────────────────────────────────────────────

let lastRequestMs = 0;
async function throttle(): Promise<void> {
  const wait = Math.max(0, 200 - (Date.now() - lastRequestMs));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestMs = Date.now();
}


const GENRE_TO_CATEGORY_ID: Record<string, string> = {
  "art & design":      "ART_AND_DESIGN",
  "auto & vehicles":   "AUTO_AND_VEHICLES",
  "android wear":      "ANDROID_WEAR",
  "beauty":            "BEAUTY",
  "books & reference": "BOOKS_AND_REFERENCE",
  "business":          "BUSINESS",
  "comics":            "COMICS",
  "communication":     "COMMUNICATION",
  "dating":            "DATING",
  "education":         "EDUCATION",
  "entertainment":     "ENTERTAINMENT",
  "events":            "EVENTS",
  "finance":           "FINANCE",
  "food & drink":      "FOOD_AND_DRINK",
  "health & fitness":  "HEALTH_AND_FITNESS",
  "house & home":      "HOUSE_AND_HOME",
  "libraries & demo":  "LIBRARIES_AND_DEMO",
  "lifestyle":         "LIFESTYLE",
  "maps & navigation": "MAPS_AND_NAVIGATION",
  "medical":           "MEDICAL",
  "music & audio":     "MUSIC_AND_AUDIO",
  "news & magazines":  "NEWS_AND_MAGAZINES",
  "parenting":         "PARENTING",
  "personalization":   "PERSONALIZATION",
  "photography":       "PHOTOGRAPHY",
  "productivity":      "PRODUCTIVITY",
  "shopping":          "SHOPPING",
  "social":            "SOCIAL",
  "sports":            "SPORTS",
  "tools":             "TOOLS",
  "travel & local":    "TRAVEL_AND_LOCAL",
  "video players":     "VIDEO_PLAYERS",
  "watch face":        "WATCH_FACE",
  "weather":           "WEATHER",
  // game subcategories
  "action":            "GAME_ACTION",
  "adventure":         "GAME_ADVENTURE",
  "arcade":            "GAME_ARCADE",
  "board":             "GAME_BOARD",
  "card":              "GAME_CARD",
  "casino":            "GAME_CASINO",
  "casual":            "GAME_CASUAL",
  "educational":       "GAME_EDUCATIONAL",
  "puzzle":            "GAME_PUZZLE",
  "racing":            "GAME_RACING",
  "role playing":      "GAME_ROLE_PLAYING",
  "simulation":        "GAME_SIMULATION",
  "strategy":          "GAME_STRATEGY",
  "trivia":            "GAME_TRIVIA",
  "word":              "GAME_WORD",
  // common aliases
  "games":             "GAME",
  "game":              "GAME",
  "health":            "HEALTH_AND_FITNESS",
  "fitness":           "HEALTH_AND_FITNESS",
  "music":             "MUSIC_AND_AUDIO",
  "travel":            "TRAVEL_AND_LOCAL",
  "food":              "FOOD_AND_DRINK",
  "books":             "BOOKS_AND_REFERENCE",
  "news":              "NEWS_AND_MAGAZINES",
  "maps":              "MAPS_AND_NAVIGATION",
  "navigation":        "MAPS_AND_NAVIGATION",
  "video":             "VIDEO_PLAYERS",
  "art":               "ART_AND_DESIGN",
  "utilities":         "TOOLS",
};

export function toCategoryId(genre: string): string | null {
  const key = genre.toLowerCase().trim();
  if (!key || key === "unknown") return null;
  return GENRE_TO_CATEGORY_ID[key] ?? null;
}

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
    app_id:    app.appId,
    platform:  "android",
    name:      app.title,
    developer: app.developer,
    category:  app.genre || app.genreId || "Unknown",
    rating: {
      score:        app.score,
      total_count:  app.ratings,
      velocity_30d: velocity,
    },
    rank: {
      current:   rank,
      delta_30d: rankDelta,
      chart:     "top-free",
    },
    install_band:  app.installs,
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
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;

  try {
    await throttle();

    const partials = await gplay.search({ term, num: Math.min(limit, 30), lang: "en", country: "us" });
    const fullMap  = await enrichBatch(partials.map(p => p.appId));

    const signals = partials
      .map(partial => {
        const full = fullMap.get(partial.appId);
        if (!full) return null;
        const key = `android:${full.appId}`;
        recordSnapshot(key, { rating_count: full.ratings, rank: null, captured_at: Date.now() });
        const cachedSignal = lookupCache.get(key);
        if (cachedSignal) return cachedSignal;
        const signal = buildAppSignal(full, null, key);
        lookupCache.set(key, signal, TTL_LOOKUP);
        return signal;
      })
      .filter((s): s is AppSignal => s !== null);

    enrichCategoryContext(signals);
    searchCache.set(cacheKey, signals, TTL_LOOKUP);
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

    const rankMap = new Map(partials.map((p, i) => [p.appId, i + 1]));
    const fullMap = await enrichBatch(partials.map(p => p.appId));

    const signals: AppSignal[] = partials
      .map(partial => {
        const full = fullMap.get(partial.appId);
        if (!full) return null;
        const rank = rankMap.get(full.appId) ?? null;
        const key  = `android:${full.appId}`;
        recordSnapshot(key, { rating_count: full.ratings, rank, captured_at: Date.now() });
        const signal = buildAppSignal(full, rank, key);
        lookupCache.set(key, signal, TTL_LOOKUP);
        return signal;
      })
      .filter((s): s is AppSignal => s !== null);

    signals.sort((a, b) => (a.rank.current ?? 999) - (b.rank.current ?? 999));
    enrichCategoryContext(signals);
    chartCache.set(cacheKey, signals, TTL_CHARTS);
    return signals;
  } catch (err) {
    console.error("[android] top chart failed:", (err as Error).message);
    return [];
  }
}

export async function androidCategoryChart(categoryId: string, limit = 50): Promise<AppSignal[]> {
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
    const fullMap = await enrichBatch(partials.map(p => p.appId));

    const signals: AppSignal[] = partials
      .map(partial => {
        const full = fullMap.get(partial.appId);
        if (!full) return null;
        const rank = rankMap.get(full.appId) ?? null;
        const key  = `android:${full.appId}`;
        recordSnapshot(key, { rating_count: full.ratings, rank, captured_at: Date.now() });
        const signal = buildAppSignal(full, rank, key);
        lookupCache.set(key, signal, TTL_LOOKUP);
        return signal;
      })
      .filter((s): s is AppSignal => s !== null);

    signals.sort((a, b) => (a.rank.current ?? 999) - (b.rank.current ?? 999));
    enrichCategoryContext(signals);
    chartCache.set(cacheKey, signals, TTL_CHARTS);
    return signals;
  } catch (err) {
    console.error(`[android] category chart failed: ${categoryId}`, (err as Error).message);
    return [];
  }
}