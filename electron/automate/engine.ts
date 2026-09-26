import type { MechanismAttempt, Run, StepResult, Workflow, WorkflowStep } from '../shared/types'
import { MECHANISM_PRIORITY } from '../shared/types'
import { getDb } from '../core/db'
import { bus, log, newId } from '../core/bus'
import { actionById } from '../generate/catalog'
import { orderLadder, recordOutcome } from '../learn/stats'
import { AskUser, executorsFor, type ExecContext } from './executors'
import { evaluate, interpolateParams, withOutputs, type Vars } from './vars'

const STEP_TIMEOUT_MS = 90_000

/** Resume bookkeeping lives in vars under keys the templates never use. */
const RESUME_AT = '__resumeAt'

export class AutomationEngine {
  constructor(private dataDir: string) {}

  async start(workflow: Workflow, triggerVars: Vars, trigger: string): Promise<Run> {
    const run: Run = {
      id: newId('run'),
      workflowId: workflow.id,
      status: 'running',
      trigger,
      startedAt: Date.now(),
      steps: [],
      vars: { ...triggerVars },
    }
    saveRun(run)
    log('engine', `▶ ${workflow.spec.name} (${trigger})`)
    return this.continueFrom(workflow, run, 0)
  }

  /** Resume a run paused for the user; `patch` lets them supply missing values. */
  async resume(workflow: Workflow, run: Run, mode: 'continue' | 'retry' | 'cancel', patch: Vars = {}): Promise<Run> {
    if (run.status !== 'waiting_user' && run.status !== 'failed') throw new Error('Run is not paused')
    if (mode === 'cancel') {
      run.status = 'stopped'
      run.message = 'Cancelled by user'
      run.finishedAt = Date.now()
      saveRun(run)
      return run
    }
    run.vars = { ...run.vars, ...patch }
    const at = Number(run.vars[RESUME_AT] ?? 0)
    const pausedIdx = run.steps.findIndex((s) => s.status === 'waiting_user' || s.status === 'failed')
    const from = mode === 'retry' && pausedIdx >= 0 ? pausedIdx : at
    run.steps = run.steps.slice(0, from)
    const paused = run.steps[pausedIdx]
    if (mode === 'continue' && paused) {
      paused.status = paused.outputs ? 'ok' : 'skipped'
      paused.message = `${paused.message ?? ''} — resolved by user`.trim()
    }
    run.status = 'running'
    run.message = undefined
    saveRun(run)
    return this.continueFrom(workflow, run, from)
  }

  private async continueFrom(workflow: Workflow, run: Run, from: number): Promise<Run> {
    const steps = workflow.spec.steps
    for (let i = from; i < steps.length; i++) {
      const step = steps[i]
      const result = await this.runStep(step, run)
      run.steps.push(result)

      if (result.status === 'ok' && result.outputs) {
        run.vars = withOutputs(run.vars, outputNamespace(step.action), result.outputs)
      }

      if (result.status === 'failed' || result.status === 'waiting_user') {
        const policy = result.status === 'waiting_user' ? 'ask_user' : step.onError
        if (policy === 'continue') {
          saveRun(run)
          continue
        }
        run.vars[RESUME_AT] = i + 1
        run.status = policy === 'ask_user' ? 'waiting_user' : 'failed'
        run.message = result.message
        if (policy === 'ask_user') result.status = 'waiting_user'
        return this.finish(run, policy === 'ask_user')
      }

      if (result.status === 'ok' && step.guard && !evaluate(step.guard.condition, run.vars)) {
        result.message = step.guard.message
        run.vars[RESUME_AT] = i + 1
        run.message = step.guard.message
        if (step.guard.onFail === 'ask_user') {
          result.status = 'waiting_user'
          run.status = 'waiting_user'
          return this.finish(run, true)
        }
        run.status = 'stopped'
        return this.finish(run, false)
      }
      saveRun(run)
    }
    run.status = 'succeeded'
    return this.finish(run, false)
  }

  private finish(run: Run, paused: boolean): Run {
    if (!paused) run.finishedAt = Date.now()
    saveRun(run)
    log('engine', `■ run ${run.id}: ${run.status}${run.message ? ` — ${run.message}` : ''}`, run.status === 'failed' ? 'warn' : 'info')
    return run
  }

  private async runStep(step: WorkflowStep, run: Run): Promise<StepResult> {
    const base: StepResult = { stepId: step.id, label: step.label, status: 'ok', attempts: [] }
    if (step.when && !evaluate(step.when, run.vars)) return { ...base, status: 'skipped', message: 'Condition not met' }

    const params = interpolateParams(step.params, run.vars)
    const ctx: ExecContext = { vars: run.vars, dataDir: this.dataDir, log: (m) => log('engine', m) }

    const executors = executorsFor(step.action)
    const order = orderLadder(
      step.action,
      MECHANISM_PRIORITY.filter((m) => executors.some((e) => e.mechanism === m)),
    )
    const attempts: MechanismAttempt[] = []
    for (const mech of order) {
      const ex = executors.find((e) => e.mechanism === mech)!
      const avail = ex.available(ctx)
      if (avail !== true) {
        attempts.push({ mechanism: mech, ok: false, error: `unavailable: ${avail}`, ms: 0 })
        continue
      }
      const t0 = Date.now()
      try {
        const outputs = await withTimeout(ex.execute(params, ctx), STEP_TIMEOUT_MS)
        const ms = Date.now() - t0
        attempts.push({ mechanism: mech, ok: true, ms })
        recordOutcome(step.action, mech, true, ms)
        return { ...base, mechanism: mech, attempts, outputs, message: ex.via }
      } catch (err) {
        if (err instanceof AskUser) return { ...base, status: 'waiting_user', attempts, message: err.message }
        const ms = Date.now() - t0
        const error = (err as Error).message.split('\n')[0].slice(0, 300)
        attempts.push({ mechanism: mech, ok: false, error, ms })
        recordOutcome(step.action, mech, false, ms)
        log('engine', `${step.action} via ${mech} failed: ${error}`, 'warn')
      }
    }
    const last = attempts.filter((a) => !a.error?.startsWith('unavailable')).pop() ?? attempts[attempts.length - 1]
    return { ...base, status: 'failed', attempts, message: last?.error ?? 'No mechanism can run this action' }
  }
}

function outputNamespace(action: string): string {
  const out = actionById.get(action)?.outputs[0]
  return out ? out.split('.')[0] : action.split('.')[0]
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timed out after ${ms / 1000}s`)), ms)
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    )
  })
}

// ---------- persistence ----------

export function saveRun(run: Run) {
  getDb()
    .prepare(
      'INSERT INTO runs (id, workflow_id, status, started_at, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, body = excluded.body',
    )
    .run(run.id, run.workflowId, run.status, run.startedAt, JSON.stringify(run))
  bus.emit('run', run)
}

export function getRun(id: string): Run | undefined {
  const row = getDb().prepare('SELECT body FROM runs WHERE id = ?').get(id) as { body: string } | undefined
  return row ? (JSON.parse(row.body) as Run) : undefined
}

export function listRuns(workflowId?: string, limit = 50): Run[] {
  const rows = (
    workflowId
      ? getDb().prepare('SELECT body FROM runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?').all(workflowId, limit)
      : getDb().prepare('SELECT body FROM runs ORDER BY started_at DESC LIMIT ?').all(limit)
  ) as { body: string }[]
  return rows.map((r) => JSON.parse(r.body) as Run)
}
