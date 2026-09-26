import { WebSocketServer, type WebSocket } from 'ws'
import type { EventKind, SensorStatus } from '../../shared/types'
import type { RawEvent } from '../agent'
import { appFromUrl } from '../normalize'
import { log } from '../../core/bus'

const ALLOWED_KINDS: EventKind[] = ['navigate', 'click', 'input', 'submit', 'download']

interface ExtensionMessage {
  type: 'hello' | 'event'
  token?: string
  event?: {
    kind: EventKind
    url?: string
    title?: string
    target?: string
    data?: Record<string, unknown>
    ts?: number
  }
}

/**
 * Local WebSocket endpoint for the WorkFlowOS browser extension. Only
 * extension origins holding the pairing token may send events, so an ordinary
 * web page cannot inject activity.
 */
export class BrowserBridge {
  private wss: WebSocketServer | null = null
  private clients = new Set<WebSocket>()
  status: SensorStatus = { name: 'Browser extension', state: 'stopped' }

  constructor(
    private emit: (e: RawEvent) => void,
    private cfg: () => { port: number; token: string; crmPort: number },
  ) {}

  start() {
    const { port } = this.cfg()
    this.wss = new WebSocketServer({
      host: '127.0.0.1',
      port,
      verifyClient: ({ origin }: { origin: string }) =>
        !origin || origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://'),
    })
    this.status = { name: 'Browser extension', state: 'running', detail: `waiting for extension on :${port}` }
    this.wss.on('error', (err) => {
      this.status = { name: 'Browser extension', state: 'error', detail: err.message }
      log('bridge', err.message, 'error')
    })
    this.wss.on('connection', (ws) => {
      let authed = false
      const authTimer = setTimeout(() => !authed && ws.close(4001, 'auth timeout'), 5000)
      ws.on('message', (buf) => {
        let msg: ExtensionMessage
        try {
          msg = JSON.parse(String(buf))
        } catch {
          return
        }
        if (!authed) {
          if (msg.type === 'hello' && msg.token === this.cfg().token) {
            authed = true
            clearTimeout(authTimer)
            this.clients.add(ws)
            this.refreshStatus()
            ws.send(JSON.stringify({ type: 'ok' }))
          } else {
            ws.close(4003, 'bad token')
          }
          return
        }
        if (msg.type === 'event' && msg.event) this.onEvent(msg.event)
      })
      ws.on('close', () => {
        clearTimeout(authTimer)
        this.clients.delete(ws)
        this.refreshStatus()
      })
    })
  }

  stop() {
    for (const c of this.clients) c.close()
    this.clients.clear()
    this.wss?.close()
    this.wss = null
    this.status = { name: 'Browser extension', state: 'stopped' }
  }

  private refreshStatus() {
    const n = this.clients.size
    this.status = {
      name: 'Browser extension',
      state: 'running',
      detail: n ? `${n} browser${n > 1 ? 's' : ''} connected` : `waiting for extension on :${this.cfg().port}`,
    }
  }

  private onEvent(e: NonNullable<ExtensionMessage['event']>) {
    if (!ALLOWED_KINDS.includes(e.kind)) return
    const app = (e.url && appFromUrl(e.url, this.cfg().crmPort)) || 'Browser'
    this.emit({
      source: 'browser',
      kind: e.kind,
      app,
      url: e.url,
      title: e.title?.slice(0, 200),
      target: e.target?.slice(0, 120),
      data: e.data,
      ts: typeof e.ts === 'number' ? e.ts : undefined,
    })
  }
}
