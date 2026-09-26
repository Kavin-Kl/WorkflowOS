import type { RawEvent } from '../observe/agent'

// Synthetic but realistic observation data for the "Process Customer Request"
// scenario, with noise, interruptions, and step-order variation. Used by the
// "Load demo observations" button and by the discovery tests.

export const DEMO_CUSTOMERS = [
  { id: 'c_1001', name: 'Priya Raman', email: 'priya@northwind.io', company: 'Northwind Traders' },
  { id: 'c_1002', name: 'Marcus Lee', email: 'marcus.lee@contoso.com', company: 'Contoso Ltd' },
  { id: 'c_1003', name: 'Ana Souza', email: 'ana@fabrikam.co', company: 'Fabrikam Inc' },
  { id: 'c_1004', name: 'Tom Becker', email: 'tbecker@globex.com', company: 'Globex Corp' },
  { id: 'c_1005', name: 'Mei Tanaka', email: 'mei@initech.jp', company: 'Initech' },
]

const TOPICS = ['Purchase order', 'Invoice correction', 'Contract renewal', 'Shipping change', 'Pricing request']

const NOISE: RawEvent[] = [
  { source: 'demo', kind: 'navigate', app: 'GitHub', url: 'https://github.com/pulls', title: 'Pull requests' },
  { source: 'demo', kind: 'navigate', app: 'news.ycombinator.com', url: 'https://news.ycombinator.com/', title: 'Hacker News' },
  { source: 'demo', kind: 'app_focus', app: 'Excel', title: 'Q3 forecast.xlsx' },
  { source: 'demo', kind: 'ui_focus', app: 'Excel', target: 'textfield:Formula bar' },
  { source: 'demo', kind: 'navigate', app: 'Google Docs', url: 'https://docs.google.com/document/d/x', title: 'Team notes' },
  { source: 'demo', kind: 'navigate', app: 'Gmail', url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Inbox - Gmail' },
]

function rand(seed: { v: number }) {
  // Deterministic LCG so tests are stable.
  seed.v = (seed.v * 1664525 + 1013904223) % 4294967296
  return seed.v / 4294967296
}

function threadId(seed: { v: number }) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let s = 'FMfcgz'
  for (let i = 0; i < 20; i++) s += chars[Math.floor(rand(seed) * chars.length)]
  return s
}

export function occurrenceEvents(i: number, seed: { v: number }, crmPort: number, variant = i % 4): RawEvent[] {
  const c = DEMO_CUSTOMERS[i % DEMO_CUSTOMERS.length]
  const topic = TOPICS[i % TOPICS.length]
  const file = `${topic.replace(/\s+/g, '_')}_${1000 + i}.pdf`
  const crm = `http://localhost:${crmPort}`
  const gmailUrl = `https://mail.google.com/mail/u/0/#inbox/${threadId(seed)}`

  const record: RawEvent[] = [
    { source: 'demo', kind: 'input', app: 'CRM', url: `${crm}/customers/${c.id}`, target: 'field:Request notes' },
    { source: 'demo', kind: 'input', app: 'CRM', url: `${crm}/customers/${c.id}`, target: 'field:Attach file' },
  ]
  if (variant === 3) record.reverse()

  const evs: RawEvent[] = [
    { source: 'demo', kind: 'app_focus', app: 'Gmail', title: 'Inbox - Gmail' },
    { source: 'demo', kind: 'navigate', app: 'Gmail', url: gmailUrl, title: `${topic} – ${c.company} - Gmail`, data: { subject: `${topic} – ${c.company}` } },
    { source: 'demo', kind: 'download', app: 'Gmail', url: gmailUrl, target: 'attachment', data: { filename: file } },
    { source: 'demo', kind: 'file_created', app: 'Files', path: `~/Downloads/${file}`, target: 'file:pdf', data: { name: file } },
    { source: 'demo', kind: 'navigate', app: 'CRM', url: `${crm}/customers`, title: 'Customers · Acme CRM' },
    { source: 'demo', kind: 'input', app: 'CRM', url: `${crm}/customers`, target: 'field:Search customers' },
    { source: 'demo', kind: 'navigate', app: 'CRM', url: `${crm}/customers/${c.id}`, title: `${c.name} · Acme CRM` },
    ...record,
    { source: 'demo', kind: 'submit', app: 'CRM', url: `${crm}/customers/${c.id}`, target: 'button:Save update' },
  ]
  if (variant === 2) {
    // An interruption in the middle of the flow.
    evs.push({ source: 'demo', kind: 'navigate', app: 'Google Calendar', url: 'https://calendar.google.com/', title: 'Calendar' })
  }
  evs.push(
    { source: 'demo', kind: 'navigate', app: 'Slack', url: 'https://app.slack.com/client/T01ACME/C0SUPPORT', title: '#support - Acme - Slack' },
    { source: 'demo', kind: 'input', app: 'Slack', url: 'https://app.slack.com/client/T01ACME/C0SUPPORT', target: 'field:Message #support' },
    { source: 'demo', kind: 'submit', app: 'Slack', url: 'https://app.slack.com/client/T01ACME/C0SUPPORT', target: 'form:Send message' },
  )
  return evs
}

/** Occurrences spread over the last few days, with noise between them. */
export function demoScenario(opts: { occurrences?: number; crmPort?: number; endTs?: number; seed?: number } = {}): RawEvent[] {
  const n = opts.occurrences ?? 5
  const crmPort = opts.crmPort ?? 4545
  const seed = { v: opts.seed ?? 42 }
  let ts = (opts.endTs ?? Date.now()) - n * 7 * 3600_000
  const out: RawEvent[] = []
  const push = (e: RawEvent, gapMs: number) => {
    ts += gapMs
    out.push({ ...e, ts })
  }
  for (let i = 0; i < n; i++) {
    const noiseCount = 1 + Math.floor(rand(seed) * 3)
    for (let k = 0; k < noiseCount; k++) push(NOISE[Math.floor(rand(seed) * NOISE.length)], 20_000 + rand(seed) * 60_000)
    push({ source: 'demo', kind: 'idle', app: 'System' }, 30_000)
    ts += 20 * 60_000
    for (const e of occurrenceEvents(i, seed, crmPort)) push(e, e.kind === 'file_created' ? 1_500 : 4_000 + rand(seed) * 25_000)
    ts += 6 * 3600_000
  }
  return out
}
