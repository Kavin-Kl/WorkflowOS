import type { ActivityEvent, Pattern, Workflow } from '../shared/types'
import { loadEvents } from '../observe/agent'
import { abstractEvents } from './abstract'
import { DEFAULT_MINE, editDistance, minePatterns, type MinedPattern } from './mine'
import { understandPattern } from '../understand/intent'
import { generateWorkflow } from '../generate/generator'
import { getSettings } from '../core/settings'
import { listPatterns, saveWorkflow, savePattern } from '../core/store'
import { log, newId } from '../core/bus'

/** Most-used Slack channel in the observed occurrences, e.g. "#support". */
function observedChannel(p: MinedPattern, byId: Map<string, ActivityEvent>): string | null {
  for (const occ of p.occurrences) {
    for (const id of occ.eventIds) {
      const e = byId.get(id)
      const m = e?.app === 'Slack' && (e.target?.match(/#[\w-]+/) || e.title?.match(/#[\w-]+/))
      if (m) return m[0]
    }
  }
  return null
}

/**
 * Runs the discovery pipeline: events → steps → mined patterns → (for new,
 * well-supported patterns) intent understanding → workflow proposal.
 */
export class DiscoveryEngine {
  private running = false
  private timer: NodeJS.Timeout | null = null

  start() {
    this.timer = setInterval(() => this.run().catch(() => {}), 5 * 60_000)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  async run(): Promise<{ patterns: number; proposed: number }> {
    if (this.running) return { patterns: 0, proposed: 0 }
    this.running = true
    try {
      const s = getSettings()
      const events = loadEvents(Date.now() - s.retentionDays * 86400_000)
      const byId = new Map(events.map((e) => [e.id, e]))
      const mined = minePatterns(abstractEvents(events), { minSupport: s.minSupport })
      const existing = listPatterns()
      let proposed = 0

      for (const m of mined) {
        const match = existing.find(
          (p) => editDistance(p.signature, m.signature) / Math.max(p.signature.length, m.signature.length) <= DEFAULT_MINE.similarity,
        )
        const pattern: Pattern = match
          ? { ...match, occurrences: m.occurrences, support: m.support, avgDurationMs: m.avgDurationMs, score: m.score, lastSeen: m.occurrences.at(-1)!.end }
          : {
              id: newId('pat'),
              signature: m.signature,
              occurrences: m.occurrences,
              support: m.support,
              avgDurationMs: m.avgDurationMs,
              apps: m.apps,
              score: m.score,
              status: 'candidate',
              firstSeen: m.occurrences[0].start,
              lastSeen: m.occurrences.at(-1)!.end,
            }

        if (pattern.status === 'candidate') {
          log('discover', `Repeated workflow found (${m.support}×): ${m.signature.join(' → ')}`)
          pattern.intent = await understandPattern(m, byId)
          const channel = observedChannel(m, byId) ?? s.slackDefaultChannel
          const { spec, warnings, errors } = await generateWorkflow(m.signature, pattern.intent, { slackChannel: channel, occurrences: m.occurrences, eventsById: byId })
          for (const w of warnings) log('generate', w, 'warn')
          if (errors.length) {
            log('generate', `Could not generate a workflow: ${errors.join('; ')}`, 'warn')
          } else {
            const wf: Workflow = { id: spec.id, patternId: pattern.id, spec, status: 'proposed', createdAt: Date.now() }
            saveWorkflow(wf)
            pattern.workflowId = wf.id
            pattern.status = 'proposed'
            proposed++
          }
        }
        savePattern(pattern)
      }
      return { patterns: mined.length, proposed }
    } finally {
      this.running = false
    }
  }
}
