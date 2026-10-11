// Synthetic frame builders shared by the tests (no real game imagery involved).
const S = require('../../src/core/mapSignature');

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function blank(W, H, v = 20) {
  const b = new Uint8Array(W * H * 4);
  for (let i = 0; i < b.length; i += 4) { b[i] = b[i + 1] = b[i + 2] = v; b[i + 3] = 255; }
  return b;
}
function smoothField(seed) {
  const r = rng(seed);
  const waves = Array.from({ length: 6 }, () => ({
    fx: 1 + r() * 5, fy: 1 + r() * 5, px: r() * 6.28, py: r() * 6.28, a: 20 + r() * 40,
  }));
  return (u, v) => 128 + waves.reduce((s, w) => s + w.a * Math.sin(w.fx * 6.28 * u + w.px) * Math.cos(w.fy * 6.28 * v + w.py), 0);
}
function paint(buf, W, H, rect, field, gain = 1, bias = 0) {
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
    const v = Math.max(0, Math.min(255, field((x - rect.x) / rect.width, (y - rect.y) / rect.height) * gain + bias));
    const i = (y * W + x) * 4; buf[i] = v * 0.9; buf[i + 1] = v; buf[i + 2] = v * 1.05;
  }
}
function dots(buf, W, rect, seed, n = 27) {         // fake POI icons (size scales with the panel, like real icons)
  const r = rng(seed), rad = Math.max(2, Math.round(rect.width * 0.012));
  for (let k = 0; k < n; k++) {
    const cx = rect.x + rad + Math.floor(r() * (rect.width - 2 * rad)), cy = rect.y + rad + Math.floor(r() * (rect.height - 2 * rad));
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      const i = ((cy + dy) * W + (cx + dx)) * 4;
      buf[i] = buf[i + 1] = buf[i + 2] = 240;
    }
  }
}
function labelBoxes(buf, W, rect, seed, n = 30) {   // overlay labels: dark translucent boxes (scaled to panel)
  const r = rng(seed), bw = Math.round(rect.width * 0.12), bh = Math.round(rect.height * 0.022);
  for (let k = 0; k < n; k++) {
    const x0 = rect.x + Math.floor(r() * (rect.width - bw)), y0 = rect.y + Math.floor(r() * (rect.height - bh));
    for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) {
      const i = (y * W + x) * 4; buf[i] *= 0.5; buf[i + 1] *= 0.5; buf[i + 2] *= 0.5;
    }
  }
}
function mapFrame(W, H, { terrain = 1, poiSeed = 1, gain = 1, bias = 0, labels = false } = {}) {
  const b = blank(W, H), rect = S.panelRect(W, H);
  paint(b, W, H, rect, smoothField(1000 + terrain), gain, bias);
  dots(b, W, rect, poiSeed);
  if (labels) labelBoxes(b, W, rect, poiSeed + 77);
  return { b, W, H };
}
function gameplayFrame(W, H, seed) {
  const b = blank(W, H, 60);
  paint(b, W, H, { x: 0, y: 0, width: W, height: H }, smoothField(seed * 31 + 7));
  return { b, W, H };
}


module.exports = { rng, blank, smoothField, paint, dots, labelBoxes, mapFrame, gameplayFrame };
