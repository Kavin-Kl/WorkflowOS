import type { Condition, ConditionOp, WorkflowSpec, WorkflowStep } from '../shared/types'
import { ACTIONS, TRIGGERS, actionById } from './catalog'

const OPS: ConditionOp[] = ['exists', 'not_exists', 'truthy', 'falsy', 'equals', 'not_equals', 'contains']
const TEMPLATE = /\{\{\s*([\w.]+)\s*\}\}/g

export interface ValidationResult {
  spec: WorkflowSpec
  warnings: string[]
  errors: string[]
}

function outputsProvide(outputs: string[], v: string): boolean {
  return outputs.some((o) => o === v || (o.endsWith('.*') && v.startsWith(o.slice(0, -1))))
}

function validCondition(c: Condition | undefined): c is Condition {
  return !!c && typeof c.var === 'string' && OPS.includes(c.op)
}

/**
 * Enforce the catalog on a generated spec: unknown actions are dropped, params
 * are restricted to declared ones, variable references are checked against
 * what earlier steps actually produce, and safety guards are ensured.
 */
export function validateSpec(input: WorkflowSpec): ValidationResult {
  const warnings: string[] = []
  const errors: string[] = []
  const spec: WorkflowSpec = structuredClone(input)

  const trig = TRIGGERS.find((t) => t.type === spec.trigger?.type)
  if (!trig) {
    warnings.push(`Unknown trigger "${spec.trigger?.type}", using manual`)
    spec.trigger = { type: 'manual', config: {}, description: 'Run manually' }
  }
  spec.trigger.config ??= {}
  const available: string[] = [...(trig ?? TRIGGERS.find((t) => t.type === 'manual')!).outputs]

  const steps: WorkflowStep[] = []
  for (const raw of spec.steps ?? []) {
    const def = actionById.get(raw.action)
    if (!def) {
      warnings.push(`Dropped step "${raw.label}": unknown action ${raw.action}`)
      continue
    }
    const params: Record<string, string> = {}
    for (const p of def.params) {
      const v = raw.params?.[p.name]
      if (v !== undefined && v !== '') params[p.name] = String(v)
      else if (p.required) errors.push(`Step "${raw.label}" is missing required param ${p.name}`)
    }
    for (const v of Object.values(params)) {
      for (const m of v.matchAll(TEMPLATE)) {
        if (!outputsProvide(available, m[1])) warnings.push(`Step "${raw.label}" references {{${m[1]}}} before it is produced`)
      }
    }
    const step: WorkflowStep = {
      id: `s${steps.length + 1}`,
      action: def.id,
      label: raw.label || def.description,
      params,
      onError: raw.onError === 'continue' || raw.onError === 'stop' ? raw.onError : 'ask_user',
    }
    if (validCondition(raw.when)) step.when = raw.when
    if (raw.guard && validCondition(raw.guard.condition)) {
      step.guard = { condition: raw.guard.condition, onFail: raw.guard.onFail === 'stop' ? 'stop' : 'ask_user', message: raw.guard.message || 'Condition not met' }
    }
    // The customer lookup must never silently fall through to an update.
    if (def.id === 'crm.find_customer' && !step.guard) {
      step.guard = {
        condition: { var: 'customer.found', op: 'truthy' },
        onFail: 'ask_user',
        message: 'Customer not found in the CRM. Please locate or create the customer, then resume.',
      }
      warnings.push('Added guard: stop and ask the user if the customer cannot be found')
    }
    steps.push(step)
    available.push(...def.outputs)
  }
  if (!steps.length) errors.push('Workflow has no executable steps')

  spec.steps = steps
  spec.integrations = [...new Set(steps.map((s) => actionById.get(s.action)!.integration).filter((i) => i !== 'control'))]
  spec.variables = (spec.variables ?? []).filter((v) => v && v.name)
  return { spec, warnings, errors }
}

export const ALL_ACTION_IDS = ACTIONS.map((a) => a.id)
