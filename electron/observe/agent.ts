import { powerMonitor } from 'electron'
import type { ActivityEvent, SensorStatus } from '../shared/types'
import { getDb } from '../core/db'
import { bus, newId } from '../core/bus'
import { getSettings } from '../core/settings'
import { applyPrivacy } from './privacy'
import { OsSensor } from './sensors/osSensor'
import { FileSensor } from './sensors/fileSensor'
import { BrowserBridge } from './sensors/browserBridge'

export type RawEvent = Omit<ActivityEvent, 'id' | 'ts'> & { ts?: number }

const IDLE_THRESHOLD_S = 300

/**
 * Desktop Activity Agent: owns the sensors, runs every raw signal through the
 * privacy filter and de-duplication, and persists structured ActivityEvents.
 */
export class ActivityAgent {
  private os = new OsSensor((e) => this.ingest(e))
  private files = new FileSensor((e) => this.ingest(e))
  private bridge = new BrowserBridge(
    (e) => this.ingest(e),
    () => {
      const s = getSettings()
      return { port: s.bridgePort, token: s.bridgeToken, crmPort: s.crmPort }
    },
  )
  private idleTimer: NodeJS.Timeout | null = null
  private wasIdle = false
  private lastKey = ''
  private lastKeyTs = 0

  start() {
    this.bridge.start()
    this.applyObserving()
    this.idleTimer = setInterval(() => this.checkIdle(), 15_000)
    this.purgeOld()
    setInterval(() => this.purgeOld(), 6 * 3600_000)
  }

  /** Sensors that watch the OS pause with the observing toggle; the bridge stays up so the extension stays paired. */
  applyObserving() {
    const s = getSettings()
    if (s.observing) {
      this.os.start()
      this.files.start(s.watchFolders)
    } else {
      this.os.stop()
      this.files.stop()
    }
  }

  stop() {
    this.os.stop()
    this.files.stop()
    this.bridge.stop()
    if (this.idleTimer) clearInterval(this.idleTimer)
  }

  sensors(): SensorStatus[] {
    return [this.os.status, this.bridge.status, this.files.status]
  }

  ingest(raw: RawEvent): ActivityEvent | null {
    const s = getSettings()
    if (!s.observing && raw.source !== 'demo') return null

    const ev = applyPrivacy({ ...raw, id: newId('ev'), ts: raw.ts ?? Date.now() }, s)
    if (!ev) return null

    // Collapse bursts of identical signals (e.g. double-fired navigations).
    const key = `${ev.kind}|${ev.app}|${ev.target ?? ''}|${ev.url ?? ''}|${ev.path ?? ''}`
    if (key === this.lastKey && ev.ts - this.lastKeyTs < 1500) return null
    this.lastKey = key
    this.lastKeyTs = ev.ts

    insertEvent(ev)
    bus.emit('activity', ev)
    return ev
  }

  private checkIdle() {
    const idle = powerMonitor.getSystemIdleTime() >= IDLE_THRESHOLD_S
    if (idle && !this.wasIdle) this.ingest({ source: 'system', kind: 'idle', app: 'System' })
    this.wasIdle = idle
  }

  private purgeOld() {
    const cutoff = Date.now() - getSettings().retentionDays * 86400_000
    getDb().prepare('DELETE FROM events WHERE ts < ?').run(cutoff)
  }
}

export function insertEvent(ev: ActivityEvent) {
  getDb()
    .prepare(
      'INSERT OR IGNORE INTO events (id, ts, source, kind, app, target, url, title, path, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(ev.id, ev.ts, ev.source, ev.kind, ev.app, ev.target ?? null, ev.url ?? null, ev.title ?? null, ev.path ?? null, ev.data ? JSON.stringify(ev.data) : null)
}

export function loadEvents(sinceTs: number, limit = 20000): ActivityEvent[] {
  const rows = getDb()
    .prepare('SELECT * FROM events WHERE ts >= ? ORDER BY ts ASC LIMIT ?')
    .all(sinceTs, limit) as Record<string, unknown>[]
  return rows.map(rowToEvent)
}

export function recentEvents(limit: number): ActivityEvent[] {
  const rows = getDb().prepare('SELECT * FROM events ORDER BY ts DESC LIMIT ?').all(limit) as Record<string, unknown>[]
  return rows.map(rowToEvent)
}

function rowToEvent(r: Record<string, unknown>): ActivityEvent {
  return {
    id: r.id as string,
    ts: r.ts as number,
    source: r.source as ActivityEvent['source'],
    kind: r.kind as ActivityEvent['kind'],
    app: r.app as string,
    target: (r.target as string) ?? undefined,
    url: (r.url as string) ?? undefined,
    title: (r.title as string) ?? undefined,
    path: (r.path as string) ?? undefined,
    data: r.data ? JSON.parse(r.data as string) : undefined,
  }
}
