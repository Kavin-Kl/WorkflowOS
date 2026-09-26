import type { ActivityEvent, IntentSummary, PatternOccurrence, WorkflowSpec, WorkflowStep } from '../shared/types'
import { ACTIONS, TRIGGERS } from './catalog'
import { validateSpec, type ValidationResult } from './validate'
import { compileReplay } from './replay'
import { generateJson, geminiAvailable } from '../understand/gemini'
import { log, newId } from '../core/bus'

export interface GenerateContext {
  slackChannel: string
  occurrences?: PatternOccurrence[]
  eventsById?: Map<string, ActivityEvent>
}

/**
 * Generate a workflow in two stages:
 * 1. A deterministic draft: API/app actions for steps the catalog covers, and
 *    learned replay steps (web / desktop) for everything else. Every step is
 *    grounded in what was actually observed.
 * 2. Gemini refines the draft — names, trigger, message text, and which run
 *    inputs can be filled from trigger data — but cannot add or change steps.
 */
export async function generateWorkflow(signature: string[], intent: IntentSummary, ctx: GenerateContext): Promise<ValidationResult> {
  const draft = templateSpec(signature, intent, ctx)
  if (geminiAvailable()) {
    try {
      const refined = await refineWithGemini(draft, intent, signature)
      const result = validateSpec(refined)
      if (!result.errors.length) return result
      log('generate', `Gemini refinement invalid (${result.errors.join('; ')}), using draft`, 'warn')
    } catch (err) {
      log('generate', `Gemini refinement failed, using draft: ${(err as Error).message}`, 'warn')
    }
  }
  return validateSpec(draft)
}

// ---------- Stage 1: deterministic draft ----------

const DEFAULT_PARAMS: Record<string, Record<string, string>> = {
  'ai.extract': { input: '{{email.subject}}\n{{email.body}}', fields: 'customer_name, company, request_summary' },
  'gmail.download_attachment': { messageId: '{{email.messageId}}' },
  'gmail.reply': { messageId: '{{email.messageId}}', text: 'Thanks, we have received your request and are on it.' },
  'crm.find_customer': { email: '{{email.fromAddress}}', name: '{{extract.customer_name}}' },
  'crm.update_customer': {
    customerId: '{{customer.id}}',
    note: 'Request via email: {{email.subject}}\n{{extract.request_summary}}',
    attachmentPath: '{{attachment.path}}',
  },
  'slack.send_message': {
    channel: '',
    text: ':inbox_tray: New request from *{{customer.name}}* ({{customer.company}})\n>{{extract.request_summary}}\nCRM: {{customer.url}}',
  },
  'excel.append_row': { file: '', values: '{{input.row_values}}' },
}

function labelFor(action: string): string {
  return (
    {
      'ai.extract': 'Read the email and identify the customer',
      'gmail.download_attachment': 'Download the attachment',
      'gmail.reply': 'Reply to the customer',
      'crm.find_customer': 'Find the customer in the CRM',
      'crm.update_customer': 'Update the customer record with the request and attachment',
      'slack.send_message': 'Notify the team in Slack',
      'excel.append_row': 'Add a row to the spreadsheet',
      'control.ask_user': 'Ask the user',
    }[action] ?? action
  )
}

export function templateSpec(signature: string[], intent: IntentSummary, ctx: GenerateContext): WorkflowSpec {
  const startsWithEmail = signature[0] === 'Gmail:open_email' || signature[0] === 'Gmail:download_attachment'
  // API actions for Gmail/CRM/Slack are wired to email data; without an email
  // trigger those steps are replayed as observed instead.
  const coveringAction = (token: string) => {
    const def = ACTIONS.find((a) => a.covers.includes(token))
    return def && (startsWithEmail || def.integration === 'excel') ? def : undefined
  }
  const replay = ctx.occurrences && ctx.eventsById ? compileReplay(signature, ctx.occurrences, ctx.eventsById, (t) => !!coveringAction(t)) : new Map()
  const steps: WorkflowStep[] = []
  const variables: WorkflowSpec['variables'] = []
  const used = new Set<string>()

  signature.forEach((token, i) => {
    const def = coveringAction(token)
    if (def) {
      if (used.has(def.id)) return
      used.add(def.id)
      const params = { ...DEFAULT_PARAMS[def.id] }
      if (def.id === 'slack.send_message') params.channel = ctx.slackChannel
      if (def.id === 'excel.append_row') {
        params.file = observedFile(i, ctx) ?? ''
        variables.push({ name: 'row_values', description: 'Row values, separated by " | "', from: 'input' })
      }
      steps.push({ id: '', action: def.id, label: labelFor(def.id), params, onError: 'ask_user' })
      return
    }
    const compiled = replay.get(i)
    if (!compiled) return
    for (const s of compiled.steps) steps.push({ id: '', ...s })
    variables.push(...compiled.variables)
  })

  // Email-driven workflows without an extraction step still need the email read.
  if (startsWithEmail && !used.has('ai.extract') && steps.some((s) => Object.values(s.params).some((v) => v.includes('extract.')))) {
    steps.unshift({ id: '', action: 'ai.extract', label: labelFor('ai.extract'), params: { ...DEFAULT_PARAMS['ai.extract'] }, onError: 'ask_user' })
  }

  // Opening a page as the very last step does nothing useful.
  while (steps.length && steps[steps.length - 1].action === 'web.open') steps.pop()

  return {
    id: newId('wf'),
    name: intent.name,
    intent: intent.name,
    description: intent.description,
    trigger: startsWithEmail
      ? { type: 'gmail.new_email', config: { query: 'is:unread has:attachment newer_than:2d' }, description: 'New matching email in Gmail' }
      : { type: 'manual', config: {}, description: 'Run on demand' },
    variables,
    steps: steps.map((s, i) => ({ ...s, id: `s${i + 1}` })),
    integrations: [],
    generatedBy: 'template',
  }
}

function observedFile(i: number, ctx: GenerateContext): string | undefined {
  for (const occ of [...(ctx.occurrences ?? [])].reverse()) {
    for (const id of occ.steps?.[i] ?? []) {
      const p = ctx.eventsById?.get(id)?.path
      if (p) return p
    }
  }
  return undefined
}

// ---------- Stage 2: Gemini refinement ----------

const REFINE_SYSTEM = `You refine a workflow that WorkFlowOS compiled from observing a user.
The steps are fixed: they replay exactly what the user did. You may only:
- name the workflow and describe it,
- choose the trigger (gmail.new_email with a precise Gmail query, schedule with a daily "HH:MM", or manual),
- rewrite step labels to be clear to a non-technical user,
- rewrite free-text params (Slack message text, CRM note, reply text, extraction fields),
- map each run input to trigger data when it obviously comes from it
  (e.g. an input labelled "Customer email" ← "{{email.fromAddress}}"), otherwise keep "input".
Never invent data sources that are not listed as available.`

const REFINE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    trigger: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['gmail.new_email', 'schedule', 'manual'] },
        query: { type: 'string' },
        time: { type: 'string', description: 'HH:MM, for schedule' },
        description: { type: 'string' },
      },
      required: ['type', 'description'],
    },
    stepLabels: { type: 'array', items: { type: 'string' } },
    textParams: {
      type: 'array',
      items: {
        type: 'object',
        properties: { step: { type: 'integer' }, name: { type: 'string' }, value: { type: 'string' } },
        required: ['step', 'name', 'value'],
      },
    },
    inputs: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, from: { type: 'string', description: '"input" or a {{template}}' }, description: { type: 'string' } },
        required: ['name', 'from', 'description'],
      },
    },
  },
  required: ['name', 'description', 'trigger', 'stepLabels', 'textParams', 'inputs'],
}

const TEXT_PARAMS: Record<string, string[]> = {
  'slack.send_message': ['text', 'channel'],
  'crm.update_customer': ['note'],
  'gmail.reply': ['text'],
  'ai.extract': ['fields'],
}

interface Refinement {
  name: string
  description: string
  trigger: { type: 'gmail.new_email' | 'schedule' | 'manual'; query?: string; time?: string; description: string }
  stepLabels: string[]
  textParams: { step: number; name: string; value: string }[]
  inputs: { name: string; from: string; description: string }[]
}

async function refineWithGemini(draft: WorkflowSpec, intent: IntentSummary, signature: string[]): Promise<WorkflowSpec> {
  const gmail = TRIGGERS.find((t) => t.type === 'gmail.new_email')!.outputs
  // Only structure goes to Gemini: labels and param templates, never recorded values.
  const stepsForPrompt = draft.steps.map((s, i) => ({
    step: i,
    action: s.action,
    label: s.label,
    params: Object.fromEntries(
      Object.entries(s.params).map(([k, v]) => [k, s.action.startsWith('web.') || s.action.startsWith('desktop.') ? (v.includes('{{') ? v : k === 'value' ? '<recorded constant>' : v) : v]),
    ),
  }))
  const out = await generateJson<Refinement>({
    system: REFINE_SYSTEM,
    schema: REFINE_SCHEMA,
    prompt: `Intent: ${intent.name} — ${intent.description}
Observed step sequence: ${signature.join(' → ')}

Draft trigger: ${JSON.stringify(draft.trigger)}
Draft steps:
${JSON.stringify(stepsForPrompt, null, 1)}

Run inputs (values that differed between observations):
${JSON.stringify(draft.variables.map((v) => ({ name: v.name, description: v.description, from: v.from })))}

Data available if the trigger is gmail.new_email: ${gmail.join(', ')}
Other data available: outputs of earlier steps (extract.*, customer.*, attachment.*).`,
  })

  const spec: WorkflowSpec = structuredClone(draft)
  spec.name = out.name || spec.name
  spec.description = out.description || spec.description
  spec.generatedBy = 'gemini'
  if (out.trigger.type === 'gmail.new_email') {
    spec.trigger = { type: 'gmail.new_email', config: { query: out.trigger.query || 'is:unread' }, description: out.trigger.description }
  } else if (out.trigger.type === 'schedule' && /^\d{1,2}:\d{2}$/.test(out.trigger.time ?? '')) {
    spec.trigger = { type: 'schedule', config: { time: out.trigger.time! }, description: out.trigger.description }
  } else if (out.trigger.type === 'manual') {
    spec.trigger = { type: 'manual', config: {}, description: out.trigger.description }
  }
  out.stepLabels.forEach((label, i) => {
    if (spec.steps[i] && label) spec.steps[i].label = label
  })
  for (const tp of out.textParams) {
    const step = spec.steps[tp.step]
    if (step && TEXT_PARAMS[step.action]?.includes(tp.name)) step.params[tp.name] = tp.value
  }
  for (const inp of out.inputs) {
    const v = spec.variables.find((x) => x.name === inp.name)
    if (!v) continue
    v.description = inp.description || v.description
    if (inp.from === 'input' || /^\{\{\s*[\w.]+\s*\}\}$/.test(inp.from.trim())) v.from = inp.from.trim()
  }
  return spec
}
