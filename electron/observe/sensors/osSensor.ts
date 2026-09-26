import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import { MAC_JXA, WIN_PS } from './osScripts'
import { appFromProcess, isBrowserProcess } from '../normalize'
import type { SensorStatus } from '../../shared/types'
import type { RawEvent } from '../agent'
import { log } from '../../core/bus'

// Never observe WorkFlowOS itself (shows up as "Electron" while developing).
const SELF = /^(workflowos|electron)(\.exe)?$/i

interface Sample {
  app?: string
  title?: string
  role?: string
  label?: string
}

/**
 * Foreground app/window + focused accessibility element, for macOS and Windows.
 * Emits app_focus when the logical app changes and ui_focus when the focused
 * control changes inside a native (non-browser) app. Browser detail comes from
 * the extension instead.
 */
export class OsSensor {
  private proc: ChildProcess | null = null
  private last: Sample = {}
  private lastApp = ''
  private restarts = 0
  private stopped = true
  status: SensorStatus = { name: 'OS activity', state: 'stopped' }

  constructor(private emit: (e: RawEvent) => void) {}

  start() {
    this.stopped = false
    if (process.platform === 'darwin') {
      this.spawn('osascript', ['-l', 'JavaScript', '-e', MAC_JXA])
    } else if (process.platform === 'win32') {
      const encoded = Buffer.from(WIN_PS, 'utf16le').toString('base64')
      this.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded])
    } else {
      this.status = { name: 'OS activity', state: 'unavailable', detail: `Not supported on ${process.platform}` }
    }
  }

  stop() {
    this.stopped = true
    this.proc?.kill()
    this.proc = null
    if (this.status.state === 'running') this.status = { name: 'OS activity', state: 'stopped' }
  }

  private spawn(cmd: string, args: string[]) {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    this.proc = proc
    this.status = { name: 'OS activity', state: 'running', detail: process.platform === 'darwin' ? 'JXA / System Events' : 'Win32 + UI Automation' }
    readline.createInterface({ input: proc.stdout! }).on('line', (line) => this.onLine(line))
    proc.stderr?.on('data', (d) => {
      const msg = String(d).trim()
      if (msg) log('os-sensor', msg.slice(0, 300), 'warn')
    })
    proc.on('exit', (code) => {
      if (this.stopped) return
      this.status = { name: 'OS activity', state: 'error', detail: `helper exited (${code})` }
      if (this.restarts++ < 5) setTimeout(() => !this.stopped && this.spawn(cmd, args), 3000 * this.restarts)
    })
  }

  private onLine(line: string) {
    let s: Sample
    try {
      s = JSON.parse(line)
    } catch {
      return
    }
    if (!s.app || SELF.test(s.app)) return
    if (s.label) s.label = s.label.replace(/\s+/g, ' ').trim()
    const app = appFromProcess(s.app, s.title)
    if (app !== this.lastApp) {
      this.emit({ source: 'window', kind: 'app_focus', app, title: s.title, data: { process: s.app } })
      this.lastApp = app
    }
    const control = s.role && s.label ? `${s.role.replace(/^AX/, '').toLowerCase()}:${s.label}` : ''
    const prevControl = this.last.role && this.last.label ? `${this.last.role.replace(/^AX/, '').toLowerCase()}:${this.last.label}` : ''
    if (control && control !== prevControl && !isBrowserProcess(s.app)) {
      this.emit({ source: 'accessibility', kind: 'ui_focus', app, target: control, title: s.title })
    }
    this.last = s
  }
}
