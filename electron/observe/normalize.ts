// Map raw OS / browser signals to a logical application name, so that
// "Google Chrome" showing mail.google.com and the Gmail PWA both become "Gmail".

const URL_APPS: { match: RegExp; app: string }[] = [
  { match: /(^|\.)mail\.google\.com$/, app: 'Gmail' },
  { match: /(^|\.)outlook\.(live|office|office365)\.com$/, app: 'Outlook' },
  { match: /(^|\.)slack\.com$/, app: 'Slack' },
  { match: /(^|\.)docs\.google\.com$/, app: 'Google Docs' },
  { match: /(^|\.)sheets\.google\.com$/, app: 'Google Sheets' },
  { match: /(^|\.)drive\.google\.com$/, app: 'Google Drive' },
  { match: /(^|\.)hubspot\.com$/, app: 'HubSpot' },
  { match: /(^|\.)salesforce\.com$|(^|\.)force\.com$/, app: 'Salesforce' },
  { match: /(^|\.)atlassian\.net$/, app: 'Jira' },
  { match: /(^|\.)notion\.so$/, app: 'Notion' },
  { match: /(^|\.)github\.com$/, app: 'GitHub' },
  { match: /(^|\.)linear\.app$/, app: 'Linear' },
  { match: /(^|\.)zendesk\.com$/, app: 'Zendesk' },
]

const PROCESS_APPS: { match: RegExp; app: string }[] = [
  { match: /^slack(\.exe)?$/i, app: 'Slack' },
  { match: /^(microsoft )?excel(\.exe)?$/i, app: 'Excel' },
  { match: /^(microsoft )?outlook(\.exe)?$|^olk(\.exe)?$/i, app: 'Outlook' },
  { match: /^(microsoft )?word(\.exe)?$|^winword(\.exe)?$/i, app: 'Word' },
  { match: /^(microsoft )?teams(\.exe)?$|^ms-teams(\.exe)?$/i, app: 'Teams' },
  { match: /^mail$/i, app: 'Apple Mail' },
  { match: /^finder$|^explorer(\.exe)?$/i, app: 'Files' },
  { match: /^numbers$/i, app: 'Numbers' },
]

const BROWSERS = /^(google chrome|chrome|chrome\.exe|msedge(\.exe)?|microsoft edge|safari|firefox(\.exe)?|arc|brave browser|brave(\.exe)?)$/i

export function isBrowserProcess(name: string): boolean {
  return BROWSERS.test(name.trim())
}

export function appFromUrl(url: string, crmPort: number): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if ((u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.port === String(crmPort)) return 'CRM'
  for (const { match, app } of URL_APPS) if (match.test(u.hostname)) return app
  const host = u.hostname.replace(/^www\./, '')
  return host || null
}

/** Browser window titles usually end with the site name ("Inbox (3) - Gmail - Google Chrome"). */
export function appFromBrowserTitle(title: string): string | null {
  const t = title.toLowerCase()
  if (t.includes('gmail')) return 'Gmail'
  if (t.includes('slack')) return 'Slack'
  if (t.includes('acme crm')) return 'CRM'
  if (t.includes('google sheets')) return 'Google Sheets'
  if (t.includes('google docs')) return 'Google Docs'
  return null
}

export function appFromProcess(name: string, title = ''): string {
  const clean = name.trim()
  if (isBrowserProcess(clean)) return appFromBrowserTitle(title) || 'Browser'
  for (const { match, app } of PROCESS_APPS) if (match.test(clean)) return app
  return clean.replace(/\.exe$/i, '')
}
