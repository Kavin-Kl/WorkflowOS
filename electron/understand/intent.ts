import type { ActivityEvent, IntentSummary } from '../shared/types'
import type { MinedPattern } from '../discover/mine'
import { generateJson, geminiAvailable } from './gemini'
import { log } from '../core/bus'

const SYSTEM = `You are the workflow-understanding module of WorkFlowOS, a desktop agent that
learns repetitive work by observation. You receive a repeated sequence of abstract
UI steps plus redacted examples of the underlying events. Infer the business
intent behind the sequence — what the person is trying to accomplish — not a
description of the clicks. Name it as a short verb phrase in Title Case
(e.g. "Process Customer Request", "Log Expense Receipt"). Identify the
variables that change between occurrences (who, what, which file). Be honest
about confidence: lower it when examples are ambiguous.`

const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short Title Case verb phrase' },
    description: { type: 'string', description: 'One or two sentences on what the workflow accomplishes and why' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    variables: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'snake_case' },
          description: { type: 'string' },
          example: { type: 'string' },
        },
        required: ['name', 'description'],
      },
    },
  },
  required: ['name', 'description', 'confidence', 'variables'],
}

function describeEvent(e: ActivityEvent): string {
  const parts = [e.app, e.kind]
  if (e.target) parts.push(`target="${e.target}"`)
  if (e.title) parts.push(`title="${e.title}"`)
  if (e.url) {
    try {
      const u = new URL(e.url)
      parts.push(`path=${u.hostname}${u.pathname}`)
    } catch {
      /* ignore */
    }
  }
  if (e.data?.subject) parts.push(`subject="${e.data.subject}"`)
  if (e.data?.filename || e.data?.name) parts.push(`file="${e.data.filename ?? e.data.name}"`)
  return parts.join(' ')
}

export async function understandPattern(p: MinedPattern, eventsById: Map<string, ActivityEvent>): Promise<IntentSummary> {
  if (geminiAvailable()) {
    const examples = p.occurrences.slice(0, 3).map((occ, i) => {
      const lines = occ.eventIds
        .map((id) => eventsById.get(id))
        .filter((e): e is ActivityEvent => !!e)
        .slice(0, 25)
        .map(describeEvent)
      return `Example ${i + 1} (${Math.round((occ.end - occ.start) / 1000)}s):\n  ${lines.join('\n  ')}`
    })
    const prompt = `Repeated step sequence (seen ${p.support} times, avg ${Math.round(p.avgDurationMs / 1000)}s each):
${p.signature.map((s, i) => `${i + 1}. ${s}`).join('\n')}

${examples.join('\n\n')}`
    try {
      const out = await generateJson<Omit<IntentSummary, 'source'>>({ system: SYSTEM, prompt, schema: SCHEMA })
      return { ...out, confidence: Math.max(0, Math.min(1, out.confidence)), source: 'gemini' }
    } catch (err) {
      log('understand', `Gemini failed, using heuristic: ${(err as Error).message}`, 'warn')
    }
  }
  return heuristicIntent(p.signature)
}

/** Offline fallback so the loop still works without an API key. */
export function heuristicIntent(signature: string[]): IntentSummary {
  const has = (prefix: string) => signature.some((s) => s.startsWith(prefix))
  if (has('Gmail:open_email') && has('CRM:update_customer') && has('Slack:send_message')) {
    return {
      name: 'Process Customer Request',
      description:
        'A customer request arrives by email; its attachment and details are recorded on the customer in the CRM and the team is notified in Slack.',
      confidence: 0.7,
      variables: [
        { name: 'customer_email', description: 'Sender of the request email' },
        { name: 'customer_name', description: 'Customer as named in the CRM' },
        { name: 'request_summary', description: 'What the customer is asking for' },
        { name: 'attachment', description: 'File attached to the request' },
      ],
      source: 'heuristic',
    }
  }
  const apps = [...new Set(signature.map((s) => s.split(':')[0]))]
  return {
    name: `${apps.join(' → ')} Routine`,
    description: `A recurring sequence of ${signature.length} steps across ${apps.join(', ')}.`,
    confidence: 0.3,
    variables: [],
    source: 'heuristic',
  }
}
