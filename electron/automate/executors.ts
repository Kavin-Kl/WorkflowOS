import fs from 'node:fs'
import path from 'node:path'
import type { Mechanism } from '../shared/types'
import type { Vars } from './vars'
import { getSettings } from '../core/settings'
import { generateJson, geminiAvailable } from '../understand/gemini'
import { downloadAttachment, gmailConnected, replyTo } from '../integrations/gmail'
import { slackConfigured, slackSend } from '../integrations/slack'
import type { Locator, Page } from 'playwright-core'
import { runPage, withPage } from './browser'
import { desktopSupported, runDesktop } from './desktop'

export interface ExecContext {
  runId: string
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

// ---------- Learned web replay ----------

type Hints = { role?: string; name?: string; text?: string; testid?: string; label?: string; placeholder?: string }

/**
 * Find an element from recorded hints, trying the most semantic locator first.
 * Polls all candidates together so a missing fallback doesn't cost a timeout each.
 */
async function locate(page: Page, h: Hints, kind: 'click' | 'field', timeoutMs = 12_000): Promise<Locator> {
  const c: Locator[] = []
  const role = (h.role || '') as Parameters<Page['getByRole']>[0]
  if (kind === 'field') {
    if (h.label) c.push(page.getByLabel(h.label, { exact: true }), page.getByRole('textbox', { name: h.label, exact: true }), page.getByLabel(h.label))
    if (h.placeholder || h.label) c.push(page.getByPlaceholder(h.placeholder || h.label!))
    if (h.label) c.push(page.getByRole('textbox', { name: h.label }))
  } else {
    if (h.role && h.name) c.push(page.getByRole(role, { name: h.name, exact: true }), page.getByRole(role, { name: h.name }))
    if (h.name) c.push(page.getByText(h.name, { exact: true }), page.getByLabel(h.name, { exact: true }))
    if (h.text) c.push(page.getByText(h.text, { exact: true }))
  }
  if (h.testid) c.push(page.getByTestId(h.testid))
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const loc of c) {
      const first = loc.first()
      if (await first.isVisible().catch(() => false)) return first
    }
    await page.waitForTimeout(300)
  }
  throw new Error(`Could not find ${kind === 'field' ? 'field' : h.role || 'element'} "${h.label || h.name || h.text || h.testid}" on ${page.url()}`)
}

async function settle(page: Page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await page.waitForTimeout(400)
}

const webExec = (action: string, via: string, fn: (page: Page, p: Record<string, string>) => Promise<Record<string, unknown>>): Executor => ({
  action,
  mechanism: 'browser',
  via,
  available: () => true,
  async execute(params, ctx) {
    const page = await runPage(ctx.runId)
    const out = await fn(page, params)
    await settle(page)
    return out
  },
})

const webOpen = webExec('web.open', 'Playwright (automation browser)', async (page, p) => {
  await page.goto(p.url, { waitUntil: 'domcontentloaded' })
  return {}
})
const webClick = webExec('web.click', 'Playwright (automation browser)', async (page, p) => {
  await (await locate(page, p, 'click')).click()
  return {}
})
const webFill = webExec('web.fill', 'Playwright (automation browser)', async (page, p) => {
  const el = await locate(page, p, 'field')
  const editable = await el.evaluate((n) => (n as HTMLElement).isContentEditable).catch(() => false)
  if (editable) {
    await el.click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.type(p.value)
  } else await el.fill(p.value)
  return {}
})
const webUpload = webExec('web.upload', 'Playwright (automation browser)', async (page, p) => {
  if (!p.path || !fs.existsSync(p.path)) throw new Error(`File not found: ${p.path || '(empty)'}`)
  await (await locate(page, p, 'field')).setInputFiles(p.path)
  return {}
})
const webPress = webExec('web.press', 'Playwright (automation browser)', async (page, p) => {
  if (p.label || p.placeholder) await (await locate(page, p, 'field')).press(p.key)
  else await page.keyboard.press(p.key)
  return {}
})

// ---------- Desktop apps (accessibility) ----------

const desktopVia = process.platform === 'win32' ? 'Windows UI Automation' : 'macOS Accessibility (AX)'
const desktopExec = (action: string, op: (p: Record<string, string>) => Parameters<typeof runDesktop>[0]): Executor => ({
  action,
  mechanism: 'accessibility',
  via: desktopVia,
  available: () => desktopSupported(),
  async execute(params) {
    await runDesktop(op(params))
    return {}
  },
})

const desktopOpen = desktopExec('desktop.open_app', (p) => ({ op: 'open', app: p.app }))
const desktopClick = desktopExec('desktop.click', (p) => ({ op: 'click', app: p.app, name: p.name, role: p.role }))
const desktopType = desktopExec('desktop.type', (p) => ({ op: 'type', app: p.app, name: p.label, value: p.value }))
const desktopPress = desktopExec('desktop.press', (p) => ({ op: 'press', app: p.app, keys: p.keys }))

// ---------- Spreadsheets (file-level app integration) ----------

const excelAppend: Executor = {
  action: 'excel.append_row',
  mechanism: 'app',
  via: 'Workbook file (ExcelJS / CSV)',
  available: () => true,
  async execute(params) {
    const values = params.values.split('|').map((v) => v.trim())
    const file = params.file
    if (!file) throw new Error('No workbook path')
    if (/\.csv$/i.test(file)) {
      const line = values.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')
      const needsNewline = fs.existsSync(file) && !fs.readFileSync(file, 'utf8').endsWith('\n')
      fs.appendFileSync(file, `${needsNewline ? '\n' : ''}${line}\n`)
      return { row: values.join(' | ') }
    }
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    if (fs.existsSync(file)) await wb.xlsx.readFile(file)
    const ws = (params.sheet && wb.getWorksheet(params.sheet)) || wb.worksheets[0] || wb.addWorksheet(params.sheet || 'Sheet1')
    const row = ws.addRow(values.map((v) => (v !== '' && !isNaN(Number(v)) ? Number(v) : v)))
    try {
      await wb.xlsx.writeFile(file)
    } catch (err) {
      throw new Error(`Could not save ${path.basename(file)} (${(err as Error).message}). Close it in Excel and retry.`)
    }
    return { row: row.number }
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
  webOpen,
  webClick,
  webFill,
  webUpload,
  webPress,
  desktopOpen,
  desktopClick,
  desktopType,
  desktopPress,
  excelAppend,
  askUser,
]

export function executorsFor(action: string): Executor[] {
  return EXECUTORS.filter((e) => e.action === action)
}
