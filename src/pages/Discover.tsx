import { useState } from 'react'
import { api, fmtAgo, fmtDuration, useLive } from '../api'
import type { Pattern } from '../../electron/shared/types'
import { StepChain } from '../components/Steps'
import { attempt } from '../components/Toast'
import type { Page } from '../App'

const STATUS_BADGE: Record<string, string> = { candidate: '', proposed: 'signal', approved: 'ok', dismissed: '' }

export default function Discover({ openWorkflow, go }: { openWorkflow: (id: string) => void; go: (p: Page) => void }) {
  const [patterns] = useLive<Pattern[]>(() => api.listPatterns(), ['pattern'], [])
  const [busy, setBusy] = useState(false)

  const run = async () => {
    setBusy(true)
    await attempt(() => api.runDiscovery(), (r) => `${r.patterns} pattern${r.patterns === 1 ? '' : 's'} · ${r.proposed} new proposal${r.proposed === 1 ? '' : 's'}`)
    setBusy(false)
  }

  const visible = patterns.filter((p) => p.status !== 'dismissed')

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="kicker">02 · Discover &amp; understand</div>
          <h1>Work you keep repeating</h1>
          <p>
            Events are grouped into tasks and mined for repeated cross-app sequences, scored by frequency, time spent and
            app hand-offs. Gemini then names the intent behind each one.
          </p>
        </div>
        <div className="actions">
          <button className="btn" onClick={run} disabled={busy}>
            {busy ? 'Mining…' : 'Run discovery now'}
          </button>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="card empty">
          <h3>No repeated workflows yet</h3>
          <p>A sequence needs to happen at least a few times before it shows up here.</p>
          <button className="btn" onClick={() => go('observe')}>
            Go to Observe
          </button>
        </div>
      ) : (
        <div className="stack">
          {visible.map((p) => (
            <div key={p.id} className="card pattern">
              <div>
                <div className="row">
                  <h3>{p.intent?.name ?? 'Unnamed pattern'}</h3>
                  <span className={`badge ${STATUS_BADGE[p.status]}`}>{p.status}</span>
                  {p.intent && (
                    <span className="badge" title={`Understood by ${p.intent.source}`}>
                      {p.intent.source}
                    </span>
                  )}
                </div>
                <div className="meta">
                  <span>
                    <b>{p.support}×</b> observed
                  </span>
                  <span>~{fmtDuration(p.avgDurationMs)} each</span>
                  <span>{p.apps.join(' → ')}</span>
                  <span>last {fmtAgo(p.lastSeen)}</span>
                  {p.intent && (
                    <span title="Intent confidence">
                      confidence <span className="confidence"><i style={{ width: `${Math.round(p.intent.confidence * 100)}%` }} /></span>
                    </span>
                  )}
                </div>
                {p.intent?.description && <p style={{ margin: '8px 0 0', color: 'var(--ink-2)' }}>{p.intent.description}</p>}
              </div>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                {p.workflowId && (
                  <button className={`btn ${p.status === 'proposed' ? 'signal' : ''}`} onClick={() => openWorkflow(p.workflowId!)}>
                    {p.status === 'proposed' ? 'Review automation' : 'Open automation'}
                  </button>
                )}
              </div>
              <StepChain signature={p.signature} />
              {p.intent && p.intent.variables.length > 0 && (
                <div className="row" style={{ gridColumn: '1 / -1', flexWrap: 'wrap' }}>
                  <span className="muted" style={{ fontSize: 12 }}>
                    Changes each time:
                  </span>
                  {p.intent.variables.map((v) => (
                    <span key={v.name} className="badge info" title={v.description}>
                      {v.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
