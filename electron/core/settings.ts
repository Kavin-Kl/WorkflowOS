import { safeStorage, app } from 'electron'
import path from 'node:path'
import crypto from 'node:crypto'
import { kvGet, kvSet } from './db'
import type { PublicSettings } from '../shared/types'

export interface Settings {
  observing: boolean
  geminiModel: string
  gmailClientId: string
  gmailAccount?: string
  slackMode: 'bot' | 'webhook' | 'none'
  slackDefaultChannel: string
  crmApiEnabled: boolean
  crmPort: number
  bridgePort: number
  bridgeToken: string
  watchFolders: string[]
  appBlocklist: string[]
  urlBlocklist: string[]
  retentionDays: number
  minSupport: number
  recordValues: boolean
}

export type SecretName = 'geminiKey' | 'gmailClientSecret' | 'gmailRefreshToken' | 'slackToken' | 'slackWebhook'

function defaults(): Settings {
  return {
    observing: true,
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    gmailClientId: process.env.GMAIL_CLIENT_ID || '',
    slackMode: 'none',
    slackDefaultChannel: '#support',
    crmApiEnabled: true,
    crmPort: 4545,
    bridgePort: 4546,
    bridgeToken: crypto.randomBytes(12).toString('hex'),
    watchFolders: ['Downloads', 'Documents', 'Desktop'].map((d) => path.join(app.getPath('home'), d)),
    appBlocklist: ['1Password', 'Keychain Access', 'Bitwarden', 'KeePassXC', 'LastPass', 'Dashlane'],
    urlBlocklist: ['bank', 'paypal.com', 'accounts.google.com', 'login.', 'signin.'],
    retentionDays: 14,
    minSupport: 3,
    recordValues: true,
  }
}

let cache: Settings | null = null

export function getSettings(): Settings {
  if (!cache) {
    const stored = kvGet<Partial<Settings>>('settings', {})
    cache = { ...defaults(), ...stored }
    // Persist generated values (e.g. bridge token) so they stay stable.
    kvSet('settings', cache)
  }
  return cache
}

export function updateSettings(patch: Partial<Settings>): Settings {
  cache = { ...getSettings(), ...patch }
  kvSet('settings', cache)
  return cache
}

export function getSecret(name: SecretName): string {
  const envFallback: Record<SecretName, string | undefined> = {
    geminiKey: process.env.GEMINI_API_KEY,
    gmailClientSecret: process.env.GMAIL_CLIENT_SECRET,
    gmailRefreshToken: undefined,
    slackToken: process.env.SLACK_BOT_TOKEN,
    slackWebhook: process.env.SLACK_WEBHOOK_URL,
  }
  const stored = kvGet<string>(`secret:${name}`, '')
  if (!stored) return envFallback[name] || ''
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    }
    return Buffer.from(stored, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

export function setSecret(name: SecretName, value: string): void {
  if (!value) {
    kvSet(`secret:${name}`, '')
    return
  }
  const enc = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(value).toString('base64')
    : Buffer.from(value, 'utf8').toString('base64')
  kvSet(`secret:${name}`, enc)
}

export function publicSettings(): PublicSettings {
  const s = getSettings()
  return {
    ...s,
    geminiConfigured: !!getSecret('geminiKey'),
    gmailConnected: !!getSecret('gmailRefreshToken'),
  }
}
