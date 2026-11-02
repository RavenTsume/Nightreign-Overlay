// Run with:  node tests/scanGate.test.js   (also part of `npm test`)
const assert = require('assert');
const { createScanGate } = require('../src/core/scanGate');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  -', name); };
const keys = (...k) => new Set(k);

test('no key pressed, map closed -> scanning is not allowed', () => {
  const g = createScanGate({ burstMs: 2000 });
  assert.strictEqual(g.sample(0, keys()), false);
  assert.strictEqual(g.allows(10, false), false);
});
test('pressing a key starts a burst that lasts burstMs', () => {
  const g = createScanGate({ burstMs: 2000 });
  g.sample(0, keys());
  assert.strictEqual(g.sample(100, keys('M')), true);
  assert.strictEqual(g.allows(150, false), true);
  assert.strictEqual(g.allows(2099, false), true);
  assert.strictEqual(g.allows(2100, false), false);
});
test('holding a key does not keep restarting the burst (only the press edge counts)', () => {
  const g = createScanGate({ burstMs: 1000 });
  g.sample(0, keys('M'));
  assert.strictEqual(g.sample(500, keys('M')), false);
  assert.strictEqual(g.sample(900, keys('M')), false);
  assert.strictEqual(g.allows(1001, false), false);
});
test('releasing and pressing again starts a new burst', () => {
  const g = createScanGate({ burstMs: 1000 });
  g.sample(0, keys('M')); g.sample(100, keys());
  assert.strictEqual(g.sample(5000, keys('M')), true);
  assert.strictEqual(g.allows(5500, false), true);
});
test('a second watched key (Esc) also triggers', () => {
  const g = createScanGate({ burstMs: 1000 });
  g.sample(0, keys());
  assert.strictEqual(g.sample(10, keys('Escape')), true);
});
test('while the map is open scanning stays allowed regardless of the burst', () => {
  const g = createScanGate({ burstMs: 1000 });
  assert.strictEqual(g.allows(999999, true), true);
});
test('a key already held when sampling starts counts as a press (first sample)', () => {
  const g = createScanGate({ burstMs: 1000 });
  assert.strictEqual(g.sample(0, keys('M')), true);
});
test('reset clears an active burst; configure changes the length', () => {
  const g = createScanGate({ burstMs: 1000 });
  g.sample(0, keys()); g.sample(1, keys('M')); g.reset();
  assert.strictEqual(g.allows(2, false), false);
  g.configure({ burstMs: 5000 }); g.sample(10, keys()); g.sample(11, keys('M'));
  assert.strictEqual(g.allows(4000, false), true);
});

test('edges() reports newly pressed keys without starting a burst; start() begins one of a chosen length', () => {
  const g = createScanGate({ burstMs: 2000 });
  assert.deepStrictEqual(g.edges(0, keys()), []);
  assert.deepStrictEqual(g.edges(10, keys('M', 'Escape')), ['M', 'Escape']);
  assert.deepStrictEqual(g.edges(20, keys('M')), [], 'held key is not a new press');
  assert.strictEqual(g.allows(30, false), false, 'edges alone start nothing');
  g.start(100, 1500);
  assert.strictEqual(g.allows(1599, false), true);
  assert.strictEqual(g.allows(1600, false), false);
  g.start(5000);
  assert.strictEqual(g.allows(6999, false), true, 'default length when none is given');
});
console.log(`\n${passed} tests passed`);
