import { useState, type ReactNode } from 'react'
import { api, useLive } from '../api'
import type { EditableSettings, SecretKey } from '../../electron/shared/api'
import type { AppStatus, PublicSettings } from '../../electron/shared/types'
import { attempt, toast } from '../components/Toast'

export default function Settings({ status }: { status: AppStatus | null }) {
  const [s, reload] = useLive<PublicSettings | null>(() => api.getSettings(), ['status'], null)
  if (!s) return null

  const update = async (patch: Partial<EditableSettings>) => {
    await attempt(() => api.updateSettings(patch))
    reload()
  }
  const secret = async (name: SecretKey, value: string) => {
    await attempt(() => api.setSecret(name, value), 'Saved securely')
    reload()
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="kicker">Connections &amp; privacy</div>
          <h1>Settings</h1>
          <p>Secrets are encrypted with your OS keychain. Observations stay in a local database on this machine.</p>
        </div>
      </div>

      <div className="settings-grid">
        <Conn title="Gemini" ok={s.geminiConfigured} desc="Understands intent, generates workflows, and extracts fields at run time.">
          <SecretField label="API key" placeholder={s.geminiConfigured ? '•••••••• (saved)' : 'AIza…'} onSave={(v) => secret('geminiKey', v)} />
          <div className="field">
            <label className="label">Model</label>
            <TextField value={s.geminiModel} onSave={(v) => update({ geminiModel: v })} />
          </div>
          <button className="btn sm" onClick={() => attempt(() => api.testGemini(), (m) => m)}>
            Test connection
          </button>
          {!s.geminiConfigured && <div className="note">Without a key, WorkFlowOS falls back to built-in heuristics.</div>}
        </Conn>

        <Conn title="Gmail" ok={s.gmailConnected} desc={s.gmailConnected ? `Connected as ${s.gmailAccount}` : 'Trigger: new customer request emails. Action: download attachments.'}>
          <div className="field">
            <label className="label">OAuth client ID (Desktop app)</label>
            <TextField value={s.gmailClientId} placeholder="…apps.googleusercontent.com" onSave={(v) => update({ gmailClientId: v })} />
          </div>
          <SecretField label="OAuth client secret" placeholder="GOCSPX-…" onSave={(v) => secret('gmailClientSecret', v)} />
          <div className="row">
            {s.gmailConnected ? (
              <button className="btn sm" onClick={async () => (await attempt(() => api.disconnectGmail()), reload())}>
                Disconnect
              </button>
            ) : (
              <button className="btn primary sm" onClick={async () => (await attempt(() => api.connectGmail(), (a) => `Connected as ${a}`), reload())}>
                Connect Gmail
              </button>
            )}
          </div>
          <div className="note">
            Create a "Desktop app" OAuth client in Google Cloud Console with the Gmail API enabled. The loopback redirect is handled automatically.
          </div>
        </Conn>

        <Conn title="Slack" ok={s.slackMode !== 'none'} desc="Notifies the team when a request is processed.">
          <div className="field">
            <label className="label">Mode</label>
            <select className="select" value={s.slackMode} onChange={(e) => update({ slackMode: e.target.value as PublicSettings['slackMode'] })}>
              <option value="none">Not connected</option>
              <option value="bot">Bot token (chat.postMessage)</option>
              <option value="webhook">Incoming webhook</option>
            </select>
          </div>
          {s.slackMode === 'bot' && <SecretField label="Bot token" placeholder="xoxb-…" onSave={(v) => secret('slackToken', v)} />}
          {s.slackMode === 'webhook' && <SecretField label="Webhook URL" placeholder="https://hooks.slack.com/services/…" onSave={(v) => secret('slackWebhook', v)} />}
          <div className="field">
            <label className="label">Default channel</label>
            <TextField value={s.slackDefaultChannel} onSave={(v) => update({ slackDefaultChannel: v })} />
          </div>
          {s.slackMode !== 'none' && (
            <button className="btn sm" onClick={() => attempt(() => api.testSlack(), (m) => m)}>
              Send test message
            </button>
          )}
        </Conn>

        <Conn title="Acme CRM (local)" ok desc={`Mock CRM served at http://localhost:${s.crmPort}: a real web app to observe and automate.`}>
          <div className="field-row">
            <div>
              <div>Public REST API</div>
              <div className="note" style={{ marginTop: 0 }}>
                Turn off to force the engine down the ladder to browser automation.
              </div>
            </div>
            <Toggle checked={s.crmApiEnabled} onChange={(v) => update({ crmApiEnabled: v })} />
          </div>
          <button className="btn sm" onClick={() => api.openCrm()}>
            Open CRM in browser
          </button>
        </Conn>

        <Conn
          title="Automation browser"
          ok={status?.automationBrowser !== 'not started'}
          desc="A separate browser profile that replays learned web steps. Sign in to the sites your workflows use once; sessions are kept."
        >
          <div className="row">
            <button className="btn primary sm" onClick={() => attempt(() => api.openAutomationBrowser(), (b) => `Opened ${b}. Sign in to your apps there.`)}>
              Open automation browser
            </button>
            <span className="note" style={{ marginTop: 0 }}>
              {status?.automationBrowser}
            </span>
          </div>
          <div className="note">Uses Chrome, Edge or Brave if installed. Keep it signed in; closing it is fine.</div>
        </Conn>

        <Conn title="Browser extension" ok={status?.sensors.find((x) => x.name === 'Browser extension')?.detail?.includes('connected')} desc="Captures navigation, clicks, form submits and downloads with semantic labels.">
          <div className="params" style={{ gridTemplateColumns: '90px 1fr' }}>
            <div className="k">port</div>
            <div className="v">{s.bridgePort}</div>
            <div className="k">token</div>
            <div className="v" style={{ userSelect: 'all' }}>{s.bridgeToken}</div>
          </div>
          <ol className="note" style={{ paddingLeft: 18 }}>
            <li>
              Open <code>chrome://extensions</code> and turn on Developer mode.
            </li>
            <li>
              Choose "Load unpacked" and pick the <code>browser-extension</code> folder in this project.
            </li>
            <li>Open the extension popup and paste the token.</li>
          </ol>
        </Conn>

        <Conn title="Privacy" ok={s.observing} desc={s.observing ? 'Observing is on.' : 'Observing is paused.'}>
          <div className="field-row">
            <span>Observe activity</span>
            <Toggle checked={s.observing} onChange={(v) => update({ observing: v })} />
          </div>
          <div className="field-row">
            <div>
              <div>Record typed values (local only)</div>
              <div className="note" style={{ marginTop: 0 }}>
                Needed to replay form filling. Passwords and card fields are never recorded.
              </div>
            </div>
            <Toggle checked={s.recordValues} onChange={(v) => update({ recordValues: v })} />
          </div>
          <div className="field">
            <label className="label">Never observe these apps</label>
            <ListField value={s.appBlocklist} onSave={(v) => update({ appBlocklist: v })} />
          </div>
          <div className="field">
            <label className="label">Never observe URLs containing</label>
            <ListField value={s.urlBlocklist} onSave={(v) => update({ urlBlocklist: v })} />
          </div>
          <div className="field">
            <label className="label">Watched folders</label>
            <ListField value={s.watchFolders} onSave={(v) => update({ watchFolders: v })} />
          </div>
          <div className="row">
            <div className="field grow">
              <label className="label">Keep events (days)</label>
              <TextField value={String(s.retentionDays)} onSave={(v) => update({ retentionDays: Math.max(1, Number(v) || 14) })} />
            </div>
            <div className="field grow">
              <label className="label">Min. repetitions to propose</label>
              <TextField value={String(s.minSupport)} onSave={(v) => update({ minSupport: Math.max(2, Number(v) || 3) })} />
            </div>
          </div>
          <div className="note">Only step names, labels and redacted titles are sent to Gemini, never recorded values.</div>
        </Conn>
      </div>

      <div className="section-title">Data</div>
      <div className="card card-pad row" style={{ marginBottom: 12 }}>
        <div className="grow">
          <div>Load sample observations</div>
          <div className="note" style={{ marginTop: 0 }}>For presentations: five recorded runs of the Gmail → CRM → Slack routine.</div>
        </div>
        <button className="btn" onClick={() => attempt(() => api.loadDemo(), (r) => `Loaded ${r.events} events · ${r.patterns} pattern(s)`)}>
          Load sample data
        </button>
      </div>
      <div className="card card-pad row">
        <div className="grow">
          <div>Reset all observations, patterns, automations and runs</div>
          <div className="note" style={{ marginTop: 0 }}>Connections and settings are kept.</div>
        </div>
        <ResetButton />
      </div>
    </div>
  )
}

function Conn({ title, ok, desc, children }: { title: string; ok?: boolean; desc: string; children: ReactNode }) {
  return (
    <div className="card card-pad">
      <div className="conn-head">
        <span className={`dot ${ok ? 'running' : 'stopped'}`} />
        <h3>{title}</h3>
      </div>
      <div className="note" style={{ marginTop: -6, marginBottom: 14 }}>
        {desc}
      </div>
      {children}
    </div>
  )
}

function TextField({ value, placeholder, onSave }: { value: string; placeholder?: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value)
  return (
    <input
      className="input"
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onSave(v.trim())}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

function SecretField({ label, placeholder, onSave }: { label: string; placeholder: string; onSave: (v: string) => void }) {
  const [v, setV] = useState('')
  return (
    <div className="field">
      <label className="label">{label}</label>
      <div className="row">
        <input className="input" type="password" value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} />
        <button
          className="btn sm"
          disabled={!v}
          onClick={() => {
            onSave(v)
            setV('')
          }}
        >
          Save
        </button>
      </div>
    </div>
  )
}

function ListField({ value, onSave }: { value: string[]; onSave: (v: string[]) => void }) {
  const [v, setV] = useState(value.join('\n'))
  return (
    <textarea
      className="textarea"
      rows={3}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onSave(v.split('\n').map((x) => x.trim()).filter(Boolean))}
    />
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  )
}

function ResetButton() {
  const [armed, setArmed] = useState(false)
  return armed ? (
    <div className="row">
      <button className="btn ghost" onClick={() => setArmed(false)}>
        Keep data
      </button>
      <button
        className="btn signal"
        onClick={async () => {
          await attempt(() => api.resetData())
          setArmed(false)
          toast('All observations and automations cleared')
        }}
      >
        Yes, reset everything
      </button>
    </div>
  ) : (
    <button className="btn" onClick={() => setArmed(true)}>
      Reset data…
    </button>
  )
}
