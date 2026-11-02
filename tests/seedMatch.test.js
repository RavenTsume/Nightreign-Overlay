// Run with:  node tests/seedMatch.test.js   (also part of `npm test`)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { matchSeeds } = require('../src/core/seedMatch');
const seeds = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/assets/data/seed_data.json'), 'utf-8'));

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  -', name); };
function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
const read = seed => Object.fromEntries(Object.entries(seed.slots).map(([id, v]) => [id, { label: v || 'empty' }]));
const FAMILY_VARIANTS = ['ruins', 'ruins_fire', 'ruins_magic', 'church', 'fort', 'fort_magic', 'sorcerers', 'township', 'greatchurch', 'mainencampment', 'spawn'];

test('a perfect reading identifies every one of the 320 seeds', () => {
  for (const s of seeds) {
    const m = matchSeeds(read(s), seeds);
    assert.strictEqual(m.seedId, s.seed_id); assert.strictEqual(m.ok, true);
    assert.strictEqual(m.mapType, s.map_type); assert.strictEqual(m.nightlord, s.nightlord);
  }
});
test('still correct when 5 random slots are read as the WRONG icon (all 320 seeds, 3 noise draws each)', () => {
  const r = rng(1);
  for (let round = 0; round < 3; round++) for (const s of seeds) {
    const d = read(s), ids = Object.keys(d);
    for (let i = 0; i < 5; i++) d[ids[Math.floor(r() * ids.length)]] = { label: FAMILY_VARIANTS[Math.floor(r() * FAMILY_VARIANTS.length)] };
    assert.strictEqual(matchSeeds(d, seeds).seedId, s.seed_id, `seed ${s.seed_id}`);
  }
});
test('still correct when 8 slots are read as empty', () => {
  const r = rng(2);
  for (const s of seeds) {
    const d = read(s), ids = Object.keys(d);
    for (let i = 0; i < 8; i++) d[ids[Math.floor(r() * ids.length)]] = { label: 'empty' };
    const m = matchSeeds(d, seeds);
    assert.strictEqual(m.seedId, s.seed_id); assert.strictEqual(m.ok, true, `seed ${s.seed_id} exact ${m.exact} margin ${m.margin}`);
  }
});
test('works when only 17 of the 27 slots could be read', () => {
  for (const s of seeds) {
    const d = read(s); Object.keys(d).slice(0, 10).forEach(id => delete d[id]);
    const m = matchSeeds(d, seeds);
    assert.strictEqual(m.seedId, s.seed_id); assert.strictEqual(m.ok, true);
  }
});
test('badge misreads inside the right family still count (partial credit)', () => {
  const s = seeds.find(x => Object.values(x.slots).filter(v => v.startsWith('ruins')).length >= 3);
  const d = read(s);
  for (const [id, v] of Object.entries(s.slots)) if (v.startsWith('ruins')) d[id] = { label: 'ruins' };
  const m = matchSeeds(d, seeds);
  assert.strictEqual(m.seedId, s.seed_id); assert.ok(m.score > m.exact, 'partial credit expected');
});
test('an all-empty or random reading is NOT accepted as a seed', () => {
  assert.strictEqual(matchSeeds(Object.fromEntries(Array.from({ length: 27 }, (_, i) => [String(i + 1).padStart(2, '0'), { label: 'empty' }])), seeds).ok, false);
  const r = rng(3);
  for (let n = 0; n < 50; n++) {
    const d = {}; for (let i = 1; i <= 27; i++) d[String(i).padStart(2, '0')] = { label: FAMILY_VARIANTS[Math.floor(r() * FAMILY_VARIANTS.length)] };
    assert.strictEqual(matchSeeds(d, seeds).ok, false, `random reading #${n} was accepted`);
  }
});
test('reports the three best candidates and the margin', () => {
  const m = matchSeeds(read(seeds[7]), seeds);
  assert.strictEqual(m.top.length, 3); assert.ok(m.margin >= 11); assert.strictEqual(m.top[0].seedId, seeds[7].seed_id);
});
console.log(`\n${passed} tests passed`);
