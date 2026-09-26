// WorkFlowOS background worker: tab navigation + downloads, and the
// authenticated WebSocket link to the desktop agent on 127.0.0.1.

const DEFAULT_PORT = 4546
let ws = null
let authed = false
let queue = []
let reconnectTimer = null
let state = 'disconnected'

async function config() {
  const { token = '', port = DEFAULT_PORT, enabled = true } = await chrome.storage.local.get(['token', 'port', 'enabled'])
  return { token, port, enabled }
}

async function connect() {
  const { token, port, enabled } = await config()
  if (!enabled || !token) {
    state = token ? 'paused' : 'needs token'
    return
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}`)
  } catch {
    scheduleReconnect()
    return
  }
  state = 'connecting'
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token }))
  ws.onmessage = (m) => {
    try {
      const msg = JSON.parse(m.data)
      if (msg.type === 'ok') {
        authed = true
        state = 'connected'
        for (const e of queue.splice(0)) ws.send(JSON.stringify({ type: 'event', event: e }))
      }
    } catch {
      /* ignore */
    }
  }
  ws.onclose = (e) => {
    authed = false
    ws = null
    state = e.code === 4003 ? 'bad token' : 'disconnected'
    if (e.code !== 4003) scheduleReconnect()
  }
  ws.onerror = () => {}
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(connect, 5000)
}

function send(event) {
  if (ws && authed && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'event', event }))
  else {
    queue.push(event)
    if (queue.length > 200) queue.shift()
    connect()
  }
}

// Keep the service worker (and socket) alive while connected.
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
  else connect()
}, 20_000)

const isWeb = (url) => /^https?:\/\//.test(url || '')

// ---------- navigation (active tab only, to skip background noise) ----------

const lastSent = new Map()
function navigate(tab) {
  if (!tab || !tab.active || !isWeb(tab.url) || tab.incognito) return
  const key = `${tab.url}|${tab.title}`
  if (lastSent.get(tab.id) === key) return
  lastSent.set(tab.id, key)
  send({ kind: 'navigate', url: tab.url, title: tab.title, ts: Date.now() })
}

chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (info.url || info.status === 'complete') navigate(tab)
})
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  lastSent.delete(tabId)
  navigate(await chrome.tabs.get(tabId).catch(() => null))
})

// ---------- downloads ----------

const pending = new Map()
chrome.downloads.onCreated.addListener((item) => {
  if (item.incognito) return
  pending.set(item.id, item)
})
chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.filename?.current) return
  const item = pending.get(delta.id)
  pending.delete(delta.id)
  if (!item) return
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  const url = isWeb(item.referrer) ? item.referrer : tab?.url
  send({
    kind: 'download',
    url,
    title: tab?.title,
    target: 'attachment',
    data: { filename: delta.filename.current.split(/[\\/]/).pop(), mime: item.mime },
    ts: Date.now(),
  })
})

// ---------- content script events ----------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'wf-event' && sender.tab && !sender.tab.incognito) {
    send(msg.event)
  } else if (msg?.type === 'wf-status') {
    reply({ state, queued: queue.length })
  } else if (msg?.type === 'wf-reconnect') {
    ws?.close()
    ws = null
    connect().then(() => reply({ state }))
    return true
  }
})

chrome.runtime.onStartup.addListener(connect)
chrome.runtime.onInstalled.addListener(connect)
connect()
