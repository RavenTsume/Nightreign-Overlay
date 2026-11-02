/**
 * keyState.js  (Electron main process, Windows only)
 *
 * Lets the app ask Windows "is this key or mouse button held down right now?" (GetAsyncKeyState).
 *
 * Why not Electron's globalShortcut? It would SWALLOW the key, so the game would
 * never receive "M" and the map would not open. GetAsyncKeyState only reads the key
 * state: it installs no keyboard hook, injects nothing, and the key still reaches
 * the game normally.
 *
 * It needs the optional `koffi` package (npm install). If that is missing or fails,
 * createKeyStateProvider() returns null and the watcher falls back to scanning
 * continuously (while the game runs).
 */

/** Windows virtual-key code for a key name from the config, or null if unknown. */
function vkFor(name) {
  const n = String(name || '').trim();
  if (/^[a-z]$/i.test(n)) return n.toUpperCase().charCodeAt(0); // A-Z  = 0x41-0x5A
  if (/^[0-9]$/.test(n)) return n.charCodeAt(0); // 0-9  = 0x30-0x39
  const f = /^f(\d{1,2})$/i.exec(n); // F1-F24 = 0x70-0x87
  if (f && +f[1] >= 1 && +f[1] <= 24) return 0x70 + (+f[1] - 1);
  const named = {
    escape: 0x1b, esc: 0x1b, tab: 0x09, enter: 0x0d, space: 0x20,
    shift: 0x10, ctrl: 0x11, control: 0x11, alt: 0x12, capslock: 0x14,
    // mouse buttons (GetAsyncKeyState reads them like keys; it reports the PHYSICAL button)
    leftmouse: 0x01, lmb: 0x01, mouse1: 0x01,
    rightmouse: 0x02, rmb: 0x02, mouse2: 0x02,
    middlemouse: 0x04, mmb: 0x04, mouse3: 0x04,
    mouse4: 0x05, mouse5: 0x06,
  };
  return named[n.toLowerCase().replace(/[\s_-]/g, '')] ?? null;
}

function createKeyStateProvider({ platform = process.platform, loader = () => require('koffi') } = {}) {
  if (platform !== 'win32') return null;
  try {
    const koffi = loader();
    const user32 = koffi.load('user32.dll');
    const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)');
    return {
      // The high bit (0x8000) is set while the key is held down.
      isDown: vk => (GetAsyncKeyState(vk) & 0x8000) !== 0,
    };
  } catch (err) {
    console.warn('[keyState] key trigger unavailable (is the optional "koffi" package installed?)', err.message);
    return null;
  }
}

module.exports = { createKeyStateProvider, vkFor };
