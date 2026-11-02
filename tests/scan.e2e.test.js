// Run with:  node tests/scan.e2e.test.js   (also part of `npm test`)
// FULL path: fake 2560x1440 screenshots (textured synthetic map panels from tests/tools/make_panels.py)
// -> AutoScan -> real worker thread -> real engine + real seed data -> seed id.
// Needs python3 with Pillow + numpy to make the panels; otherwise this test is skipped.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const AutoScan = require('../app/main/autoScan');
const sig = require('../src/core/mapSignature');

const py = ['python3', 'python'].find(p => spawnSync(p, ['-c', 'import PIL, numpy'], { stdio: 'ignore' }).status === 0);
if (!py) { console.log('  skipped - python with Pillow + numpy not found (only needed for this test)'); process.exit(0); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-e2e-'));
const gen = spawnSync(py, [path.join(__dirname, 'tools/make_panels.py'), dir, '3', '21'], { encoding: 'utf-8' });
assert.strictEqual(gen.status, 0, gen.stderr);
const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf-8'));

/** Embed a 993x974 panel into a dark 2560x1440 screenshot at the spot where the game draws the map. */
function screenshot(seedId, variant) {
  const W = 2560, H = 1440, r = sig.panelRect(W, H);
  const panel = fs.readFileSync(path.join(dir, `${seedId}_${variant}.bgra`));
  const pw = 993, ph = 974, bitmap = Buffer.alloc(W * H * 4, 20);
  for (let y = 0; y < ph; y++) panel.copy(bitmap, ((r.y + y) * W + r.x) * 4, y * pw * 4, (y + 1) * pw * 4);
  return { bitmap, width: W, height: H };
}

(async () => {
  let passed = 0;
  for (const meta of index) {
    let shots = 0;
    const scan = new AutoScan({
      rootDir: path.join(__dirname, '..'),
      isGameRunning: async () => true,
      focus: async () => ({ ok: true }),
      keyProvider: null,
      debugRoot: path.join(dir, 'debug'),
      sleep: async () => {},
      capture: async () => screenshot(meta.seed_id, Math.min(shots++, 1) ? 1 : 0),
    });
    const t0 = Date.now();
    const r = await scan.start();
    assert.strictEqual(r.ok, true, `${meta.seed_id}: ${r.message}`);
    assert.strictEqual(r.seedId, meta.seed_id);
    assert.strictEqual(r.mapType, meta.map_type);
    assert.ok(r.exact >= 18, `only ${r.exact}/27 exact`);
    const png = fs.readFileSync(path.join(r.debugDir, 'panel-1.png'));      // encoded in the worker thread
    assert.deepStrictEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.ok(Object.keys(JSON.parse(fs.readFileSync(path.join(r.debugDir, 'result.json'), 'utf-8')).slots).length === 27);
    passed++;
    console.log(`  ok  - seed ${r.seedId} (${r.mapType}, ${r.nightlord}) found: ${r.exact}/27 exact, margin ${r.margin}, ${((Date.now() - t0) / 1000).toFixed(1)} s incl. worker`);
  }
  console.log(`\n${passed} tests passed`);
})().catch(err => { console.error(err); process.exit(1); });
