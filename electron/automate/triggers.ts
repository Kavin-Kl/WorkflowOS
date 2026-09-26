import type { Workflow } from '../shared/types'
import { getDb } from '../core/db'
import { log } from '../core/bus'
import { getMessage, gmailConnected, listMessageIds, type EmailMessage } from '../integrations/gmail'
import { DEMO_CUSTOMERS } from '../demo/scenario'
import type { Vars } from './vars'

const POLL_MS = 60_000

export function emailVars(m: EmailMessage): Vars {
  return {
    'email.messageId': m.messageId,
    'email.threadId': m.threadId,
    'email.from': m.from,
    'email.fromName': m.fromName,
    'email.fromAddress': m.fromAddress,
    'email.subject': m.subject,
    'email.body': m.body,
    'email.hasAttachment': m.hasAttachment,
    'email.receivedAt': new Date(m.receivedAt).toISOString(),
  }
}

/** Sample input for a manual test run, no Gmail needed. */
export function sampleVars(missingCustomer = false): Vars {
  const c = missingCustomer
    ? { name: 'Jordan Blake', email: 'jordan@unknown-co.com', company: 'Unknown Co' }
    : DEMO_CUSTOMERS[Math.floor(Math.random() * DEMO_CUSTOMERS.length)]
  return {
    'email.demo': true,
    'email.messageId': `demo_${Date.now()}`,
    'email.from': `${c.name} <${c.email}>`,
    'email.fromName': c.name,
    'email.fromAddress': c.email,
    'email.subject': `Purchase order – ${c.company}`,
    'email.body': `Hi team,\n\nPlease find attached our purchase order for 40 additional seats starting next month. Can you update our account and confirm the new pricing?\n\nThanks,\n${c.name}\n${c.company}`,
    'email.hasAttachment': true,
    'email.demoAttachment': `PO_${c.company.split(' ')[0]}.pdf`,
  }
}

const seen = (wf: string, key: string) =>
  !!getDb().prepare('SELECT 1 FROM trigger_seen WHERE workflow_id = ? AND key = ?').get(wf, key)
const markSeen = (wf: string, key: string) =>
  getDb().prepare('INSERT OR IGNORE INTO trigger_seen (workflow_id, key, seen_at) VALUES (?, ?, ?)').run(wf, key, Date.now())

/**
 * Polls Gmail for active gmail.new_email workflows. On activation, current
 * matches are recorded as a baseline so only genuinely new emails fire.
 */
export class TriggerManager {
  private timer: NodeJS.Timeout | null = null
  private polling = false

  constructor(
    private workflows: () => Workflow[],
    private fire: (wf: Workflow, vars: Vars, label: string) => Promise<unknown>,
  ) {}

  start() {
    this.timer = setInterval(() => this.poll(), POLL_MS)
    setInterval(() => this.checkSchedules(), 20_000)
    setTimeout(() => this.poll(), 5_000)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  async baseline(wf: Workflow) {
    if (wf.spec.trigger.type !== 'gmail.new_email' || !gmailConnected()) return
    try {
      for (const id of await listMessageIds(wf.spec.trigger.config.query || 'is:unread', 50)) markSeen(wf.id, id)
    } catch (err) {
      log('trigger', `Baseline failed: ${(err as Error).message}`, 'warn')
    }
  }

  private lastScheduleCheck = ''

  /** Daily "HH:MM" schedules, checked once a minute. */
  private checkSchedules() {
    const now = new Date()
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    if (hhmm === this.lastScheduleCheck) return
    this.lastScheduleCheck = hhmm
    const day = now.toISOString().slice(0, 10)
    for (const wf of this.workflows()) {
      if (wf.status !== 'active' || wf.spec.trigger.type !== 'schedule') continue
      const [h, m] = (wf.spec.trigger.config.time ?? '').split(':').map(Number)
      if (h !== now.getHours() || m !== now.getMinutes() || seen(wf.id, `schedule:${day}`)) continue
      markSeen(wf.id, `schedule:${day}`)
      log('trigger', `Scheduled run: ${wf.spec.name}`)
      this.fire(wf, {}, `Schedule ${wf.spec.trigger.config.time}`).catch(() => {})
    }
  }

  async poll() {
    this.checkSchedules()
    if (this.polling || !gmailConnected()) return
    this.polling = true
    try {
      for (const wf of this.workflows()) {
        if (wf.status !== 'active' || wf.spec.trigger.type !== 'gmail.new_email') continue
        const ids = await listMessageIds(wf.spec.trigger.config.query || 'is:unread', 10)
        for (const id of ids.reverse()) {
          if (seen(wf.id, id)) continue
          markSeen(wf.id, id)
          const msg = await getMessage(id)
          log('trigger', `New email for "${wf.spec.name}": ${msg.subject}`)
          await this.fire(wf, emailVars(msg), `Gmail: ${msg.subject.slice(0, 60)}`)
        }
      }
    } catch (err) {
      log('trigger', `Gmail poll failed: ${(err as Error).message}`, 'warn')
    } finally {
      this.polling = false
    }
  }

  /** Run on the most recent matching email, even if it was already seen. */
  async runOnLatest(wf: Workflow) {
    const [id] = await listMessageIds(wf.spec.trigger.config.query || 'is:unread', 1)
    if (!id) throw new Error(`No email matches "${wf.spec.trigger.config.query}"`)
    markSeen(wf.id, id)
    const msg = await getMessage(id)
    return this.fire(wf, emailVars(msg), `Gmail (manual): ${msg.subject.slice(0, 60)}`)
  }
}
