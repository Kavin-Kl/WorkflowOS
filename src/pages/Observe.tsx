import { useEffect, useState } from 'react'
import { api, fmtTime, onPush, useLive } from '../api'
import type { ActivityEvent, AppStatus, PublicSettings } from '../../electron/shared/types'
import { attempt, toast } from '../components/Toast'
import type { Page } from '../App'

type LogLine = { level: string; scope: string; message: string; ts: number }

const SOURCE_BADGE: Record<string, string> = {
  window: 'info',
  browser: 'signal',
  file: 'ok',
  accessibility: 'warn',
  system: '',
  demo: '',
}

export default function Observe({ status, go }: { status: AppStatus | null; go: (p: Page) => void }) {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  const [logs, setLogs] = useState<LogLine[]>([])
  const [settings, reloadSettings] = useLive<PublicSettings | null>(() => api.getSettings(), ['status'], null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.recentEvents(80).then(setEvents)
    const offA = onPush<ActivityEvent>('activity', (e) => {
      setEvents((prev) => [e, ...prev].slice(0, 200))
      setFresh((f) => new Set(f).add(e.id))
    })
    const offL = onPush<LogLine>('log', (l) => setLogs((prev) => [l, ...prev].slice(0, 100)))
    return () => {
      offA()
      offL()
    }
  }, [])

  const loadDemo = async () => {
    setBusy(true)
    const r = await attempt(() => api.loadDemo())
    setBusy(false)
    if (!r) return
    setEvents(await api.recentEvents(80))
    toast(`Loaded ${r.events} observed events · ${r.patterns} repeated workflow${r.patterns === 1 ? '' : 's'} found`)
    if (r.proposed) go('discover')
  }

  const toggle = async () => {
    await attempt(() => api.updateSettings({ observing: !settings?.observing }))
    reloadSettings()
  }

  const sensorsUp = status?.sensors.filter((s) => s.state === 'running').length ?? 0

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="kicker">01 · Observe</div>
          <h1>What you're doing, as structured events</h1>
          <p>
            The Desktop Activity Agent watches apps, browser navigation, UI interactions and downloads, turning them into
            events. Field values and passwords are never recorded, and nothing leaves this machine.
          </p>
        </div>
        <div className="actions">
          <button className="btn" onClick={loadDemo} disabled={busy}>
            {busy ? 'Analysing…' : 'Load demo observations'}
          </button>
          <button className={`btn ${settings?.observing ? '' : 'signal'}`} onClick={toggle}>
            {settings?.observing ? 'Pause observing' : 'Resume observing'}
          </button>
        </div>
      </div>

      <div className="stats">
        <div className="card stat">
          <div className="v">{status?.eventCount ?? '–'}</div>
          <div className="k">events captured</div>
        </div>
        <div className="card stat">
          <div className="v">
            {sensorsUp}/{status?.sensors.length ?? 3}
          </div>
          <div className="k">sensors running</div>
        </div>
        <div className="card stat">
          <div className="v">{status?.patternCount ?? '–'}</div>
          <div className="k">repeated workflows</div>
        </div>
        <div className="card stat">
          <div className="v">{status?.activeWorkflows ?? '–'}</div>
          <div className="k">automations active</div>
        </div>
      </div>

      {status && status.platform === 'darwin' && !status.accessibilityTrusted && (
        <div className="warnings" style={{ marginTop: 16 }}>
          Accessibility permission is off, so window titles and focused controls in native apps aren't visible. Enable it in
          System Settings → Privacy &amp; Security → Accessibility for WorkFlowOS (or your terminal while developing).
        </div>
      )}

      <div className="section-title">Live activity</div>
      <div className="card stream">
        {events.length === 0 ? (
          <div className="empty">
            <h3>Nothing observed yet</h3>
            <p>
              Work normally with the browser extension connected, or load demo observations to see WorkFlowOS discover a
              workflow.
            </p>
          </div>
        ) : (
          events.slice(0, 80).map((e) => (
            <div key={e.id} className={`stream-row ${fresh.has(e.id) ? 'fresh' : ''}`}>
              <span className="t">{fmtTime(e.ts)}</span>
              <span>
                <span className={`badge ${SOURCE_BADGE[e.source] ?? ''}`}>{e.source}</span>
              </span>
              <span>{e.app}</span>
              <span className="muted">{e.kind}</span>
              <span className="tgt" title={e.url ?? e.path ?? ''}>
                {e.target ?? e.title ?? e.url ?? e.path ?? ''}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="section-title">Engine log</div>
      <div className="card log">
        {logs.length === 0 ? (
          <div className="muted">Discovery, generation and automation messages appear here.</div>
        ) : (
          logs.map((l, i) => (
            <div key={i} className={l.level}>
              {fmtTime(l.ts)} [{l.scope}] {l.message}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
