import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { ENV } from "./env.js";

// Ensure the directory exists (Railway volume mount may be empty on first boot)
mkdirSync(dirname(ENV.DB_PATH), { recursive: true });

export const db = new Database(ENV.DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id       TEXT    NOT NULL,
    timestamp    INTEGER NOT NULL,
    rank         INTEGER,
    rating_count INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_app_id_ts ON snapshots(app_id, timestamp);
`);

export function addSnapshot(
  app_id: string,
  snapshot: { timestamp: number; rank?: number | null; rating_count?: number | null }
): void {
  db.prepare(`
    INSERT INTO snapshots (app_id, timestamp, rank, rating_count)
    VALUES (?, ?, ?, ?)
  `).run(app_id, snapshot.timestamp, snapshot.rank ?? null, snapshot.rating_count ?? null);
}

const MS_30D = 30 * 24 * 60 * 60 * 1000;

export function getVelocity30d(app_id: string): number | null {
  const cutoff = Date.now() - MS_30D;
  const rows = db.prepare(`
    SELECT rating_count FROM snapshots
    WHERE app_id = ? AND timestamp >= ? AND rating_count IS NOT NULL
    ORDER BY timestamp ASC
  `).all(app_id, cutoff) as { rating_count: number }[];

  if (rows.length < 2) return null;
  return rows.at(-1)!.rating_count - rows[0].rating_count;
}

export function getRankDelta30d(app_id: string): number | null {
  const cutoff = Date.now() - MS_30D;
  const rows = db.prepare(`
    SELECT rank FROM snapshots
    WHERE app_id = ? AND timestamp >= ? AND rank IS NOT NULL
    ORDER BY timestamp ASC
  `).all(app_id, cutoff) as { rank: number }[];

  if (rows.length < 2) return null;
  return rows[0].rank - rows.at(-1)!.rank; // positive = rising
}