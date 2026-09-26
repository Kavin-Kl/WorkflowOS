import { useEffect, useState } from 'react'
import { api, fmtTime, onPush, useLive } from '../api'
import type { ActivityEvent, AppStatus, PublicSettings } from '../../electron/shared/types'
import { attempt } from '../components/Toast'
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

      {status && settings && <Setup status={status} settings={settings} go={go} />}

      <div className="section-title">Live activity</div>
      <div className="card stream">
        {events.length === 0 ? (
          <div className="empty">
            <h3>Nothing observed yet</h3>
            <p>Connect the browser extension, then work normally. Do a routine a few times and WorkFlowOS will pick it up.</p>
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

function Setup({ status, settings, go }: { status: AppStatus; settings: PublicSettings; go: (p: Page) => void }) {
  const ext = status.sensors.find((x) => x.name === 'Browser extension')?.detail?.includes('connected') ?? false
  const items: { label: string; done: boolean; hint: string; optional?: boolean }[] = [
    { label: 'Browser extension connected', done: ext, hint: 'Load browser-extension/ unpacked and paste the pairing token (Settings).' },
    ...(status.platform === 'darwin'
      ? [{ label: 'Accessibility permission', done: status.accessibilityTrusted, hint: 'System Settings → Privacy & Security → Accessibility → enable WorkFlowOS (or your terminal in dev), then restart.' }]
      : []),
    { label: 'Gemini API key', done: settings.geminiConfigured, hint: 'Names workflows, maps inputs, reads emails at run time.' },
    { label: 'Signed in to your apps in the automation browser', done: status.automationBrowser !== 'not started', hint: 'Settings → Automation browser → Open, then sign in to the sites your workflows use.' },
    { label: 'Gmail connected', done: settings.gmailConnected, hint: 'Only needed for email-triggered workflows.', optional: true },
    { label: 'Slack connected', done: settings.slackMode !== 'none', hint: 'Only needed to post to Slack via API.', optional: true },
  ]
  const required = items.filter((i) => !i.optional)
  if (required.every((i) => i.done)) return null
  return (
    <div className="card card-pad" style={{ marginTop: 16 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <strong className="grow">
          Set up ({required.filter((i) => i.done).length}/{required.length})
        </strong>
        <button className="btn sm" onClick={() => go('settings')}>
          Open settings
        </button>
      </div>
      {items.map((i) => (
        <div key={i.label} className="row" style={{ padding: '4px 0', alignItems: 'flex-start' }}>
          <span className={`dot ${i.done ? 'running' : 'stopped'}`} style={{ marginTop: 7 }} />
          <div>
            <div>
              {i.label} {i.optional && <span className="muted">(optional)</span>}
            </div>
            {!i.done && <div className="note" style={{ marginTop: 0 }}>{i.hint}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}
