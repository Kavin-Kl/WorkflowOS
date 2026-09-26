import { describe, expect, it } from 'vitest'
import { validateSpec } from './validate'
import { templateSpec } from './generator'
import { heuristicIntent } from '../understand/intent'
import { evaluate, interpolate } from '../automate/vars'
import type { WorkflowSpec } from '../shared/types'

const SIG = [
  'Gmail:open_email',
  'Gmail:download_attachment',
  'CRM:search_customer',
  'CRM:open_customer',
  'CRM:edit_record',
  'CRM:attach_file',
  'CRM:update_customer',
  'Slack:open_channel',
  'Slack:send_message',
]

describe('templateSpec + validateSpec', () => {
  it('builds the customer-request workflow with a not-found guard', () => {
    const { spec, errors, warnings } = validateSpec(templateSpec(SIG, heuristicIntent(SIG), { slackChannel: '#support' }))
    expect(errors).toEqual([])
    expect(spec.trigger.type).toBe('gmail.new_email')
    expect(spec.steps.map((s) => s.action)).toEqual([
      'ai.extract',
      'gmail.download_attachment',
      'crm.find_customer',
      'crm.update_customer',
      'slack.send_message',
    ])
    const find = spec.steps.find((s) => s.action === 'crm.find_customer')!
    expect(find.guard?.onFail).toBe('ask_user')
    expect(spec.integrations).toEqual(['ai', 'gmail', 'crm', 'slack'])
    expect(warnings.filter((w) => w.includes('before it is produced'))).toEqual([])
  })

  it('drops unknown actions and flags use-before-produce', () => {
    const bad: WorkflowSpec = {
      id: 'x',
      name: 'x',
      intent: 'x',
      description: '',
      trigger: { type: 'manual', config: {}, description: '' },
      variables: [],
      integrations: [],
      generatedBy: 'gemini',
      steps: [
        { id: 'a', action: 'os.format_disk', label: 'nope', params: {}, onError: 'stop' },
        { id: 'b', action: 'slack.send_message', label: 'notify', params: { channel: '#x', text: '{{customer.name}}' }, onError: 'stop' },
      ],
    }
    const { spec, warnings } = validateSpec(bad)
    expect(spec.steps).toHaveLength(1)
    expect(warnings.some((w) => w.includes('unknown action'))).toBe(true)
    expect(warnings.some((w) => w.includes('{{customer.name}}'))).toBe(true)
  })
})

describe('vars', () => {
  it('interpolates and evaluates', () => {
    const vars = { 'customer.name': 'Ana', 'customer.found': false }
    expect(interpolate('Hi {{customer.name}}{{missing}}', vars)).toBe('Hi Ana')
    expect(evaluate({ var: 'customer.found', op: 'truthy' }, vars)).toBe(false)
    expect(evaluate({ var: 'customer.name', op: 'contains', value: 'an' }, vars)).toBe(true)
  })
})
