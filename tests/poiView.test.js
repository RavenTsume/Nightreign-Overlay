// Run with:  node tests/poiView.test.js   (also part of `npm test`)
// The finder's POI view running the REAL overlay modules (data, label builder, renderer) on the REAL seed/POI data,
// drawing onto a fake canvas that tracks transforms, so positions can be checked.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const store = {};
global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
global.window = {};
global.fetch = async url => {            // relative to public/finder, like the real page
  const file = path.join(__dirname, '../public/finder', url);
  if (!fs.existsSync(file)) return { ok: false, status: 404, json: async () => null };
  return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(file, 'utf-8')) };
};
require('../src/shared/i18n/domain.js');
require('../src/overlay/i18n/domain-wire.js');
require('../src/overlay/modules/state.js');
require('../src/overlay/modules/data.js');
require('../src/overlay/runtime/seed-display.js');
require('../src/overlay/runtime/ui-state.js');
require('../src/overlay/runtime/renderer.js');
const { createPoiView } = require('../src/finder/runtime/poi-view.js');

const seeds = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/assets/data/seed_data.json'), 'utf-8'))
  .map(s => ({ ...s, shiftingEarth: s.map_type }));
const modules = window.OverlayModules, overlayRuntime = window.OverlayRuntime;
const poiById = new Map(JSON.parse(fs.readFileSync(path.join(__dirname, '../public/assets/data/poi_uv_with_ids.json'), 'utf-8')).map(p => [p.id, p]));

function fakeCtx() {
  const stack = [], ops = []; let t = { x: 0, y: 0, s: 1 };
  const abs = (x, y) => ({ x: t.x + x * t.s, y: t.y + y * t.s });
  return {
    ops, save() { stack.push({ ...t }); }, restore() { t = stack.pop(); }, setTransform() { t = { x: 0, y: 0, s: 1 }; },
    translate(x, y) { t = { ...t, x: t.x + x * t.s, y: t.y + y * t.s }; }, scale(k) { t = { ...t, s: t.s * k }; },
    beginPath() {}, fill() {}, clearRect() { ops.push({ op: 'clear' }); },
    arc(x, y, r) { ops.push({ op: 'arc', ...abs(x, y), r: r * t.s, style: this.fillStyle }); },
    fillRect(x, y, w, h) { ops.push({ op: 'box', ...abs(x, y), w, h }); }, fillText(text, x, y) { ops.push({ op: 'text', text, ...abs(x, y) }); },
    measureText(s) { return { width: s.length * 6 }; }, fillStyle: '', font: '', textAlign: '',
  };
}
function rig({ size = 800, map = 'Default' } = {}) {
  const ctx = fakeCtx();
  const canvas = { style: {}, width: 0, height: 0, getContext: () => ctx };
  const wrapper = { children: [], appendChild(c) { this.children.push(c); } };
  const state = { current: { mapPixelSize: size, activeMapType: map } };
  const view = createPoiView({ state, getMapWrapper: () => wrapper, doc: { createElement: () => canvas }, storage: localStorage, modules, overlayRuntime, dpr: () => 1 });
  return { view, ctx, canvas, wrapper, state };
}
const payloadOf = seed => ({ nightlord: seed.nightlord, seed_id: seed.seed_id, seed });
const arcs = ctx => ctx.ops.filter(o => o.op === 'arc'), boxes = ctx => ctx.ops.filter(o => o.op === 'box');
const reset = () => Object.keys(store).forEach(k => delete store[k]);

(async () => {
  let passed = 0;
  const test = async (name, fn) => { reset(); await fn(); passed++; console.log('  ok  -', name); };

  await test('every one of the 320 seeds draws labels with a marker on each POI', async () => {
    const r = rig();
    for (const seed of seeds) {
      r.ctx.ops.length = 0;
      await r.view.show(payloadOf(seed));
      assert.ok(boxes(r.ctx).length >= 5, `seed ${seed.seed_id}: only ${boxes(r.ctx).length} labels`);
      assert.strictEqual(arcs(r.ctx).length, boxes(r.ctx).length * 3, `seed ${seed.seed_id}: one 3-circle marker per label`);
    }
  });

  await test('each marker sits exactly on its POI position on the finder map', async () => {
    const r = rig({ size: 800 });
    const seed = seeds.find(s => s.seed_id === '085');
    await r.view.show(payloadOf(seed));
    const descriptors = overlayRuntime.seedDisplay.buildLabelDescriptors(
      modules.data.findSeed(await modules.data.loadSeedsForNightlord(seed.nightlord), seed.seed_id),
      { stripTypePrefix: modules.state.stripTypePrefix, SORCERERS_RISE_PREFIX: modules.data.SORCERERS_RISE_PREFIX });
    const centres = new Set(arcs(r.ctx).map(a => `${a.x.toFixed(2)},${a.y.toFixed(2)}`));
    assert.ok(descriptors.length > 5);
    for (const d of descriptors) {
      const p = poiById.get(d.poiId); if (!p) continue;
      assert.ok(centres.has(`${(p.uv[0] * 800).toFixed(2)},${(p.uv[1] * 800).toFixed(2)}`), `POI ${d.poiId} not marked at its position`);
    }
  });

  await test('the canvas is created once inside the map wrapper, sized to the map (and to the pixel ratio)', async () => {
    const r = rig({ size: 640 });
    await r.view.show(payloadOf(seeds[0])); await r.view.show(payloadOf(seeds[1]));
    assert.strictEqual(r.wrapper.children.length, 1);
    assert.deepStrictEqual([r.canvas.id, r.canvas.style.pointerEvents, r.canvas.style.width, r.canvas.width], ['poiLayer', 'none', '640px', 640]);
    r.state.current.mapPixelSize = 1000; await r.view.layout();
    assert.deepStrictEqual([r.canvas.style.width, r.canvas.width], ['1000px', 1000]);
  });

  await test('the "Show POIs on this finder map" option switches them off and on', async () => {
    const r = rig(); localStorage.setItem('finder_showPois', 'false');
    await r.view.show(payloadOf(seeds[3]));
    assert.strictEqual(boxes(r.ctx).length, 0);
    localStorage.setItem('finder_showPois', 'true'); await r.view.layout();
    assert.ok(boxes(r.ctx).length > 5);
  });

  await test('follows the same POI settings as the overlay: hidden POI types and colours', async () => {
    const r = rig(); await r.view.show(payloadOf(seeds[10]));
    const all = boxes(r.ctx).length;
    localStorage.setItem('overlay_showEvergaol', 'false'); localStorage.setItem('overlay_showFieldBoss', 'false');
    r.ctx.ops.length = 0; await r.view.layout();
    assert.ok(boxes(r.ctx).length < all, 'hiding POI types removes labels');
    localStorage.setItem('overlay_color_night', '#123456'); localStorage.setItem('overlay_showNight', 'true');
    r.ctx.ops.length = 0; await r.view.layout();
    assert.ok(arcs(r.ctx).some(a => a.style === '#123456'), 'marker takes the configured colour');
  });

  await test('overlay alignment settings (offset, scale) do NOT move POIs on the finder map', async () => {
    const r = rig({ size: 800 }); await r.view.show(payloadOf(seeds[5]));
    const before = arcs(r.ctx).map(a => `${a.x},${a.y}`).sort();
    localStorage.setItem('overlay_offsetX', '40'); localStorage.setItem('overlay_offsetY', '-25'); localStorage.setItem('overlay_scale', '1.6');
    r.ctx.ops.length = 0; await r.view.layout();
    assert.deepStrictEqual(arcs(r.ctx).map(a => `${a.x},${a.y}`).sort(), before);
  });

  await test('clear() removes everything; nothing is drawn without an active map; a slow older show() cannot draw after a clear()', async () => {
    const r = rig(); await r.view.show(payloadOf(seeds[2]));
    r.ctx.ops.length = 0; r.view.clear();
    assert.ok(r.ctx.ops.some(o => o.op === 'clear')); assert.strictEqual(r.view.hasSeed, false);
    await r.view.layout(); assert.strictEqual(boxes(r.ctx).length, 0);
    const slow = r.view.show(payloadOf(seeds[7])); r.view.clear(); await slow;
    assert.strictEqual(boxes(r.ctx).length, 0, 'superseded render must not draw');
    r.state.current.activeMapType = null; await r.view.show(payloadOf(seeds[7]));
    assert.strictEqual(boxes(r.ctx).length, 0, 'no map selected -> no POIs');
  });

  await test('a newer seed replaces the older one (the last show() wins)', async () => {
    const r = rig(); const a = r.view.show(payloadOf(seeds[1])); const b = r.view.show(payloadOf(seeds[200]));
    await Promise.all([a, b]);
    const solo = rig(); await solo.view.show(payloadOf(seeds[200]));
    assert.strictEqual(boxes(r.ctx).length, boxes(solo.ctx).length);
  });

  await test('labels are translated with the overlay\'s own locale data (Spanish differs from English)', async () => {
    const texts = async lang => {
      await window.OverlayI18N.init(lang);
      const r = rig(); await r.view.show(payloadOf(seeds.find(s => s.seed_id === '085')));
      return r.ctx.ops.filter(o => o.op === 'text').map(o => o.text).join('|');
    };
    const en = await texts('en'), es = await texts('es');
    assert.ok(en.length > 20 && es.length > 20); assert.notStrictEqual(en, es);
  });

  console.log(`\n${passed} tests passed`);
})().catch(e => { console.error(e); process.exit(1); });
