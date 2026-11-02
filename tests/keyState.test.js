// Run with:  node tests/keyState.test.js   (also part of `npm test`)
const assert = require('assert');
const { createKeyStateProvider, vkFor } = require('../app/main/keyState');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  -', name); };

test('virtual-key codes for common config names', () => {
  assert.strictEqual(vkFor('M'), 0x4d);
  assert.strictEqual(vkFor('m'), 0x4d);
  assert.strictEqual(vkFor('Escape'), 0x1b);
  assert.strictEqual(vkFor('esc'), 0x1b);
  assert.strictEqual(vkFor('Tab'), 0x09);
  assert.strictEqual(vkFor('F9'), 0x78);
  assert.strictEqual(vkFor('f1'), 0x70);
  assert.strictEqual(vkFor('5'), 0x35);
  assert.strictEqual(vkFor('Space'), 0x20);
});
test('unknown key names return null (and are ignored by the watcher)', () => {
  for (const bad of ['', 'banana', 'F99', 'MM', null, undefined]) assert.strictEqual(vkFor(bad), null);
});

test('mouse buttons are valid trigger names (physical buttons, as GetAsyncKeyState reports them)', () => {
  assert.strictEqual(vkFor('RightMouse'), 0x02);
  assert.strictEqual(vkFor('rmb'), 0x02);
  assert.strictEqual(vkFor('right_mouse'), 0x02);
  assert.strictEqual(vkFor('Mouse2'), 0x02);
  assert.strictEqual(vkFor('LeftMouse'), 0x01);
  assert.strictEqual(vkFor('MiddleMouse'), 0x04);
  assert.strictEqual(vkFor('Mouse4'), 0x05);
  assert.strictEqual(vkFor('Mouse5'), 0x06);
});

function fakeKoffi(returns) {
  const seen = { lib: null, sig: null, calls: [] };
  return { seen, koffi: {
    load: lib => { seen.lib = lib; return { func: sig => { seen.sig = sig; return vk => { seen.calls.push(vk); return returns(vk); }; } }; },
  } };
}
test('declares GetAsyncKeyState from user32.dll', () => {
  const { koffi, seen } = fakeKoffi(() => 0);
  createKeyStateProvider({ platform: 'win32', loader: () => koffi });
  assert.strictEqual(seen.lib, 'user32.dll');
  assert.match(seen.sig, /GetAsyncKeyState\(int vKey\)/);
});
test('isDown reads the high bit: negative short (0x8000) = down; 0 or 1 = up', () => {
  const states = { 0x4d: -32768, 0x1b: 1, 0x41: 0, 0x42: -32767 };
  const { koffi } = fakeKoffi(vk => states[vk]);
  const p = createKeyStateProvider({ platform: 'win32', loader: () => koffi });
  assert.strictEqual(p.isDown(0x4d), true);   // held
  assert.strictEqual(p.isDown(0x1b), false);  // only "pressed since last call" bit
  assert.strictEqual(p.isDown(0x41), false);
  assert.strictEqual(p.isDown(0x42), true);   // held + toggled
});
test('returns null when koffi is not installed (watcher falls back to continuous scanning)', () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const p = createKeyStateProvider({ platform: 'win32', loader: () => { throw new Error("Cannot find module 'koffi'"); } });
    assert.strictEqual(p, null);
  } finally { console.warn = warn; }
});
test('returns null on non-Windows platforms without even loading koffi', () => {
  let loaded = false;
  assert.strictEqual(createKeyStateProvider({ platform: 'linux', loader: () => { loaded = true; } }), null);
  assert.strictEqual(loaded, false);
});

console.log(`\n${passed} tests passed`);
