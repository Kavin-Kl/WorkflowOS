import type {
  ActivityEvent,
  AppStatus,
  Mechanism,
  MechanismStat,
  Pattern,
  PublicSettings,
  Run,
  Workflow,
  WorkflowSpec,
} from './types'

export type EditableSettings = Pick<
  PublicSettings,
  | 'observing'
  | 'geminiModel'
  | 'gmailClientId'
  | 'slackMode'
  | 'slackDefaultChannel'
  | 'crmApiEnabled'
  | 'watchFolders'
  | 'appBlocklist'
  | 'urlBlocklist'
  | 'retentionDays'
  | 'minSupport'
>

export type SecretKey = 'geminiKey' | 'gmailClientSecret' | 'slackToken' | 'slackWebhook'

export interface LadderRung {
  mechanism: Mechanism
  via?: string
  supported: boolean
}

export interface ActionInfo {
  id: string
  description: string
  params: { name: string; description: string; required: boolean }[]
  outputs: string[]
  ladder: LadderRung[]
}

/** Every method the renderer may call on the main process. */
export interface WorkflowOSApi {
  getStatus(): AppStatus
  getSettings(): PublicSettings
  updateSettings(patch: Partial<EditableSettings>): PublicSettings
  setSecret(name: SecretKey, value: string): PublicSettings

  recentEvents(limit: number): ActivityEvent[]
  listPatterns(): Pattern[]
  listWorkflows(): Workflow[]
  listRuns(workflowId?: string): Run[]
  mechanismStats(): MechanismStat[]
  actionCatalog(): ActionInfo[]

  runDiscovery(): { patterns: number; proposed: number }
  loadDemo(): { events: number; patterns: number; proposed: number }
  resetData(): void

  updateWorkflowSpec(id: string, spec: WorkflowSpec): { workflow: Workflow; warnings: string[]; errors: string[] }
  approveWorkflow(id: string): Workflow
  dismissWorkflow(id: string): void
  setWorkflowStatus(id: string, status: 'active' | 'paused'): Workflow
  runWorkflow(id: string, input: 'sample' | 'sample_missing' | 'latest_email'): Run
  resumeRun(runId: string, mode: 'continue' | 'retry' | 'cancel', patch?: Record<string, string>): Run

  connectGmail(): string
  disconnectGmail(): void
  testGemini(): string
  testSlack(): string
  openCrm(): void
  openExternal(url: string): void
}

export type ApiMethod = keyof WorkflowOSApi

export const API_METHODS: ApiMethod[] = [
  'getStatus',
  'getSettings',
  'updateSettings',
  'setSecret',
  'recentEvents',
  'listPatterns',
  'listWorkflows',
  'listRuns',
  'mechanismStats',
  'actionCatalog',
  'runDiscovery',
  'loadDemo',
  'resetData',
  'updateWorkflowSpec',
  'approveWorkflow',
  'dismissWorkflow',
  'setWorkflowStatus',
  'runWorkflow',
  'resumeRun',
  'connectGmail',
  'disconnectGmail',
  'testGemini',
  'testSlack',
  'openCrm',
  'openExternal',
]

export type PushChannel = 'activity' | 'pattern' | 'workflow' | 'run' | 'log' | 'status'
export const PUSH_CHANNELS: PushChannel[] = ['activity', 'pattern', 'workflow', 'run', 'log', 'status']

/** Methods return Promises across the bridge. */
export type AsyncApi = { [K in ApiMethod]: (...args: Parameters<WorkflowOSApi[K]>) => Promise<Awaited<ReturnType<WorkflowOSApi[K]>>> }
