import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../core/db'
import { log, newId } from '../core/bus'
import { DEMO_CUSTOMERS } from '../demo/scenario'

// "Acme CRM": a small local CRM so the demo has a real web app to observe
// and to automate. Its public /api can be switched off in Settings to force
// the Automation Engine down the ladder to browser automation.

export interface Customer {
  id: string
  name: string
  email: string
  company: string
  status: string
}

export interface Note {
  id: string
  customer_id: string
  body: string
  attachment: string | null
  author: string
  created_at: number
}

interface CrmOptions {
  port: number
  attachmentsDir: string
  apiEnabled: () => boolean
}

const EXTRA = [
  { id: 'c_1006', name: 'Olivia Grant', email: 'olivia@umbrella.co', company: 'Umbrella Health', status: 'Active' },
  { id: 'c_1007', name: 'Diego Alvarez', email: 'diego@hooli.com', company: 'Hooli', status: 'Prospect' },
]

export function seedCrm() {
  const db = getDb()
  const count = (db.prepare('SELECT COUNT(*) AS n FROM crm_customers').get() as { n: number }).n
  if (count) return
  const ins = db.prepare('INSERT INTO crm_customers (id, name, email, company, status) VALUES (?, ?, ?, ?, ?)')
  for (const c of DEMO_CUSTOMERS) ins.run(c.id, c.name, c.email, c.company, 'Active')
  for (const c of EXTRA) ins.run(c.id, c.name, c.email, c.company, c.status)
}

export function findCustomers(q: { email?: string; q?: string }): Customer[] {
  const db = getDb()
  if (q.email) {
    return db.prepare('SELECT * FROM crm_customers WHERE lower(email) = lower(?)').all(q.email.trim()) as unknown as Customer[]
  }
  const like = `%${(q.q ?? '').trim().toLowerCase()}%`
  return db
    .prepare('SELECT * FROM crm_customers WHERE lower(name) LIKE ? OR lower(email) LIKE ? OR lower(company) LIKE ? ORDER BY name')
    .all(like, like, like) as unknown as Customer[]
}

function getCustomer(id: string): Customer | undefined {
  return getDb().prepare('SELECT * FROM crm_customers WHERE id = ?').get(id) as unknown as Customer | undefined
}

function notesFor(id: string): Note[] {
  return getDb().prepare('SELECT * FROM crm_notes WHERE customer_id = ? ORDER BY created_at DESC').all(id) as unknown as Note[]
}

function addNote(opts: CrmOptions, customerId: string, body: string, author: string, file?: { name: string; base64: string }): Note {
  let attachment: string | null = null
  if (file?.name && file.base64) {
    fs.mkdirSync(opts.attachmentsDir, { recursive: true })
    const safe = `${Date.now()}_${path.basename(file.name).replace(/[^\w.-]+/g, '_')}`
    fs.writeFileSync(path.join(opts.attachmentsDir, safe), Buffer.from(file.base64, 'base64'))
    attachment = safe
  }
  const note: Note = { id: newId('n'), customer_id: customerId, body, attachment, author, created_at: Date.now() }
  getDb()
    .prepare('INSERT INTO crm_notes (id, customer_id, body, attachment, author, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(note.id, note.customer_id, note.body, note.attachment, note.author, note.created_at)
  return note
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} · Acme CRM</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--ink:#1d2330;--mute:#6b7280;--line:#e5e7eb;--brand:#2f5bea;--bg:#f6f7fb}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--ink);background:var(--bg)}
header{background:#111827;color:#fff;padding:12px 24px;display:flex;gap:16px;align-items:center}
header a{color:#fff;text-decoration:none;font-weight:600}main{max-width:900px;margin:24px auto;padding:0 16px}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:20px;margin-bottom:16px}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:10px;border-bottom:1px solid var(--line)}
th{color:var(--mute);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
input,textarea{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:6px;width:100%}
textarea{min-height:90px}button{font:inherit;background:var(--brand);color:#fff;border:0;border-radius:6px;padding:8px 16px;cursor:pointer}
.row{display:flex;gap:8px}.mute{color:var(--mute)}.pill{font-size:12px;padding:2px 8px;border-radius:99px;background:#eef2ff;color:#3730a3}
.note{border-top:1px solid var(--line);padding:12px 0}.note:first-child{border-top:0}label{display:block;font-weight:500;margin:12px 0 4px}
</style></head><body><header><a href="/customers">Acme CRM</a><span class="mute">Customers</span></header><main>${body}</main></body></html>`
}

function listPage(q: string): string {
  const rows = findCustomers({ q })
    .map(
      (c) =>
        `<tr><td><a href="/customers/${esc(c.id)}" data-testid="customer-link">${esc(c.name)}</a></td><td>${esc(c.company)}</td><td>${esc(c.email)}</td><td><span class="pill">${esc(c.status)}</span></td></tr>`,
    )
    .join('')
  return page(
    'Customers',
    `<div class="card"><form role="search" method="get" action="/customers" class="row">
<input name="q" aria-label="Search customers" placeholder="Search by name, email or company" value="${esc(q)}">
<button type="submit">Search</button></form></div>
<div class="card"><table><thead><tr><th>Name</th><th>Company</th><th>Email</th><th>Status</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="mute">No customers found</td></tr>'}</tbody></table></div>
<div class="card"><form method="post" action="/customers/new">
<strong>Add customer</strong><div class="row" style="margin-top:8px">
<input name="name" aria-label="Customer name" placeholder="Name" required>
<input name="email" aria-label="Customer email" placeholder="Email" required>
<input name="company" aria-label="Company" placeholder="Company" required>
<button type="submit">Add</button></div></form></div>`,
  )
}

function detailPage(c: Customer): string {
  const notes = notesFor(c.id)
    .map(
      (n) =>
        `<div class="note"><div class="mute">${new Date(n.created_at).toLocaleString()} · ${esc(n.author)}</div><div style="white-space:pre-wrap">${esc(n.body)}</div>${n.attachment ? `<div>📎 <a href="/attachments/${encodeURIComponent(n.attachment)}">${esc(n.attachment.replace(/^\d+_/, ''))}</a></div>` : ''}</div>`,
    )
    .join('')
  return page(
    c.name,
    `<div class="card"><h2 style="margin:0">${esc(c.name)}</h2><div class="mute">${esc(c.company)} · ${esc(c.email)} · <span class="pill">${esc(c.status)}</span></div></div>
<div class="card"><form id="update-form" data-customer="${esc(c.id)}">
<strong>Add update</strong>
<label for="note">Request notes</label><textarea id="note" name="note" aria-label="Request notes" required></textarea>
<label for="attachment">Attach file</label><input id="attachment" type="file" name="attachment" aria-label="Attach file">
<div style="margin-top:12px"><button type="submit">Save update</button> <span id="status" class="mute"></span></div>
</form></div>
<div class="card"><strong>Activity</strong><div id="notes">${notes || '<p class="mute">No updates yet</p>'}</div></div>
<script>
document.getElementById('update-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, file = f.attachment.files[0];
  let attachment;
  if (file) {
    const buf = await file.arrayBuffer();
    let bin = ''; const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    attachment = { name: file.name, base64: btoa(bin) };
  }
  document.getElementById('status').textContent = 'Saving…';
  const r = await fetch('/ui/customers/' + f.dataset.customer + '/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: f.note.value, attachment }) });
  if (r.ok) { document.getElementById('status').textContent = 'Saved'; setTimeout(() => location.reload(), 300); }
  else document.getElementById('status').textContent = 'Failed';
});
</script>`,
  )
}

async function readBody(req: http.IncomingMessage, limit = 25 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error('Body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function send(res: http.ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'content-type': type })
  res.end(body)
}

const json = (res: http.ServerResponse, status: number, data: unknown) => send(res, status, JSON.stringify(data), 'application/json')

export function startCrmServer(opts: CrmOptions): http.Server {
  seedCrm()
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://localhost:${opts.port}`)
      const p = url.pathname

      if (p.startsWith('/api/')) {
        if (!opts.apiEnabled()) return json(res, 503, { error: 'API disabled' })
        if (req.method === 'GET' && p === '/api/customers') {
          return json(res, 200, { customers: findCustomers({ email: url.searchParams.get('email') ?? undefined, q: url.searchParams.get('q') ?? '' }) })
        }
        const m = p.match(/^\/api\/customers\/([\w-]+)\/notes$/)
        if (req.method === 'POST' && m) {
          if (!getCustomer(m[1])) return json(res, 404, { error: 'Customer not found' })
          const body = JSON.parse(await readBody(req))
          if (!body.note) return json(res, 400, { error: 'note is required' })
          return json(res, 201, { note: addNote(opts, m[1], String(body.note), String(body.author ?? 'WorkFlowOS API'), body.attachment) })
        }
        return json(res, 404, { error: 'Not found' })
      }

      if (req.method === 'POST' && p === '/customers/new') {
        const form = new URLSearchParams(await readBody(req))
        const id = newId('c')
        getDb()
          .prepare('INSERT INTO crm_customers (id, name, email, company, status) VALUES (?, ?, ?, ?, ?)')
          .run(id, form.get('name') ?? '', form.get('email') ?? '', form.get('company') ?? '', 'Active')
        res.writeHead(303, { location: `/customers/${id}` })
        return res.end()
      }
      const ui = p.match(/^\/ui\/customers\/([\w-]+)\/notes$/)
      if (req.method === 'POST' && ui) {
        if (!getCustomer(ui[1])) return json(res, 404, { error: 'Customer not found' })
        const body = JSON.parse(await readBody(req))
        return json(res, 201, { note: addNote(opts, ui[1], String(body.note ?? ''), 'CRM user', body.attachment) })
      }
      if (p === '/' || p === '') {
        res.writeHead(302, { location: '/customers' })
        return res.end()
      }
      if (p === '/customers') return send(res, 200, listPage(url.searchParams.get('q') ?? ''))
      const d = p.match(/^\/customers\/([\w-]+)$/)
      if (d) {
        const c = getCustomer(d[1])
        return c ? send(res, 200, detailPage(c)) : send(res, 404, page('Not found', '<div class="card">Customer not found</div>'))
      }
      const a = p.match(/^\/attachments\/(.+)$/)
      if (a) {
        const file = path.join(opts.attachmentsDir, path.basename(decodeURIComponent(a[1])))
        if (!fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain')
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        return fs.createReadStream(file).pipe(res)
      }
      send(res, 404, page('Not found', '<div class="card">Not found</div>'))
    } catch (err) {
      json(res, 500, { error: (err as Error).message })
    }
  })
  server.on('error', (err) => log('crm', `CRM server error: ${err.message}`, 'error'))
  server.listen(opts.port, '127.0.0.1', () => log('crm', `Acme CRM on http://localhost:${opts.port}`))
  return server
}
