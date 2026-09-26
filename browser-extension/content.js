// WorkFlowOS content script: turns DOM interactions into semantic events with
// enough locator hints to replay them. Typed values are sent to the local
// desktop agent only (never to a server) and never for sensitive fields.

(() => {
  const SENSITIVE = /pass(word)?|pwd|otp|one.?time|cvv|cvc|card.?(number|no)|iban|ssn|social.?security|secret|token|\bpin\b/i

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 80)

  function labelFor(el) {
    if (!el) return ''
    const aria = el.getAttribute('aria-label')
    if (aria) return clean(aria)
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const txt = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ')
      if (clean(txt)) return clean(txt)
    }
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      if (lbl) return clean(lbl.textContent)
    }
    const wrap = el.closest('label')
    if (wrap) return clean(wrap.textContent)
    return clean(el.getAttribute('data-tooltip') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || '')
  }

  function isSensitive(el) {
    if (!el) return false
    if (el.type === 'password' || el.type === 'hidden') return true
    const ac = el.getAttribute('autocomplete') || ''
    if (/cc-|password|one-time-code/.test(ac)) return true
    return SENSITIVE.test(labelFor(el)) || SENSITIVE.test(el.name || '') || SENSITIVE.test(el.id || '')
  }

  function roleOf(el) {
    const r = el.getAttribute('role')
    if (r) return r
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button' || (tag === 'input' && /^(submit|button|reset)$/.test(el.type))) return 'button'
    if (tag === 'textarea' || (tag === 'input' && /^(text|email|search|tel|url|number|)$/.test(el.type || ''))) return 'textbox'
    if (tag === 'select') return 'combobox'
    if (tag === 'input' && el.type === 'checkbox') return 'checkbox'
    if (el.isContentEditable) return 'textbox'
    return tag
  }

  /** Locator hints for replay: tried in order by the automation engine. */
  function hints(el) {
    const h = {
      role: roleOf(el),
      name: labelFor(el) || clean(el.innerText || el.value || ''),
      tag: el.tagName.toLowerCase(),
    }
    const testid = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-qa')
    if (testid) h.testid = testid
    if (el.id && !/\d{3,}|[:]/.test(el.id)) h.id = el.id
    if (el.getAttribute('placeholder')) h.placeholder = clean(el.getAttribute('placeholder'))
    if (el.type) h.type = el.type
    const text = clean(el.innerText || '')
    if (text && text !== h.name) h.text = text
    return h
  }

  function send(kind, target, data) {
    try {
      chrome.runtime.sendMessage({ type: 'wf-event', event: { kind, target, data, url: location.href, title: document.title, ts: Date.now() } })
    } catch {
      // extension reloaded; ignore
    }
  }

  const CLICKABLE = 'button, a, [role="button"], [role="menuitem"], [role="tab"], [role="link"], [role="option"], [role="checkbox"], input[type="submit"], input[type="button"], input[type="checkbox"], summary'

  document.addEventListener(
    'click',
    (e) => {
      const el = e.target instanceof Element ? e.target.closest(CLICKABLE) : null
      if (!el || isSensitive(el)) return
      const h = hints(el)
      if (!h.name && !h.testid) return
      send('click', `${h.role}:${h.name || h.testid}`, { hints: h })
    },
    true,
  )

  document.addEventListener(
    'change',
    (e) => {
      const el = e.target
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return
      if (isSensitive(el) || el.type === 'checkbox' || el.type === 'radio') return
      const h = hints(el)
      const label = h.name || h.placeholder || el.tagName.toLowerCase()
      const data = { hints: h }
      if (el.type === 'file') {
        data.files = el.files ? [...el.files].map((f) => f.name) : []
      } else {
        data.value = String(el.value || '').slice(0, 2000)
        data.length = data.value.length
      }
      send('input', `field:${label}`, data)
    },
    true,
  )

  // Rich editors (Slack, Gmail compose) are contenteditable and never fire "change".
  let editTimer = null
  let editEl = null
  const flushEdit = () => {
    if (!editEl) return
    const el = editEl
    editEl = null
    clearTimeout(editTimer)
    const h = hints(el)
    const value = (el.innerText || el.textContent || '').slice(0, 2000)
    send('input', `field:${h.name || 'editor'}`, { hints: h, value, length: value.length })
  }
  document.addEventListener(
    'input',
    (e) => {
      const el = e.target instanceof Element ? e.target.closest('[contenteditable="true"], [contenteditable=""], [role="textbox"]') : null
      if (!el || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || isSensitive(el)) return
      editEl = el
      clearTimeout(editTimer)
      editTimer = setTimeout(flushEdit, 1200)
    },
    true,
  )

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
      const t = e.target instanceof Element ? e.target : null
      if (!t) return
      const editor = t.closest('[contenteditable="true"], [contenteditable=""], [role="textbox"]')
      const field = t instanceof HTMLInputElement && !isSensitive(t) ? t : null
      if (editor && !(editor instanceof HTMLTextAreaElement) && !(editor instanceof HTMLInputElement)) {
        if (!(editor.innerText || '').trim()) return
        flushEdit()
        send('submit', `key:Enter in ${labelFor(editor) || 'editor'}`, { key: 'Enter', hints: hints(editor) })
      } else if (field && !field.form) {
        // Enter in a standalone input (no form → no submit event), e.g. todo apps, search boxes.
        send('input', `field:${labelFor(field) || field.placeholder || 'input'}`, { hints: hints(field), value: String(field.value || '').slice(0, 2000) })
        send('submit', `key:Enter in ${labelFor(field) || field.placeholder || 'input'}`, { key: 'Enter', hints: hints(field) })
      }
    },
    true,
  )

  document.addEventListener(
    'submit',
    (e) => {
      const form = e.target
      if (!(form instanceof HTMLFormElement)) return
      if ([...form.elements].some((el) => el.type === 'password')) return
      const submitter = e.submitter
      const label = (submitter && (labelFor(submitter) || clean(submitter.innerText || submitter.value))) || labelFor(form) || form.getAttribute('role') || 'form'
      send('submit', `button:${label}`, submitter ? { hints: hints(submitter), viaButton: true } : { viaEnter: true })
    },
    true,
  )
})()
