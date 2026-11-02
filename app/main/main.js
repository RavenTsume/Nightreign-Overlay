const { app, BrowserWindow, globalShortcut, screen, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const MapWatcher = require('./mapWatcher');
const AutoScan = require('./autoScan');
const { chooseFinderPlacement, samePlacement } = require('../../src/core/finderPlacement');
const policy = require('../../src/core/overlayPolicy');

function shouldLogDev() {
  return process.env.NODE_ENV !== 'production';
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (seedWin) {
      if (seedWin.isMinimized()) seedWin.restore();
      seedWin.focus();
    }
  });
}

let overlayWin = null;
let seedWin = null;
let clickThrough = true;
let cachedHotkeys = null;
let shortcutsSuspended = false;
let currentLocale = 'en';
let mapWatcher = null;
let autoScan = null;
let scanDebugRoot = null;
let finderPlacement = null; // {mode:'normal'} or {mode:'borderless', displayId, bounds}
let lastScanResult = null; // last successful scan, re-applied if the finder window has to be rebuilt

function sanitizeAccelerator(acc, fallback) {
  if (!acc || typeof acc !== 'string') return fallback;
  const value = acc.trim();
  if (!value || /mouse\d*/i.test(value) || /unidentified/i.test(value) || /^dead$/i.test(value)) {
    console.warn(`[main] Invalid accelerator "${acc}". Falling back to ${fallback}.`);
    return fallback;
  }

  const MODIFIER_SET = new Set(['Ctrl', 'Shift', 'Alt', 'Meta']);
  const CANONICAL_TOKENS = Object.freeze({
    control: 'Ctrl',
    ctrl: 'Ctrl',
    shift: 'Shift',
    alt: 'Alt',
    option: 'Alt',
    altgr: 'Alt',
    meta: 'Meta',
    super: 'Meta',
    command: 'Meta',
    cmd: 'Meta',
    win: 'Meta',
    windows: 'Meta',
    escape: 'Esc',
    esc: 'Esc',
    space: 'Space',
    return: 'Enter',
    enter: 'Enter',
    tab: 'Tab',
    backspace: 'Backspace',
    delete: 'Delete',
    arrowup: 'ArrowUp',
    arrowdown: 'ArrowDown',
    arrowleft: 'ArrowLeft',
    arrowright: 'ArrowRight',
    plus: 'Plus',
    add: 'Plus',
    minus: 'Minus',
    subtract: 'Minus',
    pageup: 'PageUp',
    pagedown: 'PageDown',
    home: 'Home',
    end: 'End',
  });

  const normalize = token => {
    if (!token) return null;
    const trimmed = token.trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    const canonical = CANONICAL_TOKENS[lower];
    if (canonical) return canonical;
    if (lower.startsWith('ctrl')) return 'Ctrl';
    if (lower.startsWith('shift')) return 'Shift';
    if (lower.startsWith('alt')) return 'Alt';
    if (
      lower.startsWith('meta') ||
      lower.startsWith('super') ||
      lower.startsWith('command') ||
      lower.startsWith('cmd') ||
      lower.startsWith('win')
    ) {
      return 'Meta';
    }
    if (/^f\d{1,2}$/.test(lower)) return lower.toUpperCase();
    if (lower.length === 1) return lower.toUpperCase();
    if (lower.startsWith('numpad') && lower.length > 6) {
      const first = lower.charAt(6);
      const rest = lower.slice(7);
      return 'Numpad' + first.toUpperCase() + rest;
    }
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
  };

  const tokens = value.split('+').map(normalize).filter(Boolean);
  if (!tokens.length) return fallback;
  const seen = new Set();
  const normalised = [];
  let hasNonModifier = false;
  tokens.forEach(tok => {
    if (seen.has(tok)) return;
    seen.add(tok);
    normalised.push(tok);
    if (!MODIFIER_SET.has(tok)) hasNonModifier = true;
  });
  if (!normalised.length || !hasNonModifier) {
    console.warn(`[main] Accelerator "${acc}" is modifier-only. Falling back to ${fallback}.`);
    return fallback;
  }
  return normalised.join('+');
}
function normalizeHotkeyMap(map = {}) {
  return {
    toggleSeedFinder: sanitizeAccelerator(map.toggleSeedFinder, 'F7'),
    sendToOverlay: sanitizeAccelerator(map.sendToOverlay, 'F8'),
    toggleOverlay: sanitizeAccelerator(map.toggleOverlay, 'F9'),
    resetOverlay: sanitizeAccelerator(map.resetOverlay, 'F10'),
  };
}

function loadHotkeysRaw() {
  const cfgPath = path.join(__dirname, '..', '..', 'config', 'hotkeys.json');
  try {
    const raw = fs.readFileSync(cfgPath, 'utf-8');
    const data = JSON.parse(raw);
    return {
      toggleSeedFinder: data.toggleSeedFinder || 'F7',
      sendToOverlay: data.sendToOverlay || 'F8',
      toggleOverlay: data.toggleOverlay || 'F9',
      resetOverlay: data.resetOverlay || 'F10',
    };
  } catch (err) {
    console.warn(
      `[main] Failed to load hotkeys configuration from ${cfgPath}, using defaults`,
      err
    );
    return {
      toggleSeedFinder: 'F7',
      sendToOverlay: 'F8',
      toggleOverlay: 'F9',
      resetOverlay: 'F10',
    };
  }
}

function loadHotkeys() {
  const raw = loadHotkeysRaw();
  return normalizeHotkeyMap(raw);
}

function createOverlay(display) {
  const { x, y, width, height } = display.bounds;

  overlayWin = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    type: process.platform === 'win32' ? 'toolbar' : 'panel',
    useContentSize: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      zoomFactor: 1,
    },
  });

  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  // No { forward: true }: on Windows that installs a system-wide mouse hook, which makes the cursor stutter
  // whenever this app is busy. The overlay never needs mouse events (it is purely click-through).
  overlayWin.setIgnoreMouseEvents(clickThrough);
  // Keep the overlay out of screen captures so our own labels never disturb the
  // map detector (it takes screenshots to see whether the map is open).
  overlayWin.setContentProtection(true);

  overlayWin.loadFile(path.join(__dirname, '..', '..', 'public', 'overlay', 'index.html'));

  overlayWin.webContents.on('did-finish-load', event => {
    const wc = event.sender;
    if (!wc || wc.isDestroyed()) return;

    const thisWin = BrowserWindow.fromWebContents(wc);
    if (!thisWin || thisWin.isDestroyed()) return;

    try {
      wc.setZoomFactor(1);
      wc.setVisualZoomLevelLimits(1, 1);

      const d = screen.getDisplayMatching(thisWin.getBounds());
      wc.send('display-info', {
        bounds: d.bounds,
        scaleFactor: d.scaleFactor,
      });

      try {
        wc.send('overlay:locale', currentLocale);
      } catch (error) {
        if (shouldLogDev()) {
          console.warn('[main] Failed to push locale to overlay window', error);
        }
      }
    } catch (error) {
      console.error('Error in did-finish-load handler:', error);
    }
  });

  overlayWin.on('closed', () => {
    overlayWin = null;
  });
}

function currentFinderPlacement() {
  return chooseFinderPlacement(screen.getAllDisplays(), screen.getPrimaryDisplay().id);
}

// One monitor: a normal window. Two or more: a borderless window covering the second monitor, so the game keeps
// the primary one and the finder becomes a big second screen.
function createFinder({ show = true } = {}) {
  const placement = currentFinderPlacement();
  const borderless = placement.mode === 'borderless';
  const win = new BrowserWindow({
    ...(borderless
      ? { ...placement.bounds, frame: false, resizable: false, movable: false, maximizable: false, fullscreenable: false, hasShadow: false }
      : { width: 1080, height: 870 }),
    show,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  seedWin = win;
  finderPlacement = placement;
  if (borderless) win.setBounds(placement.bounds); // (re-applied so mixed-DPI monitors get the exact size)

  win.loadFile(path.join(__dirname, '..', '..', 'public', 'finder', 'index.html'));

  win.on('closed', () => {
    if (seedWin !== win) return; // an old window that was replaced on purpose
    seedWin = null;
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close();
    overlayWin = null;
    app.quit();
  });
  return win;
}

// A framed window cannot become frameless (or back) without being recreated, so a monitor being plugged in or out
// rebuilds the finder. The last successful scan is shown again so the map does not disappear.
function rebuildFinder() {
  const old = seedWin;
  const wasVisible = !old || old.isDestroyed() || old.isVisible();
  const win = createFinder({ show: wasVisible });
  if (old && !old.isDestroyed()) old.destroy();
  if (lastScanResult) win.webContents.once('did-finish-load', () => send(win, 'autoscan:result', lastScanResult));
}

function syncFinderToDisplays() {
  if (!seedWin || seedWin.isDestroyed()) return;
  const next = currentFinderPlacement();
  if (samePlacement(next, finderPlacement)) return;
  if (next.mode === 'borderless' && finderPlacement && finderPlacement.mode === 'borderless') {
    finderPlacement = next; // same kind of window, other monitor or size: just move it
    seedWin.setBounds(next.bounds);
    setTimeout(() => seedWin && !seedWin.isDestroyed() && seedWin.setBounds(next.bounds), 120);
    return;
  }
  rebuildFinder();
}

function send(win, ch, payload) {
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send(ch, payload);
    } catch (error) {
      console.error('Error sending message to window:', error);
    }
  }
}

function registerShortcuts() {
  const raw = loadHotkeysRaw();
  const sanitized = normalizeHotkeyMap(raw);
  const cfgPath = path.join(__dirname, '..', '..', 'config', 'hotkeys.json');
  if (
    raw.toggleSeedFinder !== sanitized.toggleSeedFinder ||
    raw.sendToOverlay !== sanitized.sendToOverlay ||
    raw.toggleOverlay !== sanitized.toggleOverlay ||
    raw.resetOverlay !== sanitized.resetOverlay
  ) {
    try {
      fs.writeFileSync(cfgPath, JSON.stringify(sanitized, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[main] Failed to normalise hotkeys config', err);
    }
  }
  cachedHotkeys = sanitized;
  if (shortcutsSuspended) return;
  globalShortcut.unregisterAll();

  const ACTION_EXECUTORS = {
    toggleSeedFinder() {
      if (seedWin) {
        if (seedWin.isVisible()) seedWin.hide();
        else seedWin.show();
      } else {
        createFinder();
      }
    },
    sendToOverlay() {
      send(seedWin, 'finder:request-active-seed');
    },
    toggleOverlay() {
      if (!overlayWin) return;
      if (overlayWin.isVisible()) overlayWin.hide();
      else {
        overlayWin.showInactive();
        overlayWin.setAlwaysOnTop(true, 'screen-saver');
      }
    },
    resetOverlay() {
      send(overlayWin, 'overlay:reset');
    },
  };

  Object.entries({
    toggleSeedFinder: sanitized.toggleSeedFinder,
    sendToOverlay: sanitized.sendToOverlay,
    toggleOverlay: sanitized.toggleOverlay,
    resetOverlay: sanitized.resetOverlay,
  }).forEach(([action, accelerator]) => {
    try {
      globalShortcut.register(accelerator, () => {
        try {
          ACTION_EXECUTORS[action]();
        } catch (e) {
          console.warn(`[main] Hotkey action failed: ${action}`, e);
        }
      });
    } catch (err) {
      console.warn(`[main] Failed to register shortcut ${accelerator} for ${action}`, err);
    }
  });
}

function showOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (!overlayWin.isVisible()) overlayWin.showInactive();
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
}

function hideOverlay() {
  if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) overlayWin.hide();
}

function applyOverlayAction(action) {
  if (action === 'show') showOverlay();
  else if (action === 'hide') hideOverlay();
}

const autoOverlayEnabled = () => !mapWatcher || mapWatcher.cfg.enabled;
const mapLookLearned = () => !!mapWatcher && mapWatcher.refs.length > 0;

// The overlay follows the in-game map (hidden until it opens), unless the automatic overlay is switched off in the
// overlay options. See src/core/overlayPolicy.js.
function applyAutoOverlayState() {
  if (!mapWatcher) return;
  applyOverlayAction(policy.autoOverlayAction({ enabled: autoOverlayEnabled(), active: mapLookLearned(), open: mapWatcher.isOpen }));
}

function startMapWatcher() {
  mapWatcher = new MapWatcher({ configDir: path.join(__dirname, '..', '..', 'config') });
  mapWatcher.on('open', () => applyOverlayAction(policy.watcherEventAction('open', { enabled: autoOverlayEnabled(), active: mapLookLearned() })));
  mapWatcher.on('close', () => applyOverlayAction(policy.watcherEventAction('close', { enabled: autoOverlayEnabled(), active: mapLookLearned() })));
  mapWatcher.on('status', state => send(seedWin, 'autodetect:status', state));
  mapWatcher.start();
  applyAutoOverlayState();
  startAutoScan();
}

// The Scan button: switch to the game, wait for the map, read it, find the seed.
function startAutoScan() {
  scanDebugRoot = path.join(app.getPath('userData'), 'scan-debug');
  autoScan = new AutoScan({
    rootDir: path.join(__dirname, '..', '..'),
    watcher: mapWatcher,
    gameProcess: mapWatcher.cfg.gameProcess || 'nightreign.exe',
    config: { mapKeys: mapWatcher.cfg.openKeys && mapWatcher.cfg.openKeys.length ? mapWatcher.cfg.openKeys : ['M'] },
    debugRoot: scanDebugRoot,
  });
  autoScan.on('status', s => send(seedWin, 'autoscan:status', s));
  autoScan.on('result', r => {
    if (r.ok) lastScanResult = r;
    // the map is open right now: show the labels on top of it (unless the automatic overlay is switched off)
    applyOverlayAction(policy.scanResultAction({ enabled: autoOverlayEnabled(), ok: r.ok }));
    send(seedWin, 'autoscan:result', r);
  });
}

function reattachToPrimary() {
  const d = screen.getPrimaryDisplay();
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.destroy();
  }
  createOverlay(d);
  applyAutoOverlayState();
  syncFinderToDisplays();
}

ipcMain.on('overlay:toggle-overlay', () => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (overlayWin.isVisible()) {
    overlayWin.hide();
  } else {
    overlayWin.showInactive();
    overlayWin.setAlwaysOnTop(true, 'screen-saver');
  }
});

ipcMain.on('overlay:hide-overlay', () => {
  if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) {
    overlayWin.hide();
  }
});

ipcMain.on('seed:selected', (_e, payload) => {
  send(overlayWin, 'overlay:seed-selected', payload);
});

ipcMain.on('overlay:reset', () => {
  send(overlayWin, 'overlay:reset');
});

ipcMain.on('hotkeys:suspend', (_e, flag) => {
  const shouldSuspend = Boolean(flag);
  if (shortcutsSuspended === shouldSuspend) return;
  shortcutsSuspended = shouldSuspend;
  if (shortcutsSuspended) {
    globalShortcut.unregisterAll();
  } else {
    registerShortcuts();
  }
});

ipcMain.on('hotkeys:save', (_e, cfg) => {
  const cfgPath = path.join(__dirname, '..', '..', 'config', 'hotkeys.json');
  const sanitized = normalizeHotkeyMap(cfg || {});
  try {
    fs.writeFileSync(cfgPath, JSON.stringify(sanitized, null, 2), 'utf-8');

    registerShortcuts();
  } catch (err) {
    console.error('Failed to save hotkeys config', err);
  }
});

ipcMain.on('locale:changed', (_e, code) => {
  if (typeof code === 'string' && code.trim()) {
    currentLocale = code.trim();
    send(overlayWin, 'overlay:locale', currentLocale);
  }
});

ipcMain.handle('autodetect:get', () => (mapWatcher ? mapWatcher.getState() : null));

ipcMain.handle('autodetect:set', (_e, patch) => {
  if (!mapWatcher) return null;
  const state = mapWatcher.updateConfig(patch || {});
  applyAutoOverlayState();
  return state;
});

ipcMain.handle('autodetect:clear', () => (mapWatcher ? mapWatcher.clearRefs() : null));

// Plain "remember what the open map looks like" (the Scan button does this automatically).
// The finder window stays where it is.
ipcMain.handle('autodetect:calibrate', async (_e, opts) => {
  if (!mapWatcher) return { ok: false, error: 'unavailable' };
  const delayMs = Math.min(15000, Math.max(0, Number(opts && opts.delayMs) || 5000));
  return mapWatcher.calibrate({ delayMs });
});

ipcMain.handle('autoscan:start', () => {
  if (!autoScan) return { ok: false, reason: 'unavailable' };
  if (autoScan.running) return { ok: false, reason: 'busy' };
  autoScan.start(); // runs in the background; progress arrives as 'autoscan:status' / 'autoscan:result'
  return { ok: true };
});
// "Forget map": stop a running scan and drop the remembered result (the finder resets itself and the overlay).
ipcMain.handle('autoscan:forget', () => {
  lastScanResult = null;
  if (autoScan) autoScan.cancel();
  return true;
});

// Window controls for the borderless finder (it has no title bar).
ipcMain.handle('finder:window-info', () => ({ borderless: !!finderPlacement && finderPlacement.mode === 'borderless' }));
ipcMain.on('finder:minimize', () => {
  if (seedWin && !seedWin.isDestroyed()) seedWin.minimize();
});
ipcMain.on('finder:close', () => {
  if (seedWin && !seedWin.isDestroyed()) seedWin.close(); // closing the finder quits the app, as before
});

ipcMain.handle('autoscan:cancel', () => {
  if (autoScan) autoScan.cancel();
  return true;
});
ipcMain.handle('autoscan:open-debug', async () => {
  if (!scanDebugRoot) return false;
  fs.mkdirSync(scanDebugRoot, { recursive: true });
  return (await shell.openPath(scanDebugRoot)) === '';
});

ipcMain.handle('hotkeys:request', () => {
  return cachedHotkeys || loadHotkeys();
});

async function bootstrap() {
  try {
    await app.whenReady();
  } catch (error) {
    console.error('[main] Electron failed to initialise', error);
    app.quit();
    return;
  }

  const display = screen.getPrimaryDisplay();
  createOverlay(display);
  createFinder();
  registerShortcuts();
  startMapWatcher();

  screen.on('display-added', reattachToPrimary);
  screen.on('display-removed', reattachToPrimary);
  screen.on('display-metrics-changed', reattachToPrimary);
}

bootstrap();

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  if (autoScan) autoScan.cancel();
  if (mapWatcher) mapWatcher.stop();
  globalShortcut.unregisterAll();
});
