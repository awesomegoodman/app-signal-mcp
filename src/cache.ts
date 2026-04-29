import type { Snapshot } from "./types.js";
import { addSnapshot, getVelocity30d, getRankDelta30d } from "./db.js";

// ── TTL Cache ──────────────────────────────────────────────────

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
    if (Date.now() > entry.expires) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  keys(prefix?: string): string[] {
    const now = Date.now();
    return [...this.store.entries()]
      .filter(([k, e]) => e.expires > now && (!prefix || k.startsWith(prefix)))
      .map(([k]) => k);
  }

  size(): number {
    return this.keys().length;
  }
}

// ── Snapshot API ───────────────────────────────────

export function recordSnapshot(key: string, snap: Snapshot): void {
  addSnapshot(key, {
    timestamp:    snap.captured_at,
    rank:         snap.rank,
    rating_count: snap.rating_count,
  });
}

export function getVelocity(key: string): number | null {
  return getVelocity30d(key);
}

export function getRankDelta(key: string): number | null {
  return getRankDelta30d(key);
}