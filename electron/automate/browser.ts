import type { Browser, BrowserContext, Page } from 'playwright-core'
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

// One shared, visible browser for the browser-automation tier. Prefers an
// installed Chrome/Edge/Brave, so usually nothing needs to be downloaded.

let browser: Browser | null = null
let context: BrowserContext | null = null
let idleTimer: NodeJS.Timeout | null = null

async function launch(): Promise<BrowserContext> {
  const { chromium } = await import('playwright-core')
  const errors: string[] = []
  const attempts: { name: string; opts: { channel?: string; executablePath?: string } }[] = [
    { name: 'chrome', opts: { channel: 'chrome' } },
    { name: 'msedge', opts: { channel: 'msedge' } },
    ...executableCandidates().map((p) => ({ name: path.basename(p), opts: { executablePath: p } })),
    { name: 'bundled chromium', opts: {} },
  ]
  for (const a of attempts) {
    try {
      browser = await chromium.launch({ ...a.opts, headless: false, args: ['--window-size=1200,860'] })
      log('browser', `Launched ${a.name} for browser automation`)
      break
    } catch (err) {
      errors.push(`${a.name}: ${(err as Error).message.split('\n')[0]}`)
    }
  }
  if (!browser) throw new Error(`No browser available (${errors.join('; ')})`)
  browser.on('disconnected', () => {
    browser = null
    context = null
  })
  context = await browser.newContext({ viewport: { width: 1180, height: 780 } })
  return context
}

/** Run `fn` with a fresh page; the browser closes after a minute of idleness. */
export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  if (idleTimer) clearTimeout(idleTimer)
  const ctx = context ?? (await launch())
  const page = await ctx.newPage()
  page.setDefaultTimeout(15_000)
  try {
    return await fn(page)
  } finally {
    // Leave the result visible for a moment during demos.
    setTimeout(() => page.close().catch(() => {}), 2500)
    idleTimer = setTimeout(() => closeBrowser(), 60_000)
  }
}

export async function closeBrowser() {
  const b = browser
  browser = null
  context = null
  await b?.close().catch(() => {})
}
