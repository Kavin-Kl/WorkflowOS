import { EventEmitter } from 'node:events'
import type { ActivityEvent, Pattern, Run, Workflow } from '../shared/types'

// In-process event bus. Modules publish here; ipc.ts forwards to the renderer.
export interface BusEvents {
  activity: ActivityEvent
  pattern: Pattern
  workflow: Workflow
  run: Run
  status: void
  log: { level: 'info' | 'warn' | 'error'; scope: string; message: string; ts: number }
}

class Bus {
  private ee = new EventEmitter()
  constructor() {
    this.ee.setMaxListeners(50)
  }
  emit<K extends keyof BusEvents>(name: K, payload: BusEvents[K]) {
    this.ee.emit(name, payload)
  }
  on<K extends keyof BusEvents>(name: K, fn: (payload: BusEvents[K]) => void) {
    this.ee.on(name, fn)
    return () => this.ee.off(name, fn)
  }
}

export const bus = new Bus()

export function log(scope: string, message: string, level: 'info' | 'warn' | 'error' = 'info') {
  const line = `[${scope}] ${message}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
  bus.emit('log', { level, scope, message, ts: Date.now() })
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}
