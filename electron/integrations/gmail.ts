import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import { getSecret, getSettings, setSecret, updateSettings } from '../core/settings'
import { log } from '../core/bus'

// Gmail over plain REST with an OAuth 2.0 loopback + PKCE flow (Google
// "Desktop app" client). No SDK dependency.

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'openid', 'email']
const API = 'https://gmail.googleapis.com/gmail/v1/users/me'

let accessToken = ''
let accessExpiry = 0

export async function connectGmail(): Promise<string> {
  const clientId = getSettings().gmailClientId
  const clientSecret = getSecret('gmailClientSecret')
  if (!clientId || !clientSecret) throw new Error('Add your Google OAuth client ID and secret first')

  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  const state = crypto.randomBytes(16).toString('hex')

  const code = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/') return res.end()
      const ok = url.searchParams.get('state') === state && url.searchParams.get('code')
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<html><body style="font-family:system-ui;padding:40px">${ok ? 'WorkFlowOS is connected to Gmail. You can close this tab.' : 'Authorization failed.'}</body></html>`)
      server.close()
      clearTimeout(timer)
      if (ok) resolve({ code: url.searchParams.get('code')!, redirect })
      else reject(new Error(url.searchParams.get('error') || 'Authorization failed'))
    })
    let redirect = ''
    const timer = setTimeout(() => {
      server.close()
      reject(new Error('Timed out waiting for Google sign-in'))
    }, 5 * 60_000)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      redirect = `http://127.0.0.1:${port}`
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      auth.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        response_type: 'code',
        scope: SCOPES.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
        state,
      }).toString()
      shell.openExternal(auth.toString())
    })
  })

  const tok = await tokenRequest({
    grant_type: 'authorization_code',
    code: code.code,
    redirect_uri: code.redirect,
    code_verifier: verifier,
    client_id: clientId,
    client_secret: clientSecret,
  })
  if (!tok.refresh_token) throw new Error('Google did not return a refresh token')
  setSecret('gmailRefreshToken', tok.refresh_token)
  accessToken = tok.access_token
  accessExpiry = Date.now() + (tok.expires_in - 60) * 1000
  const profile = await gmailFetch<{ emailAddress: string }>('/profile')
  updateSettings({ gmailAccount: profile.emailAddress })
  log('gmail', `Connected as ${profile.emailAddress}`)
  return profile.emailAddress
}

export function disconnectGmail() {
  setSecret('gmailRefreshToken', '')
  accessToken = ''
  updateSettings({ gmailAccount: undefined })
}

async function tokenRequest(params: Record<string, string>) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
  const body = (await r.json()) as { access_token: string; refresh_token?: string; expires_in: number; error?: string; error_description?: string }
  if (!r.ok) throw new Error(body.error_description || body.error || `Token request failed (${r.status})`)
  return body
}

async function token(): Promise<string> {
  if (accessToken && Date.now() < accessExpiry) return accessToken
  const refresh = getSecret('gmailRefreshToken')
  if (!refresh) throw new Error('Gmail is not connected')
  const tok = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: getSettings().gmailClientId,
    client_secret: getSecret('gmailClientSecret'),
  })
  accessToken = tok.access_token
  accessExpiry = Date.now() + (tok.expires_in - 60) * 1000
  return accessToken
}

async function gmailFetch<T>(p: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${API}${p}`, {
    ...init,
    headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  if (!r.ok) throw new Error(`Gmail ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return (await r.json()) as T
}

export function gmailConnected(): boolean {
  return !!getSecret('gmailRefreshToken')
}

// ---------- Messages ----------

interface Part {
  mimeType: string
  filename?: string
  headers?: { name: string; value: string }[]
  body?: { data?: string; attachmentId?: string; size?: number }
  parts?: Part[]
}

export interface EmailMessage {
  messageId: string
  threadId: string
  from: string
  fromName: string
  fromAddress: string
  subject: string
  body: string
  receivedAt: number
  hasAttachment: boolean
  attachments: { filename: string; attachmentId: string; mimeType: string; size: number }[]
  rfcMessageId: string
}

export async function listMessageIds(query: string, max = 10): Promise<string[]> {
  const r = await gmailFetch<{ messages?: { id: string }[] }>(`/messages?q=${encodeURIComponent(query)}&maxResults=${max}`)
  return (r.messages ?? []).map((m) => m.id)
}

const decode = (data: string) => Buffer.from(data, 'base64url').toString('utf8')

function walk(part: Part, out: { text: string[]; html: string[]; atts: EmailMessage['attachments'] }) {
  if (part.filename && part.body?.attachmentId) {
    out.atts.push({ filename: part.filename, attachmentId: part.body.attachmentId, mimeType: part.mimeType, size: part.body.size ?? 0 })
  } else if (part.mimeType === 'text/plain' && part.body?.data) out.text.push(decode(part.body.data))
  else if (part.mimeType === 'text/html' && part.body?.data) out.html.push(decode(part.body.data))
  for (const p of part.parts ?? []) walk(p, out)
}

export async function getMessage(id: string): Promise<EmailMessage> {
  const m = await gmailFetch<{ id: string; threadId: string; internalDate: string; payload: Part }>(`/messages/${id}?format=full`)
  const header = (n: string) => m.payload.headers?.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? ''
  const out = { text: [] as string[], html: [] as string[], atts: [] as EmailMessage['attachments'] }
  walk(m.payload, out)
  const from = header('From')
  const addr = from.match(/<([^>]+)>/)?.[1] ?? from.trim()
  const body = out.text.join('\n').trim() || out.html.join('\n').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return {
    messageId: m.id,
    threadId: m.threadId,
    from,
    fromName: from.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || addr,
    fromAddress: addr,
    subject: header('Subject'),
    body: body.slice(0, 20_000),
    receivedAt: Number(m.internalDate),
    hasAttachment: out.atts.length > 0,
    attachments: out.atts,
    rfcMessageId: header('Message-ID'),
  }
}

export async function downloadAttachment(messageId: string, dir: string, filenameContains?: string) {
  const msg = await getMessage(messageId)
  const att = msg.attachments.find((a) => !filenameContains || a.filename.toLowerCase().includes(filenameContains.toLowerCase())) ?? null
  if (!att) return { found: false, path: '', name: '' }
  const data = await gmailFetch<{ data: string }>(`/messages/${messageId}/attachments/${att.attachmentId}`)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${Date.now()}_${path.basename(att.filename).replace(/[^\w.-]+/g, '_')}`)
  fs.writeFileSync(file, Buffer.from(data.data, 'base64url'))
  return { found: true, path: file, name: att.filename }
}

export async function replyTo(messageId: string, text: string): Promise<string> {
  const msg = await getMessage(messageId)
  const subject = msg.subject.toLowerCase().startsWith('re:') ? msg.subject : `Re: ${msg.subject}`
  const raw = [
    `To: ${msg.from}`,
    `Subject: ${subject}`,
    `In-Reply-To: ${msg.rfcMessageId}`,
    `References: ${msg.rfcMessageId}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    text,
  ].join('\r\n')
  const r = await gmailFetch<{ id: string }>('/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url'), threadId: msg.threadId }),
  })
  return r.id
}
