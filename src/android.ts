import { createRequire } from "module";
import type { AppSignal } from "./types.js";
import { Cache, recordSnapshot, getVelocity, getRankDelta } from "./cache.js";
import { classifySignal, classifyConfidence, computeMomentum, categoryMedian } from "./signals.js";
import { enrichCategoryContext } from "./ios.js"; // reuse enrichment

const require = createRequire(import.meta.url);
const gplay = require("google-play-scraper") as {
  app: (opts: { appId: string; lang?: string; country?: string }) => Promise<GplayApp>;
  search: (opts: { term: string; num: number; lang?: string; country?: string }) => Promise<GplayApp[]>;
  list: (opts: { collection: string; category?: string; num: number; country?: string }) => Promise<GplayApp[]>;
  collection: { TOP_FREE: string };
  category: Record<string, string>;
};

interface GplayApp {
  appId:   string;
  title:   string;
  developer: string;
  score:   number;
  ratings: number;
  installs: string;  // e.g. "1,000,000+"
  genre:   string;
  genreId: string;
}

const TTL_LOOKUP = 6 * 60 * 60 * 1000;
const TTL_CHARTS = 60 * 60 * 1000;

const lookupCache = new Cache<AppSignal>();
const chartCache  = new Cache<AppSignal[]>();

// ── Rate limiter: 1 req/sec to respect public scraping etiquette ──────────

let lastRequestMs = 0;
async function rateLimitedFetch<T>(fn: () => Promise<T>): Promise<T> {
  const wait = Math.max(0, 1000 - (Date.now() - lastRequestMs));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestMs = Date.now();
  return fn();
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
    category:  app.genre ?? "Unknown",
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
    const app = await rateLimitedFetch(() =>
      gplay.app({ appId, lang: "en", country: "us" })
    );
    const key = `android:${app.appId}`;
    recordSnapshot(key, { rating_count: app.ratings, rank: null, captured_at: Date.now() });

    const signal = buildAppSignal(app, null, key);
    lookupCache.set(cacheKey, signal, TTL_LOOKUP);
    return signal;
  } catch {
    return null;
  }
}

export async function androidSearch(term: string, limit: number): Promise<AppSignal[]> {
  const cacheKey = `android:search:${term}:${limit}`;
  const cached = lookupCache.get(cacheKey) as unknown as AppSignal[] | null;
  if (cached) return cached as AppSignal[];

  try {
    const apps = await rateLimitedFetch(() =>
      gplay.search({ term, num: Math.min(limit, 30), lang: "en", country: "us" })
    );

    const signals = apps.map((app) => {
      const key = `android:${app.appId}`;
      recordSnapshot(key, { rating_count: app.ratings, rank: null, captured_at: Date.now() });
      const signal = buildAppSignal(app, null, key);
      lookupCache.set(`android:${app.appId}`, signal, TTL_LOOKUP);
      return signal;
    });

    (lookupCache as Cache<unknown>).set(cacheKey, signals, TTL_LOOKUP);
    return signals;
  } catch {
    return [];
  }
}

export async function androidTopChart(limit = 100): Promise<AppSignal[]> {
  const cacheKey = `android:chart:top-free:${limit}`;
  const cached = chartCache.get(cacheKey);
  if (cached) return cached;

  try {
    const apps = await rateLimitedFetch(() =>
      gplay.list({ collection: gplay.collection.TOP_FREE, num: Math.min(limit, 200), country: "us" })
    );

    const signals: AppSignal[] = apps.map((app, idx) => {
      const rank = idx + 1;
      const key  = `android:${app.appId}`;
      recordSnapshot(key, { rating_count: app.ratings, rank, captured_at: Date.now() });
      const signal = buildAppSignal(app, rank, key);
      lookupCache.set(`android:${app.appId}`, signal, TTL_LOOKUP);
      return signal;
    });

    enrichCategoryContext(signals);
    chartCache.set(cacheKey, signals, TTL_CHARTS);
    return signals;
  } catch {
    return [];
  }
}

export async function androidCategoryChart(category: string, limit = 50): Promise<AppSignal[]> {
  const cacheKey = `android:chart:${category}:${limit}`;
  const cached = chartCache.get(cacheKey);
  if (cached) return cached;

  try {
    const apps = await rateLimitedFetch(() =>
      gplay.list({
        collection: gplay.collection.TOP_FREE,
        category,
        num: Math.min(limit, 200),
        country: "us",
      })
    );

    const signals: AppSignal[] = apps.map((app, idx) => {
      const rank = idx + 1;
      const key  = `android:${app.appId}`;
      recordSnapshot(key, { rating_count: app.ratings, rank, captured_at: Date.now() });
      const signal = buildAppSignal(app, rank, key);
      lookupCache.set(`android:${app.appId}`, signal, TTL_LOOKUP);
      return signal;
    });

    enrichCategoryContext(signals);
    chartCache.set(cacheKey, signals, TTL_CHARTS);
    return signals;
  } catch {
    return [];
  }
}