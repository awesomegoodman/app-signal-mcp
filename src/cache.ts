import { createRequire } from "module";
import { existsSync, mkdirSync } from "fs";
import type { Snapshot } from "./types.js";

// ── TTL Cache (in-memory) ──────────────────────────────────────────────────

interface Entry<T> {
  value: T;
  expires: number;
}

export class Cache<T> {
  private store = new Map<string, Entry<T>>();

  set(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expires: Date.now() + ttlMs });
  }

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) { this.store.delete(key); return null; }
    return entry.value;
  }

  keys(prefix?: string): string[] {
    const now = Date.now();
    return [...this.store.entries()]
      .filter(([k, e]) => e.expires > now && (!prefix || k.startsWith(prefix)))
      .map(([k]) => k);
  }

  size(): number { return this.keys().length; }
}

// ── SQLite snapshot store ──────────────────────────────────────────────────
// Persists rating_count + rank snapshots across process restarts so that
// velocity_30d and rank_delta_30d accumulate across Railway redeploys.
//
// Setup:
//   1. npm install better-sqlite3
//   2. In Railway dashboard: add a Volume mounted at /data
//   3. Set DATA_DIR=/data in Railway env vars (or leave as default)
//
// Falls back gracefully to in-memory if better-sqlite3 is unavailable.

type SqliteDB = {
  prepare: (sql: string) => {
    run:  (...args: unknown[]) => void;
    all:  (...args: unknown[]) => unknown[];
  };
  exec: (sql: string) => void;
};

const _require = createRequire(import.meta.url);

function initDb(): SqliteDB | null {
  try {
    const Database = _require("better-sqlite3") as new (path: string) => SqliteDB;
    const dataDir  = process.env.DATA_DIR ?? "/data";
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const db = new Database(`${dataDir}/snapshots.db`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        key          TEXT    NOT NULL,
        rating_count INTEGER NOT NULL,
        rank         INTEGER,
        captured_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_key_time ON snapshots(key, captured_at DESC);
    `);
    console.log(`[cache] SQLite ready at ${dataDir}/snapshots.db`);
    return db;
  } catch (e) {
    console.warn("[cache] SQLite unavailable — using in-memory snapshots:", (e as Error).message);
    return null;
  }
}

const db = initDb();

// ── In-memory fallback ─────────────────────────────────────────────────────

const memSnapshots = new Map<string, Snapshot[]>();

function memRecord(key: string, snap: Snapshot): void {
  const history = memSnapshots.get(key) ?? [];
  history.push(snap);
  if (history.length > 2) history.shift();
  memSnapshots.set(key, history);
}

function memGetTwo(key: string): [Snapshot, Snapshot] | null {
  const h = memSnapshots.get(key);
  if (!h || h.length < 2) return null;
  return [h[h.length - 2], h[h.length - 1]];
}

// ── Public API ─────────────────────────────────────────────────────────────

export function recordSnapshot(key: string, snap: Snapshot): void {
  if (db) {
    db.prepare("INSERT INTO snapshots(key,rating_count,rank,captured_at) VALUES(?,?,?,?)")
      .run(key, snap.rating_count, snap.rank ?? null, snap.captured_at);
  } else {
    memRecord(key, snap);
  }
}

type SnapshotRow = { rating_count: number; rank: number | null; captured_at: number };

function getTwoSnapshots(key: string): [Snapshot, Snapshot] | null {
  if (db) {
    const rows = db.prepare(
      "SELECT rating_count, rank, captured_at FROM snapshots WHERE key=? ORDER BY captured_at DESC LIMIT 2"
    ).all(key) as SnapshotRow[];
    if (rows.length < 2) return null;
    const cur: Snapshot = { rating_count: rows[0].rating_count, rank: rows[0].rank, captured_at: rows[0].captured_at };
    const old: Snapshot = { rating_count: rows[1].rating_count, rank: rows[1].rank, captured_at: rows[1].captured_at };
    return [old, cur];
  }
  return memGetTwo(key);
}

const MS_30D = 30 * 24 * 60 * 60 * 1000;

export function getVelocity(key: string): number | null {
  const pair = getTwoSnapshots(key);
  if (!pair) return null;
  const [old, cur] = pair;
  const deltaMs = cur.captured_at - old.captured_at;
  if (deltaMs <= 0) return null;
  return Math.round(((cur.rating_count - old.rating_count) / deltaMs) * MS_30D);
}

export function getRankDelta(key: string): number | null {
  const pair = getTwoSnapshots(key);
  if (!pair) return null;
  const [old, cur] = pair;
  if (old.rank === null || cur.rank === null) return null;
  return old.rank - cur.rank; // positive = rising
}