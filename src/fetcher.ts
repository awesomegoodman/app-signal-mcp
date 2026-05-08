import type { AppSignal, GrowthSignal } from "./types.js";
import { iosLookup, iosSearch, iosTopChart, iosCategoryChart, enrichCategoryContext } from "./ios.js";
import { androidLookup, androidSearch, androidTopChart, androidCategoryChart, toGplayCategory } from "./android.js";
import { meetsSignalThreshold, rankBySignal, computeMomentum, categoryMedian } from "./signals.js";

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

const CATEGORY_ALIASES: Record<string, string[]> = {
  "health":       ["health & fitness", "medical"],
  "games":        ["games", "game"],
  "social":       ["social networking", "social"],
  "finance":      ["finance", "business"],
  "productivity": ["productivity", "utilities"],
  "music":        ["music", "music & audio"],
  "travel":       ["travel", "navigation"],
  "food":         ["food & drink", "food"],
  "education":    ["education", "educational"],
  "sports":       ["sports", "health & fitness"],
};

function matchesCategory(appCategory: string, query: string): boolean {
  const q = query.toLowerCase();
  const aliases = CATEGORY_ALIASES[q] ?? [q];
  return aliases.some(a => appCategory.toLowerCase().includes(a));
}

async function enrichSingle(app: AppSignal): Promise<void> {
  if (app.competitive_context.category_median_rating_velocity !== null) return;

  try {
    let peers: AppSignal[] = [];

    if (app.platform === "ios") {
      peers = await iosCategoryChart(app.category, 50);
      if (peers.length === 0) {
        const all = await iosTopChart(200);
        peers = all.filter(a => a.category === app.category);
      }
    } else {
      peers = await androidCategoryChart(toGplayCategory(app.category), 50);
      if (peers.length === 0) {
        const all = await androidTopChart(200);
        peers = all.filter(a => a.category === app.category);
      }
    }

    if (peers.length === 0) return;

    const velocities = peers.map(p => p.rating.velocity_30d);
    const median = categoryMedian(velocities);
    app.competitive_context.category_median_rating_velocity = median;
    app.competitive_context.relative_momentum = computeMomentum(app.rating.velocity_30d, median);
  } catch {
    // Left as null/unknown — better than throwing
  }
}

async function enrichMany(apps: AppSignal[]): Promise<void> {
  // Group by platform+category, fetch peers once per group
  const groups = new Map<string, AppSignal[]>();
  for (const app of apps) {
    const key = `${app.platform}:${app.category}`;
    const list = groups.get(key) ?? [];
    list.push(app);
    groups.set(key, list);
  }

  await Promise.allSettled(
    [...groups.values()].map(group => enrichSingle(group[0]).then(() => {
      // Apply the same median to all apps in this group
      const median = group[0].competitive_context.category_median_rating_velocity;
      for (const app of group) {
        app.competitive_context.category_median_rating_velocity = median;
        app.competitive_context.relative_momentum = computeMomentum(app.rating.velocity_30d, median);
      }
    }))
  );
}

// ── Cache warm ─────────────────────────────────────────────────────────────

export async function warmCache(): Promise<void> {
  console.log("[appsignal] Warming chart caches...");
  await Promise.allSettled([iosTopChart(100), androidTopChart(100)]);
  console.log("[appsignal] Chart caches ready.");
}

export function startBackgroundRefresh(): void {
  setInterval(async () => {
    console.log("[appsignal] Background cache refresh...");
    await Promise.allSettled([iosTopChart(100), androidTopChart(100)]);
  }, REFRESH_INTERVAL_MS);
}

// ── Tool implementations ───────────────────────────────────────────────────

export async function getAppSignal(
  appId: string,
  platform: "ios" | "android"
): Promise<AppSignal> {
  const result = platform === "ios"
    ? await iosLookup(appId)
    : await androidLookup(appId);
  if (!result) throw new Error(`App not found: ${appId} on ${platform}`);

  // Enrich with category context from warm chart cache (cache read, no network)
  await enrichSingle(result);

  return result;
}

export async function searchApps(
  query: string,
  platform: "ios" | "android" | "both",
  limit: number
): Promise<AppSignal[]> {
  const perPlatform = Math.ceil(limit / (platform === "both" ? 2 : 1));

  const [ios, android] = await Promise.allSettled([
    platform !== "android" ? iosSearch(query, perPlatform) : Promise.resolve([]),
    platform !== "ios"     ? androidSearch(query, perPlatform) : Promise.resolve([]),
  ]);

  const results: AppSignal[] = [
    ...(ios.status     === "fulfilled" ? ios.value     : []),
    ...(android.status === "fulfilled" ? android.value : []),
  ];

  // First pass: enrich from within-batch peers (fast, no network)
  enrichCategoryContext(results);

  // Second pass: for any still null, pull from chart cache
  const stillNull = results.filter(
    a => a.competitive_context.category_median_rating_velocity === null
  );
  if (stillNull.length > 0) await enrichMany(stillNull);

  return rankBySignal(results).slice(0, limit);
}

export async function getBreakoutApps(
  category: string | undefined,
  platform: "ios" | "android" | "both",
  minSignal: string,
  limit: number
): Promise<AppSignal[]> {
  const threshold = minSignal as GrowthSignal;

  const [ios, android] = await Promise.allSettled([
    platform !== "android" ? iosTopChart(200) : Promise.resolve([]),
    platform !== "ios"     ? androidTopChart(200) : Promise.resolve([]),
  ]);

  let apps: AppSignal[] = [
    ...(ios.status     === "fulfilled" ? ios.value     : []),
    ...(android.status === "fulfilled" ? android.value : []),
  ];

  if (category) {
    apps = apps.filter(a => matchesCategory(a.category, category));
  }

  return rankBySignal(
    apps.filter(a => meetsSignalThreshold(a.growth_signal, threshold))
  ).slice(0, limit);
}

export async function getCategoryLeaders(
  category: string,
  platform: "ios" | "android",
  limit: number
): Promise<AppSignal[]> {
  if (platform === "android") {
    const specific = await androidCategoryChart(toGplayCategory(category), limit);
    if (specific.length > 0) return specific.slice(0, limit);
    const all = await androidTopChart(200);
    return all.filter(a => matchesCategory(a.category, category)).slice(0, limit);
  }

  const specific = await iosCategoryChart(category, limit);
  if (specific.length > 0) return specific.slice(0, limit);

  const all = await iosTopChart(200);
  return all.filter(a => matchesCategory(a.category, category)).slice(0, limit);
}