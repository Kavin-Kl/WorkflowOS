import type { Mechanism, MechanismStat } from '../shared/types'
import { getDb } from '../core/db'

// Learn: per (action, mechanism) reliability. The last N outcomes decide
// whether a mechanism keeps its place in the ladder or is demoted.

const WINDOW = 10
const MIN_ATTEMPTS = 3
const DEMOTE_BELOW = 0.4

export function recordOutcome(action: string, mechanism: Mechanism, ok: boolean, ms: number) {
  const db = getDb()
  const row = db.prepare('SELECT recent FROM mechanism_stats WHERE action = ? AND mechanism = ?').get(action, mechanism) as
    | { recent: string }
    | undefined
  const recent = ((row?.recent ?? '') + (ok ? '1' : '0')).slice(-WINDOW)
  db.prepare(
    `INSERT INTO mechanism_stats (action, mechanism, successes, failures, total_ms, recent) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(action, mechanism) DO UPDATE SET
       successes = successes + excluded.successes,
       failures = failures + excluded.failures,
       total_ms = total_ms + excluded.total_ms,
       recent = excluded.recent`,
  ).run(action, mechanism, ok ? 1 : 0, ok ? 0 : 1, Math.round(ms), recent)
}

export function recentSuccessRate(action: string, mechanism: Mechanism): number | null {
  const row = getDb().prepare('SELECT recent FROM mechanism_stats WHERE action = ? AND mechanism = ?').get(action, mechanism) as
    | { recent: string }
    | undefined
  if (!row || row.recent.length < MIN_ATTEMPTS) return null
  return [...row.recent].filter((c) => c === '1').length / row.recent.length
}

/** Keep priority order, but move unreliable mechanisms to the end. */
export function orderLadder(action: string, mechanisms: Mechanism[]): Mechanism[] {
  const healthy: Mechanism[] = []
  const demoted: Mechanism[] = []
  for (const m of mechanisms) {
    const rate = recentSuccessRate(action, m)
    ;(rate !== null && rate < DEMOTE_BELOW ? demoted : healthy).push(m)
  }
  return [...healthy, ...demoted]
}

export function allStats(): MechanismStat[] {
  const rows = getDb().prepare('SELECT * FROM mechanism_stats ORDER BY action, mechanism').all() as {
    action: string
    mechanism: Mechanism
    successes: number
    failures: number
    total_ms: number
  }[]
  return rows.map((r) => ({
    action: r.action,
    mechanism: r.mechanism,
    successes: r.successes,
    failures: r.failures,
    avgMs: r.successes + r.failures ? Math.round(r.total_ms / (r.successes + r.failures)) : 0,
  }))
}
