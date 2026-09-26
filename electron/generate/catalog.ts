import type { TriggerType } from '../shared/types'

export interface ActionDef {
  id: string
  integration: 'gmail' | 'crm' | 'slack' | 'ai' | 'control'
  description: string
  params: { name: string; description: string; required: boolean }[]
  /** Variables this action writes, as "namespace.key". */
  outputs: string[]
  /** Step tokens from discovery that this action replaces. */
  covers: string[]
}

export const ACTIONS: ActionDef[] = [
  {
    id: 'ai.extract',
    integration: 'ai',
    description:
      'Read unstructured text (e.g. the email body) and extract named fields. Outputs are written as extract.<field>.',
    params: [
      { name: 'input', description: 'Text to read, usually "{{email.subject}}\\n{{email.body}}"', required: true },
      { name: 'fields', description: 'Comma-separated field names, e.g. "customer_name, customer_email, request_summary"', required: true },
    ],
    outputs: ['extract.*'],
    covers: ['Gmail:open_email'],
  },
  {
    id: 'gmail.download_attachment',
    integration: 'gmail',
    description: 'Download the first (or matching) attachment of the trigger email to a local folder.',
    params: [
      { name: 'messageId', description: 'Usually "{{email.messageId}}"', required: true },
      { name: 'filenameContains', description: 'Optional filter on the attachment filename', required: false },
    ],
    outputs: ['attachment.path', 'attachment.name', 'attachment.found'],
    covers: ['Gmail:download_attachment'],
  },
  {
    id: 'gmail.reply',
    integration: 'gmail',
    description: 'Reply to the trigger email thread.',
    params: [
      { name: 'messageId', description: 'Usually "{{email.messageId}}"', required: true },
      { name: 'text', description: 'Reply body', required: true },
    ],
    outputs: ['reply.id'],
    covers: ['Gmail:reply', 'Gmail:send_email'],
  },
  {
    id: 'crm.find_customer',
    integration: 'crm',
    description: 'Look up a customer in the CRM by email (preferred) or name.',
    params: [
      { name: 'email', description: 'Customer email, e.g. "{{email.fromAddress}}"', required: false },
      { name: 'name', description: 'Customer name fallback', required: false },
    ],
    outputs: ['customer.id', 'customer.name', 'customer.company', 'customer.url', 'customer.found'],
    covers: ['CRM:search_customer', 'CRM:open_customer'],
  },
  {
    id: 'crm.update_customer',
    integration: 'crm',
    description: 'Add a request note (and optional attachment) to a customer record.',
    params: [
      { name: 'customerId', description: 'Usually "{{customer.id}}"', required: true },
      { name: 'note', description: 'Note text with the request details', required: true },
      { name: 'attachmentPath', description: 'Optional local file path, e.g. "{{attachment.path}}"', required: false },
    ],
    outputs: ['crm.noteId'],
    covers: ['CRM:edit_record', 'CRM:attach_file', 'CRM:update_customer'],
  },
  {
    id: 'slack.send_message',
    integration: 'slack',
    description: 'Post a message to a Slack channel.',
    params: [
      { name: 'channel', description: 'Channel name like "#support"', required: true },
      { name: 'text', description: 'Message text (Slack mrkdwn)', required: true },
    ],
    outputs: ['slack.ts'],
    covers: ['Slack:open_channel', 'Slack:compose_message', 'Slack:send_message'],
  },
  {
    id: 'control.ask_user',
    integration: 'control',
    description: 'Pause the run and ask the user to handle something manually.',
    params: [{ name: 'message', description: 'What the user needs to do', required: true }],
    outputs: [],
    covers: [],
  },
]

export const TRIGGERS: { type: TriggerType; description: string; outputs: string[]; config: string[] }[] = [
  {
    type: 'gmail.new_email',
    description: 'Fires for each new Gmail message matching a Gmail search query.',
    outputs: ['email.messageId', 'email.threadId', 'email.from', 'email.fromName', 'email.fromAddress', 'email.subject', 'email.body', 'email.hasAttachment', 'email.receivedAt'],
    config: ['query'],
  },
  {
    type: 'manual',
    description: 'Run on demand from WorkFlowOS with sample input.',
    outputs: ['email.messageId', 'email.from', 'email.fromName', 'email.fromAddress', 'email.subject', 'email.body'],
    config: [],
  },
]

export const actionById = new Map(ACTIONS.map((a) => [a.id, a]))

export function catalogForPrompt(): string {
  const triggers = TRIGGERS.map((t) => `- ${t.type}: ${t.description} Config: ${t.config.join(', ') || 'none'}. Provides: ${t.outputs.join(', ')}`).join('\n')
  const actions = ACTIONS.map(
    (a) =>
      `- ${a.id}: ${a.description}\n  params: ${a.params.map((p) => `${p.name}${p.required ? '' : '?'} (${p.description})`).join('; ')}\n  outputs: ${a.outputs.join(', ') || 'none'}`,
  ).join('\n')
  return `TRIGGERS\n${triggers}\n\nACTIONS\n${actions}`
}
