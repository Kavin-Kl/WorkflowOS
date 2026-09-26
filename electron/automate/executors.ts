import fs from 'node:fs'
import path from 'node:path'
import type { Mechanism } from '../shared/types'
import type { Vars } from './vars'
import { getSettings } from '../core/settings'
import { generateJson, geminiAvailable } from '../understand/gemini'
import { downloadAttachment, gmailConnected, replyTo } from '../integrations/gmail'
import { slackConfigured, slackSend } from '../integrations/slack'
import { withPage } from './browser'

export interface ExecContext {
  vars: Vars
  dataDir: string
  log: (msg: string) => void
}

export interface Executor {
  action: string
  mechanism: Mechanism
  /** Human-readable name of the concrete mechanism, e.g. "Gmail REST API". */
  via: string
  available(ctx: ExecContext): string | true
  execute(params: Record<string, string>, ctx: ExecContext): Promise<Record<string, unknown>>
}

const isDemo = (ctx: ExecContext) => ctx.vars['email.demo'] === true
const crmBase = () => `http://localhost:${getSettings().crmPort}`

// ---------- AI ----------

const aiExtractApi: Executor = {
  action: 'ai.extract',
  mechanism: 'api',
  via: 'Gemini',
  available: () => (geminiAvailable() ? true : 'Gemini API key not configured'),
  async execute(params) {
    const fields = params.fields.split(',').map((f) => f.trim()).filter(Boolean)
    const out = await generateJson<Record<string, string>>({
      system:
        'Extract the requested fields from the text. Use an empty string when a field is not present. request_summary / summary fields: one concise sentence.',
      prompt: params.input,
      schema: { type: 'object', properties: Object.fromEntries(fields.map((f) => [f, { type: 'string' }])), required: fields },
      temperature: 0,
    })
    return out
  },
}

/** Local fallback: derive fields from email headers and the first sentence. */
const aiExtractLocal: Executor = {
  action: 'ai.extract',
  mechanism: 'app',
  via: 'Local heuristic extraction',
  available: () => true,
  async execute(params, ctx) {
    const fields = params.fields.split(',').map((f) => f.trim()).filter(Boolean)
    const body = String(ctx.vars['email.body'] ?? params.input)
    const firstSentence = body.replace(/\s+/g, ' ').split(/(?<=[.!?])\s/)[0]?.slice(0, 200) ?? ''
    const out: Record<string, string> = {}
    for (const f of fields) {
      if (/name/.test(f)) out[f] = String(ctx.vars['email.fromName'] ?? '')
      else if (/email/.test(f)) out[f] = String(ctx.vars['email.fromAddress'] ?? '')
      else if (/summary|request/.test(f)) out[f] = `${ctx.vars['email.subject'] ?? ''}: ${firstSentence}`.trim()
      else out[f] = ''
    }
    return out
  },
}

// ---------- Gmail ----------

const gmailDownload: Executor = {
  action: 'gmail.download_attachment',
  mechanism: 'api',
  via: 'Gmail REST API',
  available: (ctx) => (isDemo(ctx) || gmailConnected() ? true : 'Gmail not connected'),
  async execute(params, ctx) {
    const dir = path.join(ctx.dataDir, 'attachments')
    if (isDemo(ctx)) {
      fs.mkdirSync(dir, { recursive: true })
      const name = String(ctx.vars['email.demoAttachment'] ?? 'request.txt')
      const file = path.join(dir, `${Date.now()}_${name}`)
      fs.writeFileSync(file, `Sample attachment for ${ctx.vars['email.subject']}\n`)
      return { found: true, path: file, name }
    }
    return downloadAttachment(params.messageId, dir, params.filenameContains)
  },
}

const gmailReply: Executor = {
  action: 'gmail.reply',
  mechanism: 'api',
  via: 'Gmail REST API',
  available: (ctx) => (isDemo(ctx) || gmailConnected() ? true : 'Gmail not connected'),
  async execute(params, ctx) {
    if (isDemo(ctx)) {
      ctx.log(`(demo) would reply: ${params.text.slice(0, 80)}`)
      return { id: 'demo' }
    }
    return { id: await replyTo(params.messageId, params.text) }
  },
}

// ---------- CRM ----------

async function crmApi<T>(p: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${crmBase()}${p}`, init)
  if (r.status === 503) throw new Error('CRM API is disabled')
  if (!r.ok) throw new Error(`CRM API ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return (await r.json()) as T
}

type CrmCustomer = { id: string; name: string; company: string; email: string }
const customerOut = (c: CrmCustomer | undefined) =>
  c
    ? { found: true, id: c.id, name: c.name, company: c.company, url: `${crmBase()}/customers/${c.id}` }
    : { found: false, id: '', name: '', company: '', url: '' }

const crmFindApi: Executor = {
  action: 'crm.find_customer',
  mechanism: 'api',
  via: 'Acme CRM REST API',
  available: () => (getSettings().crmApiEnabled ? true : 'CRM API disabled'),
  async execute(params) {
    if (params.email) {
      const { customers } = await crmApi<{ customers: CrmCustomer[] }>(`/api/customers?email=${encodeURIComponent(params.email)}`)
      if (customers[0]) return customerOut(customers[0])
    }
    if (params.name) {
      const { customers } = await crmApi<{ customers: CrmCustomer[] }>(`/api/customers?q=${encodeURIComponent(params.name)}`)
      if (customers.length === 1) return customerOut(customers[0])
    }
    return customerOut(undefined)
  },
}

const crmFindBrowser: Executor = {
  action: 'crm.find_customer',
  mechanism: 'browser',
  via: 'Playwright → Acme CRM web UI',
  available: () => true,
  async execute(params) {
    return withPage(async (page) => {
      for (const q of [params.email, params.name].filter(Boolean)) {
        await page.goto(`${crmBase()}/customers`)
        await page.getByLabel('Search customers').fill(q)
        await page.getByRole('button', { name: 'Search' }).click()
        await page.waitForLoadState('domcontentloaded')
        const links = page.getByTestId('customer-link')
        if ((await links.count()) === 1) {
          await links.first().click()
          await page.waitForURL(/\/customers\/[\w-]+$/)
          const id = page.url().split('/').pop()!
          const name = (await page.locator('h2').first().textContent())?.trim() ?? ''
          const meta = (await page.locator('.card .mute').first().textContent()) ?? ''
          return customerOut({ id, name, company: meta.split('·')[0].trim(), email: q })
        }
      }
      return customerOut(undefined)
    })
  },
}

const crmUpdateApi: Executor = {
  action: 'crm.update_customer',
  mechanism: 'api',
  via: 'Acme CRM REST API',
  available: () => (getSettings().crmApiEnabled ? true : 'CRM API disabled'),
  async execute(params) {
    let attachment: { name: string; base64: string } | undefined
    if (params.attachmentPath && fs.existsSync(params.attachmentPath)) {
      attachment = { name: path.basename(params.attachmentPath).replace(/^\d+_/, ''), base64: fs.readFileSync(params.attachmentPath).toString('base64') }
    }
    const { note } = await crmApi<{ note: { id: string } }>(`/api/customers/${encodeURIComponent(params.customerId)}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: params.note, attachment, author: 'WorkFlowOS' }),
    })
    return { noteId: note.id }
  },
}

const crmUpdateBrowser: Executor = {
  action: 'crm.update_customer',
  mechanism: 'browser',
  via: 'Playwright → Acme CRM web UI',
  available: () => true,
  async execute(params) {
    return withPage(async (page) => {
      await page.goto(`${crmBase()}/customers/${encodeURIComponent(params.customerId)}`)
      await page.getByLabel('Request notes').fill(params.note)
      if (params.attachmentPath && fs.existsSync(params.attachmentPath)) {
        await page.getByLabel('Attach file').setInputFiles(params.attachmentPath)
      }
      await page.getByRole('button', { name: 'Save update' }).click()
      await page.locator('#status', { hasText: 'Saved' }).waitFor()
      return { noteId: 'ui' }
    })
  },
}

// ---------- Slack ----------

const slackApi: Executor = {
  action: 'slack.send_message',
  mechanism: 'api',
  via: 'Slack Web API',
  available: (ctx) => (isDemo(ctx) || slackConfigured() ? true : 'Slack not configured'),
  async execute(params, ctx) {
    if (isDemo(ctx) && !slackConfigured()) {
      ctx.log(`(demo) would post to ${params.channel}: ${params.text.slice(0, 120)}`)
      return { ts: 'demo' }
    }
    return slackSend(params.channel || getSettings().slackDefaultChannel, params.text)
  },
}

// ---------- Control ----------

export class AskUser extends Error {}

const askUser: Executor = {
  action: 'control.ask_user',
  mechanism: 'app',
  via: 'WorkFlowOS',
  available: () => true,
  async execute(params) {
    throw new AskUser(params.message)
  },
}

export const EXECUTORS: Executor[] = [
  aiExtractApi,
  aiExtractLocal,
  gmailDownload,
  gmailReply,
  crmFindApi,
  crmFindBrowser,
  crmUpdateApi,
  crmUpdateBrowser,
  slackApi,
  askUser,
]

export function executorsFor(action: string): Executor[] {
  return EXECUTORS.filter((e) => e.action === action)
}
