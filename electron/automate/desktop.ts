import { execFile } from 'node:child_process'

// Desktop automation through the OS accessibility layer: macOS AX via
// System Events (JXA), Windows UI Automation (PowerShell). Controls are found
// by role + accessible name, never by screen coordinates.

export interface DesktopOp {
  op: 'open' | 'click' | 'type' | 'press'
  app: string
  name?: string
  role?: string
  value?: string
  keys?: string
}

const MAC = String.raw`
function run(argv) {
  var a = JSON.parse(argv[0]);
  var se = Application('System Events');
  var app = Application(a.app);
  app.activate();
  delay(0.7);
  if (a.op === 'open') return 'ok';
  if (a.op === 'press') {
    var parts = a.keys.toLowerCase().split('+');
    var key = parts.pop();
    var mods = parts.map(function (m) {
      return { cmd: 'command down', command: 'command down', ctrl: 'control down', control: 'control down', alt: 'option down', option: 'option down', shift: 'shift down' }[m];
    }).filter(Boolean);
    var codes = { enter: 36, return: 36, tab: 48, escape: 53, esc: 53, delete: 51, space: 49, up: 126, down: 125, left: 123, right: 124 };
    if (codes[key] !== undefined) se.keyCode(codes[key], { using: mods });
    else se.keystroke(key, { using: mods });
    return 'ok';
  }
  var p = se.applicationProcesses.whose({ frontmost: true })[0];
  var want = String(a.name || '').toLowerCase();
  var role = String(a.role || '').toLowerCase().replace(/^ax/, '');
  function nameOf(e) {
    var n = '';
    try { n = e.description(); } catch (x) {}
    if (!n) { try { n = e.name(); } catch (x) {} }
    if (!n) { try { n = e.title(); } catch (x) {} }
    return String(n || '').toLowerCase();
  }
  function roleOf(e) { try { return String(e.role()).toLowerCase().replace(/^ax/, ''); } catch (x) { return ''; } }
  var els = [];
  try { els = p.windows[0].entireContents(); } catch (x) { throw new Error('No window for ' + a.app); }
  var exact = null, partial = null;
  for (var i = 0; i < els.length; i++) {
    var e = els[i];
    var r = roleOf(e);
    if (a.op === 'type' && !/textfield|textarea|combobox|searchfield/.test(r)) continue;
    if (a.op === 'click' && role && r !== role && !(role === 'button' && /button/.test(r))) continue;
    var n = nameOf(e);
    if (n === want || !want) { exact = e; break; }
    if (!partial && n.indexOf(want) >= 0) partial = e;
  }
  var el = exact || partial;
  if (!el) throw new Error('Control not found: ' + (a.role || '') + ' "' + a.name + '"');
  if (a.op === 'click') { el.actions['AXPress'].perform(); return 'ok'; }
  try { el.focused = true; } catch (x) {}
  el.value = a.value;
  return 'ok';
}
`

const WIN = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
$a = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:WF_ARGS)) | ConvertFrom-Json
$name = $a.app -replace '\.exe$', ''
$proc = Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) {
  Start-Process $a.app
  for ($i = 0; $i -lt 20 -and -not $proc; $i++) {
    Start-Sleep -Milliseconds 500
    $proc = Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  }
}
if (-not $proc) { throw "Could not start $($a.app)" }
(New-Object -ComObject WScript.Shell).AppActivate($proc.Id) | Out-Null
Start-Sleep -Milliseconds 400
if ($a.op -eq 'open') { 'ok'; exit 0 }
if ($a.op -eq 'press') { [System.Windows.Forms.SendKeys]::SendWait($a.keys); 'ok'; exit 0 }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$want = "$($a.name)".ToLower()
$el = $null; $partial = $null
foreach ($e in $all) {
  $n = "$($e.Current.Name)".ToLower()
  if ($a.op -eq 'type') {
    $isText = $e.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -or $e.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document
    if (-not $isText) { continue }
  }
  if ($n -eq $want -or -not $want) { $el = $e; break }
  if (-not $partial -and $want -and $n.Contains($want)) { $partial = $e }
}
if (-not $el) { $el = $partial }
if (-not $el) { throw "Control not found: $($a.role) '$($a.name)'" }
if ($a.op -eq 'click') {
  try { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
  catch { $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle() }
} else {
  $el.SetFocus()
  $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($a.value)
}
'ok'
`

/** "cmd+s" → SendKeys "^s" (Windows has no Cmd; treat it as Ctrl). */
export function toSendKeys(keys: string): string {
  const parts = keys.toLowerCase().split('+').map((p) => p.trim())
  const key = parts.pop() ?? ''
  const mods = parts.map((m) => ({ cmd: '^', command: '^', ctrl: '^', control: '^', alt: '%', option: '%', shift: '+' })[m] ?? '').join('')
  const named: Record<string, string> = { enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', escape: '{ESC}', esc: '{ESC}', delete: '{DEL}', space: ' ', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}' }
  return mods + (named[key] ?? key)
}

export function desktopSupported(): string | true {
  if (process.platform === 'darwin' || process.platform === 'win32') return true
  return `Desktop automation is not supported on ${process.platform}`
}

export function runDesktop(op: DesktopOp): Promise<string> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, stdout: string, stderr: string) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').filter(Boolean).pop()?.replace(/^.*execution error: /, '') ?? 'Desktop action failed'))
      else resolve(stdout.trim())
    }
    if (process.platform === 'darwin') {
      execFile('osascript', ['-l', 'JavaScript', '-e', MAC, JSON.stringify(op)], { timeout: 60_000 }, done)
    } else if (process.platform === 'win32') {
      const payload = { ...op, keys: op.keys ? toSendKeys(op.keys) : undefined }
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WIN, 'utf16le').toString('base64')],
        { timeout: 60_000, windowsHide: true, env: { ...process.env, WF_ARGS: Buffer.from(JSON.stringify(payload)).toString('base64') } },
        done,
      )
    } else reject(new Error('Unsupported platform'))
  })
}
