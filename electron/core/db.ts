import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import fs from 'node:fs'

let db: DatabaseSync | null = null

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  app TEXT NOT NULL,
  target TEXT,
  url TEXT,
  title TEXT,
  path TEXT,
  data TEXT
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS patterns (
  id TEXT PRIMARY KEY,
  signature_key TEXT UNIQUE NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  pattern_id TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_wf ON runs(workflow_id, started_at);

CREATE TABLE IF NOT EXISTS mechanism_stats (
  action TEXT NOT NULL,
  mechanism TEXT NOT NULL,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  total_ms INTEGER NOT NULL DEFAULT 0,
  recent TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (action, mechanism)
);

CREATE TABLE IF NOT EXISTS trigger_seen (
  workflow_id TEXT NOT NULL,
  key TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, key)
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS crm_customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS crm_notes (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  body TEXT NOT NULL,
  attachment TEXT,
  author TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`

export function openDb(dir: string): DatabaseSync {
  if (db) return db
  fs.mkdirSync(dir, { recursive: true })
  db = new DatabaseSync(path.join(dir, 'workflowos.db'))
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec(SCHEMA)
  return db
}

/** For tests: an in-memory database with the same schema. */
export function openMemoryDb(): DatabaseSync {
  db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
  return db
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('Database not opened')
  return db
}

export function kvGet<T>(key: string, fallback: T): T {
  const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}

export function kvSet(key: string, value: unknown): void {
  getDb()
    .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value))
}
