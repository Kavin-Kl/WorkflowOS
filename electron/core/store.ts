import type { Pattern, Workflow } from '../shared/types'
import { getDb } from './db'
import { bus } from './bus'

export function listPatterns(): Pattern[] {
  const rows = getDb().prepare('SELECT body FROM patterns ORDER BY updated_at DESC').all() as { body: string }[]
  return rows.map((r) => JSON.parse(r.body) as Pattern).sort((a, b) => b.score - a.score)
}

export function getPattern(id: string): Pattern | undefined {
  const row = getDb().prepare('SELECT body FROM patterns WHERE id = ?').get(id) as { body: string } | undefined
  return row ? (JSON.parse(row.body) as Pattern) : undefined
}

export function savePattern(p: Pattern) {
  getDb()
    .prepare(
      `INSERT INTO patterns (id, signature_key, body, status, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET signature_key = excluded.signature_key, body = excluded.body, status = excluded.status, updated_at = excluded.updated_at`,
    )
    .run(p.id, p.signature.join('>'), JSON.stringify(p), p.status, Date.now())
  bus.emit('pattern', p)
}

export function listWorkflows(): Workflow[] {
  const rows = getDb().prepare('SELECT body FROM workflows ORDER BY created_at DESC').all() as { body: string }[]
  return rows.map((r) => JSON.parse(r.body) as Workflow)
}

export function getWorkflow(id: string): Workflow | undefined {
  const row = getDb().prepare('SELECT body FROM workflows WHERE id = ?').get(id) as { body: string } | undefined
  return row ? (JSON.parse(row.body) as Workflow) : undefined
}

export function saveWorkflow(w: Workflow) {
  getDb()
    .prepare(
      `INSERT INTO workflows (id, pattern_id, body, status, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET body = excluded.body, status = excluded.status`,
    )
    .run(w.id, w.patternId ?? null, JSON.stringify(w), w.status, w.createdAt)
  bus.emit('workflow', w)
}

export function resetAll() {
  const db = getDb()
  db.exec('DELETE FROM events; DELETE FROM patterns; DELETE FROM workflows; DELETE FROM runs; DELETE FROM mechanism_stats; DELETE FROM trigger_seen;')
}
