/**
 * windowFocus.js  (Electron main process, Windows only)
 *
 * Brings the game window to the front, like Alt+Tab would. It uses a short PowerShell
 * snippet (SetForegroundWindow). Windows allows this because our app is the one the
 * user just clicked in. It does not touch the game process, only its window.
 */
const { execFile } = require('child_process');

const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$p = Get-Process -Name $env:NR_PROC -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
  'if (-not $p) { exit 2 }',
  "Add-Type -Namespace NR -Name Win -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(System.IntPtr h); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(System.IntPtr h, int c); [DllImport(\"user32.dll\")] public static extern bool IsIconic(System.IntPtr h);'",
  '$h = $p.MainWindowHandle',
  'if ([NR.Win]::IsIconic($h)) { [void][NR.Win]::ShowWindow($h, 9) }',
  'if ([NR.Win]::SetForegroundWindow($h)) { exit 0 } else { exit 3 }',
].join('\n');

const processBaseName = name => String(name || '').trim().replace(/\.exe$/i, '').replace(/[^A-Za-z0-9._ -]/g, '');

/** @returns {Promise<{ok:boolean, reason?:string}>} never rejects */
function focusGameWindow({ processName, run = execFile, platform = process.platform, timeoutMs = 15000 } = {}) {
  const name = processBaseName(processName);
  if (platform !== 'win32') return Promise.resolve({ ok: false, reason: 'unsupported' });
  if (!name) return Promise.resolve({ ok: false, reason: 'no-process-name' });
  return new Promise(resolve => {
    run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      { windowsHide: true, timeout: timeoutMs, env: { ...process.env, NR_PROC: name } },
      err => {
        if (!err) return resolve({ ok: true });
        const reason = err.code === 2 ? 'no-window' : err.code === 3 ? 'refused' : 'failed';
        resolve({ ok: false, reason });
      }
    );
  });
}

module.exports = { focusGameWindow, processBaseName };
