// Run with:  node tests/finderLoad.test.js   (also part of `npm test`)
// Loads ALL of the finder's scripts, in the order public/finder/index.html lists them, into ONE shared global scope
// (like a browser does), so clashing names, load-order mistakes or broken wiring show up. Then the real lazy
// poiViewInstance getter draws a seed's POIs. No jsdom: a minimal fake document is enough.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/finder/index.html'), 'utf-8');
const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);

const store = {};
const ops = [];
const ctx2d = new Proxy({ measureText: s => ({ width: String(s).length * 6 }) }, {
  get: (t, k) => (k in t ? t[k] : (...a) => { ops.push({ op: String(k), a }); }),
  set: (t, k, v) => { t[k] = v; return true; },
});
const wrapper = { children: [], appendChild(c) { this.children.push(c); } };
const dom = { mapWrapper: wrapper };
const wrap = { tag: 'div', children: [], appendChild(c) { this.children.push(c); return c; } };
const mkEl = tag => {
  const e = { tag, style: {}, children: [], listeners: {}, className: '', textContent: '', hidden: false, width: 0, height: 0 };
  e.appendChild = c => { e.children.push(c); return c; };
  e.replaceChildren = () => { e.children.length = 0; };
  e.addEventListener = (type, fn) => { e.listeners[type] = fn; };
  e.getContext = () => ctx2d;
  return e;
};
const fakeDocument = {
  readyState: 'loading', // init code waits for DOMContentLoaded, which never fires: we only want the scripts' definitions
  addEventListener() {}, getElementById: id => dom[id] || null, querySelector: sel => (sel === '.wrap' ? wrap : null), querySelectorAll: () => [],
  createElement: mkEl,
  createTextNode: text => ({ text }), body: { appendChild() {} }, documentElement: { lang: 'en' },
};
const sandbox = {
  console, setTimeout, clearTimeout, Promise, URL, JSON, Math, Object, Array, Map, Set, Number, String, Error, Date, Proxy, Buffer,
  document: fakeDocument, navigator: { language: 'en' },
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  fetch: async url => {
    const file = path.join(root, 'public/finder', url);
    if (!fs.existsSync(file)) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(file, 'utf-8')) };
  },
  Event: class { constructor(type) { this.type = type; } },
};
const listeners = {};
sandbox.addEventListener = (type, fn) => (listeners[type] = listeners[type] || []).push(fn);
sandbox.dispatchEvent = e => (listeners[e.type] || []).forEach(fn => fn(e));
sandbox.window = sandbox;
vm.createContext(sandbox);

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ok  -', name); };

(async () => {
  await test(`all ${scripts.length} scripts of the finder load without errors, in the page's order`, () => {
    for (const rel of scripts) {
      const file = path.normalize(path.join(root, 'public/finder', rel));
      try { vm.runInContext(fs.readFileSync(file, 'utf-8'), sandbox, { filename: rel }); }
      catch (err) { assert.fail(`${rel} failed to load: ${err.message}`); }
    }
    assert.ok(sandbox.Seedfinder && sandbox.SeedfinderRuntime && sandbox.OverlayModules && sandbox.OverlayRuntime);
  });

  await test('the overlay modules and the finder modules live in separate namespaces (nothing overwritten)', () => {
    assert.ok(sandbox.Seedfinder.state && sandbox.OverlayModules.state && sandbox.Seedfinder.state !== sandbox.OverlayModules.state);
    assert.ok(sandbox.OverlayModules.data.loadSeedsForNightlord && sandbox.Seedfinder.data.loadAll);
    assert.ok(sandbox.SeedfinderRuntime.createView && sandbox.OverlayRuntime.renderer.renderDescriptors);
  });

  await test('the real lazy poiViewInstance draws a seed on the finder map through the real wiring', async () => {
    const st = sandbox.Seedfinder.state;
    st.setActiveMapType('Default'); st.setSizes(700, 50);
    const seed = JSON.parse(fs.readFileSync(path.join(root, 'public/assets/data/seed_data.json'), 'utf-8')).find(s => s.seed_id === '085');
    const view = sandbox.SeedfinderRuntime.poiViewInstance;
    assert.ok(view && typeof view.show === 'function');
    assert.strictEqual(sandbox.SeedfinderRuntime.poiViewInstance, view, 'one instance, created once');
    await view.show({ nightlord: seed.nightlord, seed_id: seed.seed_id, seed });
    assert.strictEqual(wrapper.children.length, 1, 'canvas added to the map wrapper');
    const boxes = ops.filter(o => o.op === 'fillRect').length, circles = ops.filter(o => o.op === 'arc').length;
    assert.ok(boxes >= 5 && circles === boxes * 3, `labels ${boxes}, circles ${circles}`);
  });

  await test('the real route view (through the real getters) plans routes for the shown seed and adds its panel', async () => {
    const view = sandbox.SeedfinderRuntime.routeViewInstance;
    assert.ok(view && typeof view.setSeed === 'function' && sandbox.Seedfinder.routing.planRoutesAsync);
    for (let i = 0; i < 100 && !view.result; i++) await new Promise(r => setTimeout(r, 100));   // planning runs in small steps
    assert.ok(view.result && view.result.plans.length >= 2, 'routes were planned after the POI view showed the seed');
    const panel = wrap.children.find(c => c.id === 'routePanel');
    assert.ok(panel && panel.hidden === false, 'the panel was added to the page and is visible');
    assert.ok(ops.some(o => o.op === 'arc'), 'something was drawn');
    sandbox.SeedfinderRuntime.poiViewInstance.clear();
    assert.strictEqual(view.result, null); assert.strictEqual(panel.hidden, true);
  });

  await test('changing an option in the finder redraws the POIs: the event the option inputs fire reaches the view', async () => {
    assert.strictEqual((listeners['overlay-prefs-changed'] || []).length, 2, 'the POI view and the route view each subscribed once');
    store.finder_showRoutes = 'false'; // keep the route view out of this test: it draws on the same fake canvas
    store.finder_showRoutes = 'false';
    const seed0 = JSON.parse(fs.readFileSync(path.join(root, 'public/assets/data/seed_data.json'), 'utf-8')).find(s => s.seed_id === '085');
    await sandbox.SeedfinderRuntime.poiViewInstance.show({ nightlord: seed0.nightlord, seed_id: seed0.seed_id, seed: seed0 });
    const before = ops.filter(o => o.op === 'fillRect').length;
    store.overlay_showEvergaol = 'false'; store.overlay_showFieldBoss = 'false';
    ops.length = 0;
    sandbox.dispatchEvent(new sandbox.Event('overlay-prefs-changed')); // what overlay-prefs.js does after saving an option
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    const after = ops.filter(o => o.op === 'fillRect').length;
    assert.ok(after > 0 && after < before, `fewer labels once POI types are hidden (${before} -> ${after})`);
  });

  await test('hiding the POIs on the finder map from the options clears the canvas content', async () => {
    store.finder_showPois = 'false'; ops.length = 0;
    await sandbox.SeedfinderRuntime.poiViewInstance.layout();
    assert.strictEqual(ops.filter(o => o.op === 'fillRect').length, 0);
    assert.ok(ops.some(o => o.op === 'clearRect'));
  });

  console.log(`\n${passed} tests passed`);
})().catch(e => { console.error(e); process.exit(1); });
