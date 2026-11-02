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
// Tests must never call the real `tasklist` or read the real keyboard: default to "game is running"
// and "no key reader" (continuous scanning) unless a test overrides it.
class MapWatcher extends RealMapWatcher {
  constructor(opts) { super({ isGameRunning: async () => true, keyProvider: null, ...opts }); }
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

  await test('after markOpen() (a scan just read the map) closing the map is noticed and the overlay can hide', async () => {
    const w = new MapWatcher({ configDir: tmp() });
    currentFrame = mapFrame(W, H, { terrain: 1 });
    assert.strictEqual(w.addReferenceFromFrame({ bitmap: currentFrame.b, width: W, height: H }), true);
    assert.strictEqual(w.addReferenceFromFrame({ bitmap: currentFrame.b, width: W, height: H }), false, 'same look is not added twice');
    const log = events(w);
    w.markOpen();
    assert.strictEqual(w.isOpen, true);
    currentFrame = gameplayFrame(W, H, 6);
    for (let i = 0; i < 3; i++) await w._tick();
    assert.deepStrictEqual(log, ['close']);
  });

  await test('pause() stops all screenshots until resume()', async () => {
    const w = new MapWatcher({ configDir: tmp() });
    currentFrame = mapFrame(W, H); await w.calibrate({ delayMs: 0 });
    w.pause(); captureCalls = 0;
    for (let i = 0; i < 4; i++) await w._tick();
    assert.strictEqual(captureCalls, 0);
    w.resume(); await w._tick();
    assert.strictEqual(captureCalls, 1);
  });

  // ---- key trigger ----------------------------------------------------------
  const VK_M = 0x4d, VK_ESC = 0x1b, VK_RMB = 0x02;
  function keyed(extra = {}) {
    const down = new Set(); const state = { t: 0, queried: 0, kicks: 0, lastKick: null };
    const provider = { isDown: vk => { state.queried++; return down.has(vk); } };
    const w = new MapWatcher({ configDir: tmp(), keyProvider: provider, now: () => state.t, ...extra });
    w._kick = ms => { state.kicks++; state.lastKick = ms; };
    const press = vk => { down.add(vk); w._sampleKeys(); down.delete(vk); w._sampleKeys(); };
    return { w, state, press };
  }
  /** calibrated watcher whose map is currently OPEN, with the clock at t=1650 */
  async function openMap(r) {
    currentFrame = mapFrame(W, H, { terrain: 1 }); await r.w.calibrate({ delayMs: 0 });
    currentFrame = gameplayFrame(W, H, 4); await r.w._tick();            // learns "game is running"
    r.state.t = 1000; r.press(VK_M);
    currentFrame = mapFrame(W, H, { terrain: 1, poiSeed: 21 });
    r.state.t = 1150; await r.w._tick(); r.state.t = 1650; await r.w._tick();
    assert.strictEqual(r.w.isOpen, true);
  }

  await test('key trigger: normal gameplay takes no screenshots at all', async () => {
    const { w } = keyed();
    currentFrame = mapFrame(W, H, { terrain: 1 }); await w.calibrate({ delayMs: 0 });
    currentFrame = gameplayFrame(W, H, 4);
    captureCalls = 0;
    for (let i = 0; i < 6; i++) await w._tick();
    assert.strictEqual(captureCalls, 0);
    const s = w.getState();
    assert.deepStrictEqual([s.trigger, s.idle], ['keys', true]);
    assert.deepStrictEqual(s.openKeys, ['M']);
    assert.deepStrictEqual(s.closeKeys, ['M', 'Escape', 'RightMouse']);
  });

  await test('M opens -> NO polling while the map is open -> right mouse button closes it -> idle again', async () => {
    const r = keyed(); const { w, state, press } = r; const log = events(w);
    await openMap(r);
    assert.deepStrictEqual(log, ['open']);
    assert.strictEqual(state.lastKick, 150, 'open: look soon');

    captureCalls = 0;
    state.t = 4000; await w._tick();                 // burst is over
    state.t = 6000; await w._tick();                 // 4.3 s since the last look
    assert.strictEqual(captureCalls, 0, 'an open map is not polled');
    state.t = 7000; await w._tick();                 // 5.3 s: one slow safety look
    assert.strictEqual(captureCalls, 1);
    assert.deepStrictEqual(log, ['open'], 'still open');

    currentFrame = gameplayFrame(W, H, 8);           // the player right-clicks and the map goes away
    state.t = 8000; press(VK_RMB);
    assert.strictEqual(state.lastKick, 300, 'close: first look after the map had time to vanish');
    state.t = 8300; await w._tick();
    assert.deepStrictEqual(log, ['open', 'close'], 'ONE confirming screenshot is enough after a close key');

    captureCalls = 0; state.t = 30000; await w._tick(); await w._tick();
    assert.strictEqual(captureCalls, 0, 'idle again');
  });

  await test('M and Esc close the map too', async () => {
    for (const vk of [VK_M, VK_ESC]) {
      const r = keyed(); const log = events(r.w);
      await openMap(r);
      currentFrame = gameplayFrame(W, H, 9);
      r.state.t = 9000; r.press(vk); r.state.t = 9300; await r.w._tick();
      assert.deepStrictEqual(log, ['open', 'close'], `key 0x${vk.toString(16)}`);
    }
  });

  await test('a right-click while the map stays open does NOT hide it (verified by a screenshot)', async () => {
    const r = keyed(); const log = events(r.w);
    await openMap(r);
    r.state.t = 9000; r.press(VK_RMB);
    currentFrame = mapFrame(W, H, { terrain: 1, poiSeed: 21, labels: true });   // map still there
    r.state.t = 9300; await r.w._tick(); r.state.t = 9800; await r.w._tick(); r.state.t = 10300; await r.w._tick();
    assert.deepStrictEqual(log, ['open']);
    assert.strictEqual(r.w.isOpen, true);
  });

  await test('right mouse button / Esc while the map is CLOSED cause no screenshots (no work during combat)', async () => {
    const r = keyed();
    currentFrame = mapFrame(W, H, { terrain: 1 }); await r.w.calibrate({ delayMs: 0 });
    currentFrame = gameplayFrame(W, H, 4); await r.w._tick();
    for (let i = 0; i < 5; i++) { r.press(VK_RMB); r.press(VK_ESC); }
    assert.strictEqual(r.state.kicks, 0);
    captureCalls = 0; r.state.t = 500; await r.w._tick();
    assert.strictEqual(captureCalls, 0);
    r.press(VK_M);
    assert.strictEqual(r.state.kicks, 1, 'only the map key starts a look while closed');
  });

  await test('closing without any key (e.g. controller): slow safety looks notice it after two of them', async () => {
    const r = keyed(); const log = events(r.w);
    await openMap(r);
    currentFrame = gameplayFrame(W, H, 9);
    captureCalls = 0;
    r.state.t = 7000; await r.w._tick();             // first safety look: not enough on its own
    assert.deepStrictEqual(log, ['open']);
    r.state.t = 12500; await r.w._tick();            // second one, 5.5 s later
    assert.deepStrictEqual(log, ['open', 'close']);
    assert.strictEqual(captureCalls, 2);
  });

  await test('automatic overlay switched off: no screenshots and the keyboard is not read either', async () => {
    const r = keyed();
    currentFrame = mapFrame(W, H, { terrain: 1 }); await r.w.calibrate({ delayMs: 0 });
    currentFrame = gameplayFrame(W, H, 4); await r.w._tick();       // game is running
    r.w.updateConfig({ enabled: false });
    r.state.queried = 0; captureCalls = 0;
    r.press(VK_M); await r.w._tick();
    assert.strictEqual(r.state.queried, 0, 'keyboard not read');
    assert.strictEqual(captureCalls, 0, 'screen not read');
    assert.strictEqual(r.state.kicks, 0);
    r.w.updateConfig({ enabled: true });
    r.press(VK_M);
    assert.strictEqual(r.state.kicks, 1, 'works again once switched back on');
  });

  await test('key trigger: keys are not even read while the game is closed', async () => {
    let running = false;
    const { w, state } = keyed({ isGameRunning: async () => running });
    currentFrame = mapFrame(W, H); await w.calibrate({ delayMs: 0 });
    await w._tick(); w._sampleKeys(); w._sampleKeys();
    assert.strictEqual(state.queried, 0);
  });

  await test('no key reader available -> falls back to continuous scanning and says so', async () => {
    const w = new MapWatcher({ configDir: tmp(), keyProvider: null });
    currentFrame = mapFrame(W, H); await w.calibrate({ delayMs: 0 });
    captureCalls = 0; await w._tick(); await w._tick();
    assert.strictEqual(captureCalls, 2);
    const s = w.getState();
    assert.deepStrictEqual([s.trigger, s.keysUnavailable], ['always', true]);
  });

  await test("config trigger 'always' scans continuously even when a key reader exists", async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'autodetect.json'), JSON.stringify({ trigger: 'always' }));
    const w = new MapWatcher({ configDir: d, keyProvider: { isDown: () => false } });
    currentFrame = mapFrame(W, H); await w.calibrate({ delayMs: 0 });
    captureCalls = 0; await w._tick();
    assert.strictEqual(captureCalls, 1);
    assert.strictEqual(w.getState().keysUnavailable, false);
  });

  await test('key sampler timer only runs in key mode, and stop() clears both timers', async () => {
    const { w } = keyed(); w.start();
    assert.ok(w.keyTimer && w.timer); w.stop();
    assert.ok(!w.keyTimer && !w.timer);
    const w2 = new MapWatcher({ configDir: tmp(), keyProvider: null }); w2.start();
    assert.ok(w2.timer && !w2.keyTimer); w2.stop();
  });

  await test('unknown key names in the config are ignored; mouse buttons are accepted', async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'autodetect.json'), JSON.stringify({ openKeys: ['M', 'banana'], closeKeys: ['RMB', 'nope'] }));
    const w = new MapWatcher({ configDir: d, keyProvider: { isDown: () => false } });
    const s = w.getState();
    assert.deepStrictEqual([s.openKeys, s.closeKeys], [['M'], ['RMB']]);
  });

  console.log(`\n${passed} tests passed`);
})().catch(err => { console.error(err); process.exit(1); });
