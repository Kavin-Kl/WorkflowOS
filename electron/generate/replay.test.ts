import { describe, expect, it } from 'vitest'
import type { ActivityEvent } from '../shared/types'
import { abstractEvents } from '../discover/abstract'
import { minePatterns } from '../discover/mine'
import { templateSpec } from './generator'
import { validateSpec } from './validate'
import { heuristicIntent } from '../understand/intent'

const TODO = 'https://demo.playwright.dev/todomvc/#/'
const CRM = 'http://localhost:4545/customers'

/** A generic routine (no API coverage): add a todo, then add the lead to the CRM. */
function occurrence(n: number, t0: number, name: string, email: string): ActivityEvent[] {
  let ts = t0
  let i = 0
  const ev = (e: Omit<ActivityEvent, 'id' | 'ts' | 'source'>): ActivityEvent => ({ ...e, id: `o${n}_${i++}`, ts: (ts += 4000), source: 'browser' })
  const field = (label: string, value: string, hints: object) => ({ hints: { role: 'textbox', name: label, ...hints }, value })
  return [
    ev({ kind: 'navigate', app: 'demo.playwright.dev', url: TODO, title: 'React • TodoMVC' }),
    ev({ kind: 'input', app: 'demo.playwright.dev', url: TODO, target: 'field:What needs to be done?', data: field('What needs to be done?', `Call ${name}`, { placeholder: 'What needs to be done?' }) }),
    ev({ kind: 'submit', app: 'demo.playwright.dev', url: TODO, target: 'key:Enter in What needs to be done?', data: { key: 'Enter', hints: { placeholder: 'What needs to be done?' } } }),
    ev({ kind: 'navigate', app: 'CRM', url: CRM, title: 'Customers · Acme CRM' }),
    ev({ kind: 'input', app: 'CRM', url: CRM, target: 'field:Customer name', data: field('Customer name', name, {}) }),
    ev({ kind: 'input', app: 'CRM', url: CRM, target: 'field:Customer email', data: field('Customer email', email, {}) }),
    ev({ kind: 'input', app: 'CRM', url: CRM, target: 'field:Company', data: field('Company', 'Inbound', {}) }),
    ev({ kind: 'click', app: 'CRM', url: CRM, target: 'button:Add', data: { hints: { role: 'button', name: 'Add' } } }),
    ev({ kind: 'submit', app: 'CRM', url: CRM, target: 'button:Add', data: { viaButton: true, hints: { role: 'button', name: 'Add' } } }),
    ev({ kind: 'navigate', app: 'CRM', url: `http://localhost:4545/customers/c_${n}`, title: `${name} · Acme CRM` }),
  ]
}

describe('replay compilation', () => {
  it('learns a generic web routine with constants and run inputs', () => {
    const people = [
      ['Ana Lima', 'ana@x.io'],
      ['Ben Ode', 'ben@y.io'],
      ['Cy Park', 'cy@z.io'],
    ]
    const events = people.flatMap(([name, email], n) => occurrence(n, 1_800_000_000_000 + n * 3_600_000, name, email))
    const byId = new Map(events.map((e) => [e.id, e]))
    const [p] = minePatterns(abstractEvents(events), { minSupport: 3 })
    expect(p.support).toBe(3)

    const { spec, errors } = validateSpec(
      templateSpec(p.signature, heuristicIntent(p.signature), { slackChannel: '#x', occurrences: p.occurrences, eventsById: byId }),
    )
    expect(errors).toEqual([])
    expect(spec.trigger.type).toBe('manual')
    expect(spec.steps.map((s) => s.action)).toEqual(['web.open', 'web.fill', 'web.press', 'web.open', 'web.fill', 'web.fill', 'web.fill', 'web.click'])

    const fill = (label: string) => spec.steps.find((s) => s.action === 'web.fill' && s.params.label === label)!
    expect(fill('Company').params.value).toBe('Inbound') // same every time → constant
    expect(fill('Customer name').params.value).toBe('{{input.customer_name}}') // varied → input
    expect(fill('What needs to be done?').params.value).toBe('{{input.what_needs_to_be_done}}')
    expect(spec.variables.map((v) => v.name)).toEqual(['what_needs_to_be_done', 'customer_name', 'customer_email'])
    // The navigation to the new customer page follows the click, so it is not replayed.
    expect(spec.steps.filter((s) => s.action === 'web.open').map((s) => s.params.url)).toEqual([TODO, CRM])
  })
})
