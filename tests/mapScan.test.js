// Run with:  node tests/mapScan.test.js   (also part of `npm test`)
// Engine logic on panels composed in pure Node. Backgrounds are smooth, so this checks geometry and
// decisions, not real-game fidelity (see tests/scan.e2e.test.js for textured synthetic screenshots).
const assert = require('assert');
const scan = require('../src/core/mapScan');
const { composePanel, templatesJson, slots } = require('./helpers/compose');

const templates = scan.loadTemplates(templatesJson);
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  -', name); };
const labels = r => Object.fromEntries(Object.entries(r).map(([id, v]) => [id, v.label]));

const LAYOUT = { '01': 'church', '03': 'fort', '05': 'ruins', '09': 'ruins_fire', '12': 'greatchurch', '14': 'sorcerers', '16': 'township', '19': 'mainencampment', '22': 'fort_magic', '25': 'ruins_frostbite' };

test('alignment: picks the right map and recovers shift and scale', () => {
  for (const map of ['Default', 'Crater', 'Mountaintop']) {
    const frame = composePanel({ map, s: 1.04, tx: 0.02, ty: -0.015 });
    const a = scan.align(scan.toWork(frame), templates);
    assert.strictEqual(a.map, map);
    assert.ok(Math.abs(a.s - 1.04) < 0.01 && Math.abs(a.tx - 0.02) < 0.006 && Math.abs(a.ty + 0.015) < 0.006, JSON.stringify(a));
  }
});
test('checkMapOpen: true for a map panel, false for noise / gameplay-like frames', () => {
  assert.strictEqual(scan.checkMapOpen(composePanel({}), templates).open, true);
  const w = 256, noise = Buffer.alloc(w * w * 4); let s = 5;
  for (let i = 0; i < noise.length; i++) noise[i] = (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) >>> 24;
  assert.strictEqual(scan.checkMapOpen({ width: w, height: w, data: noise }, templates).open, false);
});
test('reads each icon family and variant at the right slot', () => {
  const r = scan.classifyFrame(composePanel({ placements: LAYOUT }), templates, slots);
  const got = labels(scan.fuse([r]));
  for (const [id, want] of Object.entries(LAYOUT)) assert.strictEqual(got[id], want, `slot ${id}`);
});
test('slots without an icon stay empty', () => {
  const r = scan.classifyFrame(composePanel({ placements: LAYOUT }), templates, slots);
  const got = labels(scan.fuse([r]));
  const wrong = Object.entries(got).filter(([id, l]) => !LAYOUT[id] && l !== 'empty');
  assert.deepStrictEqual(wrong, []);
});
test('an empty map reads as 27 empty slots and no spawn', () => {
  const got = labels(scan.fuse([scan.classifyFrame(composePanel({}), templates, slots)]));
  assert.strictEqual(Object.keys(got).length, 27);
  assert.ok(Object.values(got).every(l => l === 'empty'));
});
test('works when the game draws the map shifted, scaled and with bigger icons', () => {
  const frame = composePanel({ placements: LAYOUT, s: 0.96, tx: -0.03, ty: 0.025, iconScale: 1.3 });
  const got = labels(scan.fuse([scan.classifyFrame(frame, templates, slots)]));
  const hits = Object.entries(LAYOUT).filter(([id, want]) => got[id] === want).length;
  assert.ok(hits >= 8, `only ${hits}/10 correct`);
});
test('exactly one spawn: ring on open ground -> "spawn", glow on a church -> "church_spawn"', () => {
  let got = labels(scan.fuse([scan.classifyFrame(composePanel({ placements: { ...LAYOUT, '17': 'spawn' } }), templates, slots)]));
  assert.strictEqual(got['17'], 'spawn');
  assert.strictEqual(Object.values(got).filter(l => l === 'spawn' || l === 'church_spawn').length, 1);
  got = labels(scan.fuse([scan.classifyFrame(composePanel({ placements: { ...LAYOUT, '01': 'church_spawn' } }), templates, slots)]));
  assert.strictEqual(got['01'], 'church_spawn');
});
test('fuse keeps the more confident of two screenshots', () => {
  const a = { slots: { '01': { label: 'empty', score: 0.3, family: 'empty', blue: 0 } } };
  const b = { slots: { '01': { label: 'church', score: 0.8, family: 'church', blue: 0 } } };
  assert.strictEqual(scan.fuse([a, b])['01'].label, 'church');
  assert.strictEqual(scan.fuse([a, b])['01'].agree, false);
});
test('toWork rejects a buffer that does not match the stated size', () => {
  assert.throws(() => scan.toWork({ width: 100, height: 100, data: Buffer.alloc(10) }), /buffer/i);
});
console.log(`\n${passed} tests passed`);
