import { app, BrowserWindow, ipcMain, Notification, shell, systemPreferences } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { WorkflowOSApi } from './shared/api'
import { API_METHODS, PUSH_CHANNELS } from './shared/api'
import { MECHANISM_PRIORITY, type Workflow } from './shared/types'
import { getDb, kvGet, kvSet, openDb } from './core/db'
import { bus, log, newId } from './core/bus'
import { getSettings, publicSettings, setSecret, updateSettings } from './core/settings'
import { getWorkflow, listPatterns, listWorkflows, resetAll, saveWorkflow, savePattern, getPattern } from './core/store'
import { ActivityAgent, insertEvent, recentEvents } from './observe/agent'
import { DiscoveryEngine } from './discover/engine'
import { AutomationEngine, getRun, listRuns } from './automate/engine'
import { TriggerManager, sampleVars } from './automate/triggers'
import { EXECUTORS } from './automate/executors'
import { automationBrowserName, closeBrowser, openForSignIn, setProfileDir } from './automate/browser'
import { ACTIONS } from './generate/catalog'
import { validateSpec } from './generate/validate'
import { allStats } from './learn/stats'
import { startCrmServer } from './integrations/crmServer'
import { connectGmail, disconnectGmail } from './integrations/gmail'
import { slackSend } from './integrations/slack'
import { testGemini } from './understand/gemini'
import { demoScenario } from './demo/scenario'
import type { Vars } from './automate/vars'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
process.env.APP_ROOT = path.join(__dirname, '..')
try {
  process.loadEnvFile(path.join(process.env.APP_ROOT, '.env'))
} catch {
  // .env is optional
}
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

// Opt-in CDP port for automated UI testing (e.g. WF_DEBUG_PORT=9333 npm run dev).
if (process.env.WF_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.WF_DEBUG_PORT)
// Isolated profile for tests / demos (e.g. WF_PROFILE=demo).
if (process.env.WF_PROFILE) app.setPath('userData', path.join(app.getPath('appData'), `WorkFlowOS-${process.env.WF_PROFILE}`))
else app.setName('WorkFlowOS')

let win: BrowserWindow | null = null
const dataDir = app.getPath('userData')

openDb(dataDir)
setProfileDir(path.join(dataDir, 'automation-browser'))
const agent = new ActivityAgent()
const discovery = new DiscoveryEngine()
const engine = new AutomationEngine(dataDir)
const fire = (wf: Workflow, vars: Vars, label: string) => engine.start(wf, vars, label)
const triggers = new TriggerManager(listWorkflows, fire)

let demoLoading = false

function notify(title: string, body: string) {
  if (Notification.isSupported()) new Notification({ title, body }).show()
}

bus.on('workflow', (wf) => {
  if (wf.status === 'proposed') notify('WorkFlowOS found a repetitive workflow', `"${wf.spec.name}" — review it to automate.`)
})
bus.on('run', (run) => {
  if (run.status === 'waiting_user') notify('Workflow needs you', run.message ?? 'A run is waiting for your input.')
})

// ---------- API implementation ----------

const api: WorkflowOSApi = {
  getStatus: () => ({
    platform: process.platform,
    sensors: agent.sensors(),
    eventCount: countEvents(),
    patternCount: listPatterns().length,
    activeWorkflows: listWorkflows().filter((w) => w.status === 'active').length,
    accessibilityTrusted: process.platform === 'darwin' ? systemPreferences.isTrustedAccessibilityClient(false) : true,
    automationBrowser: automationBrowserName() === 'not started' && kvGet('automationBrowserUsed', false) ? 'ready' : automationBrowserName(),
  }),
  getSettings: () => publicSettings(),
  updateSettings: (patch) => {
    const before = getSettings()
    updateSettings(patch)
    if (patch.observing !== undefined && patch.observing !== before.observing) agent.applyObserving()
    if (patch.watchFolders) agent.applyObserving()
    bus.emit('status', undefined)
    return publicSettings()
  },
  setSecret: (name, value) => {
    setSecret(name, value.trim())
    return publicSettings()
  },

  recentEvents: (limit) => recentEvents(Math.min(limit, 500)),
  listPatterns: () => listPatterns(),
  listWorkflows: () => listWorkflows(),
  listRuns: (workflowId) => listRuns(workflowId),
  mechanismStats: () => allStats(),
  actionCatalog: () =>
    ACTIONS.map((a) => ({
      id: a.id,
      description: a.description,
      params: a.params,
      outputs: a.outputs,
      ladder: MECHANISM_PRIORITY.map((m) => {
        const ex = EXECUTORS.find((e) => e.action === a.id && e.mechanism === m)
        return { mechanism: m, via: ex?.via, supported: !!ex }
      }),
    })),

  runDiscovery: () => discovery.run() as never,
  loadDemo: (async () => {
    if (demoLoading) throw new Error('Demo observations are already loading')
    demoLoading = true
    try {
      // Replace, never stack: overlapping demo timelines would interleave into noise.
      getDb().prepare("DELETE FROM events WHERE source = 'demo'").run()
      const events = demoScenario({ crmPort: getSettings().crmPort })
      for (const e of events) insertEvent({ ...e, id: newId('ev'), ts: e.ts ?? Date.now() })
      const res = await discovery.run()
      bus.emit('status', undefined)
      return { events: events.length, ...res }
    } finally {
      demoLoading = false
    }
  }) as never,
  resetData: () => {
    resetAll()
    bus.emit('status', undefined)
  },

  updateWorkflowSpec: (id, spec) => {
    const wf = mustWorkflow(id)
    const { spec: clean, warnings, errors } = validateSpec({ ...spec, id: wf.id })
    if (!errors.length) {
      wf.spec = clean
      saveWorkflow(wf)
    }
    return { workflow: wf, warnings, errors }
  },
  approveWorkflow: (async (id: string) => {
    const wf = mustWorkflow(id)
    wf.status = 'active'
    wf.approvedAt = Date.now()
    saveWorkflow(wf)
    setPatternStatus(wf, 'approved')
    await triggers.baseline(wf)
    log('approve', `Automation "${wf.spec.name}" approved and active`)
    return wf
  }) as never,
  dismissWorkflow: (id) => {
    const wf = mustWorkflow(id)
    wf.status = 'dismissed'
    saveWorkflow(wf)
    setPatternStatus(wf, 'dismissed')
  },
  setWorkflowStatus: (id, status) => {
    const wf = mustWorkflow(id)
    wf.status = status
    saveWorkflow(wf)
    return wf
  },
  runWorkflow: (async (id: string, input: 'now' | 'sample' | 'latest_email', inputs: Record<string, string> = {}) => {
    const wf = mustWorkflow(id)
    if (input === 'latest_email') return triggers.runOnLatest(wf)
    const given = Object.fromEntries(Object.entries(inputs).filter(([, v]) => v !== '').map(([k, v]) => [`input.${k}`, v]))
    if (input === 'sample') return engine.start(wf, { ...sampleVars(), ...given }, 'Test run (sample email)')
    return engine.start(wf, given, 'Run now')
  }) as never,
  resumeRun: (async (runId: string, mode: 'continue' | 'retry' | 'cancel', patch: Record<string, string> = {}) => {
    const run = getRun(runId)
    if (!run) throw new Error('Run not found')
    const vars: Vars = { ...patch }
    if (patch['customer.id']) vars['customer.found'] = true
    return engine.resume(mustWorkflow(run.workflowId), run, mode, vars)
  }) as never,

  connectGmail: (() => connectGmail()) as never,
  disconnectGmail: () => disconnectGmail(),
  testGemini: (() => testGemini()) as never,
  testSlack: (async () => {
    await slackSend(getSettings().slackDefaultChannel, ':wave: WorkFlowOS is connected.')
    return `Posted to ${getSettings().slackDefaultChannel}`
  }) as never,
  openCrm: () => {
    shell.openExternal(`http://localhost:${getSettings().crmPort}/customers`)
  },
  openAutomationBrowser: ((url?: string) => {
    kvSet('automationBrowserUsed', true)
    return openForSignIn(url)
  }) as never,
  openExternal: (url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
  },
}

function countEvents(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
}

function mustWorkflow(id: string): Workflow {
  const wf = getWorkflow(id)
  if (!wf) throw new Error('Workflow not found')
  return wf
}

function setPatternStatus(wf: Workflow, status: 'approved' | 'dismissed') {
  const p = wf.patternId ? getPattern(wf.patternId) : undefined
  if (p) savePattern({ ...p, status })
}

ipcMain.handle('wf:call', async (event, method: keyof WorkflowOSApi, ...args: unknown[]) => {
  if (event.senderFrame?.url && win && !isOwnUrl(event.senderFrame.url)) return { ok: false, error: 'Forbidden' }
  if (!API_METHODS.includes(method)) return { ok: false, error: `Unknown method ${method}` }
  try {
    const fn = api[method] as (...a: unknown[]) => unknown
    return { ok: true, value: await fn(...args) }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
})

function isOwnUrl(url: string): boolean {
  return VITE_DEV_SERVER_URL ? url.startsWith(VITE_DEV_SERVER_URL) : url.startsWith('file://')
}

for (const ch of PUSH_CHANNELS) {
  bus.on(ch as never, (payload: unknown) => win?.webContents.send(`wf:${ch}`, payload))
}

// ---------- Window & lifecycle ----------

function createWindow() {
  win = new BrowserWindow({
    show: false,
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'WorkFlowOS',
    backgroundColor: '#f4f1ea',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!isOwnUrl(url)) e.preventDefault()
  })
  win.once('ready-to-show', () => win?.show())
  // Never leave a blank window: show it anyway after a few seconds, and retry
  // if the dev server was not ready or the renderer died.
  setTimeout(() => win && !win.isVisible() && win.show(), 4000)
  let retries = 0
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return // -3 = aborted by a newer navigation
    log('window', `Load failed (${code} ${desc}) for ${url}`, 'error')
    if (retries++ < 10) setTimeout(() => load(), 1000)
  })
  win.webContents.on('render-process-gone', (_e, d) => {
    log('window', `Renderer gone: ${d.reason}`, 'error')
    if (retries++ < 10) setTimeout(() => load(), 500)
  })
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') log('renderer', e.message.slice(0, 500), 'error')
  })
  const load = () => (VITE_DEV_SERVER_URL ? win?.loadURL(VITE_DEV_SERVER_URL) : win?.loadFile(path.join(RENDERER_DIST, 'index.html')))
  load()
}

// One instance only: a second copy would fight over the CRM and extension ports.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
}

app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) return
  const s = getSettings()
  startCrmServer({ port: s.crmPort, attachmentsDir: path.join(dataDir, 'crm-attachments'), apiEnabled: () => getSettings().crmApiEnabled })
  agent.start()
  discovery.start()
  triggers.start()
  createWindow()
  setInterval(() => bus.emit('status', undefined), 5000)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('before-quit', () => {
  agent.stop()
  discovery.stop()
  triggers.stop()
  closeBrowser()
})
