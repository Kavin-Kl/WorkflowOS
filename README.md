# WorkFlowOS

**AI-powered, OS-level workflow automation.** WorkFlowOS watches how you normally work, finds the sequences you keep repeating across apps, works out what they are for, and turns them into workflows you approve before anything is automated.

```
Observe → Understand → Detect repetition → Generate workflow → User approval → Automate → Learn
```

Users know how to do their work. They shouldn't also have to know how to automate it.

## Quick start

```bash
npm install
npm run dev          # launches the Electron app
npm test             # discovery + generator tests
```

1. **Observe** → click **Load demo observations**. This loads five realistic occurrences of the *customer request* workflow (Gmail → CRM → Slack), mixed with noise, interruptions and reordered steps.
2. **Discover**: the engine finds the repeated 10-step sequence (5×, ~2.5 min each), and Gemini names it *Process Customer Request*.
3. **Automate** → review the generated workflow (trigger, steps, variables, guard) → **Test with sample email** → **Approve & activate**.
4. Try **Test: unknown customer**. The run pauses for you ("Customer not found"). Enter a customer ID such as `c_1003` and continue.
5. In Settings, turn off the **CRM public API** and run again. The same steps now run through the **Browser** rung (Playwright drives the CRM web UI).

To observe real work, load the browser extension (below) and use Gmail, the local CRM (`http://localhost:4545`) and Slack as you normally would. Discovery runs every 5 minutes, or on demand.

## Architecture

Everything runs in the Electron **main process**. The renderer only displays state, through a typed and allowlisted IPC surface (`electron/shared/api.ts`).

```
electron/
  observe/      Desktop Activity Agent
    sensors/osSensor.ts      foreground app + focused UI element
                             macOS: persistent JXA (NSWorkspace + System Events / AX)
                             Windows: persistent PowerShell (Win32 + UI Automation)
    sensors/browserBridge.ts WebSocket 127.0.0.1:4546 for the extension (origin + token auth)
    sensors/fileSensor.ts    watches Downloads (configurable)
    privacy.ts               app/URL blocklists, sensitive-field drop, e-mail/number scrubbing
    agent.ts                 privacy → de-dup → SQLite → bus
  discover/     Workflow Discovery Engine
    abstract.ts   raw events → semantic steps (Gmail:open_email, CRM:update_customer, …)
    mine.ts       sessionize → prune rare tokens → n-gram support → maximal patterns →
                  rotation dedupe → variant merge (edit distance) → approximate matches → score
    engine.ts     orchestrates discover → understand → generate
  understand/   AI Workflow Understanding (Gemini structured output; offline heuristic fallback)
  generate/     Workflow Generator
    catalog.ts    closed catalog of triggers/actions: the contract with the executor
    generator.ts  Gemini → spec (JSON schema), or a deterministic template
    validate.ts   enforces catalog, checks {{var}} data flow, ensures not-found guard
  automate/     Automation Engine
    executors.ts  one executor per (action, mechanism)
    engine.ts     ladder API → App → Accessibility → Browser → Vision; guards; ask-user pause/resume
    triggers.ts   Gmail poller with baseline (only genuinely new emails fire)
    browser.ts    Playwright via installed Chrome / Edge / Brave (or cached Chromium)
  learn/stats.ts  per (action, mechanism) reliability; unreliable rungs are demoted
  integrations/ Gmail (OAuth PKCE loopback, REST), Slack (bot or webhook), Acme CRM (local mock)
browser-extension/   MV3: navigation, clicks, submits, downloads, as semantic labels only
src/                 React UI: Observe · Discover · Automate · Connections & privacy
```

**Storage:** `node:sqlite` (built into Electron's Node, so no native module to rebuild). Secrets are encrypted with the OS keychain through `safeStorage`.

### Automation ladder

| Action | API | App | Accessibility | Browser | Vision |
|---|---|---|---|---|---|
| `ai.extract` | Gemini | local heuristic | | | |
| `gmail.download_attachment`, `gmail.reply` | Gmail REST | | | | |
| `crm.find_customer`, `crm.update_customer` | CRM REST | | | Playwright | |
| `slack.send_message` | Slack Web API / webhook | | | | |

The engine tries each supported rung in order and records every attempt. `learn/` demotes a rung whose recent success rate drops below 40%. The Accessibility and Vision rungs are part of the model and the UI, but no executor implements them yet (see *Roadmap*).

## Connections

Configure these under **Connections & privacy**, or in `.env` (see `.env.example`).

- **Gemini**: API key and model (default `gemini-2.5-flash`). Without a key, understanding and generation fall back to heuristics or templates, and `ai.extract` uses local extraction.
- **Gmail**: create an OAuth client of type *Desktop app* in Google Cloud Console with the Gmail API enabled, paste the client ID and secret, then click **Connect Gmail**. Scope: `gmail.modify`.
- **Slack**: a bot token (`chat:write`, and invite the bot to the channel) or an incoming webhook.
- **Acme CRM**: built in, at `http://localhost:4545`. Its `/api` can be switched off to demonstrate the browser fallback.

### Browser extension

1. `chrome://extensions` (or `brave://extensions`, `edge://extensions`) → Developer mode → **Load unpacked** → select `browser-extension/`.
2. Paste the pairing token from **Settings → Browser extension** into the extension popup.

## Privacy

- Observations stay in a local SQLite database, and raw events are purged after 14 days (configurable).
- Field **values** are never captured, only labels. Password, card, OTP and token fields are dropped entirely.
- Blocked apps (password managers by default) and blocked URLs (banking, sign-in pages) are never recorded.
- Gemini receives only abstract step names and redacted titles when it names an intent. At run time, `ai.extract` sends the trigger email to Gemini.
- Nothing is automated without explicit approval, and runs pause for the user when a guard fails.

## Platform notes

- **macOS**: grant *Accessibility* to WorkFlowOS (or to your terminal while developing) so window titles and focused controls are visible. The first run also asks for permission to control *System Events*.
- **Windows**: no extra permissions are needed. The OS sensor uses PowerShell with UI Automation.
- Packaging: `npm run build:mac` / `npm run build:win`.

## Roadmap

- Accessibility executor (AX / UIA actions) for native desktop apps.
- Vision fallback: screenshot + Gemini to locate controls when there is no DOM or accessibility tree.
- More catalog actions and triggers (Sheets, Outlook, Jira, schedules, file-created).
- Learn from user edits and ask-user resolutions to refine generated workflows.

## Dev tips

- `WF_PROFILE=demo npm run dev` uses an isolated data directory.
- `WF_DEBUG_PORT=9333 npm run dev` exposes CDP so the UI can be driven by Playwright.
