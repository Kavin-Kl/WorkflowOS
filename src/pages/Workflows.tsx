import { useEffect, useMemo, useState } from 'react'
import { api, fmtAgo, fmtDuration, useLive } from '../api'
import type { ActionInfo } from '../../electron/shared/api'
import type { MechanismStat, Pattern, PublicSettings, Run, Workflow, WorkflowSpec } from '../../electron/shared/types'
import { Ladder, mechLabel } from '../components/Steps'
import { attempt, toast } from '../components/Toast'

const WF_BADGE: Record<string, string> = { proposed: 'signal', active: 'ok', paused: 'warn', dismissed: '' }
const RUN_BADGE: Record<string, string> = { running: 'info', succeeded: 'ok', failed: 'bad', waiting_user: 'warn', stopped: '' }
const STEP_ICON: Record<string, string> = { ok: '✓', skipped: '–', failed: '✕', waiting_user: '!' }

export default function Workflows({ focus, onFocus }: { focus: string | null; onFocus: (id: string) => void }) {
  const [workflows] = useLive<Workflow[]>(() => api.listWorkflows(), ['workflow'], [])
  const visible = workflows
    .filter((w) => w.status !== 'dismissed')
    .sort((a, b) => order(a.status) - order(b.status) || b.createdAt - a.createdAt)
  const selected = visible.find((w) => w.id === focus) ?? visible[0]

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="kicker">03 · Generate, approve, automate</div>
          <h1>Automations</h1>
          <p>
            Each discovered workflow becomes a trigger, steps, conditions and variables. Nothing runs until you approve it.
            Each step uses the most reliable mechanism available: API → App → Accessibility → Browser → Vision.
          </p>
        </div>
      </div>
      {visible.length === 0 ? (
        <div className="card empty">
          <h3>No automations yet</h3>
          <p>When discovery finds a repeated workflow, a proposed automation appears here for review.</p>
        </div>
      ) : (
        <div className="wf-layout">
          <div className="wf-list">
            {visible.map((w) => (
              <button key={w.id} className={`wf-item ${selected?.id === w.id ? 'on' : ''}`} onClick={() => onFocus(w.id)}>
                <div className="row">
                  <span className="n grow">{w.spec.name}</span>
                </div>
                <div className="row" style={{ marginTop: 4 }}>
                  <span className={`badge ${WF_BADGE[w.status]}`}>{w.status}</span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {w.spec.steps.length} steps · {w.spec.integrations.join(', ')}
                  </span>
                </div>
              </button>
            ))}
          </div>
          {selected && <WorkflowDetail key={selected.id} wf={selected} />}
        </div>
      )}
    </div>
  )
}

function order(s: string) {
  return { proposed: 0, active: 1, paused: 2, dismissed: 3 }[s] ?? 4
}

function WorkflowDetail({ wf }: { wf: Workflow }) {
  const [catalog, setCatalog] = useState<ActionInfo[]>([])
  const [stats] = useLive<MechanismStat[]>(() => api.mechanismStats(), ['run'], [])
  const [runs] = useLive<Run[]>(() => api.listRuns(wf.id), ['run'], [])
  const [patterns] = useLive<Pattern[]>(() => api.listPatterns(), ['pattern'], [])
  const [settings] = useLive<PublicSettings | null>(() => api.getSettings(), ['status'], null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<WorkflowSpec>(wf.spec)
  const [warnings, setWarnings] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    api.actionCatalog().then(setCatalog)
  }, [])
  useEffect(() => setDraft(wf.spec), [wf.spec])

  const byAction = useMemo(() => new Map(catalog.map((a) => [a.id, a])), [catalog])
  const pattern = patterns.find((p) => p.id === wf.patternId)
  const succeeded = runs.filter((r) => r.status === 'succeeded').length
  const spec = editing ? draft : wf.spec

  const act = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(label)
    await attempt(fn, ok)
    setBusy(null)
  }

  const save = async () => {
    const r = await attempt(() => api.updateWorkflowSpec(wf.id, draft))
    if (!r) return
    setWarnings(r.warnings)
    if (r.errors.length) toast(r.errors.join('; '), true)
    else {
      setEditing(false)
      toast('Workflow saved')
    }
  }

  const setParam = (stepIdx: number, name: string, value: string) =>
    setDraft((d) => ({ ...d, steps: d.steps.map((s, i) => (i === stepIdx ? { ...s, params: { ...s.params, [name]: value } } : s)) }))

  const needsGmail = wf.spec.trigger.type === 'gmail.new_email' && !settings?.gmailConnected

  return (
    <div>
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="row">
          <h2 style={{ fontFamily: 'var(--serif)', fontWeight: 500, fontSize: 24, margin: 0 }} className="grow">
            {spec.name}
          </h2>
          <span className={`badge ${WF_BADGE[wf.status]}`}>{wf.status}</span>
          <span className="badge" title="How this workflow was generated">
            {wf.spec.generatedBy}
          </span>
        </div>
        <p style={{ margin: '6px 0 0', color: 'var(--ink-2)' }}>{spec.description}</p>
        <div className="row" style={{ marginTop: 12, gap: 16, fontSize: 12, color: 'var(--mute)', flexWrap: 'wrap' }}>
          {pattern && (
            <span>
              Learned from <b>{pattern.support}</b> observations (~{fmtDuration(pattern.avgDurationMs)} each)
            </span>
          )}
          <span>
            <b>{succeeded}</b> successful runs
          </span>
          {pattern && succeeded > 0 && <span>≈ {fmtDuration(pattern.avgDurationMs * succeeded)} of manual work saved</span>}
          {pattern && wf.approvedAt && pattern.lastSeen > wf.approvedAt && (
            <span className="badge warn">still done manually since approval — check the trigger</span>
          )}
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="warnings">
          {warnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      )}

      <div className="row" style={{ marginBottom: 12 }}>
        <div className="section-title grow" style={{ margin: 0 }}>
          Workflow
        </div>
        {editing ? (
          <>
            <button className="btn ghost" onClick={() => (setEditing(false), setDraft(wf.spec))}>
              Cancel
            </button>
            <button className="btn primary" onClick={save}>
              Save changes
            </button>
          </>
        ) : (
          <button className="btn" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>

      <div className="pipeline">
        <div className="node trigger">
          <div className="pin">⚡</div>
          <div className="card body">
            <div className="title">
              <span className="kicker">Trigger</span>
              <strong>{spec.trigger.description}</strong>
            </div>
            {spec.trigger.type === 'gmail.new_email' && (
              <div className="params">
                <div className="k">gmail query</div>
                {editing ? (
                  <input
                    className="input mono"
                    value={draft.trigger.config.query ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, trigger: { ...d.trigger, config: { ...d.trigger.config, query: e.target.value } } }))}
                  />
                ) : (
                  <div className="v">{spec.trigger.config.query}</div>
                )}
              </div>
            )}
          </div>
        </div>

        {spec.steps.map((s, i) => {
          const info = byAction.get(s.action)
          return (
            <div className="node" key={s.id}>
              <div className="pin">{i + 1}</div>
              <div className="card body">
                <div className="title">
                  <strong className="grow">{s.label}</strong>
                  <span className="badge mono">{s.action}</span>
                </div>
                <div className="params">
                  {Object.entries(s.params).map(([k, v]) => (
                    <FragmentParam key={k} k={k} v={v} editing={editing} onChange={(val) => setParam(i, k, val)} />
                  ))}
                </div>
                {s.guard && (
                  <div className="guard">
                    If <code>{s.guard.condition.var}</code> is not {s.guard.condition.op.replace('_', ' ')}
                    {s.guard.condition.value ? ` "${s.guard.condition.value}"` : ''} → {s.guard.onFail === 'ask_user' ? 'pause and ask you' : 'stop'}:{' '}
                    {s.guard.message}
                  </div>
                )}
                {info && <Ladder rungs={info.ladder} stats={stats} action={s.action} />}
              </div>
            </div>
          )
        })}
      </div>

      {wf.status === 'proposed' ? (
        <div className="approve-bar">
          <div className="grow">
            <b>Automate this?</b>{' '}
            <span style={{ opacity: 0.7 }}>
              {needsGmail ? 'Connect Gmail in Settings so the trigger can fire. You can still test it with a sample email.' : 'It will run for every new email matching the trigger.'}
            </span>
          </div>
          <button className="btn" disabled={!!busy} onClick={() => act('test', () => api.runWorkflow(wf.id, 'sample'))}>
            Test with sample email
          </button>
          <button className="btn" disabled={!!busy} onClick={() => act('dismiss', () => api.dismissWorkflow(wf.id), 'Dismissed')}>
            Dismiss
          </button>
          <button className="btn signal" disabled={!!busy || editing} onClick={() => act('approve', () => api.approveWorkflow(wf.id), 'Automation approved and active')}>
            Approve &amp; activate
          </button>
        </div>
      ) : (
        <div className="row" style={{ marginTop: 16, flexWrap: 'wrap' }}>
          <button className="btn" disabled={!!busy} onClick={() => act('sample', () => api.runWorkflow(wf.id, 'sample'))}>
            Test: sample email
          </button>
          <button className="btn" disabled={!!busy} onClick={() => act('missing', () => api.runWorkflow(wf.id, 'sample_missing'))}>
            Test: unknown customer
          </button>
          {wf.spec.trigger.type === 'gmail.new_email' && (
            <button className="btn" disabled={!!busy || needsGmail} onClick={() => act('latest', () => api.runWorkflow(wf.id, 'latest_email'))}>
              Run on latest matching email
            </button>
          )}
          <span className="grow" />
          <button className="btn" onClick={() => act('status', () => api.setWorkflowStatus(wf.id, wf.status === 'active' ? 'paused' : 'active'))}>
            {wf.status === 'active' ? 'Pause' : 'Activate'}
          </button>
        </div>
      )}
      {busy && <div className="note">Working… {busy === 'approve' ? 'activating trigger' : 'running'}</div>}

      <div className="section-title">Runs</div>
      <div className="card">
        {runs.length === 0 ? (
          <div className="empty" style={{ padding: 28 }}>
            No runs yet. Test with a sample email to watch each step choose its mechanism.
          </div>
        ) : (
          runs.map((r) => <RunView key={r.id} run={r} wf={wf} byAction={byAction} />)
        )}
      </div>
    </div>
  )
}

function FragmentParam({ k, v, editing, onChange }: { k: string; v: string; editing: boolean; onChange: (v: string) => void }) {
  return (
    <>
      <div className="k">{k}</div>
      {editing ? (
        <textarea className="textarea" rows={Math.min(5, v.split('\n').length + 1)} value={v} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <div className="v">{v}</div>
      )}
    </>
  )
}

function RunView({ run, wf, byAction }: { run: Run; wf: Workflow; byAction: Map<string, ActionInfo> }) {
  const [customerId, setCustomerId] = useState('')
  const [open, setOpen] = useState(run.status !== 'succeeded')
  const resume = (mode: 'continue' | 'retry' | 'cancel') =>
    attempt(() => api.resumeRun(run.id, mode, customerId ? { 'customer.id': customerId } : {}))
  const pausedOnCustomer = run.status === 'waiting_user' && /customer/i.test(run.message ?? '')

  return (
    <div className="run">
      <div className="row" style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        <span className={`badge ${RUN_BADGE[run.status]}`}>{run.status.replace('_', ' ')}</span>
        <span className="grow">{run.trigger}</span>
        <span className="muted mono">{fmtAgo(run.startedAt)}</span>
        {run.finishedAt && <span className="muted mono">{fmtDuration(run.finishedAt - run.startedAt)}</span>}
      </div>
      {open && (
        <>
          <div className="run-steps">
            {run.steps.map((s) => {
              const step = wf.spec.steps.find((x) => x.id === s.stepId)
              const info = step && byAction.get(step.action)
              return (
                <div className="run-step" key={s.stepId}>
                  <span className="ico" style={{ color: s.status === 'ok' ? 'var(--ok)' : s.status === 'failed' ? 'var(--bad)' : 'var(--warn)' }}>
                    {STEP_ICON[s.status]}
                  </span>
                  <div>
                    <div>{s.label}</div>
                    {s.message && <div className="muted" style={{ fontSize: 12 }}>{s.message}</div>}
                    {info && s.attempts.length > 0 && <Ladder rungs={info.ladder} attempts={s.attempts} action={info.id} />}
                  </div>
                  <span className="muted mono">
                    {s.mechanism ? `${mechLabel(s.mechanism)} · ${s.attempts.find((a) => a.ok)?.ms ?? 0}ms` : ''}
                  </span>
                </div>
              )
            })}
          </div>
          {run.status === 'waiting_user' && (
            <div className="waiting">
              <div style={{ marginBottom: 8 }}>
                <b>Needs you:</b> {run.message}
              </div>
              <div className="row">
                {pausedOnCustomer && (
                  <input className="input" style={{ maxWidth: 260 }} placeholder="CRM customer id (e.g. c_1001)" value={customerId} onChange={(e) => setCustomerId(e.target.value)} />
                )}
                <button className="btn primary sm" onClick={() => resume('continue')} disabled={pausedOnCustomer && !customerId}>
                  Continue
                </button>
                <button className="btn sm" onClick={() => resume('retry')}>
                  Retry step
                </button>
                <button className="btn ghost sm" onClick={() => resume('cancel')}>
                  Cancel run
                </button>
                {pausedOnCustomer && (
                  <button className="btn ghost sm" onClick={() => api.openCrm()}>
                    Open CRM
                  </button>
                )}
              </div>
            </div>
          )}
          {run.status === 'failed' && (
            <div className="row" style={{ marginTop: 10 }}>
              <span className="muted grow" style={{ fontSize: 12 }}>{run.message}</span>
              <button className="btn sm" onClick={() => resume('retry')}>
                Retry failed step
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
