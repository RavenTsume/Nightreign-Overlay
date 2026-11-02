// Run with:  node tests/autoScan.test.js   (also part of `npm test`)
// Drives the real AutoScan orchestrator with a fake clock, screen, keyboard, window focus and analyzer.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AutoScan = require('../app/main/autoScan');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ok  -', name); };

const VK_M = 0x4d;
function frame(w = 320, h = 180, v = 90) {
  const bitmap = Buffer.alloc(w * h * 4, v);
  return { bitmap, width: w, height: h };
}
const READING_OK = { ok: true, mapOpen: true, ms: 1500, match: { ok: true, seedId: '042', mapType: 'Default', nightlord: 'Adel', exact: 24, margin: 9, top: [] } };

/** Builds a scan wired to fakes. `script` decides what the analyzer says. */
function rig(over = {}) {
  const log = { calls: [], captures: 0, status: [], analyze: [], focus: 0, ref: 0, paused: 0, resumed: 0 };
  let t = 1000;
  const keys = new Set();
  const deps = {
    now: () => t,
    sleep: async ms => { t += ms; if (over.onSleep) over.onSleep(t, keys); },
    isGameRunning: async () => over.running !== false,
    focus: async () => { log.focus++; return over.focus || { ok: true }; },
    capture: async () => { log.captures++; return over.capture ? over.capture(log.captures) : frame(); },
    keyProvider: over.keyProvider === null ? null : { isDown: vk => keys.has(vk) },
    analyze: async job => {
      log.analyze.push(job.type + ':' + job.frames.length);
      return over.analyze ? over.analyze(job, log) : job.type === 'check' ? { open: true, score: 0.9 } : READING_OK;
    },
    encodePngs: async frames => frames.map(f => Buffer.from([f.width & 255])),
    watcher: { pause: () => log.paused++, resume: () => log.resumed++, addReferenceFromFrame: () => { log.ref++; return true; }, markOpen: () => { log.markedOpen = (log.markedOpen || 0) + 1; } },
    config: over.config,
    ...over.deps,
  };
  const scan = new AutoScan(deps);
  scan.on('status', s => log.status.push(s.phase));
  return { scan, log, keys, time: () => t };
}

(async () => {
  await test('game not running -> clear error, nothing touched', async () => {
    const { scan, log } = rig({ running: false });
    const r = await scan.start();
    assert.deepStrictEqual([r.ok, r.reason], [false, 'game-not-running']);
    assert.match(r.message, /not running/i);
    assert.strictEqual(log.focus + log.captures, 0);
    assert.strictEqual(log.resumed, 1, 'watcher must be resumed even on failure');
  });

  await test('map already open: focus -> check -> second screenshot -> scan -> seed', async () => {
    const { scan, log } = rig();
    const r = await scan.start();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.seedId, '042');
    assert.match(r.message, /042/);
    assert.deepStrictEqual(log.analyze, ['check:1', 'scan:2']);
    assert.strictEqual(log.captures, 2, 'exactly two screenshots');
    assert.strictEqual(log.focus, 1);
    assert.deepStrictEqual(log.status.filter((p, i, a) => a.indexOf(p) === i),
      ['starting', 'focusing', 'waiting-map', 'capturing', 'analyzing', 'done']);
    assert.strictEqual(log.ref, 1, 'a good scan teaches the watcher what the map looks like');
    assert.strictEqual(log.markedOpen, 1, 'and tells it the map is open now, so closing it later is noticed');
    assert.deepStrictEqual([log.paused, log.resumed], [1, 1]);
  });

  await test('waits for the map key; takes NO screenshots while nothing happens', async () => {
    let opened = false;
    const { scan, log, keys } = rig({
      analyze: job => job.type === 'check' ? { open: opened, score: opened ? 0.9 : 0.02 } : READING_OK,
      onSleep: (t, k) => {
        if (t >= 3000 && t < 3100) k.add(VK_M);        // player presses M at ~t=3 s
        if (t >= 3100) { k.delete(VK_M); opened = true; }
      },
      config: { safetyPollMs: 60000 },
    });
    const r = await scan.start();
    assert.strictEqual(r.ok, true);
    // 1 look at the start (map closed) + 1 after the key press + 1 second screenshot
    assert.strictEqual(log.captures, 3);
    assert.deepStrictEqual(log.analyze, ['check:1', 'check:1', 'scan:2']);
  });

  await test('map not open yet when M is pressed -> keeps waiting for the next press', async () => {
    let presses = 0, opened = false;
    const { scan, log, keys } = rig({
      analyze: job => job.type === 'check' ? { open: opened, score: 0.1 } : READING_OK,
      onSleep: (t, k) => {
        if (t % 5000 < 60 && presses < 2 && !k.has(VK_M)) { k.add(VK_M); presses++; if (presses === 2) opened = true; }
        else k.delete(VK_M);
      },
      config: { safetyPollMs: 600000 },
    });
    const r = await scan.start();
    assert.strictEqual(r.ok, true);
    assert.ok(presses >= 2);
  });

  await test('no key reader: polls the screen every pollMs until the map appears', async () => {
    let checks = 0;
    const { scan, log } = rig({
      keyProvider: null,
      analyze: job => job.type === 'check' ? { open: ++checks >= 4, score: 0.5 } : READING_OK,
    });
    const r = await scan.start();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(checks, 4);
  });

  await test('gives up after the timeout with a clear message', async () => {
    const { scan } = rig({ analyze: () => ({ open: false, score: 0.01 }), config: { timeoutMs: 20000 } });
    const r = await scan.start();
    assert.deepStrictEqual([r.ok, r.reason], [false, 'timeout']);
    assert.match(r.message, /Gave up waiting/);
  });

  await test('cancel while waiting', async () => {
    const { scan } = rig({ analyze: () => ({ open: false, score: 0 }), onSleep: () => scan.cancel() });
    const r = await scan.start();
    assert.deepStrictEqual([r.ok, r.reason], [false, 'cancelled']);
  });

  await test('focus failure is not fatal: tells the user and carries on', async () => {
    const { scan, log } = rig({ focus: { ok: false, reason: 'refused' } });
    const r = await scan.start();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(log.focus, 1);
  });

  await test('low confidence: reports the best guess but does NOT learn from the screenshot', async () => {
    const { scan, log } = rig({
      analyze: job => job.type === 'check' ? { open: true, score: 0.9 }
        : { ok: false, mapOpen: true, match: { ok: false, seedId: '007', mapType: 'Crater', nightlord: 'Maris', exact: 9, margin: 1, top: [] } },
    });
    const r = await scan.start();
    assert.deepStrictEqual([r.ok, r.reason, r.seedId], [false, 'low-confidence', '007']);
    assert.match(r.message, /best guess 007/);
    assert.strictEqual(log.ref, 0);
  });

  await test('map vanished between check and scan -> map-not-visible', async () => {
    const { scan } = rig({ analyze: job => job.type === 'check' ? { open: true, score: 0.9 } : { ok: false, mapOpen: false } });
    const r = await scan.start();
    assert.strictEqual(r.reason, 'map-not-visible');
  });

  await test('screenshot failure -> capture-failed; second screenshot missing -> carries on with one', async () => {
    let r = await rig({ capture: () => null }).scan.start();
    assert.strictEqual(r.reason, 'capture-failed');
    const rr = rig({ capture: n => (n === 2 ? null : frame()) });
    r = await rr.scan.start();
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(rr.log.analyze, ['check:1', 'scan:1']);
  });

  await test('an exception inside the analyzer is reported, and the watcher is resumed', async () => {
    const { scan, log } = rig({ analyze: () => { throw new Error('worker blew up'); } });
    const r = await scan.start();
    assert.deepStrictEqual([r.ok, r.reason], [false, 'error']);
    assert.match(r.message, /worker blew up/);
    assert.strictEqual(log.resumed, 1);
  });

  await test('a second start while one is running is refused', async () => {
    const { scan } = rig({ analyze: async job => { await new Promise(r => setImmediate(r)); return job.type === 'check' ? { open: true, score: 1 } : READING_OK; } });
    const first = scan.start();
    const second = await scan.start();
    assert.strictEqual(second.reason, 'busy');
    assert.strictEqual((await first).ok, true);
  });

  await test("result event carries the same object start() returns", async () => {
    const { scan } = rig();
    let emitted; scan.on('result', r => { emitted = r; });
    const r = await scan.start();
    assert.strictEqual(emitted, r);
  });

  await test('screenshots + reading are saved for troubleshooting; only the 10 newest folders are kept', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scandbg-'));
    let n = 0;
    const { scan } = rig({ deps: { debugRoot: root, now: () => Date.UTC(2026, 9, 13, 12, 0, ++n) } });
    let last;
    for (let i = 0; i < 12; i++) last = await scan.start();
    assert.ok(last.debugDir && fs.existsSync(path.join(last.debugDir, 'panel-1.png')));
    assert.ok(fs.existsSync(path.join(last.debugDir, 'panel-2.png')));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(last.debugDir, 'result.json'))).match.seedId, '042');
    assert.strictEqual(fs.readdirSync(root).length, 10);
  });

  await test('cropPanel cuts the map panel out of a full screenshot (2560x1440 -> ~993x974)', async () => {
    const W = 2560, H = 1440, bitmap = Buffer.alloc(W * H * 4);
    const p = AutoScan.cropPanel({ bitmap, width: W, height: H });
    assert.ok(Math.abs(p.width - 993) <= 1 && Math.abs(p.height - 974) <= 1, `${p.width}x${p.height}`);
    assert.strictEqual(p.data.length, p.width * p.height * 4);
  });
  await test('cropPanel copies the right pixels', async () => {
    const W = 320, H = 180, bitmap = Buffer.alloc(W * H * 4);
    const sig = require('../src/core/mapSignature'); const r = sig.panelRect(W, H);
    const i = ((r.y + 3) * W + (r.x + 5)) * 4; bitmap[i] = 200; bitmap[i + 1] = 100; bitmap[i + 2] = 50;
    const p = AutoScan.cropPanel({ bitmap, width: W, height: H });
    const j = (3 * p.width + 5) * 4;
    assert.deepStrictEqual([p.data[j], p.data[j + 1], p.data[j + 2]], [200, 100, 50]);
  });

  console.log(`\n${passed} tests passed`);
})().catch(err => { console.error(err); process.exit(1); });
