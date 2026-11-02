/**
 * png.js  (pure Node)
 *
 * Minimal PNG writer: BGRA pixels in, 8-bit RGB PNG out. It exists so the scan's debug screenshots can be
 * encoded inside the worker thread; Electron's nativeImage.toPNG() would block the main thread (and with it
 * the mouse) for ~100 ms per image.
 */
'use strict';
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** @param {{width:number,height:number,data:Uint8Array}} frame BGRA, 4 bytes per pixel */
function encodePng({ width, height, data }) {
  if (!data || data.length < width * height * 4) throw new Error('encodePng: pixel buffer smaller than width*height*4');
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    let o = y * stride; // filter type 0 (none) for every row
    raw[o++] = 0;
    let i = y * width * 4;
    for (let x = 0; x < width; x++, i += 4) {
      raw[o++] = data[i + 2]; raw[o++] = data[i + 1]; raw[o++] = data[i];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { encodePng, crc32 };
