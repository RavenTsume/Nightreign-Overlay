// Run with:  node tests/png.test.js   (also part of `npm test`)
const assert = require('assert');
const zlib = require('zlib');
const { encodePng, crc32 } = require('../src/core/png');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  -', name); };

/** tiny PNG reader for what encodePng writes: checks signature + every chunk CRC, returns RGB pixels */
function decode(png) {
  assert.deepStrictEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'signature');
  let o = 8, ihdr = null; const idat = [], types = [];
  while (o < png.length) {
    const len = png.readUInt32BE(o), type = png.toString('ascii', o + 4, o + 8), body = png.subarray(o + 8, o + 8 + len);
    assert.strictEqual(png.readUInt32BE(o + 8 + len), crc32(png.subarray(o + 4, o + 8 + len)), `CRC of ${type}`);
    types.push(type);
    if (type === 'IHDR') ihdr = { w: body.readUInt32BE(0), h: body.readUInt32BE(4), depth: body[8], colour: body[9] };
    if (type === 'IDAT') idat.push(body);
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = ihdr.w * 3 + 1, rgb = Buffer.alloc(ihdr.w * ihdr.h * 3);
  for (let y = 0; y < ihdr.h; y++) { assert.strictEqual(raw[y * stride], 0, 'filter byte'); raw.copy(rgb, y * ihdr.w * 3, y * stride + 1, (y + 1) * stride); }
  return { ihdr, rgb, types };
}

test('known CRC-32 value', () => assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926));
test('round trip: size, colour type, chunk order and every pixel (BGRA -> RGB)', () => {
  const w = 7, h = 5, data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = i * 3 % 256; data[i * 4 + 1] = i * 5 % 256; data[i * 4 + 2] = i * 7 % 256; data[i * 4 + 3] = 255; }
  const d = decode(encodePng({ width: w, height: h, data }));
  assert.deepStrictEqual(d.ihdr, { w, h, depth: 8, colour: 2 });
  assert.deepStrictEqual(d.types, ['IHDR', 'IDAT', 'IEND']);
  for (let i = 0; i < w * h; i++) assert.deepStrictEqual([d.rgb[i * 3], d.rgb[i * 3 + 1], d.rgb[i * 3 + 2]], [data[i * 4 + 2], data[i * 4 + 1], data[i * 4]]);
});
test('a realistic 993x974 panel encodes quickly and is much smaller than the raw pixels', () => {
  const w = 993, h = 974, data = Buffer.alloc(w * h * 4, 90);
  const t0 = Date.now(); const png = encodePng({ width: w, height: h, data });
  assert.ok(png.length < data.length / 10); assert.ok(Date.now() - t0 < 1500);
});
test('rejects a buffer that is too small', () => assert.throws(() => encodePng({ width: 10, height: 10, data: Buffer.alloc(8) }), /buffer/i));
console.log(`\n${passed} tests passed`);
