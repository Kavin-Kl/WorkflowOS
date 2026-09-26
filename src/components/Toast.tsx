import { useEffect, useState } from 'react'

type Toast = { text: string; err?: boolean; id: number }
let push: ((t: Toast) => void) | null = null

export function toast(text: string, err = false) {
  push?.({ text, err, id: Date.now() })
}

/** Wrap an async action: shows errors as toasts, optional success message. */
export async function attempt<T>(fn: () => Promise<T>, success?: string | ((v: T) => string)): Promise<T | undefined> {
  try {
    const v = await fn()
    if (success) toast(typeof success === 'function' ? success(v) : success)
    return v
  } catch (e) {
    toast((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true)
    return undefined
  }
}

export function Toaster() {
  const [t, setT] = useState<Toast | null>(null)
  useEffect(() => {
    push = setT
    return () => {
      push = null
    }
  }, [])
  useEffect(() => {
    if (!t) return
    const h = setTimeout(() => setT(null), t.err ? 6000 : 3500)
    return () => clearTimeout(h)
  }, [t])
  return t ? <div className={`toast ${t.err ? 'err' : ''}`}>{t.text}</div> : null
}
