# AppSignal MCP

**App Store growth intelligence for AI agents.**
iOS & Android rank momentum, rating velocity, install scale — served as an MCP tool on the [Context marketplace](https://ctxprotocol.com).

## What it is

| Signal | Source | Method |
|--------|--------|--------|
| Category rank (iOS) | Apple RSS Marketing Tools | Official JSON feed |
| Rating score + count | iTunes Search API | Official documented API |
| Rating velocity | Snapshot delta computation | Pre-computed offline |
| Install scale (Android) | Google Play public pages | google-play-scraper (MIT) |
| Growth signal | Classifier on velocity + rank delta | `breakout / strong / moderate / stable / declining` |

No API keys. No scraping Apple. Zero upstream cost.

## Tools

| Tool | Description | Latency |
|------|-------------|---------|
| `get_app_signal` | Full intelligence for one app by ID | ~10ms cached / ~5s cold |
| `search_apps` | Keyword search, ranked by growth signal | ~1–2s |
| `get_breakout_apps` | Momentum filter over live chart corpus | ~10ms (pre-warmed) |
| `get_category_leaders` | Top apps in a category with context | ~10ms (pre-warmed) |

## Run locally

```bash
npm install
npm run dev
```

Test with MCP Inspector or curl:

```bash
# List tools
curl -N -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/list",
    "id": 1
  }'

# Look up Spotify on iOS
curl -N -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "id": 2,
    "params": {
      "name": "get_app_signal",
      "arguments": {
        "app_id": "324684580",
        "platform": "ios"
      }
    }
  }'
```

> **Note:** `tools/call` returns `{"error":"Unauthorized"}` locally unless you have a valid CTX JWT.
> This is correct — the CTX middleware guards paid calls. Use the [CTX developer console](https://ctxprotocol.com/developer)
> to test with a real signed request, or comment out `createContextMiddleware()` in `server.ts` for local development.

## Transport

The server uses SSE transport (`SSEServerTransport`) with a hybrid stateless POST handler:

- `GET /mcp` — opens a persistent SSE session (for MCP Inspector and SDK clients)
- `POST /mcp` — stateless single-shot handler for CTX discovery and paid calls
  - `tools/list` and `initialize` return plain JSON with no session or `Accept` header required
  - `tools/call` executes directly and returns plain JSON (no SSE framing)

This is different from `StreamableHTTPServerTransport`, which requires `Accept: application/json, text/event-stream` and is not compatible with CTX's discovery flow.

## Deploy

### Railway / Render (easiest)
Push to GitHub, connect repo, set `PORT` env var. Done.

### Hetzner CX22 (~€4/mo)
```bash
docker build -t appsignal-mcp .
docker run -d -p 3000:3000 --env-file .env --restart unless-stopped appsignal-mcp
```

Expose via Caddy or nginx for HTTPS (required by CTX).

## List on CTX marketplace

1. Deploy and get a public HTTPS endpoint
2. Go to [ctxprotocol.com/contribute](https://ctxprotocol.com/contribute)
3. Paste your endpoint URL (`https://your-server.com/mcp`)
4. CTX auto-discovers all 4 tools via `tools/list`
5. Set listing price ($0.10/response)
6. Stake $10 USDC → listing goes live

## Growth signal classifier

```
velocity > 500 AND rank_delta > 10  → breakout
velocity > 200 OR  rank_delta > 5   → strong
velocity > 50                        → moderate
velocity < 0                         → declining
else                                 → stable
```

Velocity = extrapolated 30-day rating count delta from consecutive snapshots.
`velocity_30d` is `null` on first fetch (no prior snapshot). `confidence` field tells you how much to trust each signal.
Charts refresh every 6 hours via background process.

## Category matching

Category filters use alias expansion so natural language queries work:

| Query | Matches |
|-------|---------|
| `health` | Health & Fitness, Medical |
| `games` | Games, Game |
| `social` | Social Networking, Social |
| `finance` | Finance, Business |
| `music` | Music, Music & Audio |

## Confidence tiers

| Tier | Condition |
|------|-----------|
| `high` | Top-200 ranked + velocity data available |
| `medium` | Ranked 200–2000, no velocity yet |
| `low` | Unranked or first-ever fetch (cold) |

## Architecture note

This is a real-time intelligence engine, not a historical analytics platform. Snapshots accumulate in SQLite as apps are queried — velocity data improves organically with traffic and persists across deploys.