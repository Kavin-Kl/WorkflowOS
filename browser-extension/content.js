// WorkFlowOS content script: turns DOM interactions into semantic events.
// Sends labels ("button:Save update", "field:Request notes"), never values.

(() => {
  const SENSITIVE = /pass(word)?|pwd|otp|one.?time|cvv|cvc|card|iban|ssn|secret|token|pin\b/i

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
    return SENSITIVE.test(labelFor(el)) || SENSITIVE.test(el.name || '')
  }

  function send(kind, target, data) {
    try {
      chrome.runtime.sendMessage({ type: 'wf-event', event: { kind, target, data, url: location.href, title: document.title, ts: Date.now() } })
    } catch {
      // extension reloaded; ignore
    }
  }

  const CLICKABLE = 'button, a, [role="button"], [role="menuitem"], [role="tab"], [role="link"], input[type="submit"], input[type="button"], summary'

  document.addEventListener(
    'click',
    (e) => {
      const el = e.target instanceof Element ? e.target.closest(CLICKABLE) : null
      if (!el || isSensitive(el)) return
      const role = el.getAttribute('role') || (el.tagName === 'A' ? 'link' : 'button')
      const label = labelFor(el) || clean(el.innerText || el.value || '')
      if (!label) return
      send('click', `${role}:${label}`)
    },
    true,
  )

  document.addEventListener(
    'change',
    (e) => {
      const el = e.target
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return
      if (isSensitive(el)) return
      const label = labelFor(el) || el.tagName.toLowerCase()
      const data = el.type === 'file' ? { files: el.files ? el.files.length : 0 } : { length: (el.value || '').length }
      send('input', `field:${label}`, data)
    },
    true,
  )

  // Rich editors (Slack, Gmail compose) are contenteditable and never fire "change".
  let editTimer = null
  document.addEventListener(
    'input',
    (e) => {
      const el = e.target instanceof Element ? e.target.closest('[contenteditable="true"], [role="textbox"]') : null
      if (!el || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
      clearTimeout(editTimer)
      editTimer = setTimeout(() => send('input', `field:${labelFor(el) || 'editor'}`, { length: (el.textContent || '').length }), 1200)
    },
    true,
  )

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
      const el = e.target instanceof Element ? e.target.closest('[contenteditable="true"], [role="textbox"]') : null
      if (!el || el instanceof HTMLTextAreaElement) return
      if (!(el.textContent || '').trim()) return
      clearTimeout(editTimer)
      send('submit', `form:Send ${labelFor(el) || 'message'}`)
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
      send('submit', `button:${label}`)
    },
    true,
  )
})()
