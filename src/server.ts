import express, { type Request, type Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createContextMiddleware } from "@ctxprotocol/sdk";

import { TOOLS } from "./tools.js";
import {
  getAppSignal,
  searchApps,
  getBreakoutApps,
  getCategoryLeaders,
  warmCache,
  startBackgroundRefresh,
} from "./fetcher.js";
import { ENV } from "./env.js";

// ── Logger ─────────────────────────────────────────────────────────────────

const log = {
  info:  (msg: string, meta?: object) => console.log( `[INFO]  ${msg}`, meta ? JSON.stringify(meta) : ""),
  warn:  (msg: string, meta?: object) => console.warn( `[WARN]  ${msg}`, meta ? JSON.stringify(meta) : ""),
  error: (msg: string, meta?: object) => console.error(`[ERROR] ${msg}`, meta ? JSON.stringify(meta) : ""),
};

// ── Express ────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.use((req, _res, next) => {
  log.info("request", { method: req.method, path: req.path, body_method: req.body?.method });
  next();
});

app.use("/mcp", createContextMiddleware());

// ── MCP Server (SSE sessions only) ────────────────────────────────────────

function makeServer(): Server {
  const server = new Server(
    { name: "appsignal", version: "1.0.0" },
    { capabilities: { tools: { listChanged: false } } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    log.info("tools/list");
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const t0 = Date.now();
    log.info("tool/call", { name });

    try {
      switch (name) {
        case "get_app_signal": {
          const result = await getAppSignal(args.app_id as string, (args.platform ?? "ios") as "ios" | "android");
          log.info("tool/ok", { name, ms: Date.now() - t0 });
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
        }
        case "search_apps": {
          const apps = await searchApps(args.query as string, (args.platform ?? "both") as "ios" | "android" | "both", (args.limit as number) ?? 10);
          const out = { apps, count: apps.length };
          log.info("tool/ok", { name, ms: Date.now() - t0, count: out.count });
          return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
        }
        case "get_breakout_apps": {
          const apps = await getBreakoutApps(args.category as string | undefined, (args.platform ?? "both") as "ios" | "android" | "both", (args.min_signal as string) ?? "strong", (args.limit as number) ?? 25);
          const out = { apps, count: apps.length };
          log.info("tool/ok", { name, ms: Date.now() - t0, count: out.count });
          return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
        }
        case "get_category_leaders": {
          const leaders = await getCategoryLeaders(args.category as string, (args.platform ?? "ios") as "ios" | "android", (args.limit as number) ?? 20);
          const out = { category: args.category, platform: args.platform ?? "ios", leaders };
          log.info("tool/ok", { name, ms: Date.now() - t0, count: leaders.length });
          return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("tool/err", { name, ms: Date.now() - t0, message });
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true, structuredContent: { error: message } };
    }
  });

  return server;
}

// ── Routes ─────────────────────────────────────────────────────────────────

const sessions = new Map<string, SSEServerTransport>();

app.get("/mcp", async (_req: Request, res: Response) => {
  const transport = new SSEServerTransport("/mcp", res);
  const server = makeServer();
  sessions.set(transport.sessionId, transport);
  res.on("close", () => {
    sessions.delete(transport.sessionId);
    log.info("sse/close", { activeSessions: sessions.size });
  });
  await server.connect(transport);
});

app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string | undefined;

  if (sessionId) {
    const transport = sessions.get(sessionId);
    if (!transport) { res.status(404).json({ error: "Session not found" }); return; }
    await transport.handlePostMessage(req, res, req.body);
    return;
  }

  const { method, id } = req.body ?? {};

  if (method === "initialize") {
    res.json({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "appsignal", version: "1.0.0" }, capabilities: { tools: { listChanged: false } } } });
    return;
  }

  if (method === "notifications/initialized") {
    log.info("notifications/initialized")
    res.status(204).end();
    return;
  }

  if (method === "notifications/cancelled") {
    log.warn("tool/cancelled", { id });
    res.json({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "tools/list") {
    log.info("tools/list");
    res.json({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }

  if (method === "tools/call") {
    const { name, arguments: args = {} } = req.body?.params ?? {};
    const t0 = Date.now();
    log.info("tool/call", { name });

    try {
      let result: unknown;
      switch (name) {
        case "get_app_signal":
          result = await getAppSignal(args.app_id as string, (args.platform ?? "ios") as "ios" | "android");
          break;
        case "search_apps": {
          const apps = await searchApps(args.query as string, (args.platform ?? "both") as "ios" | "android" | "both", (args.limit as number) ?? 10);
          result = { apps, count: apps.length };
          break;
        }
        case "get_breakout_apps": {
          const apps = await getBreakoutApps(args.category as string | undefined, (args.platform ?? "both") as "ios" | "android" | "both", (args.min_signal as string) ?? "strong", (args.limit as number) ?? 25);
          result = { apps, count: apps.length };
          break;
        }
        case "get_category_leaders": {
          const leaders = await getCategoryLeaders(args.category as string, (args.platform ?? "ios") as "ios" | "android", (args.limit as number) ?? 20);
          result = { category: args.category, platform: args.platform ?? "ios", leaders };
          break;
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
      log.info("tool/ok", { name, ms: Date.now() - t0 });
      res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("tool/err", { name, ms: Date.now() - t0, message });
      res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${message}` }], isError: true, structuredContent: { error: message } } });
    }
    return;
  }

  log.warn("unknown_method", { method });
  res.status(400).json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "appsignal-mcp", version: "1.0.0", activeSessions: sessions.size });
});

// ── Start ──────────────────────────────────────────────────────────────────

app.listen(ENV.PORT, () => {
  log.info("listening", { port: ENV.PORT });
  warmCache()
    .then(() => log.info("cache/warmed"))
    .catch((err) => log.error("cache/warm_failed", { message: String(err) }));
  startBackgroundRefresh();
});