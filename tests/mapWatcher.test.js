// Run with:  npm run test:watcher
// Drives the real MapWatcher with a stubbed Electron (fake screen + desktopCapturer).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { mapFrame, gameplayFrame } = require('./helpers/frames');

// ---- fake electron ----------------------------------------------------------
const W = 960, H = 540;
let currentFrame = gameplayFrame(W, H, 1);
let captureFails = false;
let captureCalls = 0;
const fakeElectron = {
  screen: { getPrimaryDisplay: () => ({ id: 1, size: { width: 1920, height: 1080 } }) },
  desktopCapturer: {
    getSources: async () => {
      captureCalls++;
      if (captureFails) throw new Error('boom');
      const f = currentFrame;
      return [{
        display_id: '1',
        thumbnail: { isEmpty: () => false, getSize: () => ({ width: f.W, height: f.H }), toBitmap: () => f.b },
      }];
    },
  },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? fakeElectron : origLoad.call(this, request, ...rest);
};
const RealMapWatcher = require('../app/main/mapWatcher');
// Tests must never call the real `tasklist`; default to "game is running" unless a test overrides it.
class MapWatcher extends RealMapWatcher {
  constructor(opts) { super({ isGameRunning: async () => true, ...opts }); }
}

// ---- helpers ----------------------------------------------------------------
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mapwatcher-'));
const events = w => { const log = []; ['open', 'close'].forEach(e => w.on(e, () => log.push(e))); return log; };
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ok  -', name); };

(async () => {
  await test('uncalibrated: never opens, reports 0 references', async () => {
    const w = new MapWatcher({ configDir: tmp() });
    const log = events(w);
    currentFrame = mapFrame(W, H, { terrain: 1, poiSeed: 1 });
    for (let i = 0; i < 5; i++) await w._tick();
    assert.deepStrictEqual(log, []);
    assert.strictEqual(w.active, false);
    assert.strictEqual(w.getState().refs, 0);
  });

  await test('calibrate rejects a blank screen', async () => {
    const w = new MapWatcher({ configDir: tmp() });
    currentFrame = { b: new Uint8Array(W * H * 4), W, H };
    const r = await w.calibrate({ delayMs: 0 });
    assert.deepStrictEqual([r.ok, r.error], [false, 'blank-frame']);
    assert.strictEqual(w.refs.length, 0);
  });

  await test('calibrate reports capture failure instead of throwing', async () => {
    const w = new MapWatcher({ configDir: tmp() });
    captureFails = true;
    const r = await w.calibrate({ delayMs: 0 });
    captureFails = false;
    assert.deepStrictEqual([r.ok, r.error], [false, 'capture-failed']);
  });

  const dir = tmp();
  await test('full cycle: calibrate -> gameplay -> map opens -> map closes', async () => {
    const w = new MapWatcher({ configDir: dir });
    const log = events(w);
    currentFrame = mapFrame(W, H, { terrain: 1, poiSeed: 1 });
    assert.strictEqual((await w.calibrate({ delayMs: 0 })).ok, true);
    assert.strictEqual(w.active, true);

    currentFrame = gameplayFrame(W, H, 3);
    for (let i = 0; i < 4; i++) await w._tick();
    assert.deepStrictEqual(log, [], 'gameplay must not open the overlay');

    currentFrame = mapFrame(W, H, { terrain: 1, poiSeed: 42 });      // new seed, same map type
    await w._tick();
    assert.deepStrictEqual(log, [], 'one frame is not enough (debounce)');
    await w._tick();
    assert.deepStrictEqual(log, ['open']);
    assert.strictEqual(w.isOpen, true);

    currentFrame = mapFrame(W, H, { terrain: 1, poiSeed: 42, labels: true });  // overlay labels now visible
    for (let i = 0; i < 6; i++) await w._tick();
    assert.deepStrictEqual(log, ['open'], 'our own labels must not make the map look closed');

    currentFrame = gameplayFrame(W, H, 9);
    for (let i = 0; i < 3; i++) await w._tick();
    assert.deepStrictEqual(log, ['open', 'close']);
  });

  await test('status events carry score + reference count', async () => {
    const w = new MapWatcher({ configDir: dir });           // reloads the saved calibration
    assert.strictEqual(w.refs.length, 1);
    const seen = [];
    w.on('status', s => seen.push(s));
    currentFrame = mapFrame(W, H, { terrain: 1, poiSeed: 5 });
    await w._tick();
    assert.strictEqual(seen.length, 1);
    assert.ok(seen[0].score > 0.85 && seen[0].refs === 1 && seen[0].enabled === true);
  });

  await test('calibration survives a restart (map-refs.json) and can be cleared', async () => {
    const w = new MapWatcher({ configDir: dir });
    assert.strictEqual(w.active, true);
    w.clearRefs();
    assert.strictEqual(new MapWatcher({ configDir: dir }).refs.length, 0);
  });

  await test('several map types: each calibrated terrain is recognised', async () => {
    const w = new MapWatcher({ configDir: tmp() });
    for (const t of [1, 2, 3]) { currentFrame = mapFrame(W, H, { terrain: t }); await w.calibrate({ delayMs: 0 }); }
    const log = events(w);
    currentFrame = mapFrame(W, H, { terrain: 3, poiSeed: 8 });
    await w._tick(); await w._tick();
    assert.deepStrictEqual(log, ['open']);
  });

  await test('disabling stops detection; settings persist and thresholds are sanitised', async () => {
    const d = tmp();
    const w = new MapWatcher({ configDir: d });
    currentFrame = mapFrame(W, H); await w.calibrate({ delayMs: 0 });
    w.updateConfig({ enabled: false });
    const log = events(w);
    for (let i = 0; i < 4; i++) await w._tick();
    assert.deepStrictEqual(log, []);
    assert.strictEqual(new MapWatcher({ configDir: d }).cfg.enabled, false);
    const s = w.updateConfig({ openThreshold: 0.6, closeThreshold: 0.9 });
    assert.ok(s.closeThreshold < s.openThreshold, 'close threshold must stay below open threshold');
  });

  await test('ignores references saved with a different grid size', async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'map-refs.json'), JSON.stringify({ version: 1, grid: [8, 8], refs: [{ sig: new Array(64).fill(1) }] }));
    assert.strictEqual(new MapWatcher({ configDir: d }).refs.length, 0);
  });

  await test('a failing capture does not crash the loop or get stuck busy', async () => {
    const w = new MapWatcher({ configDir: tmp() });
    captureFails = true; await w._tick(); captureFails = false;
    assert.strictEqual(w.busy, false);
  });

  await test('no calibration -> no screenshots are taken at all', async () => {
    const w = new MapWatcher({ configDir: tmp() });
    captureCalls = 0;
    for (let i = 0; i < 5; i++) await w._tick();
    assert.strictEqual(captureCalls, 0);
  });

  await test('game not running -> no screenshots; starts capturing once it runs', async () => {
    let running = false;
    const w = new MapWatcher({ configDir: tmp(), isGameRunning: async () => running });
    currentFrame = mapFrame(W, H, { terrain: 1 }); await w.calibrate({ delayMs: 0 });
    const log = events(w);
    const statuses = []; w.on('status', s => statuses.push(s));
    captureCalls = 0;
    for (let i = 0; i < 4; i++) await w._tick();
    assert.strictEqual(captureCalls, 0, 'must not capture while the game is closed');
    assert.strictEqual(w.getState().gameRunning, false);
    assert.strictEqual(statuses.length, 1, 'status is only sent when the state changes');
    running = true;
    await w._tick(); await w._tick();
    assert.ok(captureCalls >= 2);
    assert.deepStrictEqual(log, ['open']);
  });

  await test('game exits while the map is open -> overlay is told to close', async () => {
    let running = true;
    const w = new MapWatcher({ configDir: tmp(), isGameRunning: async () => running });
    currentFrame = mapFrame(W, H, { terrain: 1 }); await w.calibrate({ delayMs: 0 });
    const log = events(w);
    await w._tick(); await w._tick();
    assert.deepStrictEqual(log, ['open']);
    running = false;
    await w._tick();
    assert.deepStrictEqual(log, ['open', 'close']);
    assert.strictEqual(w.isOpen, false);
  });

  console.log(`\n${passed} tests passed`);
})().catch(err => { console.error(err); process.exit(1); });
