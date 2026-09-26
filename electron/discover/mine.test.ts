import { describe, expect, it } from 'vitest'
import type { ActivityEvent } from '../shared/types'
import { abstractEvents, normTarget } from './abstract'
import { editDistance, minePatterns } from './mine'
import { demoScenario } from '../demo/scenario'

function toEvents(): ActivityEvent[] {
  return demoScenario({ occurrences: 5, endTs: 1_800_000_000_000 }).map((e, i) => ({ ...e, id: `e${i}`, ts: e.ts! }))
}

describe('abstractEvents', () => {
  it('maps the scenario into semantic steps and merges downloads with saved files', () => {
    const tokens = abstractEvents(toEvents()).map((s) => s.token)
    expect(tokens).toContain('Gmail:open_email')
    expect(tokens).toContain('Gmail:download_attachment')
    expect(tokens).toContain('CRM:update_customer')
    expect(tokens).toContain('Slack:send_message')
    expect(tokens).not.toContain('Files:save_pdf')
  })

  it('normalizes counts out of targets', () => {
    expect(normTarget('Inbox (12)')).toBe(normTarget('Inbox (3)'))
  })
})

describe('minePatterns', () => {
  it('discovers the customer-request workflow despite noise and variations', () => {
    const patterns = minePatterns(abstractEvents(toEvents()), { minSupport: 3 })
    expect(patterns.length).toBeGreaterThan(0)
    const top = patterns[0]
    expect(top.signature[0]).toBe('Gmail:open_email')
    expect(top.signature).toContain('CRM:update_customer')
    expect(top.signature[top.signature.length - 1]).toBe('Slack:send_message')
    expect(top.support).toBe(5)
    expect(top.apps).toEqual(expect.arrayContaining(['Gmail', 'CRM', 'Slack']))
  })

  it('returns nothing below the support threshold', () => {
    const events = demoScenario({ occurrences: 2, endTs: 1_800_000_000_000 }).map((e, i) => ({ ...e, id: `e${i}`, ts: e.ts! }))
    expect(minePatterns(abstractEvents(events), { minSupport: 3 })).toEqual([])
  })

  it('computes edit distance', () => {
    expect(editDistance(['a', 'b', 'c'], ['a', 'c'])).toBe(1)
    expect(editDistance(['a', 'b'], ['a', 'b'])).toBe(0)
  })
})
