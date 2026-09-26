import { getSecret, getSettings } from '../core/settings'

/** Post via bot token (chat.postMessage) or an incoming webhook, per Settings. */
export async function slackSend(channel: string, text: string): Promise<{ ts: string }> {
  const mode = getSettings().slackMode
  if (mode === 'bot') {
    const token = getSecret('slackToken')
    if (!token) throw new Error('Slack bot token not configured')
    const r = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: channel.replace(/^#/, ''), text }),
    })
    const body = (await r.json()) as { ok: boolean; ts?: string; error?: string }
    if (!body.ok) throw new Error(`Slack: ${body.error}`)
    return { ts: body.ts ?? '' }
  }
  if (mode === 'webhook') {
    const url = getSecret('slackWebhook')
    if (!url) throw new Error('Slack webhook URL not configured')
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
    if (!r.ok) throw new Error(`Slack webhook ${r.status}: ${await r.text()}`)
    return { ts: String(Date.now() / 1000) }
  }
  throw new Error('Slack is not configured')
}

export function slackConfigured(): boolean {
  const mode = getSettings().slackMode
  return (mode === 'bot' && !!getSecret('slackToken')) || (mode === 'webhook' && !!getSecret('slackWebhook'))
}
