import type { AppSignal, GrowthSignal } from "./types.js";
import { iosLookup, iosSearch, iosTopChart, iosCategoryChart } from "./ios.js";
import { androidLookup, androidSearch, androidTopChart, androidCategoryChart } from "./android.js";
import { meetsSignalThreshold, rankBySignal } from "./signals.js";

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

export async function getAppSignal(
  appId: string,
  platform: "ios" | "android"
): Promise<AppSignal> {
  const result = platform === "ios"
    ? await iosLookup(appId)
    : await androidLookup(appId);
  if (!result) throw new Error(`App not found: ${appId} on ${platform}`);
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
    const specific = await androidCategoryChart(category.toUpperCase(), limit);
    if (specific.length > 0) return specific.slice(0, limit);

    const all = await androidTopChart(200);
    return all
      .filter(a => matchesCategory(a.category, category))
      .slice(0, limit);
  }

  const specific = await iosCategoryChart(category, limit);
  if (specific.length > 0) return specific.slice(0, limit);

  const all = await iosTopChart(200);
  return all
    .filter(a => matchesCategory(a.category, category))
    .slice(0, limit);
}