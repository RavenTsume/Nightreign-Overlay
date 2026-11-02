// Builds a synthetic map-panel screenshot in pure Node from the scan templates (no Python, no image files).
// Background = the map's 128px luminance art (smooth, grey); icons = the real icon templates, alpha-composited.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '../..');
const templatesJson = JSON.parse(fs.readFileSync(path.join(root, 'public/assets/data/scan_templates.json'), 'utf-8'));
const slots = JSON.parse(fs.readFileSync(path.join(root, 'public/assets/data/coordsXY.json'), 'utf-8'));
const b64 = s => Uint8Array.from(Buffer.from(s, 'base64'));

function bilerp(src, w, h, u, v) {
  const x = Math.min(w - 1.001, Math.max(0, u * w - 0.5)), y = Math.min(h - 1.001, Math.max(0, v * h - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const p = y0 * w + x0;
  return (src[p] * (1 - fx) + src[p + 1] * fx) * (1 - fy) + (src[p + w] * (1 - fx) + src[p + w + 1] * fx) * fy;
}

/** placements: {slotId: iconName}; s/tx/ty: how the "game" frames the map; iconScale vs the finder's 1/14 */
function composePanel({ map = 'Default', size = 512, s = 1, tx = 0, ty = 0, iconScale = 1, placements = {}, gain = 1 }) {
  const lum = b64(templatesJson.maps[map].lum), m = templatesJson.maps[map].w;
  const rgb = new Float32Array(size * size * 3);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const mu = 0.5 + ((i + 0.5) / size - 0.5 - tx) / s, mv = 0.5 + ((j + 0.5) / size - 0.5 - ty) / s;
    const v = mu < 0 || mu > 1 || mv < 0 || mv > 1 ? 18 : bilerp(lum, m, m, mu, mv);
    rgb.fill(v / 255, (j * size + i) * 3, (j * size + i) * 3 + 3);
  }
  const T = Math.round(size * s * iconScale / 14);
  for (const [slotId, name] of Object.entries(placements)) {
    const sl = slots.find(x => x.id === slotId), ic = templatesJson.icons[name], px = b64(ic.rgba);
    const cx = (0.5 + s * (sl.x / 1000 - 0.5) + tx) * size, cy = (0.5 + s * (sl.y / 1000 - 0.5) + ty) * size;
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const sx = Math.min(ic.w - 1, Math.floor((x + 0.5) * ic.w / T)), sy = Math.min(ic.h - 1, Math.floor((y + 0.5) * ic.h / T));
      const o = (sy * ic.w + sx) * 4, a = px[o + 3] / 255;
      const X = Math.round(cx - T / 2 + x), Y = Math.round(cy - T / 2 + y);
      if (X < 0 || Y < 0 || X >= size || Y >= size) continue;
      const d = (Y * size + X) * 3;
      for (let c = 0; c < 3; c++) rgb[d + c] = a * (px[o + c] / 255) + (1 - a) * rgb[d + c];
    }
  }
  const data = Buffer.alloc(size * size * 4);
  for (let k = 0; k < size * size; k++) {
    data[k * 4] = Math.min(255, rgb[k * 3 + 2] * 255 * gain); data[k * 4 + 1] = Math.min(255, rgb[k * 3 + 1] * 255 * gain);
    data[k * 4 + 2] = Math.min(255, rgb[k * 3] * 255 * gain); data[k * 4 + 3] = 255;
  }
  return { width: size, height: size, data };
}
module.exports = { composePanel, templatesJson, slots };
