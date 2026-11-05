// Run with:  node tests/viewHooks.test.js   (also part of `npm test`)
// The real finder view.js, with the map view and DOM stubbed: wherever the finder talks to the overlay
// (send seed / clear / reset / resize) the POIs on the finder map must follow.
const assert = require('assert');

const calls = [];
const routeCalls = [];
const routesSpy = { layout: () => routeCalls.push('layout') };
const poi = { show: p => calls.push(['show', p.seed_id]), clear: () => calls.push(['clear']), layout: () => calls.push(['layout']) };
const noop = () => {};
const mapViewStub = new Proxy({}, { get: () => noop });
global.window = { SeedfinderRuntime: { createMapView: () => mapViewStub, poiViewInstance: poi, routeViewInstance: routesSpy }, app: { seed: { sendSelected: p => calls.push(['sent', p.seed_id]) }, overlay: { reset: () => calls.push(['overlay-reset']) } } };
require('../src/finder/runtime/view.js');

const seed = { seed_id: '042' };
const state = {
  current: { candidateSeeds: [seed], selectionBySlot: { nightlord: 'Adel' }, texts: { ui: {} }, slotCoords: [], activeMapType: 'Default' },
  setActiveMapType() {}, clearSelections() {},
};
const view = window.SeedfinderRuntime.createView({ state, data: { supportedLocales: {} }, dom: {} });

let passed = 0;
const test = (name, fn) => { calls.length = 0; fn(); passed++; console.log('  ok  -', name); };

test('one candidate left: the seed goes to the overlay AND the finder map', () => {
  view.showSingleSeedOverlay();
  assert.deepStrictEqual(calls, [['show', '042'], ['sent', '042']]);
});
test('several candidates: nothing is shown anywhere', () => {
  state.current.candidateSeeds = [seed, { seed_id: '043' }];
  view.showSingleSeedOverlay();
  assert.deepStrictEqual(calls, []);
  state.current.candidateSeeds = [seed];
});
test('the seed stops being unique: overlay and finder POIs are both cleared', () => {
  state.current.candidateSeeds = [seed, { seed_id: '043' }];
  view.clearOverlayIfNeeded(seed);
  assert.deepStrictEqual(calls, [['clear'], ['overlay-reset']]);
  state.current.candidateSeeds = [seed];
});
test('no previous seed or still unique: nothing is cleared', () => {
  view.clearOverlayIfNeeded(null); view.clearOverlayIfNeeded(seed);
  assert.deepStrictEqual(calls, []);
});
test('resetActiveMap clears the finder POIs', () => {
  view.resetActiveMap();
  assert.ok(calls.some(c => c[0] === 'clear'));
});
test('resizing the window redraws the POIs at the new map size', () => {
  view.recalcMapLayout();
  assert.deepStrictEqual(calls, [['layout']]);
});
test('resizing also redraws the route layer; a broken route view is ignored', () => {
  routeCalls.length = 0; view.recalcMapLayout();
  assert.deepStrictEqual(routeCalls, ['layout']);
  Object.defineProperty(window.SeedfinderRuntime, 'routeViewInstance', { configurable: true, get() { throw new Error('no routes'); } });
  view.recalcMapLayout(); // must not throw
  Object.defineProperty(window.SeedfinderRuntime, 'routeViewInstance', { configurable: true, value: routesSpy, writable: true });
});
test('a missing / broken POI view never breaks the finder', () => {
  Object.defineProperty(window.SeedfinderRuntime, 'poiViewInstance', { configurable: true, get() { throw new Error('no overlay modules'); } });
  view.showSingleSeedOverlay(); view.resetActiveMap(); view.recalcMapLayout(); view.clearOverlayIfNeeded(seed);
  assert.deepStrictEqual(calls.filter(c => c[0] === 'sent'), [['sent', '042']], 'the overlay still gets the seed');
});
console.log(`\n${passed} tests passed`);
