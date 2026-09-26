import { it, expect } from 'vitest'
import { runDesktop } from './desktop'
// Live check against TextEdit (macOS only; needs Accessibility for the terminal).
it.runIf(process.platform === 'darwin' && process.env.WF_LIVE)('drives TextEdit through AX', async () => {
  await runDesktop({ op: 'open', app: 'TextEdit' })
  await runDesktop({ op: 'press', app: 'TextEdit', keys: 'cmd+n' })
  await new Promise((r) => setTimeout(r, 800))
  const out = await runDesktop({ op: 'type', app: 'TextEdit', name: 'text entry area', value: 'Hello from WorkFlowOS' }).catch((e) => String(e))
  const blank = await runDesktop({ op: 'type', app: 'TextEdit', name: '', value: 'Hello again from WorkFlowOS' }).catch((e) => String(e))
  expect(blank).toBe('ok')
  process.stderr.write(`\ntype result: ${out}\n`)
  expect(out).toBe('ok')
}, 60_000)
