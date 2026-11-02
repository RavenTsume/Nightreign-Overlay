// Run with:  node tests/finderApply.test.js   (also part of `npm test`)
// Loads the finder's REAL state, filtering and selection modules (with a stubbed view) and checks that
// applying a scan result for each of the 320 seeds ends with exactly that seed resolved + sent to the overlay.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.window = { SeedfinderRuntime: {} };
global.document = { readyState: 'complete', addEventListener() {} };
// serve the app's real data files to the finder's real loader
global.fetch = async url => {
  const file = path.join(__dirname, '../public/finder', url);
  if (!fs.existsSync(file)) return { ok: false, status: 404, json: async () => null };
  return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(file, 'utf-8')) };
};
require('../src/finder/modules/data.js');
require('../src/finder/modules/state.js');
const filtering = require('../src/core/filtering.js');
require('../src/finder/runtime/selection.js');
const { applySeedResult, applyPartialResult, forgetMap } = require('../src/finder/runtime/autodetect.js');

const state = window.Seedfinder.state;
let seeds;

const calls = { overlay: 0, highlight: [] };
const view = {
  updateStatus() {}, updateCandidatesList() {}, updateSendButtonState() {}, renderSlotIcons() {},
  showSingleSeedOverlay() { calls.overlay++; }, clearOverlayIfNeeded() {}, highlightMapButton(t) { calls.highlight.push(t); },
  resetActiveMap() {}, openSlotPicker() {},
};
const data = { buildingIcons: {}, nightlordIcons: {}, buildingIconIds: [] };
const selection = window.SeedfinderRuntime.createSelectionController({ state, data, view, filtering });


let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('every one of the 320 seeds resolves to itself and is sent to the overlay', () => {
  let n = 0;
  for (const seed of seeds) {
    const before = calls.overlay;
    const r = applySeedResult({ state, selection }, { seedId: seed.seed_id });
    assert.strictEqual(r.ok, true, `seed ${seed.seed_id}: ${r.reason}`);
    assert.strictEqual(state.current.resolvedSeed.seed_id, seed.seed_id);
    assert.strictEqual(state.current.activeMapType, seed.map_type);
    assert.strictEqual(state.current.selectionBySlot.nightlord, seed.nightlord);
    assert.ok(calls.overlay > before, 'overlay must be (re)sent');
    n++;
  }
  assert.strictEqual(n, 320);
});
test('applying the same seed twice re-sends it to the overlay', () => {
  applySeedResult({ state, selection }, { seedId: '001' });
  const before = calls.overlay;
  applySeedResult({ state, selection }, { seedId: '001' });
  assert.ok(calls.overlay > before);
});
test('switching to a seed on another map replaces the previous selection completely', () => {
  const a = seeds.find(s => s.map_type === 'Default'), b = seeds.find(s => s.map_type === 'Crater');
  applySeedResult({ state, selection }, { seedId: a.seed_id });
  applySeedResult({ state, selection }, { seedId: b.seed_id });
  assert.strictEqual(state.current.activeMapType, 'Crater');
  assert.strictEqual(state.current.resolvedSeed.seed_id, b.seed_id);
  assert.strictEqual(state.current.candidateSeeds.length, 1);
});
test('an unknown seed id is reported, not applied', () => {
  const r = applySeedResult({ state, selection }, { seedId: '999' });
  assert.deepStrictEqual([r.ok, r.reason], [false, 'unknown-seed']);
});
test('the Nightlord medallion is no longer clickable', () => {
  applySeedResult({ state, selection }, { seedId: '001' });
  const nl = state.current.selectionBySlot.nightlord;
  selection.onSlotClick('nightlord');
  assert.strictEqual(state.current.selectionBySlot.nightlord, nl);
});

function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
/** A reading where only `right` random slots are correct and the rest are plausible but wrong. */
function noisyReading(seed, right, r) {
  const ids = Object.keys(seed.slots), slots = {};
  const correct = new Set([...ids].sort(() => r() - 0.5).slice(0, right));
  for (const id of ids) {
    const truth = seed.slots[id] || 'empty';
    slots[id] = { label: correct.has(id) ? truth : (truth === 'fort' ? 'church' : 'fort'), score: 0.7, agree: true };
  }
  return slots;
}

test('uncertain scan: only slots that agree with the best guess are pre-filled, the finder is never left with 0 candidates (all 320 seeds)', () => {
  const r = rng(7);
  for (const seed of seeds) {
    const res = applyPartialResult({ state, selection }, { seedId: seed.seed_id, slots: noisyReading(seed, 12, r) });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(state.current.activeMapType, seed.shiftingEarth || seed.map_type);
    assert.ok(state.current.candidateSeeds.length >= 1, `seed ${seed.seed_id}: no candidates left`);
    assert.ok(state.current.candidateSeeds.some(c => c.seed_id === seed.seed_id), 'the best guess stays a candidate');
    assert.ok(res.filled <= 12);
    for (const [id, val] of Object.entries(state.current.selectionBySlot)) assert.strictEqual(val, seed.slots[id], `slot ${id} must agree with the best guess`);
  }
});
test('uncertain scan: the user can finish by clicking the remaining slots, and ends on the right seed', () => {
  const seed = seeds[200];
  applyPartialResult({ state, selection }, { seedId: seed.seed_id, slots: noisyReading(seed, 10, rng(3)) });
  const before = Object.keys(state.current.selectionBySlot).length;
  for (const [id, v] of Object.entries(seed.slots)) if (v) state.updateSelection(id, v);   // what clicking each slot does
  selection.applySelections();
  assert.ok(Object.keys(state.current.selectionBySlot).length > before);
  assert.strictEqual(state.current.resolvedSeed && state.current.resolvedSeed.seed_id, seed.seed_id);
});
test('uncertain scan: a wrong reading is NOT applied, and a slot can be corrected by the user afterwards', () => {
  const seed = seeds.find(s => s.slots['05'] && s.slots['05'] !== 'empty');
  const slots = Object.fromEntries(Object.entries(seed.slots).map(([id, v]) => [id, { label: v || 'empty' }]));
  slots['05'] = { label: 'empty' };                                                     // slot 05 misread as empty
  applyPartialResult({ state, selection }, { seedId: seed.seed_id, slots });
  assert.strictEqual(state.current.selectionBySlot['05'], undefined, 'misread slot stays unset');
  state.updateSelection('05', seed.slots['05']); selection.applySelections();           // the user clicks it
  assert.strictEqual(state.current.selectionBySlot['05'], seed.slots['05']);
  assert.strictEqual(state.current.resolvedSeed.seed_id, seed.seed_id);
});
test('uncertain scan with an unknown seed id is reported', () => {
  assert.deepStrictEqual(applyPartialResult({ state, selection }, { seedId: '999', slots: {} }), { ok: false, reason: 'unknown-seed' });
});

test('Forget map: finder back to its default state, overlay cleared, scan stopped, remembered result dropped', async () => {
  const order = [];
  window.app = { overlay: { reset: () => order.push('overlay-reset') } };
  applySeedResult({ state, selection }, { seedId: seeds[40].seed_id });
  assert.ok(state.current.resolvedSeed && state.current.activeMapType);
  await forgetMap({ scanApi: { cancel: async () => order.push('cancel'), forget: async () => order.push('forget') }, selection });
  assert.strictEqual(state.current.activeMapType, null);
  assert.strictEqual(state.current.resolvedSeed, null);
  assert.deepStrictEqual(state.current.candidateSeeds, []);
  assert.deepStrictEqual(state.current.selectionBySlot, {});
  assert.deepStrictEqual(order, ['cancel', 'forget', 'overlay-reset']);
  delete window.app;
});
test('Forget map works even when the scan API is missing, and scanning again afterwards works', async () => {
  await forgetMap({ scanApi: null, selection });
  const r = applySeedResult({ state, selection }, { seedId: seeds[7].seed_id });
  assert.strictEqual(r.ok, true);
});

(async () => {
  const loaded = await window.Seedfinder.data.loadAll();   // the finder's own loader + normaliser
  seeds = loaded.seeds;
  assert.strictEqual(seeds.length, 320);
  state.setSeeds(seeds);
  for (const [name, fn] of tests) { await fn(); passed++; console.log('  ok  -', name); }
  console.log(`\n${passed} tests passed`);
})().catch(e => { console.error(e); process.exit(1); });
