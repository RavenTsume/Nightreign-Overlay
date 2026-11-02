// Run with:  node tests/overlayRenderer.test.js   (also part of `npm test`)
// Checks the POI markers with a fake canvas that tracks translate/scale, so we can compare absolute positions.
const assert = require('assert');
global.window = {};
require('../src/overlay/runtime/renderer.js');
const renderer = global.window.OverlayRuntime.renderer;

function fakeCtx() {
  const stack = [], ops = [];
  let t = { x: 0, y: 0, s: 1 };
  const abs = (x, y) => ({ x: t.x + x * t.s, y: t.y + y * t.s });
  return {
    ops,
    save() { stack.push({ ...t }); }, restore() { t = stack.pop(); },
    translate(x, y) { t = { ...t, x: t.x + x * t.s, y: t.y + y * t.s }; },
    scale(k) { t = { ...t, s: t.s * k }; },
    beginPath() {}, fill() {}, clearRect() {},
    arc(x, y, r) { ops.push({ op: 'arc', ...abs(x, y), r: r * t.s, style: this.fillStyle }); },
    fillRect(x, y, w, h) { const a = abs(x, y); ops.push({ op: 'box', x: a.x, y: a.y, w: w * t.s, h: h * t.s }); },
    fillText(text, x, y) { ops.push({ op: 'text', text, ...abs(x, y) }); },
    measureText(s) { return { width: s.length * 6 }; },
    fillStyle: '', font: '', textAlign: '',
  };
}
const ui = { fontPx: 12, labelPad: 12, labelH: 16, bgAlpha: 0.5, offsetX: 0, offsetY: 0 };
const panelRect = { x: 100, y: 50, width: 400, height: 400 };
const POIS = { a: { uv: [0.25, 0.25] }, b: { uv: [0.75, 0.5] } };
const deps = (extra = {}) => ({
  panelRect, ui, getPoiRecord: id => POIS[id],
  uvToScreen: (r, u, v) => ({ x: r.x + u * r.width, y: r.y + v * r.height }),
  isStyleVisible: k => k !== 'hidden', getStyleColor: k => ({ night: '#ff0000', field: '#00ff00' }[k] || '#fff'),
  wrapLabelText: t => [t], globalScale: 1, ...extra,
});
const D = [{ poiId: 'a', text: 'Night Boss', styleKey: 'night' }, { poiId: 'b', text: 'Field', styleKey: 'field' }];

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  -', name); };

test('a marker is drawn exactly on every POI position', () => {
  const ctx = fakeCtx(); renderer.renderDescriptors(ctx, D, deps());
  const centres = ctx.ops.filter(o => o.op === 'arc').map(o => `${o.x},${o.y}`);
  assert.ok(centres.includes('200,150'), 'POI a at uv .25/.25 -> 200,150');
  assert.ok(centres.includes('400,250'), 'POI b at uv .75/.5 -> 400,250');
  assert.strictEqual(ctx.ops.filter(o => o.op === 'arc').length, 6, '3 circles (outline, ring, centre dot) per POI');
});
test('the label is lifted so it sits above the marker, not on top of it', () => {
  const ctx = fakeCtx(); renderer.renderDescriptors(ctx, D.slice(0, 1), deps());
  const box = ctx.ops.find(o => o.op === 'box');
  const r = renderer.markerRadius(ui);
  assert.ok(box.y + box.h <= 150 - r, `label bottom ${box.y + box.h} must be above marker top ${150 - r}`);
  assert.ok(Math.abs(box.x + box.w / 2 - 200) < 0.01, 'label stays horizontally centred on the POI');
});
test('all labels are drawn first, all markers last (a label can never hide a marker)', () => {
  const ctx = fakeCtx(); renderer.renderDescriptors(ctx, D, deps());
  const lastBox = ctx.ops.map(o => o.op).lastIndexOf('box');
  const firstArc = ctx.ops.map(o => o.op).indexOf('arc');
  assert.ok(firstArc > lastBox);
});
test('marker uses the label colour of its style', () => {
  const ctx = fakeCtx(); renderer.renderDescriptors(ctx, D, deps());
  const styles = ctx.ops.filter(o => o.op === 'arc').map(o => o.style);
  assert.ok(styles.includes('#ff0000') && styles.includes('#00ff00'));
});
test('marker: false restores the old look (label centred on the POI, no circles)', () => {
  const ctx = fakeCtx(); renderer.renderDescriptors(ctx, D.slice(0, 1), deps({ marker: false }));
  assert.strictEqual(ctx.ops.filter(o => o.op === 'arc').length, 0);
  const box = ctx.ops.find(o => o.op === 'box');
  assert.ok(Math.abs(box.y + box.h / 2 - 150) < 0.01);
});
test('hidden styles and unknown POIs draw neither label nor marker', () => {
  const ctx = fakeCtx();
  renderer.renderDescriptors(ctx, [{ poiId: 'a', text: 'x', styleKey: 'hidden' }, { poiId: 'zzz', text: 'y', styleKey: 'night' }], deps());
  assert.strictEqual(ctx.ops.length, 0);
});
test('user label offsets still apply on top of the lift', () => {
  const base = fakeCtx(); renderer.renderDescriptors(base, D.slice(0, 1), deps());
  const moved = fakeCtx(); renderer.renderDescriptors(moved, D.slice(0, 1), deps({ ui: { ...ui, offsetX: 7, offsetY: 10 } }));
  const a = base.ops.find(o => o.op === 'box'), b = moved.ops.find(o => o.op === 'box');
  assert.ok(Math.abs(b.x - a.x - 7) < 0.01 && Math.abs(b.y - a.y - 10) < 0.01);
  assert.ok(moved.ops.filter(o => o.op === 'arc').every(o => o.x === 200 || o.x === 400), 'markers do not move with the label offset');
});
test('markers scale with the overlay scale and stay on the POI', () => {
  const ctx = fakeCtx(); renderer.renderDescriptors(ctx, D.slice(0, 1), deps({ globalScale: 1.5 }));
  const arc = ctx.ops.find(o => o.op === 'arc');
  // scale 1.5 about the panel centre (300,250): POI (200,150) -> (150,100)
  assert.ok(Math.abs(arc.x - 150) < 0.01 && Math.abs(arc.y - 100) < 0.01);
});
console.log(`\n${passed} tests passed`);
