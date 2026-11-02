// Run with:  node tests/scanPanel.test.js   (also part of `npm test`)
// Smoke test of the Scan panel in the finder: a minimal fake DOM and fake main-process APIs, driven like a user would.
const assert = require('assert');

const created = [];
const mkEl = tag => {
  const el = { tag, children: [], style: {}, listeners: {}, className: '', textContent: '' };
  el.appendChild = c => { el.children.push(c); return c; };
  el.addEventListener = (type, fn) => { el.listeners[type] = fn; };
  el.click = () => el.listeners.click && el.listeners.click();
  created.push(el);
  return el;
};
const controls = mkEl('div'), checkbox = mkEl('input'); checkbox.type = 'checkbox';
global.document = {
  readyState: 'complete', createElement: mkEl, createTextNode: text => ({ text }),
  getElementById: id => ({ controls, 'autodetect-enabled': checkbox }[id] || null),
};

const log = [];
const handlers = {};
const seed = { seed_id: '042', shiftingEarth: 'Default', map_type: 'Default', nightlord: 'Adel', slots: { '01': 'church' } };
const state = {
  current: { seeds: [seed], resolvedSeed: null, candidateSeeds: [], selectionBySlot: {}, activeMapType: null },
  setActiveMapType(t) { this.current.activeMapType = t; }, setSelectionBySlot(s) { this.current.selectionBySlot = s; },
  updateSelection(k, v) { this.current.selectionBySlot[k] = v; },
};
const selection = {
  applySelections() { state.current.resolvedSeed = seed; log.push('apply'); },
  dispatchSeedToOverlay() { log.push('dispatch'); },
  resetFinderState() { state.current.activeMapType = null; state.current.resolvedSeed = null; log.push('reset-finder'); },
};
let watcherState = { enabled: true, refs: 0, score: null, open: false, gameRunning: null, trigger: 'keys', idle: false, openKeys: ['M'], gameProcess: 'nightreign.exe' };
global.window = {
  Seedfinder: { state }, SeedfinderRuntime: { selectionInstance: selection },
  app: {
    autoscan: {
      start: async () => { log.push('start'); return { ok: true }; }, cancel: async () => { log.push('cancel'); }, forget: async () => { log.push('forget'); },
      openDebugFolder: () => log.push('open-folder'),
      onStatus: h => { handlers.scanStatus = h; }, onResult: h => { handlers.scanResult = h; },
    },
    autodetect: {
      get: async () => watcherState, set: async p => { log.push(['set', p]); watcherState = { ...watcherState, ...p }; return watcherState; },
      clear: async () => { log.push('clear-look'); watcherState = { ...watcherState, refs: 0 }; return watcherState; },
      onStatus: h => { handlers.watchStatus = h; },
    },
  },
};
require('../src/finder/runtime/autodetect.js');

const byId = id => created.find(e => e.id === id);
const byTitle = part => created.find(e => e.title && e.title.includes(part));
const scanBtn = byId('scanMapButton'), scanLine = byId('scan-status'), watchLine = byId('autodetect-status');
const forgetBtn = byTitle('Forget the current map'), resetLookBtn = byTitle('Forget what the open map looks like');
const tick = () => new Promise(r => setImmediate(r));

(async () => {
  let passed = 0;
  const test = async (name, fn) => { log.length = 0; await fn(); passed++; console.log('  ok  -', name); };
  await tick();

  await test('the panel is added to the controls with all its buttons', async () => {
    assert.ok(controls.children.length === 1 && scanBtn && scanLine && watchLine && forgetBtn && resetLookBtn);
    assert.strictEqual(scanBtn.textContent === '' ? scanBtn.children[0].text : scanBtn.textContent, 'Scan map');
  });

  await test('Scan map starts a scan and turns into Cancel; status messages are shown', async () => {
    scanBtn.click(); await tick();
    assert.deepStrictEqual(log, ['start']);
    assert.strictEqual(scanBtn.textContent, 'Cancel scan');
    handlers.scanStatus({ phase: 'focusing', message: 'Switching to Nightreign…' });
    assert.strictEqual(scanLine.textContent, 'Switching to Nightreign…');
    handlers.scanStatus({ phase: 'waiting-map', detail: { similarity: 0.123 } });
    assert.match(scanLine.textContent, /0\.12/);
    log.length = 0; scanBtn.click(); await tick();
    assert.deepStrictEqual(log, ['cancel'], 'clicking again cancels');
  });

  await test('a successful result shows the seed in the finder, sends it to the overlay and resets the button', async () => {
    handlers.scanResult({ ok: true, seedId: '042', mapType: 'Default', nightlord: 'Adel', message: 'Seed 042 found (25/27 slots matched).' });
    await tick();
    assert.deepStrictEqual(log, ['apply', 'dispatch']);
    assert.strictEqual(state.current.activeMapType, 'Default');
    assert.match(scanLine.textContent, /042.*Default.*Adel/);
    assert.notStrictEqual(scanBtn.textContent, 'Cancel scan');
  });

  await test('a failed scan only shows the message and leaves the finder alone', async () => {
    handlers.scanResult({ ok: false, reason: 'game-not-running', message: 'Nightreign (nightreign.exe) is not running. Start the game first.' });
    await tick();
    assert.deepStrictEqual(log, []);
    assert.match(scanLine.textContent, /not running/);
  });

  await test('an unsure scan pre-fills the finder with what it recognised', async () => {
    handlers.scanResult({ ok: false, reason: 'low-confidence', seedId: '042', exact: 11, slots: { '01': { label: 'church' } }, message: 'x' });
    await tick();
    assert.ok(log.includes('apply'));
    assert.strictEqual(state.current.selectionBySlot['01'], 'church');
    assert.match(scanLine.textContent, /Not sure about this one.*1 slots/);
  });

  await test('a result that arrives before the finder has loaded its data waits for it', async () => {
    const seeds = state.current.seeds; state.current.seeds = [];
    handlers.scanResult({ ok: true, seedId: '042', mapType: 'Default', nightlord: 'Adel', message: 'ok' });
    await tick(); assert.deepStrictEqual(log, [], 'nothing applied yet');
    state.current.seeds = seeds; await new Promise(r => setTimeout(r, 400));
    assert.deepStrictEqual(log, ['apply', 'dispatch']);
  });

  await test('Forget map: scan stopped, remembered result dropped, finder + overlay back to the start state', async () => {
    forgetBtn.click(); await tick();
    assert.deepStrictEqual(log, ['cancel', 'forget', 'reset-finder']);
    assert.strictEqual(state.current.activeMapType, null);
    assert.match(scanLine.textContent, /Forgot the current map/);
  });

  await test('the automatic-overlay option (Overlay Options) is saved through the main process', async () => {
    checkbox.checked = false; checkbox.listeners.change(); await tick();
    assert.deepStrictEqual(log, [['set', { enabled: false }]]);
    assert.match(watchLine.textContent, /off \(Overlay Options\)/);
    log.length = 0; checkbox.checked = true; checkbox.listeners.change(); await tick();
    assert.deepStrictEqual(log, [['set', { enabled: true }]]);
  });

  await test('the checkbox follows the saved setting when the panel starts / status arrives', async () => {
    handlers.watchStatus({ ...watcherState, enabled: false });
    assert.strictEqual(checkbox.checked, false);
    handlers.watchStatus({ ...watcherState, enabled: true, refs: 2, open: true, score: 0.93 });
    assert.strictEqual(checkbox.checked, true);
    assert.match(watchLine.textContent, /OPEN.*0\.93/);
  });

  await test('Reset auto-open forgets the learned map look; Scan files opens the folder', async () => {
    resetLookBtn.click(); await tick();
    assert.deepStrictEqual(log, ['clear-look']);
    log.length = 0; byTitle('Screenshots and readings').click();
    assert.deepStrictEqual(log, ['open-folder']);
  });

  console.log(`\n${passed} tests passed`);
})().catch(e => { console.error(e); process.exit(1); });
