import { ipcRenderer, contextBridge } from 'electron'
import { API_METHODS, PUSH_CHANNELS, type ApiMethod, type PushChannel } from './shared/api'

// The renderer gets exactly the typed API surface: allowlisted methods and
// push channels, never raw ipcRenderer.
const call = (method: ApiMethod, ...args: unknown[]) => {
  if (!API_METHODS.includes(method)) return Promise.reject(new Error(`Unknown method ${method}`))
  return ipcRenderer.invoke('wf:call', method, ...args).then((r: { ok: boolean; value?: unknown; error?: string }) => {
    if (!r.ok) throw new Error(r.error)
    return r.value
  })
}

contextBridge.exposeInMainWorld('wf', {
  call,
  on(channel: PushChannel, fn: (payload: unknown) => void) {
    if (!PUSH_CHANNELS.includes(channel)) throw new Error(`Unknown channel ${channel}`)
    const listener = (_: unknown, payload: unknown) => fn(payload)
    ipcRenderer.on(`wf:${channel}`, listener)
    return () => ipcRenderer.off(`wf:${channel}`, listener)
  },
})
