import type { ActivityEvent, PatternOccurrence, WorkflowStep } from '../shared/types'

// Replay compiler: turns the observed events of a repeated workflow into
// executable web / desktop steps. Values that were identical in every
// occurrence become constants; values that differed become run inputs.

export interface CompiledReplay {
  steps: Omit<WorkflowStep, 'id'>[]
  variables: { name: string; description: string; from: string; example?: string }[]
}

type Hints = { role?: string; name?: string; text?: string; testid?: string; placeholder?: string; app?: string; tag?: string; type?: string }

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'value'
  )
}

const hintsOf = (e: ActivityEvent): Hints => (e.data?.hints as Hints) ?? {}
const fieldLabel = (e: ActivityEvent) => (e.target ?? '').replace(/^field:/, '')

function pageUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}${u.hash}`
  } catch {
    return url
  }
}

/** Longest common URL prefix, cut at a path boundary. */
function commonUrl(urls: string[]): string {
  if (urls.every((u) => u === urls[0])) return urls[0]
  let prefix = urls[0]
  for (const u of urls) while (!u.startsWith(prefix)) prefix = prefix.slice(0, -1)
  const cut = prefix.lastIndexOf('/')
  return cut > 8 ? prefix.slice(0, cut + 1) : new URL(urls[0]).origin
}

/**
 * @param isCovered  tokens handled by an API/app action instead of replay
 * @param stepIndexes which signature positions to compile
 */
export function compileReplay(
  signature: string[],
  occurrences: PatternOccurrence[],
  byId: Map<string, ActivityEvent>,
  isCovered: (token: string) => boolean,
): Map<number, CompiledReplay> {
  const exact = occurrences.filter((o) => o.steps && o.steps.length === signature.length)
  const out = new Map<number, CompiledReplay>()
  if (!exact.length) return out
  const rep = exact[exact.length - 1]
  const evsAt = (occ: PatternOccurrence, i: number) => (occ.steps![i] ?? []).map((id) => byId.get(id)).filter((e): e is ActivityEvent => !!e)

  const usedVars = new Set<string>()
  let webPage = '' // URL the replay browser is currently on
  let lastActionTs = -Infinity
  let desktopApp = ''
  let lastClick = { name: '', ts: -Infinity }

  signature.forEach((token, i) => {
    if (isCovered(token)) return
    const steps: Omit<WorkflowStep, 'id'>[] = []
    const variables: CompiledReplay['variables'] = []
    const events = evsAt(rep, i)

    /** Same field's final value in every exact occurrence. */
    const valuesFor = (label: string, source: string) =>
      exact.map((occ) => {
        const matches = evsAt(occ, i).filter((e) => e.kind === 'input' && e.source === source && fieldLabel(e) === label)
        return matches.length ? String(matches[matches.length - 1].data?.value ?? '') : undefined
      })

    const valueParam = (label: string, source: string, fallback: string): string => {
      const vals = valuesFor(label, source)
      const known = vals.filter((v): v is string => v !== undefined)
      if (known.length && known.every((v) => v === known[0]) && known.length === vals.length) return known[0]
      let name = slug(label)
      while (usedVars.has(name) && !variables.some((v) => v.name === name)) name += '_2'
      if (!usedVars.has(name)) {
        usedVars.add(name)
        variables.push({ name, description: label || 'value', from: 'input', example: known[known.length - 1] ?? fallback })
      }
      return `{{input.${name}}}`
    }

    const ensurePage = (ev: ActivityEvent) => {
      if (!ev.url) return
      const url = pageUrl(ev.url)
      if (url === webPage) return
      const urls = exact.map((occ) => evsAt(occ, i).find((e) => e.kind === ev.kind && e.url)?.url).filter((u): u is string => !!u).map(pageUrl)
      const varies = urls.some((u) => u !== urls[0])
      // Arrived here because of the previous click/submit (soon after it, or at a
      // URL that differs every time, like a new record's page) → replaying the
      // click gets us here too.
      const sameOrigin = webPage && new URL(url).origin === new URL(webPage).origin
      if (sameOrigin && (ev.ts - lastActionTs < 6000 || (varies && lastActionTs > -Infinity))) {
        webPage = url
        return
      }
      const target = urls.length > 1 ? commonUrl(urls) : url
      steps.push({ action: 'web.open', label: `Open ${new URL(target).host}${new URL(target).pathname}`, params: { url: target }, onError: 'ask_user' })
      webPage = url
    }

    const ensureApp = (app: string) => {
      if (!app || app === desktopApp) return
      steps.push({ action: 'desktop.open_app', label: `Switch to ${app}`, params: { app }, onError: 'ask_user' })
      desktopApp = app
    }

    for (const ev of events) {
      const h = hintsOf(ev)
      if (ev.source === 'browser') {
        desktopApp = ''
        if (ev.kind === 'navigate') {
          ensurePage(ev)
          continue
        }
        ensurePage(ev)
        if (ev.kind === 'click') {
          const name = h.name || (ev.target ?? '').split(':').slice(1).join(':')
          const params: Record<string, string> = { name }
          if (h.role) params.role = h.role
          if (h.text && h.text !== name) params.text = h.text
          if (h.testid) params.testid = h.testid
          steps.push({ action: 'web.click', label: `Click ${h.role ?? 'element'} "${name}"`, params, onError: 'ask_user' })
          lastActionTs = ev.ts
          lastClick = { name, ts: ev.ts }
        } else if (ev.kind === 'input') {
          const label = fieldLabel(ev)
          const params: Record<string, string> = { label }
          if (h.placeholder) params.placeholder = h.placeholder
          if (h.testid) params.testid = h.testid
          if (Array.isArray(ev.data?.files)) {
            const name = slug(`${label} file`)
            if (!usedVars.has(name)) {
              usedVars.add(name)
              variables.push({ name, description: `File for "${label}"`, from: '{{attachment.path}}' })
            }
            steps.push({ action: 'web.upload', label: `Attach file to "${label}"`, params: { label, path: `{{input.${name}}}` }, onError: 'ask_user' })
          } else {
            params.value = valueParam(label, 'browser', String(ev.data?.value ?? ''))
            const prev = steps[steps.length - 1]
            if (prev?.action === 'web.fill' && prev.params.label === label) steps.pop()
            steps.push({ action: 'web.fill', label: `Fill "${label}"`, params, onError: 'ask_user' })
          }
        } else if (ev.kind === 'submit') {
          // A form submitted by clicking its button: the replayed click submits it.
          if (ev.data?.viaButton && ev.ts - lastClick.ts < 6000) continue
          const label = h.name || (ev.target ?? '').replace(/^key:Enter in /, '')
          const params: Record<string, string> = { key: 'Enter' }
          if (label && label !== 'editor' && label !== 'input') params.label = label
          if (h.placeholder) params.placeholder = h.placeholder
          steps.push({ action: 'web.press', label: `Press Enter${params.label ? ` in "${params.label}"` : ''}`, params, onError: 'ask_user' })
          lastActionTs = ev.ts
        }
      } else if (ev.source === 'accessibility') {
        const app = h.app || ev.app
        if (ev.kind === 'input') {
          ensureApp(app)
          const label = fieldLabel(ev)
          steps.push({ action: 'desktop.type', label: `Type into "${label}" in ${ev.app}`, params: { app, label, value: valueParam(label, 'accessibility', '') }, onError: 'ask_user' })
        } else if (ev.kind === 'click') {
          ensureApp(app)
          const name = h.name || (ev.target ?? '').split(':').slice(1).join(':')
          steps.push({ action: 'desktop.click', label: `Press "${name}" in ${ev.app}`, params: { app, name, role: h.role ?? 'button' }, onError: 'ask_user' })
        }
      }
    }
    if (steps.length) out.set(i, { steps, variables })
  })
  return out
}
