const $ = (id) => document.getElementById(id)

async function refresh() {
  const r = await chrome.runtime.sendMessage({ type: 'wf-status' }).catch(() => null)
  const s = r?.state ?? 'unknown'
  $('state').textContent = `● ${s}${r?.queued ? ` · ${r.queued} queued` : ''}`
  $('state').className = `state ${s === 'connected' ? 'connected' : ''}`
}

chrome.storage.local.get(['token', 'port', 'enabled']).then(({ token = '', port = 4546, enabled = true }) => {
  $('token').value = token
  $('port').value = port
  $('enabled').checked = enabled
})

$('save').onclick = async () => {
  await chrome.storage.local.set({ token: $('token').value.trim(), port: Number($('port').value) || 4546, enabled: $('enabled').checked })
  await chrome.runtime.sendMessage({ type: 'wf-reconnect' }).catch(() => null)
  setTimeout(refresh, 600)
}
$('enabled').onchange = () => $('save').onclick()

refresh()
setInterval(refresh, 1500)
