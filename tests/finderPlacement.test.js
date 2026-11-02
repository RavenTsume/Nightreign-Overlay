// Run with:  node tests/finderPlacement.test.js   (also part of `npm test`)
const assert = require('assert');
const { chooseFinderPlacement, samePlacement } = require('../src/core/finderPlacement');
const { autoOverlayAction, watcherEventAction, scanResultAction } = require('../src/core/overlayPolicy');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  -', name); };
const disp = (id, x, y, w, h) => ({ id, bounds: { x, y, width: w, height: h } });

test('one monitor -> normal window', () => {
  assert.deepStrictEqual(chooseFinderPlacement([disp(1, 0, 0, 2560, 1440)], 1), { mode: 'normal' });
  assert.deepStrictEqual(chooseFinderPlacement([], 1), { mode: 'normal' });
});
test('two monitors -> borderless on the one that is not the primary', () => {
  const p = chooseFinderPlacement([disp(1, 0, 0, 2560, 1440), disp(2, 2560, 0, 1920, 1080)], 1);
  assert.deepStrictEqual(p, { mode: 'borderless', displayId: 2, bounds: { x: 2560, y: 0, width: 1920, height: 1080 } });
});
test('works whichever side the second monitor is on (negative coordinates) and whichever is primary', () => {
  const left = chooseFinderPlacement([disp(1, 0, 0, 2560, 1440), disp(2, -1920, 120, 1920, 1080)], 1);
  assert.strictEqual(left.displayId, 2); assert.strictEqual(left.bounds.x, -1920);
  const swapped = chooseFinderPlacement([disp(1, 0, 0, 2560, 1440), disp(2, 2560, 0, 1920, 1080)], 2);
  assert.strictEqual(swapped.displayId, 1);
});
test('three monitors -> the largest non-primary one; ties keep the first', () => {
  const ds = [disp(1, 0, 0, 2560, 1440), disp(2, 2560, 0, 1280, 1024), disp(3, -1920, 0, 1920, 1080)];
  assert.strictEqual(chooseFinderPlacement(ds, 1).displayId, 3);
  assert.strictEqual(chooseFinderPlacement([disp(1, 0, 0, 10, 10), disp(2, 10, 0, 800, 600), disp(3, 810, 0, 800, 600)], 1).displayId, 2);
});
test('ignores broken display entries', () => {
  assert.deepStrictEqual(chooseFinderPlacement([disp(1, 0, 0, 100, 100), { id: 2 }, disp(3, 0, 0, 0, 0)], 1), { mode: 'normal' });
});
test('samePlacement notices a change of mode, monitor or size', () => {
  const a = chooseFinderPlacement([disp(1, 0, 0, 2560, 1440), disp(2, 2560, 0, 1920, 1080)], 1);
  assert.strictEqual(samePlacement(a, { ...a }), true);
  assert.strictEqual(samePlacement(a, { mode: 'normal' }), false);
  assert.strictEqual(samePlacement(a, { ...a, displayId: 3 }), false);
  assert.strictEqual(samePlacement(a, { ...a, bounds: { ...a.bounds, width: 1280 } }), false);
  assert.strictEqual(samePlacement({ mode: 'normal' }, { mode: 'normal' }), true);
});

test('overlay policy: automatic overlay switched off -> always hidden, never shown by itself', () => {
  for (const active of [true, false]) for (const open of [true, false]) assert.strictEqual(autoOverlayAction({ enabled: false, active, open }), 'hide');
  assert.strictEqual(watcherEventAction('open', { enabled: false, active: true }), 'leave');
  assert.strictEqual(scanResultAction({ enabled: false, ok: true }), 'leave');
});
test('overlay policy: switched on -> follows the map once the app has learned its look', () => {
  assert.strictEqual(autoOverlayAction({ enabled: true, active: false, open: false }), 'leave');
  assert.strictEqual(autoOverlayAction({ enabled: true, active: true, open: true }), 'show');
  assert.strictEqual(autoOverlayAction({ enabled: true, active: true, open: false }), 'hide');
  assert.strictEqual(watcherEventAction('open', { enabled: true, active: true }), 'show');
  assert.strictEqual(watcherEventAction('close', { enabled: true, active: true }), 'hide');
  assert.strictEqual(watcherEventAction('open', { enabled: true, active: false }), 'leave');
  assert.strictEqual(scanResultAction({ enabled: true, ok: true }), 'show');
  assert.strictEqual(scanResultAction({ enabled: true, ok: false }), 'leave');
});
console.log(`\n${passed} tests passed`);
