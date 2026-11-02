/**
 * mapWatcher.js  (Electron main process)
 *
 * Periodically looks at the screen (read-only screenshots via desktopCapturer) and
 * emits 'open' / 'close' when the in-game map appears / disappears, so the overlay no
 * longer needs a hotkey. It never touches the game process or its memory.
 *
 * How it knows what "map open" looks like: the user calibrates once (button in the
 * finder window) while the map is open. We store a tiny luminance grid of the map panel
 * and compare live frames against it. See src/core/mapSignature.js.
 *
 * Events:
 *   'open'   – map just opened
 *   'close'  – map just closed
 *   'status' – {enabled, refs, score, open, openThreshold, closeThreshold}  (every tick)
 */
const { desktopCapturer, screen } = require('electron');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const sig = require('../../src/core/mapSignature');
const { createGameProcessCheck } = require('./gameProcess');
const { createKeyStateProvider, vkFor } = require('./keyState');
const { createScanGate } = require('../../src/core/scanGate');

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  intervalMs: 500, // how often to look at the screen
  captureWidth: 640, // screenshot width used for analysis (small = cheap, less hitching)
  openThreshold: 0.85, // similarity needed to count as "map open"
  closeThreshold: 0.7, // similarity below which the map counts as "closed"
  openFrames: 2, // consecutive frames needed to open
  closeFrames: 2, // consecutive frames needed to close when no key hinted at it (slow safety checks)
  closeFramesAfterKey: 1, // ...and right after a close key press (one confirming screenshot is enough)
  gameProcess: 'nightreign.exe', // only capture while this process runs ('' = always)
  trigger: 'keys', // 'keys' = scan only after a key press / while the map is open; 'always' = scan continuously
  openKeys: ['M'], // pressing one of these while the map is CLOSED starts a short look (the Scan button waits for the first)
  closeKeys: ['M', 'Escape', 'RightMouse'], // pressing one of these while the map is OPEN checks whether it closed
  burstMs: 2500, // how long to look after an open key
  closeBurstMs: 1500, // how long to look after a close key
  openPollMs: 5000, // map open and no key pressed: one safety look this often (e.g. closed with a controller)
  keyPollMs: 40, // how often key state is sampled (cheap)
});

const MAX_REFS = 8;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

class MapWatcher extends EventEmitter {
  constructor({ configDir, isGameRunning, keyProvider, now } = {}) {
    super();
    this.cfgPath = path.join(configDir, 'autodetect.json');
    this.refsPath = path.join(configDir, 'map-refs.json');
    this.cfg = this._loadConfig();
    this.refs = this._loadRefs();
    this._buildRefCache();
    this.detector = sig.createDetector(this.cfg);
    this._isGameRunning =
      isGameRunning || createGameProcessCheck({ processName: this.cfg.gameProcess }).isRunning;
    this.gameRunning = null; // unknown until the first check
    this._now = now || Date.now;
    // keyProvider: undefined = create the real one, null = explicitly unavailable
    this._keys = keyProvider === undefined ? createKeyStateProvider() : keyProvider;
    const known = list => (list || []).map(String).filter(name => vkFor(name) !== null);
    this._openSet = new Set(known(this.cfg.openKeys));
    this._closeSet = new Set(known(this.cfg.closeKeys));
    this._watchedKeys = [...new Set([...this._openSet, ...this._closeSet])].map(name => ({ name, vk: vkFor(name) }));
    this.gate = createScanGate({ burstMs: this.cfg.burstMs });
    this.idle = false; // true while the key trigger is holding screenshots back
    this.paused = false; // true while a scan is running (it takes its own screenshots)
    this.timer = null;
    this.keyTimer = null;
    this.busy = false;
    this.lastScore = null;
    this._lastCaptureAt = -Infinity;
  }

  // ---- state ---------------------------------------------------------------
  /** True when auto mode is on AND we know what the map looks like. */
  get active() {
    return this.cfg.enabled && this.refs.length > 0;
  }
  get isOpen() {
    return this.detector.isOpen;
  }
  getState() {
    return {
      enabled: this.cfg.enabled,
      refs: this.refs.length,
      score: this.lastScore,
      open: this.detector.isOpen,
      gameRunning: this.gameRunning,
      gameProcess: this.cfg.gameProcess,
      trigger: this._effectiveTrigger(),
      keysUnavailable: this.cfg.trigger === 'keys' && this._effectiveTrigger() !== 'keys',
      openKeys: [...this._openSet],
      closeKeys: [...this._closeSet],
      idle: this.idle,
      openThreshold: this.cfg.openThreshold,
      closeThreshold: this.cfg.closeThreshold,
    };
  }

  // ---- lifecycle -----------------------------------------------------------
  start() {
    this.stop();
    this.timer = setInterval(() => this._tick(), this.cfg.intervalMs);
    if (this._effectiveTrigger() === 'keys') {
      this.keyTimer = setInterval(() => this._sampleKeys(), this.cfg.keyPollMs);
    }
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.keyTimer) clearInterval(this.keyTimer);
    this.timer = null;
    this.keyTimer = null;
  }

  /** 'keys' only when requested AND the key reader works AND there are keys to watch. */
  _effectiveTrigger() {
    const usable = this._keys && this._watchedKeys.length > 0;
    return this.cfg.trigger === 'keys' && usable ? 'keys' : 'always';
  }

  /** Take a look shortly (the map needs a moment to appear/vanish). Overridable in tests. */
  _kick(ms = 150) {
    setTimeout(() => this._tick(), ms);
  }

  /** Cheap: asks Windows which watched keys are down. Runs only while the game runs. */
  _sampleKeys() {
    if (!this.cfg.enabled || this.gameRunning !== true || this._effectiveTrigger() !== 'keys') return;
    try {
      const down = new Set();
      for (const { name, vk } of this._watchedKeys) if (this._keys.isDown(vk)) down.add(name);
      const now = this._now();
      const open = this.detector.isOpen;
      const relevant = open ? this._closeSet : this._openSet; // M opens, M / Esc / right mouse button close
      if (this.gate.edges(now, down).some(key => relevant.has(key))) {
        this.gate.start(now, open ? this.cfg.closeBurstMs : this.cfg.burstMs);
        this._kick(open ? 300 : 150); // the map needs a moment to appear / vanish
      }
    } catch (err) {
      console.warn('[mapWatcher] key sampling failed', err);
    }
  }

  updateConfig(patch = {}) {
    const next = { ...this.cfg };
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    if (Number.isFinite(patch.openThreshold)) next.openThreshold = clamp(patch.openThreshold, 0.3, 0.99);
    if (Number.isFinite(patch.closeThreshold)) next.closeThreshold = clamp(patch.closeThreshold, 0.1, 0.95);
    if (next.closeThreshold >= next.openThreshold) next.closeThreshold = next.openThreshold - 0.05;
    this.cfg = next;
    this.detector.configure(this.cfg);
    if (patch.enabled === true) this.detector.reset();
    this._saveConfig();
    return this.getState();
  }

  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }

  /** Learn what the open map looks like from a screenshot taken by a successful scan. */
  addReferenceFromFrame({ bitmap, width, height }) {
    const grid = sig.computeSignature(bitmap, width, height);
    if (!sig.hasContent(grid)) return false;
    if (this._refGrids.some(g => sig.correlation(g, grid) > 0.97)) return false; // already known
    this._pushRef(grid);
    return true;
  }

  /** The map is known to be open right now (a scan just read it), so a later close will be noticed. */
  markOpen() {
    this.detector.setOpen(true);
    this._lastCaptureAt = this._now(); // no safety look needed right after a scan
  }

  _pushRef(grid) {
    this.refs.push({ createdAt: new Date().toISOString(), sig: Array.from(grid, v => Math.round(v * 100) / 100) });
    if (this.refs.length > MAX_REFS) this.refs.shift();
    this._buildRefCache();
    this._saveRefs();
    this.detector.reset();
  }

  clearRefs() {
    this.refs = [];
    this._buildRefCache();
    this._saveRefs();
    this.detector.reset();
    this.lastScore = null;
    return this.getState();
  }

  /**
   * Record what the open map looks like. The user must have the map open when the
   * delay is over. Call once per map type for best results (up to 8 are kept).
   */
  async calibrate({ delayMs = 5000 } = {}) {
    if (delayMs > 0) await sleep(delayMs);
    const frame = await this._capture();
    if (!frame) return { ok: false, error: 'capture-failed' };
    const grid = sig.computeSignature(frame.bitmap, frame.width, frame.height);
    if (!sig.hasContent(grid)) return { ok: false, error: 'blank-frame' };

    this._pushRef(grid);
    return { ok: true, ...this.getState() };
  }

  // ---- capture + analysis --------------------------------------------------
  async _capture() {
    try {
      const display = screen.getPrimaryDisplay();
      const width = this.cfg.captureWidth;
      const height = Math.round((width * display.size.height) / display.size.width);
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height },
        fetchWindowIcons: false,
      });
      const source =
        sources.find(s => String(s.display_id) === String(display.id)) || sources[0];
      if (!source || source.thumbnail.isEmpty()) return null;
      const size = source.thumbnail.getSize();
      return { bitmap: source.thumbnail.toBitmap(), width: size.width, height: size.height };
    } catch (err) {
      console.warn('[mapWatcher] capture failed', err);
      return null;
    }
  }

  async _tick() {
    // Nothing to compare against yet: don't touch the screen at all.
    if (this.busy || this.paused || !this.cfg.enabled || this.refs.length === 0) return;
    this.busy = true;
    try {
      // Game closed: no screenshots. If the map was "open", treat it as closed.
      const running = await this._isGameRunning();
      const changed = running !== this.gameRunning;
      this.gameRunning = running;
      if (!running) {
        this.lastScore = null;
        this.idle = false;
        this.gate.reset();
        if (this.detector.isOpen) {
          this.detector.reset();
          this.emit('close');
        }
        if (changed) this.emit('status', this.getState());
        return;
      }

      // Key trigger: look only shortly after a relevant key press. While the map is open there is no polling at
      // all; the close is noticed from the close key (M / Esc / right mouse button) plus one slow safety look.
      const now = this._now();
      const open = this.detector.isOpen;
      let afterKey = false;
      if (this._effectiveTrigger() === 'keys') {
        afterKey = this.gate.allows(now, false);
        const safety = open && now - this._lastCaptureAt >= this.cfg.openPollMs;
        if (!afterKey && !safety) {
          if (!this.idle) {
            this.idle = true;
            if (!open) this.lastScore = null;
            this.emit('status', this.getState());
          }
          return;
        }
      }
      this.idle = false;
      this.detector.configure({ closeFrames: afterKey ? this.cfg.closeFramesAfterKey : this.cfg.closeFrames });
      this._lastCaptureAt = now;

      const frame = await this._capture();
      if (!frame) return;
      const grid = sig.computeSignature(frame.bitmap, frame.width, frame.height);
      const { score } = sig.bestScore(grid, this._refGrids);
      this.lastScore = score;

      const transition = this.detector.update(score);
      if (transition) this.emit(transition);
      this.emit('status', this.getState());
    } catch (err) {
      console.warn('[mapWatcher] tick failed', err);
    } finally {
      this.busy = false;
    }
  }

  // ---- persistence ---------------------------------------------------------
  _buildRefCache() {
    this._refGrids = this.refs.map(r => Float32Array.from(r.sig));
  }

  _loadConfig() {
    try {
      const data = JSON.parse(fs.readFileSync(this.cfgPath, 'utf-8'));
      return { ...DEFAULT_CONFIG, ...data };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  _saveConfig() {
    try {
      fs.writeFileSync(this.cfgPath, JSON.stringify(this.cfg, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[mapWatcher] could not save config', err);
    }
  }

  _loadRefs() {
    try {
      const data = JSON.parse(fs.readFileSync(this.refsPath, 'utf-8'));
      const gridOk = Array.isArray(data.grid) && data.grid[0] === sig.GRID_W && data.grid[1] === sig.GRID_H;
      if (!gridOk) {
        console.warn('[mapWatcher] stored references use a different grid size; please recalibrate');
        return [];
      }
      return (data.refs || []).filter(r => Array.isArray(r.sig) && r.sig.length === sig.GRID_W * sig.GRID_H);
    } catch {
      return [];
    }
  }

  _saveRefs() {
    try {
      fs.writeFileSync(
        this.refsPath,
        JSON.stringify({ version: 1, grid: [sig.GRID_W, sig.GRID_H], refs: this.refs }),
        'utf-8'
      );
    } catch (err) {
      console.warn('[mapWatcher] could not save references', err);
    }
  }
}

module.exports = MapWatcher;
