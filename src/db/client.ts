import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "./schema";

// Shared across route bundles: opening the same SQLite file from several module
// instances wastes handles and can trip WAL writer contention.
const G = globalThis as unknown as { __arenaDb?: DatabaseSync | null };
let instance: DatabaseSync | null = G.__arenaDb ?? null;

export function dbFile(): string {
  const configured = process.env.ARENA_DB;
  return configured
    ? path.resolve(/* turbopackIgnore: true */ process.cwd(), configured)
    : path.join(process.cwd(), "data", "arena.db");
}

export function getDb(): DatabaseSync {
  if (instance) return instance;
  const file = dbFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  instance = db;
  G.__arenaDb = db;
  return db;
}

/** Test-only: run against an in-memory database. */
export function useMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  instance = db;
  G.__arenaDb = db;
  return db;
}

export function resetDbForTests(): void {
  instance = null;
  G.__arenaDb = null;
}

export function nid(prefix = ""): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  const s = Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
  return prefix ? `${prefix}_${s}` : s;
}
