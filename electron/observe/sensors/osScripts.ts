// Long-running helper scripts for the OS sensor. Each prints one JSON line
// ({ app, title, role, label }) whenever the foreground state changes.

// macOS — JXA. The frontmost app comes from NSWorkspace (no permission needed).
// Window title and focused element come from System Events, which needs the
// Accessibility permission; without it, those fields are simply absent.
export const MAC_JXA = String.raw`
ObjC.import('AppKit');
ObjC.import('Foundation');
var se = Application('System Events');
var out = $.NSFileHandle.fileHandleWithStandardOutput;
function emit(s) { out.writeData($(s + '\n').dataUsingEncoding($.NSUTF8StringEncoding)); }
var last = '';
while (true) {
  var o = {};
  try {
    var fa = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    o.app = ObjC.unwrap(fa.localizedName);
  } catch (e) {}
  try {
    var p = se.applicationProcesses.whose({ frontmost: true })[0];
    try { o.title = p.windows[0].name(); } catch (e) {}
    try {
      var f = p.attributes['AXFocusedUIElement'].value();
      try { o.role = f.role(); } catch (e) {}
      var label = '';
      try { label = f.description(); } catch (e) {}
      if (!label) { try { label = f.name(); } catch (e) {} }
      if (!label) { try { label = f.title(); } catch (e) {} }
      if (label) o.label = String(label).slice(0, 80);
    } catch (e) {}
  } catch (e) {}
  var s = JSON.stringify(o);
  if (s !== last) { emit(s); last = s; }
  delay(1.5);
}
`

// Windows — PowerShell. Win32 for the foreground window, UI Automation for the
// focused element. No extra permissions are required.
export const WIN_PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WfW {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$last = ''
while ($true) {
  $o = [ordered]@{}
  try {
    $h = [WfW]::GetForegroundWindow()
    $sb = New-Object System.Text.StringBuilder 512
    [void][WfW]::GetWindowText($h, $sb, 512)
    $o.title = $sb.ToString()
    $procId = 0
    [void][WfW]::GetWindowThreadProcessId($h, [ref]$procId)
    $o.app = (Get-Process -Id $procId).ProcessName
  } catch {}
  try {
    $f = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($f) {
      $o.role = $f.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
      $n = $f.Current.Name
      if ($n) { $o.label = $n.Substring(0, [Math]::Min(80, $n.Length)) }
    }
  } catch {}
  $s = $o | ConvertTo-Json -Compress
  if ($s -ne $last) { [Console]::Out.WriteLine($s); [Console]::Out.Flush(); $last = $s }
  Start-Sleep -Milliseconds 1500
}
`
