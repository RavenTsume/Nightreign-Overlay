// Run with:  npm run test:signature
const assert = require('assert');
const S = require('../src/core/mapSignature');
const { mapFrame, gameplayFrame, blank } = require('./helpers/frames');

const sig = f => S.computeSignature(f.b, f.W, f.H);

// --- tests -------------------------------------------------------------------
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  -', name); };

test('panelRect: exact 16:9 uses the whole screen', () => {
  const r = S.panelRect(1920, 1080);
  assert.deepStrictEqual(r, { x: 1090, y: 162, width: 744, height: 730 });
});
test('panelRect scales with resolution', () => {
  const a = S.panelRect(1920, 1080), b = S.panelRect(3840, 2160);
  assert.ok(Math.abs(b.x - a.x * 2) <= 2 && Math.abs(b.width - a.width * 2) <= 2);
});
test('panelRect: 21:9 monitor is pillarboxed into a centered 16:9 frame', () => {
  const r = S.panelRect(3440, 1440);
  const frameW = Math.round(1440 * 16 / 9), offset = Math.round((3440 - frameW) / 2);
  assert.ok(r.x > offset && r.x + r.width < offset + frameW);
});
test('panelRect: 16:10 monitor is letterboxed', () => {
  const r = S.panelRect(1920, 1200);
  const frameH = Math.round(1920 / (16 / 9)), offset = Math.round((1200 - frameH) / 2);
  assert.ok(r.y > offset && r.y + r.height < offset + frameH);
});

test('same map, different seed icons + brightness change -> high correlation', () => {
  const ref = sig(mapFrame(960, 540, { poiSeed: 1 }));
  for (const [seed, gain, bias] of [[2, 1, 0], [3, 0.7, 10], [4, 1.2, -15]]) {
    const c = S.correlation(ref, sig(mapFrame(960, 540, { poiSeed: seed, gain, bias })));
    assert.ok(c > 0.9, `expected >0.9, got ${c.toFixed(3)}`);
  }
});
test('overlay labels drawn on top of the map do NOT drop it below the close threshold', () => {
  const ref = sig(mapFrame(960, 540, { poiSeed: 1 }));
  const c = S.correlation(ref, sig(mapFrame(960, 540, { poiSeed: 1, labels: true })));
  assert.ok(c > 0.7, `expected >0.7, got ${c.toFixed(3)}`);
});
test('gameplay frames are clearly below the open threshold', () => {
  const ref = sig(mapFrame(960, 540, { poiSeed: 1 }));
  for (let s = 1; s <= 25; s++) {
    const c = S.correlation(ref, sig(gameplayFrame(960, 540, s)));
    assert.ok(c < 0.85, `gameplay #${s} scored ${c.toFixed(3)}`);
  }
});
test('same map captured at a different resolution still matches', () => {
  const a = sig(mapFrame(960, 540)), b = sig(mapFrame(1440, 810));
  assert.ok(S.correlation(a, b) > 0.95);
});
test('black / flat frame scores 0 and is rejected as a reference', () => {
  const s = sig({ b: blank(960, 540, 0), W: 960, H: 540 });
  assert.strictEqual(S.correlation(s, sig(mapFrame(960, 540))), 0);
  assert.strictEqual(S.hasContent(s), false);
  assert.strictEqual(S.hasContent(sig(mapFrame(960, 540))), true);
});
test('computeSignature rejects a buffer that does not match the stated size', () => {
  assert.throws(() => S.computeSignature(new Uint8Array(100), 960, 540), /buffer/i);
});
test('bestScore picks the matching reference among several map types', () => {
  const refs = [1, 2, 3, 4, 5].map(t => sig(mapFrame(960, 540, { terrain: t })));
  const probe = sig(mapFrame(960, 540, { terrain: 4, poiSeed: 9 }));
  const { score, index } = S.bestScore(probe, refs);
  assert.strictEqual(index, 3);
  assert.ok(score > 0.9);
  assert.strictEqual(S.bestScore(probe, []).score, null);
});

test('detector: needs consecutive frames to open and to close (debounce)', () => {
  const d = S.createDetector({ openThreshold: 0.85, closeThreshold: 0.7, openFrames: 2, closeFrames: 3 });
  assert.strictEqual(d.update(0.95), null);
  assert.strictEqual(d.update(0.3), null);     // streak broken
  assert.strictEqual(d.update(0.95), null);
  assert.strictEqual(d.update(0.96), 'open');
  assert.strictEqual(d.isOpen, true);
  assert.strictEqual(d.update(0.4), null);
  assert.strictEqual(d.update(0.9), null);     // streak broken
  assert.strictEqual(d.update(0.4), null);
  assert.strictEqual(d.update(0.4), null);
  assert.strictEqual(d.update(0.4), 'close');
});
test('detector: hysteresis band (0.7..0.85) keeps the current state', () => {
  const d = S.createDetector();
  d.update(0.9); d.update(0.9);
  for (let i = 0; i < 10; i++) assert.strictEqual(d.update(0.78), null);
  assert.strictEqual(d.isOpen, true);
});
test('detector ignores null / NaN scores (no references yet)', () => {
  const d = S.createDetector();
  assert.strictEqual(d.update(null), null);
  assert.strictEqual(d.update(NaN), null);
});

console.log(`\n${passed} tests passed`);
