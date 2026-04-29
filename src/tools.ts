const APP_SIGNAL_SCHEMA = {
  type: "object",
  description: "Full AppSignal intelligence object for one app",
  properties: {
    app_id:    { type: "string", description: "Numeric trackId (iOS) or package name (Android)" },
    platform:  { type: "string", enum: ["ios", "android"] },
    name:      { type: "string", description: "App display name" },
    developer: { type: "string", description: "Publisher / developer name" },
    category:  { type: "string", description: "Primary store category" },
    rating: {
      type: "object",
      properties: {
        score:        { type: "number", description: "Average rating (0-5)" },
        total_count:  { type: "number", description: "Lifetime rating count" },
        velocity_30d: { type: ["number", "null"], description: "Extrapolated 30-day rating count delta. null on first fetch (no prior snapshot)." },
      },
      required: ["score", "total_count", "velocity_30d"],
    },
    rank: {
      type: "object",
      properties: {
        current:   { type: ["number", "null"], description: "Current chart position (1-based)" },
        delta_30d: { type: ["number", "null"], description: "Rank change over 30d (positive = rising)" },
        chart:     { type: "string", description: "Chart name, e.g. top-free" },
      },
      required: ["current", "delta_30d", "chart"],
    },
    install_band: {
      type: ["string", "null"],
      description: "Android only: Google ground-truth install band label, e.g. '1,000,000+'. null for iOS.",
    },
    growth_signal: {
      type: "string",
      enum: ["breakout", "strong", "moderate", "stable", "declining"],
      description: "Composite momentum classification. breakout = velocity>500 AND rank_delta>10.",
    },
    competitive_context: {
      type: "object",
      properties: {
        category_median_rating_velocity: { type: ["number", "null"], description: "Median 30d rating velocity across apps in the same category" },
        relative_momentum: { type: "string", enum: ["above_median", "below_median", "at_median", "unknown"] },
      },
      required: ["category_median_rating_velocity", "relative_momentum"],
    },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
      description: "high = top-200 ranked + 30d snapshot data. medium = ranked. low = cold/unranked.",
    },
    data_freshness: { type: "string", format: "date-time" },
  },
  required: [
    "app_id", "platform", "name", "developer", "category", "rating",
    "rank", "install_band", "growth_signal", "competitive_context",
    "confidence", "data_freshness",
  ],
};

export const TOOLS = [
  {
    name: "get_app_signal",
    description: [
      "Look up full growth intelligence for one app.",
      "Returns rank, rating velocity, install band, and growth signal.",
      "iOS: pass numeric trackId or bundle ID (e.g. 324684580 or com.spotify.music).",
      "Android: pass package name (e.g. com.spotify.music).",
      "Cold apps (not in top charts) have lower confidence and ~5s latency.",
    ].join(" "),
    examples: [
      { input: { app_id: "324684580", platform: "ios" } },
      { input: { app_id: "com.spotify.music", platform: "android" } },
    ],
    _meta: {
      surface: "both",
      queryEligible: true,
      latencyClass: "fast",
      pricing: { executeUsd: "0.0015" },
      rateLimit: {
        maxRequestsPerMinute: 40,
        cooldownMs: 500,
        maxConcurrency: 5,
        notes: "iTunes API is unauthenticated — keep concurrent lookups reasonable.",
      },
    },
    inputSchema: {
      type: "object",
      properties: {
        app_id: {
          type: "string",
          description: "App identifier: numeric trackId or bundle ID for iOS, package name for Android",
          default: "324684580",
          examples: ["324684580", "com.spotify.music", "com.netflix.mediaclient"],
        },
        platform: {
          type: "string",
          enum: ["ios", "android"],
          description: "Target platform",
          default: "ios",
        },
      },
      required: ["app_id", "platform"],
    },
    outputSchema: APP_SIGNAL_SCHEMA,
  },

  {
    name: "search_apps",
    description: [
      "Search for apps by keyword and return ranked AppSignal objects.",
      "Use platform='both' for cross-platform competitive analysis.",
      "Results are sorted by growth signal strength (breakout first).",
    ].join(" "),
    examples: [
      { input: { query: "meditation", platform: "both", limit: 10 } },
      { input: { query: "budget tracker", platform: "ios", limit: 5 } },
    ],
    _meta: {
      surface: "both",
      queryEligible: true,
      latencyClass: "fast",
      pricing: { executeUsd: "0.0015" },
      rateLimit: {
        maxRequestsPerMinute: 20,
        cooldownMs: 1000,
        maxConcurrency: 2,
        notes: "Each search triggers one iTunes + one Play Store request.",
      },
    },
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search keyword or phrase",
          default: "meditation",
          examples: ["meditation", "budget tracker", "ai assistant"],
        },
        platform: {
          type: "string",
          enum: ["ios", "android", "both"],
          description: "Platform scope",
          default: "both",
        },
        limit: {
          type: "number",
          description: "Max results to return",
          default: 10,
          minimum: 1,
          maximum: 30,
        },
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      properties: {
        apps:  { type: "array", items: APP_SIGNAL_SCHEMA },
        count: { type: "number", description: "Number of results returned" },
      },
      required: ["apps", "count"],
    },
  },

  {
    name: "get_breakout_apps",
    description: [
      "Return apps currently showing breakout or strong growth signals from the live top-chart corpus.",
      "Ideal for surfacing fast-movers and emerging hits in a category.",
      "Apps are ranked by signal strength, then by raw velocity.",
    ].join(" "),
    examples: [
      { input: { platform: "both", min_signal: "strong", limit: 25 } },
      { input: { category: "games", platform: "ios", min_signal: "breakout", limit: 10 } },
    ],
    _meta: {
      surface: "both",
      queryEligible: true,
      latencyClass: "instant",
      pricing: { executeUsd: "0.0010" },
      rateLimit: {
        maxRequestsPerMinute: 60,
        cooldownMs: 0,
        maxConcurrency: 10,
        notes: "Served from pre-warmed chart cache. Near-zero latency.",
        supportsBulk: true,
      },
    },
    inputSchema: {
      type: "object",
      properties: {
        platform: {
          type: "string",
          enum: ["ios", "android", "both"],
          default: "both",
        },
        category: {
          type: "string",
          description: "Optional category filter (partial match). E.g. 'games', 'productivity'",
          examples: ["games", "health", "finance", "social"],
        },
        min_signal: {
          type: "string",
          enum: ["breakout", "strong", "moderate"],
          description: "Minimum signal threshold",
          default: "strong",
        },
        limit: {
          type: "number",
          description: "Max apps to return",
          default: 25,
          minimum: 1,
          maximum: 100,
        },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        apps:  { type: "array", items: APP_SIGNAL_SCHEMA },
        count: { type: "number" },
      },
      required: ["apps", "count"],
    },
  },

  {
    name: "get_category_leaders",
    description: [
      "Top apps in a specific category with full growth signal context.",
      "Use for competitive landscape snapshots and category-level momentum analysis.",
      "Includes category median velocity for relative benchmarking.",
    ].join(" "),
    examples: [
      { input: { category: "productivity", platform: "ios", limit: 20 } },
      { input: { category: "games", platform: "android", limit: 10 } },
    ],
    _meta: {
      surface: "both",
      queryEligible: true,
      latencyClass: "instant",
      pricing: { executeUsd: "0.0010" },
      rateLimit: {
        maxRequestsPerMinute: 60,
        cooldownMs: 0,
        maxConcurrency: 10,
        notes: "Served from pre-warmed chart cache.",
        supportsBulk: true,
      },
    },
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Category name (case-insensitive). iOS: genre name. Android: Google Play category ID.",
          default: "productivity",
          examples: ["games", "productivity", "health & fitness", "finance", "social networking"],
        },
        platform: {
          type: "string",
          enum: ["ios", "android"],
          default: "ios",
        },
        limit: {
          type: "number",
          description: "Number of leaders to return",
          default: 20,
          minimum: 1,
          maximum: 50,
        },
      },
      required: ["category", "platform"],
    },
    outputSchema: {
      type: "object",
      properties: {
        category: { type: "string" },
        platform: { type: "string" },
        leaders:  { type: "array", items: APP_SIGNAL_SCHEMA },
      },
      required: ["category", "platform", "leaders"],
    },
  },
];