# WorkFlowOS

**AI-powered, OS-level workflow automation.**

WorkFlowOS is a desktop agent that watches how you normally work, notices the routines you keep repeating across apps, works out what they are for, and turns them into automations. You approve each one before anything runs.

```
Observe → Understand → Detect repetition → Generate workflow → User approval → Automate → Learn
```

> Users know how to do their work. They shouldn't also have to know how to automate it.

---

## Contents

- [Why](#why)
- [How it works](#how-it-works)
- [Example: customer request processing](#example-customer-request-processing)
- [Requirements](#requirements)
- [Installation](#installation)
- [Setup](#setup)
- [Using WorkFlowOS](#using-workflowos)
- [What can be automated](#what-can-be-automated)
- [The automation ladder](#the-automation-ladder)
- [Architecture](#architecture)
- [Privacy and security](#privacy-and-security)
- [Configuration](#configuration)
- [Scripts and testing](#scripts-and-testing)
- [Troubleshooting](#troubleshooting)
- [Known limits](#known-limits)
- [Roadmap](#roadmap)

---

## Why

Knowledge workers spend hours on repetitive digital work that crosses applications: Email → Browser → Excel → CRM → Slack. They copy information, update records, create tickets and send notifications. Existing automation tools make you design the automation yourself. WorkFlowOS learns it from watching you work instead.

## How it works

| Stage | What happens |
|---|---|
| **Observe** | The Desktop Activity Agent records apps, browser navigation, clicks, form fields, submits, downloads and file saves as structured events. |
| **Detect repetition** | The Discovery Engine abstracts events into semantic steps and mines repeated sequences. It scores them by frequency, time spent and hand-offs between apps. |
| **Understand** | Gemini names the intent behind a sequence (e.g. *Process Customer Request*) and identifies which data changes each time. |
| **Generate** | The Workflow Generator compiles a workflow made of a trigger, steps, conditions, variables and integrations, grounded in exactly what was observed. |
| **Approve** | You review, edit, test and approve. Nothing runs before you do. |
| **Automate** | The Automation Engine runs each step with the most reliable mechanism available: API → App → Accessibility → Browser → Vision. |
| **Learn** | Success and failure per step and mechanism is recorded. An unreliable mechanism is moved down the ladder. |

## Example: customer request processing

A support user repeatedly does this:

1. Opens a customer email in Gmail
2. Downloads the attachment
3. Finds the customer in the CRM
4. Updates the record with the request details and the attachment
5. Notifies the team in Slack

After seeing this a few times, WorkFlowOS proposes:

- **Trigger:** new customer request in Gmail
- **Action 1:** read the email and identify the customer (Gemini extraction)
- **Action 2:** download the attachment (Gmail API)
- **Action 3:** find the customer in the CRM (CRM API, or the CRM web UI as fallback)
- **Action 4:** update the customer record with the request and attachment
- **Action 5:** post a Slack notification to the team
- **Condition:** if the customer can't be found, pause and ask the user

You approve it once. From then on, every matching email is processed automatically.

---

## Requirements

- **macOS** or **Windows**
- **Node.js 20+** and npm
- A Chromium browser (Chrome, Edge or Brave) for the extension and for browser automation
- *Optional:* a Gemini API key, a Google Cloud OAuth client (Gmail), and a Slack bot token or webhook

## Installation

```bash
git clone <repo-url> WorkflowOS
cd WorkflowOS
npm install
cp .env.example .env    # optional; every value can also be set in the app
npm run dev
```

`npm run dev` starts Vite and opens the Electron app. The database uses `node:sqlite`, which is built into Electron's Node runtime, so there are no native modules to rebuild.

## Setup

The **Observe** page shows a setup checklist until the essentials are done.

### 1. Browser extension (required for web workflows)

1. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`).
2. Turn on **Developer mode** and click **Load unpacked**.
3. Select the `browser-extension/` folder in this project.
4. Copy the pairing token from **Connections & privacy → Browser extension** and paste it into the extension popup. Click **Save & connect**.

The sidebar should then show **Browser extension: 1 browser connected**.

### 2. Accessibility permission (macOS, for desktop apps)

Go to **System Settings → Privacy & Security → Accessibility** and enable WorkFlowOS. While developing, enable your terminal app instead. Restart the app afterwards. The first run also asks for permission to control **System Events**. Allow it.

Windows needs no extra permissions.

### 3. Gemini API key (recommended)

Add it in **Connections & privacy → Gemini**, or set `GEMINI_API_KEY` in `.env`. Gemini:
- names workflows and describes their intent
- maps run inputs to trigger data (e.g. *customer email* ← the email's sender)
- extracts fields from emails at run time

Without a key, everything still works, but names are generic and extraction uses local heuristics.

### 4. Automation browser (required for web workflows)

Open **Connections & privacy → Automation browser → Open automation browser**. Sign in to the web apps your workflows use. This is a separate browser profile, and your logins are kept between runs. Learned web steps run here.

### 5. Gmail (optional: email-triggered workflows)

1. In [Google Cloud Console](https://console.cloud.google.com), create a project and enable the **Gmail API**.
2. Configure the **OAuth consent screen** as *External*, and add your Gmail address as a **Test user**.
3. Create an **OAuth client ID** of type **Desktop app**.
4. Paste the client ID and secret into **Connections & privacy → Gmail** and click **Connect Gmail**.

### 6. Slack (optional)

Choose one:
- **Incoming webhook:** create a Slack app, enable Incoming Webhooks, pick a channel and paste the URL.
- **Bot token:** give the app the `chat:write` scope, install it, and `/invite` the bot to your channel.

Click **Send test message** to confirm.

---

## Using WorkFlowOS

1. **Work normally.** Do a routine at least **3 times**: in the browser, in desktop apps, or across both. The **Observe** page shows events arriving live.
2. **Discover.** Discovery runs every 5 minutes. To run it now, click **Discover → Run discovery now**. Each repeated routine appears with its steps, frequency, average duration and the data that changes each time.
3. **Review.** Click **Review automation**. You'll see the trigger, the **inputs** (values that change each run) and every step, with the mechanism it will use. Click **Edit** to change the trigger, step labels, parameters or input mappings.
4. **Test.** Click **Test run**. For email workflows you can also click **Try with sample email**.
5. **Approve.** Click **Approve & activate**.
6. **Run.**
   - **Run now:** asks for any inputs, then runs.
   - **Daily schedule:** set under **Edit → Trigger → Every day at…**
   - **Gmail trigger:** runs for each new email matching the query. Emails that already existed when you approved are ignored.
7. **Handle pauses.** If a step fails, a guard fails (e.g. customer not found), or an input is missing, the run pauses and notifies you. Provide the value, then click **Continue**, **Retry step** or **Cancel run**.

### Sample data (for presentations)

**Connections & privacy → Data → Load sample data** loads five recorded runs of the Gmail → CRM → Slack routine. You can then show discovery, approval, the "customer not found" pause and the API → Browser fallback without doing the routine live. To show the fallback, turn off **Acme CRM → Public REST API** and run again.

---

## What can be automated

| You did this | WorkFlowOS runs | Mechanism |
|---|---|---|
| Gmail → CRM → Slack steps in a flow that starts from an email | `ai.extract`, `gmail.download_attachment`, `gmail.reply`, `crm.find_customer`, `crm.update_customer`, `slack.send_message` | API, with browser fallback for the CRM |
| Saved a spreadsheet in a watched folder | `excel.append_row` (edits the `.xlsx` / `.csv` file directly) | App |
| Typed into fields or pressed controls in a desktop app | `desktop.open_app`, `desktop.type`, `desktop.click`, `desktop.press` | Accessibility (macOS AX / Windows UI Automation) |
| Anything else in a web app | `web.open`, `web.fill`, `web.click`, `web.press`, `web.upload` | Browser (Playwright in the automation profile) |

How values are learned:
- A value that was **identical** in every observation is replayed as a **constant**.
- A value that **differed** becomes a **run input**. It is asked for when the workflow runs, or mapped by Gemini to trigger data.
- Navigation that happened *because of* a click (like landing on a newly created record) is not replayed. The click takes you there again.

## The automation ladder

Each step tries the mechanisms it supports, in priority order, and records every attempt:

| Action | API | App | Accessibility | Browser | Vision |
|---|---|---|---|---|---|
| `ai.extract` | Gemini | local heuristic | | | |
| `gmail.*` | Gmail REST | | | | |
| `crm.find_customer`, `crm.update_customer` | CRM REST | | | Playwright | |
| `slack.send_message` | Slack Web API / webhook | | | | |
| `excel.append_row` | | workbook file | | | |
| `desktop.*` | | | AX / UI Automation | | |
| `web.*` | | | | Playwright | |

A mechanism whose recent success rate drops below 40% (over at least 3 attempts) is moved to the end of the ladder. The run history shows which rung ran each step, which failed, and why. The Vision rung is modelled but not implemented yet.

---

## Architecture

Everything runs in the Electron **main process**. The React renderer only displays state, through a typed and allowlisted IPC surface (`electron/shared/api.ts`) with a sandboxed preload.

```
electron/
  main.ts                    wiring, IPC, window, single-instance lock
  preload.ts                 allowlisted bridge (window.wf)
  shared/                    types + API contract shared with the renderer
  core/                      SQLite (node:sqlite), settings + keychain secrets, event bus, store

  observe/                   Desktop Activity Agent
    sensors/osSensor.ts        foreground app, focused control, field values
                               macOS: persistent JXA (NSWorkspace + System Events / AX)
                               Windows: persistent PowerShell (Win32 + UI Automation)
    sensors/browserBridge.ts   WebSocket on 127.0.0.1:4546 for the extension (origin + token auth)
    sensors/fileSensor.ts      new and modified files in watched folders
    normalize.ts               process / URL → logical app (Gmail, Slack, CRM, Excel, …)
    privacy.ts                 blocklists, sensitive-field drop, scrubbing
    agent.ts                   privacy → de-dup → SQLite → bus

  discover/                  Workflow Discovery Engine
    abstract.ts                events → semantic steps (Gmail:open_email, CRM:update_customer, site:edit:field, …)
    mine.ts                    sessions → prune rare steps → n-gram support → maximal patterns →
                               rotation dedupe → variant merge (edit distance) → approximate matches → score
    engine.ts                  discover → understand → generate → propose

  understand/                AI Workflow Understanding
    gemini.ts                  structured-output client
    intent.ts                  intent name, description, variables (heuristic fallback)

  generate/                  Workflow Generator
    catalog.ts                 closed catalog of triggers and actions (the contract with the executor)
    replay.ts                  compiles observed events into web / desktop steps, with constants vs inputs
    generator.ts               deterministic draft → Gemini refinement (names, trigger, text, input mapping)
    validate.ts                enforces the catalog, checks {{variable}} data flow, adds safety guards

  automate/                  Automation Engine
    engine.ts                  runs steps down the ladder; guards; pause for input / user; resume
    executors.ts               one executor per (action, mechanism)
    browser.ts                 persistent Playwright profile (Chrome / Edge / Brave / Chromium)
    desktop.ts                 AX (JXA) and UI Automation (PowerShell) driver
    triggers.ts                Gmail poller with baseline, daily schedules
    vars.ts                    templating and conditions

  learn/stats.ts             per (action, mechanism) reliability; demotes unreliable rungs
  integrations/              Gmail (OAuth PKCE loopback + REST), Slack, Acme CRM (local web app + API)
  demo/scenario.ts           sample observations for presentations and tests

browser-extension/           MV3 extension: navigation, clicks, fields, submits, downloads + locator hints
src/                         React UI: Observe · Discover · Automate · Connections & privacy
```

**Storage:** one local SQLite database in the app's user-data folder holds events, patterns, workflows, runs, mechanism stats and the mock CRM. Secrets are encrypted with the OS keychain through Electron `safeStorage`.

**Acme CRM:** a small local CRM at `http://localhost:4545`, with a web UI and a REST API. You can add real customers to it and use it as your CRM. Its API can be switched off to show the browser fallback.

---

## Privacy and security

- **Local first.** Observations live in a local SQLite database. Raw events are deleted after 14 days (configurable).
- **Typed values stay on your machine.** They are needed to tell constants from inputs, and you can turn recording off in Settings.
- **Never recorded:** password, card, OTP and token fields, blocked apps (password managers by default) and blocked URLs (banking, sign-in pages). Incognito windows are ignored.
- **What Gemini sees:** step names, field labels and redacted page titles. Never recorded values. At run time, `ai.extract` sends the triggering email to Gemini to extract fields.
- **Approval first.** Nothing is automated without explicit approval, and runs pause for you when something looks wrong.
- **Hardening:** the extension bridge only accepts extension origins holding the pairing token. The renderer is sandboxed with context isolation and can only call an allowlisted API. Secrets are keychain-encrypted.

## Configuration

Everything can be set in **Connections & privacy**. `.env` (in the project root) provides optional defaults:

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Gemini API key |
| `GEMINI_MODEL` | Model name (default `gemini-2.5-flash`) |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` | Google OAuth "Desktop app" client |
| `SLACK_BOT_TOKEN` / `SLACK_WEBHOOK_URL` | Slack credentials |

Values saved in the app take precedence. `GMAIL_CLIENT_ID` and `GEMINI_MODEL` are only read on first launch; change them in Settings afterwards.

Other settings: observing on/off, recording typed values, app and URL blocklists, watched folders (default Downloads, Documents, Desktop), retention days, minimum repetitions before proposing (default 3), CRM API on/off.

## Scripts and testing

| Command | What it does |
|---|---|
| `npm run dev` | Run the app in development |
| `npm test` | Unit tests: discovery, generation, validation, replay compilation, Excel/CSV |
| `npm run typecheck` | TypeScript check |
| `npm run lint` | ESLint |
| `npm run build:mac` / `npm run build:win` | Package installers (electron-builder) |

Development helpers:
- `WF_PROFILE=<name> npm run dev` uses an isolated data folder, for experiments or demos.
- `WF_DEBUG_PORT=9333 npm run dev` exposes Chrome DevTools Protocol so the UI can be driven by Playwright.
- `WF_LIVE=1 npx vitest run electron/automate/desktop.live.test.ts` runs a live accessibility test against TextEdit (macOS).

## Troubleshooting

| Problem | Fix |
|---|---|
| Blank or error window | The app retries if the dev server wasn't ready and shows an error screen if rendering fails. Check the terminal and the **Engine log**. Make sure only one copy is running. |
| Extension shows "needs token" / "bad token" | Paste the current token from **Connections & privacy → Browser extension** into the popup. |
| Extension "disconnected" | WorkFlowOS must be running. Port 4546 must be free. |
| No window titles or desktop events on macOS | Grant Accessibility (see Setup) and restart the app. |
| "No browser available" | Install Chrome, Edge or Brave, or run `npx playwright install chromium`. |
| A replayed web step can't find an element | The site changed its label. Open the workflow → **Edit** and update the step's `label` / `name`. |
| Excel step fails to save | Close the workbook in Excel (Windows locks open files), then click **Retry step**. |
| Nothing discovered | A routine needs at least 3 repetitions (configurable). Check that events appear on **Observe**, then click **Run discovery now**. |

## Known limits

- **macOS native button clicks** can't be observed without a compiled helper, because buttons don't take focus. Typing into fields and switching apps is captured. On Windows, clicked controls take focus, so clicks are captured too.
- **Replay depends on labels.** If an app renames its controls, the step pauses for you until the label is updated.
- **Vision fallback** (screenshot-based) is not implemented yet.
- **Tested so far:** discovery, generation and web replay on macOS with the real extension, the TextEdit accessibility driver, and Excel/CSV writing. **Not yet verified:** the Windows sensors and driver, and live Gmail, Slack and Gemini calls.

## Roadmap

- Native helper for observing button clicks in macOS apps
- Vision fallback: screenshot + Gemini to locate controls without a DOM or accessibility tree
- More integrations: Google Sheets, Outlook, Jira, HubSpot
- Learn from user edits and pause resolutions to improve generated workflows
- Data flow between web steps (reading values from a page for later steps)
