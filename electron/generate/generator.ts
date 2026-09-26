import type { IntentSummary, WorkflowSpec, WorkflowStep } from '../shared/types'
import { ACTIONS, catalogForPrompt } from './catalog'
import { validateSpec, ALL_ACTION_IDS, type ValidationResult } from './validate'
import { generateJson, geminiAvailable } from '../understand/gemini'
import { log, newId } from '../core/bus'

const SYSTEM = `You are the workflow generator of WorkFlowOS. Convert an observed, repeated
human workflow into an executable automation using ONLY the triggers and actions
in the catalog. Rules:
- Pick the trigger that starts the observed sequence (an email being opened → gmail.new_email).
- One step per meaningful action; merge UI micro-steps (search, open, type, save) into one catalog action.
- Wire data between steps with {{namespace.key}} templates, using only outputs that
  the trigger or an EARLIER step provides.
- Use ai.extract when information must be read out of free text.
- Add guards for failure cases a careful human would check, e.g. customer not found
  → onFail "ask_user" with a clear message.
- Write Slack/CRM text the way the user would: concise, specific, includes the key facts.
- Gmail query: a precise Gmail search that matches only this kind of email.`

const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    trigger: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['gmail.new_email', 'manual'] },
        query: { type: 'string', description: 'Gmail search query for gmail.new_email' },
        description: { type: 'string' },
      },
      required: ['type', 'description'],
    },
    variables: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, description: { type: 'string' }, from: { type: 'string' } },
        required: ['name', 'description', 'from'],
      },
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ALL_ACTION_IDS },
          label: { type: 'string' },
          params: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'] },
          },
          guard: {
            type: 'object',
            properties: {
              var: { type: 'string' },
              op: { type: 'string', enum: ['exists', 'not_exists', 'truthy', 'falsy', 'equals', 'not_equals', 'contains'] },
              value: { type: 'string' },
              onFail: { type: 'string', enum: ['stop', 'ask_user'] },
              message: { type: 'string' },
            },
            required: ['var', 'op', 'onFail', 'message'],
          },
          onError: { type: 'string', enum: ['stop', 'ask_user', 'continue'] },
        },
        required: ['action', 'label', 'params', 'onError'],
      },
    },
  },
  required: ['name', 'description', 'trigger', 'variables', 'steps'],
}

interface GeminiSpec {
  name: string
  description: string
  trigger: { type: 'gmail.new_email' | 'manual'; query?: string; description: string }
  variables: { name: string; description: string; from: string }[]
  steps: {
    action: string
    label: string
    params: { name: string; value: string }[]
    guard?: { var: string; op: string; value?: string; onFail: 'stop' | 'ask_user'; message: string }
    onError: 'stop' | 'ask_user' | 'continue'
  }[]
}

export async function generateWorkflow(
  signature: string[],
  intent: IntentSummary,
  ctx: { slackChannel: string },
): Promise<ValidationResult> {
  if (geminiAvailable()) {
    try {
      const out = await generateJson<GeminiSpec>({
        system: SYSTEM,
        schema: SCHEMA,
        prompt: `${catalogForPrompt()}

OBSERVED WORKFLOW
Intent: ${intent.name} — ${intent.description}
Varying data: ${intent.variables.map((v) => v.name).join(', ') || 'unknown'}
Steps as observed:
${signature.map((s, i) => `${i + 1}. ${s}`).join('\n')}

The team's Slack channel seen in the observations is ${ctx.slackChannel}.`,
      })
      const spec: WorkflowSpec = {
        id: newId('wf'),
        name: out.name,
        intent: intent.name,
        description: out.description,
        trigger: {
          type: out.trigger.type,
          config: out.trigger.type === 'gmail.new_email' ? { query: out.trigger.query || 'is:unread' } : {},
          description: out.trigger.description,
        },
        variables: out.variables,
        steps: out.steps.map(
          (s, i): WorkflowStep => ({
            id: `s${i + 1}`,
            action: s.action,
            label: s.label,
            params: Object.fromEntries(s.params.map((p) => [p.name, p.value])),
            guard: s.guard
              ? { condition: { var: s.guard.var, op: s.guard.op as never, value: s.guard.value }, onFail: s.guard.onFail, message: s.guard.message }
              : undefined,
            onError: s.onError,
          }),
        ),
        integrations: [],
        generatedBy: 'gemini',
      }
      const result = validateSpec(spec)
      if (!result.errors.length) return result
      log('generate', `Gemini spec invalid (${result.errors.join('; ')}), using template`, 'warn')
    } catch (err) {
      log('generate', `Gemini failed, using template: ${(err as Error).message}`, 'warn')
    }
  }
  return validateSpec(templateSpec(signature, intent, ctx))
}

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
}

/** Deterministic mapping from observed step tokens to catalog actions. */
export function templateSpec(signature: string[], intent: IntentSummary, ctx: { slackChannel: string }): WorkflowSpec {
  const steps: WorkflowStep[] = []
  const startsWithEmail = signature[0]?.startsWith('Gmail:')
  for (const token of signature) {
    const def = ACTIONS.find((a) => a.covers.includes(token))
    if (!def || steps.some((s) => s.action === def.id)) continue
    const params = { ...DEFAULT_PARAMS[def.id] }
    if (def.id === 'slack.send_message') params.channel = ctx.slackChannel
    steps.push({ id: `s${steps.length + 1}`, action: def.id, label: labelFor(def.id), params, onError: 'ask_user' })
  }
  return {
    id: newId('wf'),
    name: intent.name,
    intent: intent.name,
    description: intent.description,
    trigger: startsWithEmail
      ? { type: 'gmail.new_email', config: { query: 'is:unread has:attachment newer_than:2d' }, description: 'New customer request received in Gmail' }
      : { type: 'manual', config: {}, description: 'Run manually' },
    variables: intent.variables.map((v) => ({ name: v.name, description: v.description, from: 'observed' })),
    steps,
    integrations: [],
    generatedBy: 'template',
  }
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
      'control.ask_user': 'Ask the user',
    }[action] ?? action
  )
}
