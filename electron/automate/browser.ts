import type { BrowserContext, Page } from 'playwright-core'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { log } from '../core/bus'

/** Other Chromium browsers and cached Playwright builds, per platform. */
function executableCandidates(): string[] {
  const home = os.homedir()
  const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
  const pf = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(Boolean) as string[]
  const fixed =
    process.platform === 'darwin'
      ? ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Arc.app/Contents/MacOS/Arc']
      : process.platform === 'win32'
        ? [...pf, local].flatMap((d) => [path.join(d, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), path.join(d, 'Chromium', 'Application', 'chrome.exe')])
        : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/brave-browser']
  const cacheDir =
    process.platform === 'darwin' ? path.join(home, 'Library', 'Caches', 'ms-playwright') : process.platform === 'win32' ? path.join(local, 'ms-playwright') : path.join(home, '.cache', 'ms-playwright')
  const cached: string[] = []
  try {
    for (const dir of fs.readdirSync(cacheDir).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
      const base = path.join(cacheDir, dir)
      cached.push(
        path.join(base, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        path.join(base, 'chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        path.join(base, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        path.join(base, 'chrome-win', 'chrome.exe'),
        path.join(base, 'chrome-win64', 'chrome.exe'),
        path.join(base, 'chrome-linux', 'chrome'),
      )
    }
  } catch {
    // no Playwright cache
  }
  return [...fixed, ...cached].filter((p) => fs.existsSync(p))
}

// One persistent, visible "automation browser" profile. You sign in to your
// web apps there once; replayed workflows then run with those sessions.
// Prefers an installed Chrome/Edge/Brave, so usually nothing is downloaded.

let context: BrowserContext | null = null
let launching: Promise<BrowserContext> | null = null
let idleTimer: NodeJS.Timeout | null = null
let profileDir = ''
let browserName = ''
const runPages = new Map<string, Page>()

export function setProfileDir(dir: string) {
  profileDir = dir
}

export function automationBrowserName(): string {
  return context ? browserName : browserName ? `${browserName} (closed)` : 'not started'
}

async function launch(): Promise<BrowserContext> {
  const { chromium } = await import('playwright-core')
  const errors: string[] = []
  const attempts: { name: string; opts: { channel?: string; executablePath?: string } }[] = [
    { name: 'Chrome', opts: { channel: 'chrome' } },
    { name: 'Edge', opts: { channel: 'msedge' } },
    ...executableCandidates().map((p) => ({ name: path.basename(p), opts: { executablePath: p } })),
    { name: 'bundled Chromium', opts: {} },
  ]
  fs.mkdirSync(profileDir, { recursive: true })
  for (const a of attempts) {
    try {
      const ctx = await chromium.launchPersistentContext(profileDir, {
        ...a.opts,
        headless: false,
        viewport: null,
        args: ['--window-size=1240,900', '--no-first-run', '--no-default-browser-check'],
      })
      browserName = a.name
      log('browser', `Automation browser: ${a.name}`)
      ctx.on('close', () => {
        context = null
        runPages.clear()
      })
      return ctx
    } catch (err) {
      errors.push(`${a.name}: ${(err as Error).message.split('\n')[0]}`)
    }
  }
  throw new Error(`No browser available (${errors.join('; ')})`)
}

async function getContext(): Promise<BrowserContext> {
  if (idleTimer) clearTimeout(idleTimer)
  if (context) return context
  launching ??= launch().finally(() => (launching = null))
  context = await launching
  return context
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (!runPages.size) closeBrowser()
  }, 3 * 60_000)
}

/** Run `fn` with a fresh page that closes afterwards (single-shot actions). */
export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const ctx = await getContext()
  const page = await ctx.newPage()
  page.setDefaultTimeout(15_000)
  try {
    return await fn(page)
  } finally {
    // Leave the result visible for a moment.
    setTimeout(() => page.close().catch(() => {}), 2500)
    scheduleIdleClose()
  }
}

/** One page per workflow run, so replayed steps continue in the same tab. */
export async function runPage(runId: string): Promise<Page> {
  const existing = runPages.get(runId)
  if (existing && !existing.isClosed()) return existing
  const ctx = await getContext()
  const page = await ctx.newPage()
  page.setDefaultTimeout(15_000)
  runPages.set(runId, page)
  return page
}

export function releaseRunPage(runId: string) {
  const page = runPages.get(runId)
  runPages.delete(runId)
  if (page) setTimeout(() => page.close().catch(() => {}), 3000)
  scheduleIdleClose()
}

/** Open the automation browser so the user can sign in to their apps. */
export async function openForSignIn(url?: string): Promise<string> {
  const ctx = await getContext()
  const page = await ctx.newPage()
  await page.goto(url || 'about:blank').catch(() => {})
  await page.bringToFront()
  return browserName
}

export async function closeBrowser() {
  const c = context
  context = null
  runPages.clear()
  await c?.close().catch(() => {})
}
