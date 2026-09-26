import { useCallback, useEffect, useState } from 'react'
import type { AsyncApi, PushChannel } from '../electron/shared/api'

declare global {
  interface Window {
    wf: {
      call: (method: string, ...args: unknown[]) => Promise<unknown>
      on: (channel: PushChannel, fn: (payload: unknown) => void) => () => void
    }
  }
}

/** Typed proxy: api.listWorkflows() → main process. */
export const api = new Proxy({} as AsyncApi, {
  get: (_, method: string) => (...args: unknown[]) => window.wf.call(method, ...args),
})

export function onPush<T>(channel: PushChannel, fn: (payload: T) => void): () => void {
  return window.wf.on(channel, fn as (p: unknown) => void)
}

/** Load data and reload whenever any of the given push channels fire. */
export function useLive<T>(load: () => Promise<T>, channels: PushChannel[], initial: T): [T, () => void] {
  const [data, setData] = useState<T>(initial)
  const reload = useCallback(() => {
    load().then(setData).catch((e) => console.error(e))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    reload()
    let t: ReturnType<typeof setTimeout> | null = null
    const debounced = () => {
      if (t) clearTimeout(t)
      t = setTimeout(reload, 150)
    }
    const offs = channels.map((c) => onPush(c, debounced))
    return () => offs.forEach((off) => off())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return [data, reload]
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function fmtAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
