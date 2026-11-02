/**
 * autoScan.js  (Electron main process)
 *
 * One "scan" = the whole flow behind the Scan button:
 *
 *   1. make sure Nightreign is running
 *   2. bring its window to the front
 *   3. wait until the in-game map is open (reacts to the map key; no constant screenshots)
 *   4. take two screenshots of the map
 *   5. read the icons + find the seed in a worker thread (the app never stalls)
 *   6. report back: 'status' updates while running and one 'result' at the end
 *
 * On success the screenshot also teaches the map watcher what the open map looks like, so the
 * overlay can open itself next time. Screenshots + the reading are saved for troubleshooting.
 */
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const sig = require('../../src/core/mapSignature');
const { createKeyStateProvider, vkFor } = require('./keyState');
const { focusGameWindow } = require('./windowFocus');
const { createGameProcessCheck } = require('./gameProcess');

const DEFAULTS = {
  timeoutMs: 120000, // give up waiting for the map after 2 minutes
  focusDelayMs: 900, // let the game window come up before looking
  settleMs: 1100, // after the map key: let the map finish opening
  secondShotMs: 500, // pause between the two screenshots
  pollMs: 1500, // no key reader: look this often
  safetyPollMs: 4000, // key reader: also look this often (map may already be open / opened by controller)
  keyPollMs: 40,
  mapKeys: ['M'],
};

/** Copy the map panel out of a full-screen frame (BGRA). */
function cropPanel(frame) {
  const { width: W, height: H } = frame;
  const r = sig.panelRect(W, H);
  const x0 = Math.max(0, Math.min(W - 1, r.x));
  const y0 = Math.max(0, Math.min(H - 1, r.y));
  const w = Math.max(1, Math.min(W - x0, r.width));
  const h = Math.max(1, Math.min(H - y0, r.height));
  const src = Buffer.from(frame.bitmap.buffer, frame.bitmap.byteOffset, frame.bitmap.length);
  const out = Buffer.allocUnsafeSlow(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * W + x0) * 4;
    src.copy(out, y * w * 4, from, from + w * 4);
  }
  return { width: w, height: h, data: out };
}

/** Full-resolution screenshot of the primary display. */
async function captureFullScreen() {
  const { desktopCapturer, screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) },
    fetchWindowIcons: false,
  });
  const source = sources.find(s => String(s.display_id) === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) return null;
  const size = source.thumbnail.getSize();
  return { bitmap: source.thumbnail.toBitmap(), width: size.width, height: size.height };
}

function loadScanData(rootDir) {
  const dir = path.join(rootDir, 'public', 'assets', 'data');
  const read = f => fs.readFileSync(path.join(dir, f), 'utf-8');
  return { templatesJson: read('scan_templates.json'), seedsJson: read('seed_data.json'), slotsJson: read('coordsXY.json') };
}

/** Worker threads cannot always load scripts from inside app.asar, so a packaged app uses the unpacked copy. */
function workerFile() {
  const file = path.join(__dirname, 'scanWorker.js');
  const unpacked = file.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return unpacked !== file && fs.existsSync(unpacked) ? unpacked : file;
}

function runWorker(job, data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile(), { workerData: { job, ...data } });
    worker.once('message', msg => {
      worker.terminate();
      msg.ok ? resolve(msg.result) : reject(new Error(msg.error));
    });
    worker.once('error', reject);
  });
}

class AutoScan extends EventEmitter {
  constructor(deps = {}) {
    super();
    this.cfg = { ...DEFAULTS, ...(deps.config || {}) };
    this.gameProcess = deps.gameProcess || 'nightreign.exe';
    this._isGameRunning = deps.isGameRunning || createGameProcessCheck({ processName: this.gameProcess, ttlMs: 0 }).isRunning;
    this._focus = deps.focus || (() => focusGameWindow({ processName: this.gameProcess }));
    this._capture = deps.capture || captureFullScreen;
    this._keys = deps.keyProvider === undefined ? createKeyStateProvider() : deps.keyProvider;
    this._sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this._now = deps.now || Date.now;
    this._data = null;
    this._loadData = deps.loadData || (() => loadScanData(deps.rootDir));
    this._analyze = deps.analyze || (job => runWorker(job, (this._data = this._data || this._loadData())));
    // PNG encoding happens in the worker thread (it would block the main thread, and the mouse, for ~100 ms each)
    this._encodePngs = deps.encodePngs || (async frames => (await runWorker({ type: 'png', frames }, {})).pngs);
    this.debugRoot = deps.debugRoot || null;
    this.watcher = deps.watcher || null;
    this.running = false;
    this._cancel = false;
  }

  cancel() {
    this._cancel = true;
  }

  /** Runs one scan. Never rejects; resolves with the same object that is emitted as 'result'. */
  async start() {
    if (this.running) return { ok: false, reason: 'busy' };
    this.running = true;
    this._cancel = false;
    if (this.watcher && this.watcher.pause) this.watcher.pause();
    let result;
    try {
      result = await this._run();
    } catch (err) {
      result = { ok: false, reason: 'error', message: `Scan failed: ${(err && err.message) || err}` };
    } finally {
      this.running = false;
      if (this.watcher && this.watcher.resume) this.watcher.resume();
    }
    const phase = result.ok ? 'done' : result.reason === 'cancelled' ? 'cancelled' : 'error';
    this._status(phase, result.message);
    this.emit('result', result);
    return result;
  }

  _status(phase, message, detail) {
    this.emit('status', { phase, message, detail: detail || null });
  }
  _fail(reason, message, extra) {
    return { ok: false, reason, message, ...(extra || {}) };
  }

  async _run() {
    this._status('starting', 'Checking that Nightreign is running…');
    if (!(await this._isGameRunning())) {
      return this._fail('game-not-running', `Nightreign (${this.gameProcess}) is not running. Start the game first.`);
    }

    this._status('focusing', 'Switching to Nightreign…');
    const focus = await this._focus();
    if (focus && focus.ok) await this._sleep(this.cfg.focusDelayMs);
    else this._status('focusing', 'Could not switch to the game automatically. Please click the Nightreign window.');
    if (this._cancel) return this._fail('cancelled', 'Scan cancelled.');

    const key = (this.cfg.mapKeys[0] || 'M').toUpperCase();
    this._status('waiting-map', `Open the in-game map (press ${key}). Waiting…`);
    const found = await this._waitForMap();
    if (found.reason) return found.result || this._fail(found.reason, found.message);

    this._status('capturing', 'Map found. Taking screenshots…');
    const panels = [found.panel];
    await this._sleep(this.cfg.secondShotMs);
    const second = await this._capture();
    if (second) panels.push(cropPanel(second));

    this._status('analyzing', 'Reading the map…');
    const reading = await this._analyze({ type: 'scan', frames: panels });
    const debugDir = await this._dump(panels, reading);

    if (!reading.mapOpen) {
      return this._fail('map-not-visible', 'The map was not visible in the screenshots. Keep it open and try again.', { debugDir, reading });
    }
    const m = reading.match;
    const summary = { seedId: m.seedId, mapType: m.mapType, nightlord: m.nightlord, exact: m.exact, margin: m.margin, top: m.top, slots: reading.slots, ms: reading.ms, debugDir };
    if (!reading.ok) {
      return this._fail('low-confidence',
        `Could not identify the seed confidently (best guess ${m.seedId}, ${m.exact}/27 slots matched). Make sure the whole map is visible and try again.${debugDir ? ' Details saved for troubleshooting.' : ''}`,
        summary);
    }

    if (this.watcher && this.watcher.addReferenceFromFrame) {
      try { this.watcher.addReferenceFromFrame(found.frame); } catch (err) { console.warn('[autoScan] could not learn map look', err); }
    }
    if (this.watcher && this.watcher.markOpen) this.watcher.markOpen(); // so closing the map later hides the overlay
    return { ok: true, message: `Seed ${m.seedId} found (${m.exact}/27 slots matched).`, ...summary };
  }

  /** Resolves with {frame, panel} once the map is on screen, or {reason}. */
  async _waitForMap() {
    const deadline = this._now() + this.cfg.timeoutMs;
    const vks = this.cfg.mapKeys.map(vkFor).filter(v => v !== null);
    const useKeys = !!this._keys && vks.length > 0;
    let look = true; // look right away: the map may already be open
    let lastLook = this._now();
    let prevDown = false;

    while (this._now() < deadline) {
      if (this._cancel) return { reason: 'cancelled', message: 'Scan cancelled.' };
      if (look) {
        const frame = await this._capture();
        if (!frame) return { reason: 'capture-failed', message: 'Could not take a screenshot.' };
        const panel = cropPanel(frame);
        const check = await this._analyze({ type: 'check', frames: [panel] });
        this._status('waiting-map', undefined, { similarity: check.score });
        if (check.open) return { frame, panel, check };
        look = false;
        lastLook = this._now();
      }
      await this._sleep(useKeys ? this.cfg.keyPollMs : this.cfg.pollMs);
      if (!useKeys) {
        look = true;
        continue;
      }
      const down = vks.some(vk => this._keys.isDown(vk));
      if (down && !prevDown) {
        await this._sleep(this.cfg.settleMs); // the map needs a moment to open
        look = true;
      }
      prevDown = down;
      if (!look && this._now() - lastLook >= this.cfg.safetyPollMs) look = true;
    }
    return { reason: 'timeout', message: `Gave up waiting for the map after ${Math.round(this.cfg.timeoutMs / 1000)} s.` };
  }

  /** Save the screenshots and the reading so a failed scan can be inspected. Never throws, never blocks the main thread. */
  async _dump(panels, reading) {
    if (!this.debugRoot) return null;
    try {
      const stamp = new Date(this._now()).toISOString().replace(/[:.]/g, '-');
      const dir = path.join(this.debugRoot, `scan-${stamp}`);
      await fs.promises.mkdir(dir, { recursive: true });
      const pngs = await this._encodePngs(panels);
      await Promise.all(pngs.map((png, i) => fs.promises.writeFile(path.join(dir, `panel-${i + 1}.png`), png)));
      await fs.promises.writeFile(path.join(dir, 'result.json'), JSON.stringify(reading, null, 2));
      const old = (await fs.promises.readdir(this.debugRoot)).filter(n => n.startsWith('scan-')).sort().slice(0, -10);
      await Promise.all(old.map(n => fs.promises.rm(path.join(this.debugRoot, n), { recursive: true, force: true })));
      return dir;
    } catch (err) {
      console.warn('[autoScan] could not save debug files', err);
      return null;
    }
  }
}

module.exports = AutoScan;
module.exports.cropPanel = cropPanel;
module.exports.loadScanData = loadScanData;
module.exports.runWorker = runWorker;
module.exports.DEFAULTS = DEFAULTS;
