import type { ActivityEvent } from '../shared/types'

export interface PrivacyConfig {
  appBlocklist: string[]
  urlBlocklist: string[]
  /** Keep typed values (local only) so form filling can be learned and replayed. */
  recordValues: boolean
}

const SENSITIVE_TARGET = /pass(word)?|pwd|otp|2fa|cvv|card.?number|ssn|social.?security|secret|token|pin\b/i
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const LONG_DIGITS = /\b\d{6,}\b/g

/** Returns null if the event must be dropped entirely, otherwise a redacted copy. */
export function applyPrivacy(ev: ActivityEvent, cfg: PrivacyConfig): ActivityEvent | null {
  const appLower = ev.app.toLowerCase()
  if (cfg.appBlocklist.some((b) => b && appLower.includes(b.toLowerCase()))) return null
  if (ev.url) {
    const urlLower = ev.url.toLowerCase()
    if (cfg.urlBlocklist.some((b) => b && urlLower.includes(b.toLowerCase()))) return null
  }
  if (ev.target && SENSITIVE_TARGET.test(ev.target)) return null

  const out: ActivityEvent = { ...ev }
  if (out.title) out.title = scrub(out.title)
  if (out.target) out.target = scrub(out.target).slice(0, 80)
  if (out.url) out.url = stripQuery(out.url)
  if (out.data) {
    const data: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(out.data)) {
      // Typed values stay unscrubbed (replay needs them) but are local-only and
      // never included in anything sent to Gemini.
      if (k === 'value') {
        if (cfg.recordValues && typeof v === 'string') data[k] = v.slice(0, 2000)
        continue
      }
      data[k] = typeof v === 'string' ? scrub(v).slice(0, 200) : v
    }
    out.data = data
  }
  return out
}

function scrub(s: string): string {
  return s.replace(EMAIL, '<email>').replace(LONG_DIGITS, '<num>')
}

function stripQuery(url: string): string {
  try {
    const u = new URL(url)
    u.search = ''
    return u.toString()
  } catch {
    return url
  }
}
