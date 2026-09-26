import type { ActivityEvent } from '../shared/types'

/** A semantic step extracted from one or more raw events. */
export interface Step {
  token: string
  ts: number
  eventIds: string[]
  app: string
  /** Session boundary marker (idle, long gap). */
  isBreak?: boolean
}

const EDIT_ROLES = /^(textfield|textarea|text field|edit|document|combobox|searchfield|text area)/i

/** Lowercase, strip counts/ids so "Inbox (12)" and "Inbox (3)" become one token. */
export function normTarget(t: string): string {
  return t
    .toLowerCase()
    .replace(/<email>|<num>/g, '')
    .replace(/\(\d+\)|\d+/g, '')
    .replace(/[^a-z:#\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
}

function path(url?: string): { path: string; hash: string; query: string } {
  if (!url) return { path: '', hash: '', query: '' }
  try {
    const u = new URL(url)
    return { path: u.pathname, hash: u.hash, query: u.search }
  } catch {
    return { path: '', hash: '', query: '' }
  }
}

/**
 * Semantic rules for well-known apps. Returning undefined falls through to the
 * generic mapping; returning null marks the event as noise.
 */
function knownAppToken(ev: ActivityEvent): string | null | undefined {
  const t = normTarget(ev.target ?? '')
  const { path: p, hash } = path(ev.url)

  if (ev.app === 'Gmail') {
    if (ev.kind === 'navigate') {
      // #inbox/FMfcgz... or #label/Support/FMfcgz... → an opened thread
      if (/^#[^/]+(\/[^/]+)*\/[A-Za-z0-9]{12,}$/.test(hash)) return 'Gmail:open_email'
      return null
    }
    if (ev.kind === 'download' || /download/.test(t)) return 'Gmail:download_attachment'
    if (/\bsend\b/.test(t)) return 'Gmail:send_email'
    if (/\breply\b/.test(t)) return 'Gmail:reply'
    return undefined
  }

  if (ev.app === 'CRM') {
    if (ev.kind === 'navigate') {
      if (/^\/customers\/[^/]+$/.test(p)) return 'CRM:open_customer'
      if (/^\/customers\/?$/.test(p)) return 'CRM:search_customer'
      return null
    }
    if (ev.kind === 'submit' && /search/.test(t)) return 'CRM:search_customer'
    if (ev.kind === 'input' && /search/.test(t)) return 'CRM:search_customer'
    if (ev.kind === 'input' && /attach|file/.test(t)) return 'CRM:attach_file'
    if (ev.kind === 'input' && /note|request/.test(t)) return 'CRM:edit_record'
    if ((ev.kind === 'submit' || ev.kind === 'click') && /save|update|note/.test(t)) return 'CRM:update_customer'
    return undefined
  }

  if (ev.app === 'Slack') {
    if (ev.kind === 'navigate') return /\/client\/[^/]+\/[CDG][A-Z0-9]+/.test(p) ? 'Slack:open_channel' : null
    if (ev.kind === 'submit' || /send/.test(t)) return 'Slack:send_message'
    if ((ev.kind === 'input' || ev.kind === 'ui_focus') && /message/.test(t)) return 'Slack:compose_message'
    return undefined
  }

  return undefined
}

export function toStep(ev: ActivityEvent): Step | null {
  const base = { ts: ev.ts, eventIds: [ev.id], app: ev.app }
  if (ev.kind === 'idle') return { ...base, token: '|', isBreak: true }
  if (ev.kind === 'app_focus') return null

  const known = knownAppToken(ev)
  if (known === null) return null
  if (known) return { ...base, token: known }

  const t = normTarget(ev.target ?? '')
  switch (ev.kind) {
    case 'file_created': {
      const ext = ev.target?.split(':')[1] ?? 'file'
      // A spreadsheet saved while working = an Excel/Numbers edit, not a download.
      if (/^(xlsx|xlsm|xls|csv|numbers)$/.test(ext) && ev.data?.modified) return { ...base, app: 'Excel', token: `Excel:save_sheet` }
      return { ...base, token: `Files:save_${ext}` }
    }
    case 'download':
      return { ...base, token: `${ev.app}:download` }
    case 'navigate':
      return { ...base, token: `${ev.app}:view` }
    case 'submit':
      if (ev.data?.key === 'Enter') return { ...base, token: `${ev.app}:press_enter:${normTarget((ev.target ?? '').replace(/^key:Enter in /, ''))}` }
      return { ...base, token: `${ev.app}:submit${t ? ':' + t : ''}` }
    case 'click':
      return t ? { ...base, token: `${ev.app}:click:${t}` } : null
    case 'input':
      return { ...base, token: `${ev.app}:edit${t ? ':' + t.replace(/^field:/, '') : ''}` }
    case 'ui_focus': {
      const [role, ...rest] = (ev.target ?? '').split(':')
      if (!EDIT_ROLES.test(role)) return null
      return { ...base, token: `${ev.app}:edit:${normTarget(rest.join(':'))}` }
    }
    default:
      return null
  }
}

/**
 * Events → steps: map, merge a download with the file it produced, and collapse
 * consecutive duplicates (typing in a field fires many input events).
 */
export function abstractEvents(events: ActivityEvent[]): Step[] {
  const out: Step[] = []
  let lastDownloadTs = -Infinity
  let lastClick: ActivityEvent | null = null
  for (const ev of events) {
    // A form submit right after clicking its button is the same user action.
    if (ev.kind === 'submit' && ev.data?.viaButton && lastClick && ev.ts - lastClick.ts < 2500 && out.length) {
      out[out.length - 1].eventIds.push(ev.id)
      continue
    }
    lastClick = ev.kind === 'click' ? ev : null
    const step = toStep(ev)
    if (!step) continue
    if (ev.kind === 'download' || step.token.endsWith(':download_attachment')) lastDownloadTs = ev.ts
    if (ev.kind === 'file_created' && ev.ts - lastDownloadTs < 15_000) {
      out[out.length - 1]?.eventIds.push(ev.id)
      continue
    }
    const prev = out[out.length - 1]
    if (prev && prev.token === step.token) {
      prev.eventIds.push(...step.eventIds)
      continue
    }
    out.push(step)
  }
  return out
}
