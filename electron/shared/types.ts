// Types shared by the main process and the renderer. Keep this file free of
// runtime imports so both sides can import it.

export type EventSource = 'window' | 'browser' | 'file' | 'accessibility' | 'system' | 'demo'

export type EventKind =
  | 'app_focus'
  | 'navigate'
  | 'click'
  | 'input'
  | 'submit'
  | 'download'
  | 'file_created'
  | 'ui_focus'
  | 'idle'

export interface ActivityEvent {
  id: string
  ts: number
  source: EventSource
  kind: EventKind
  /** Logical application, e.g. "Gmail", "CRM", "Slack", "Excel". */
  app: string
  /** Semantic target, e.g. "button:Save", "field:Notes". Never a raw value. */
  target?: string
  url?: string
  title?: string
  path?: string
  /** Small, redacted payload (lengths, ids, subjects that passed the privacy filter). */
  data?: Record<string, unknown>
}

export interface PatternOccurrence {
  start: number
  end: number
  eventIds: string[]
  /** Event ids per signature step (only for exact matches), used to compile replay steps. */
  steps?: string[][]
}

export type PatternStatus = 'candidate' | 'proposed' | 'approved' | 'dismissed'

export interface Pattern {
  id: string
  /** Abstract step tokens, e.g. ["Gmail:open_email", "Gmail:download_attachment", ...]. */
  signature: string[]
  occurrences: PatternOccurrence[]
  support: number
  avgDurationMs: number
  apps: string[]
  score: number
  status: PatternStatus
  intent?: IntentSummary
  workflowId?: string
  firstSeen: number
  lastSeen: number
}

export interface IntentSummary {
  name: string
  description: string
  confidence: number
  variables: { name: string; description: string; example?: string }[]
  source: 'gemini' | 'heuristic'
}

// ---------- Workflow spec ----------

export type TriggerType = 'gmail.new_email' | 'schedule' | 'manual'

export interface WorkflowTrigger {
  type: TriggerType
  /** gmail.new_email → { query }, schedule → { time: "HH:MM" } */
  config: Record<string, string>
  description: string
}

export type ConditionOp = 'exists' | 'not_exists' | 'truthy' | 'falsy' | 'equals' | 'not_equals' | 'contains'

export interface Condition {
  var: string
  op: ConditionOp
  value?: string
}

export interface WorkflowStep {
  id: string
  /** Action id from the catalog, e.g. "crm.update_customer". */
  action: string
  label: string
  /** String params; may contain {{variable}} templates. */
  params: Record<string, string>
  /** Only run this step when the condition holds. */
  when?: Condition
  /** Checked after the step runs; if it fails, `onFail` decides what happens. */
  guard?: { condition: Condition; onFail: 'stop' | 'ask_user'; message: string }
  onError: 'stop' | 'ask_user' | 'continue'
}

export interface WorkflowSpec {
  id: string
  name: string
  intent: string
  description: string
  trigger: WorkflowTrigger
  /** from: "input" = asked when the run starts; otherwise a template like "{{email.fromAddress}}". */
  variables: { name: string; description: string; from: string; example?: string }[]
  steps: WorkflowStep[]
  integrations: string[]
  generatedBy: 'gemini' | 'template'
}

export interface Workflow {
  id: string
  patternId?: string
  spec: WorkflowSpec
  status: 'proposed' | 'active' | 'paused' | 'dismissed'
  createdAt: number
  approvedAt?: number
}

// ---------- Execution ----------

export type Mechanism = 'api' | 'app' | 'accessibility' | 'browser' | 'vision'

export const MECHANISM_PRIORITY: Mechanism[] = ['api', 'app', 'accessibility', 'browser', 'vision']

export interface MechanismAttempt {
  mechanism: Mechanism
  ok: boolean
  error?: string
  ms: number
}

export interface StepResult {
  stepId: string
  label: string
  status: 'ok' | 'skipped' | 'failed' | 'waiting_user'
  mechanism?: Mechanism
  attempts: MechanismAttempt[]
  outputs?: Record<string, unknown>
  message?: string
}

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'waiting_user' | 'stopped'

export interface Run {
  id: string
  workflowId: string
  status: RunStatus
  trigger: string
  startedAt: number
  finishedAt?: number
  steps: StepResult[]
  vars: Record<string, unknown>
  message?: string
  /** Inputs the run is waiting for (status waiting_user). */
  needs?: { name: string; description: string }[]
}

export interface MechanismStat {
  action: string
  mechanism: Mechanism
  successes: number
  failures: number
  avgMs: number
}

// ---------- Settings / status ----------

export interface PublicSettings {
  observing: boolean
  geminiModel: string
  geminiConfigured: boolean
  gmailClientId: string
  gmailConnected: boolean
  gmailAccount?: string
  slackMode: 'bot' | 'webhook' | 'none'
  slackDefaultChannel: string
  crmApiEnabled: boolean
  crmPort: number
  bridgePort: number
  bridgeToken: string
  watchFolders: string[]
  appBlocklist: string[]
  urlBlocklist: string[]
  retentionDays: number
  minSupport: number
  recordValues: boolean
}

export interface SensorStatus {
  name: string
  state: 'running' | 'stopped' | 'unavailable' | 'error'
  detail?: string
}

export interface AppStatus {
  platform: NodeJS.Platform
  sensors: SensorStatus[]
  eventCount: number
  patternCount: number
  activeWorkflows: number
  accessibilityTrusted: boolean
  automationBrowser: string
}
