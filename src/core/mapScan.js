/**
 * mapScan.js  (pure logic, Node only: no Electron / DOM)
 *
 * Reads a screenshot of the in-game map and works out which icon sits on each of the
 * 27 slots. Steps:
 *
 *  1. toWork()     shrink the cropped map panel to a 512x512 working image
 *  2. align()      find which map type it is and how it is shifted/scaled by comparing the
 *                  terrain with the known map art (normalised cross-correlation)
 *  3. classify()   for each slot, template-match all icon types (alpha-weighted NCC) in a
 *                  small search window; element badges (ruins_fire ...) get a second look
 *  4. fuse()       combine two screenshots into one result per slot
 *
 * Everything here works on plain typed arrays so it can run inside a worker thread.
 */
'use strict';

const WORK = 512;
const ICON_FRACTION = 1 / 14; // the finder draws slot icons at 1/14 of the 1000px map

const DEFAULTS = {
  minMapScore: 0.45, // terrain correlation needed to say "the map is open"
  minIconScore: 0.55, // below this a slot counts as empty
  scaleFactors: [0.7, 0.85, 1.0, 1.2, 1.4], // icon size relative to the finder's size
  searchRadius: 6, // +- px (at 512) around the expected slot position
  minSpawn: 0.2, // blue-glow evidence needed to call a slot the spawn point
  blueDelta: 0.15, // how much bluer than its surroundings a spawn ring must be
  spawnMaxOtherScore: 0.62, // a slot already matching another building this well is not the spawn
};

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
const b64ToBytes = s => Uint8Array.from(Buffer.from(s, 'base64'));
const familyOf = label => String(label).split('_')[0];

function loadTemplates(json) {
  const icons = {};
  for (const [name, t] of Object.entries(json.icons)) {
    const px = b64ToBytes(t.rgba);
    const n = t.w * t.h;
    const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), a = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      r[i] = px[i * 4] / 255; g[i] = px[i * 4 + 1] / 255; b[i] = px[i * 4 + 2] / 255; a[i] = px[i * 4 + 3] / 255;
    }
    icons[name] = { name, w: t.w, h: t.h, r, g, b, a, family: familyOf(name) };
  }
  const maps = {};
  for (const [name, t] of Object.entries(json.maps)) {
    const px = b64ToBytes(t.lum);
    const lum = new Float32Array(px.length);
    for (let i = 0; i < px.length; i++) lum[i] = px[i] / 255;
    maps[name] = { name, size: t.w, lum };
  }
  return { icons, maps, cache: new Map() };
}

/** Box-average a single plane from (sw x sh) to (dw x dh). */
function resizePlane(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw));
      let s = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { s += src[yy * sw + xx]; n++; }
      out[y * dw + x] = s / n;
    }
  }
  return out;
}

/** 3x3 box blur (edges clamped). */
function blur3(src, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - 1), yb = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - 1), xb = Math.min(w - 1, x + 1);
      let sum = 0, n = 0;
      for (let yy = ya; yy <= yb; yy++) for (let xx = xa; xx <= xb; xx++) { sum += src[yy * w + xx]; n++; }
      out[y * w + x] = sum / n;
    }
  }
  return out;
}

/** BGRA frame -> {n, r, g, b, lum} float planes (0..1) at n x n. */
function toWork(frame, n = WORK) {
  const { width: W, height: H, data } = frame;
  if (!data || data.length < W * H * 4) throw new Error('toWork: pixel buffer smaller than width*height*4');
  const r = new Float32Array(n * n), g = new Float32Array(n * n), b = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    const y0 = Math.floor((y * H) / n), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * H) / n));
    for (let x = 0; x < n; x++) {
      const x0 = Math.floor((x * W) / n), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * W) / n));
      let sr = 0, sg = 0, sb = 0, cnt = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * W + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) { sb += data[i]; sg += data[i + 1]; sr += data[i + 2]; cnt++; }
      }
      const k = 1 / (255 * cnt);
      r[y * n + x] = sr * k; g[y * n + x] = sg * k; b[y * n + x] = sb * k;
    }
  }
  const lum = new Float32Array(n * n), cb = new Float32Array(n * n);
  for (let i = 0; i < lum.length; i++) {
    lum[i] = 0.299 * r[i] + 0.587 * g[i] + 0.114 * b[i];
    cb[i] = b[i] - 0.5 * (r[i] + g[i]); // "blueness": the spawn glow is blue, terrain is not
  }
  return { n, r, g, b, lum, cb, lumB: blur3(lum, n, n) };
}

// ---------------------------------------------------------------------------
// alignment: which map, and how is it shifted / scaled on screen?
// panel_uv = 0.5 + s * (map_uv - 0.5) + t
// ---------------------------------------------------------------------------
function nccTransform(L, n, R, m, s, tx, ty) {
  let cnt = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  const inv = 1 / s;
  for (let j = 0; j < n; j++) {
    const mv = 0.5 + ((j + 0.5) / n - 0.5 - ty) * inv;
    if (mv < 0 || mv >= 1) continue;
    const fy = mv * m - 0.5, y0 = Math.max(0, Math.min(m - 2, Math.floor(fy))), wy = Math.min(1, Math.max(0, fy - y0));
    for (let i = 0; i < n; i++) {
      const mu = 0.5 + ((i + 0.5) / n - 0.5 - tx) * inv;
      if (mu < 0 || mu >= 1) continue;
      const fx = mu * m - 0.5, x0 = Math.max(0, Math.min(m - 2, Math.floor(fx))), wx = Math.min(1, Math.max(0, fx - x0));
      const p = y0 * m + x0;
      const v = (R[p] * (1 - wx) + R[p + 1] * wx) * (1 - wy) + (R[p + m] * (1 - wx) + R[p + m + 1] * wx) * wy;
      const a = L[j * n + i];
      cnt++; sx += a; sy += v; sxx += a * a; syy += v * v; sxy += a * v;
    }
  }
  if (cnt < 0.5 * n * n) return -1;
  const vx = sxx - (sx * sx) / cnt, vy = syy - (sy * sy) / cnt;
  if (vx < 1e-9 || vy < 1e-9) return 0;
  return (sxy - (sx * sy) / cnt) / Math.sqrt(vx * vy);
}

function align(work, templates) {
  const L64 = resizePlane(work.lum, work.n, work.n, 64, 64);
  const L128 = resizePlane(work.lum, work.n, work.n, 128, 128);
  const scores = {};
  const best = {};
  for (const map of Object.values(templates.maps)) {
    const R64 = resizePlane(map.lum, map.size, map.size, 64, 64);
    let top = { score: -2, s: 1, tx: 0, ty: 0 };
    for (const s of [0.92, 0.96, 1.0, 1.04, 1.08]) {
      for (let dy = -5; dy <= 5; dy++) {
        for (let dx = -5; dx <= 5; dx++) {
          const sc = nccTransform(L64, 64, R64, 64, s, dx / 64, dy / 64);
          if (sc > top.score) top = { score: sc, s, tx: dx / 64, ty: dy / 64 };
        }
      }
    }
    best[map.name] = top;
    scores[map.name] = top.score;
  }
  const ranked = Object.keys(scores).sort((a, b) => scores[b] - scores[a]);
  const name = ranked[0];
  // refine the winner at 128px with a small pattern search
  const map = templates.maps[name];
  const R128 = resizePlane(map.lum, map.size, map.size, 128, 128);
  let cur = { ...best[name] };
  cur.score = nccTransform(L128, 128, R128, 128, cur.s, cur.tx, cur.ty);
  for (const [ds, dt] of [[0.01, 0.006], [0.004, 0.0025], [0.002, 0.001]]) {
    for (let iter = 0; iter < 20; iter++) {
      let moved = false;
      for (const [a, b, c] of [[ds, 0, 0], [-ds, 0, 0], [0, dt, 0], [0, -dt, 0], [0, 0, dt], [0, 0, -dt]]) {
        const cand = { s: cur.s + a, tx: cur.tx + b, ty: cur.ty + c };
        const sc = nccTransform(L128, 128, R128, 128, cand.s, cand.tx, cand.ty);
        if (sc > cur.score + 1e-6) { cur = { ...cand, score: sc }; moved = true; }
      }
      if (!moved) break;
    }
  }
  return {
    map: name, score: cur.score, s: cur.s, tx: cur.tx, ty: cur.ty,
    second: ranked[1], secondScore: scores[ranked[1]], scores,
  };
}

// ---------------------------------------------------------------------------
// templates scaled to an icon size, prepared for weighted NCC
// ---------------------------------------------------------------------------
function scaledTemplate(templates, name, T) {
  const key = name + '@' + T;
  const hit = templates.cache.get(key);
  if (hit) return hit;
  const ic = templates.icons[name];
  // alpha-weighted box resize so transparent pixels don't bleed into the colours
  const r = new Float32Array(T * T), g = new Float32Array(T * T), b = new Float32Array(T * T), a = new Float32Array(T * T);
  for (let y = 0; y < T; y++) {
    const y0 = Math.floor((y * ic.h) / T), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * ic.h) / T));
    for (let x = 0; x < T; x++) {
      const x0 = Math.floor((x * ic.w) / T), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * ic.w) / T));
      let sa = 0, sr = 0, sg = 0, sb = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = yy * ic.w + xx, al = ic.a[i];
        sa += al; sr += al * ic.r[i]; sg += al * ic.g[i]; sb += al * ic.b[i]; n++;
      }
      const o = y * T + x;
      a[o] = sa / n;
      if (sa > 1e-6) { r[o] = sr / sa; g[o] = sg / sa; b[o] = sb / sa; }
    }
  }
  const t = { name, T, r, g, b, a, family: ic.family };
  const wp = templates.weightPow ?? 1, minA = templates.minAlpha ?? 0.15;
  const wts = new Float32Array(T * T);
  for (let i = 0; i < wts.length; i++) wts[i] = a[i] >= minA ? Math.pow(a[i], wp) : 0;
  t.full = prep(t, wts, 1e-6);
  templates.cache.set(key, t);
  return t;
}

/** Build the sparse weighted representation used by the NCC scorers. */
function prep(t, weights, minW) {
  const T = t.T;
  const idx = [];
  for (let i = 0; i < T * T; i++) if (weights[i] >= minW) idx.push(i);
  const n = idx.length;
  const dx = new Int32Array(n), dy = new Int32Array(n), w = new Float32Array(n);
  let Sw = 0, mr = 0, mg = 0, mb = 0;
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    dx[k] = i % T; dy[k] = (i / T) | 0; w[k] = weights[i];
    Sw += w[k]; mr += w[k] * t.r[i]; mg += w[k] * t.g[i]; mb += w[k] * t.b[i];
  }
  if (Sw < 1e-6) return { n: 0, Sw: 0 };
  mr /= Sw; mg /= Sw; mb /= Sw;
  const wr = new Float32Array(n), wg = new Float32Array(n), wb = new Float32Array(n), wl = new Float32Array(n);
  const tr = new Float32Array(n), tg = new Float32Array(n), tb = new Float32Array(n);
  let vr = 0, vg = 0, vb = 0, vl = 0;
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    tr[k] = t.r[i]; tg[k] = t.g[i]; tb[k] = t.b[i];
    const cr = t.r[i] - mr, cg = t.g[i] - mg, cb = t.b[i] - mb;
    const cl = 0.299 * cr + 0.587 * cg + 0.114 * cb;
    wr[k] = w[k] * cr; wg[k] = w[k] * cg; wb[k] = w[k] * cb; wl[k] = w[k] * cl;
    vr += w[k] * cr * cr; vg += w[k] * cg * cg; vb += w[k] * cb * cb; vl += w[k] * cl * cl;
  }
  return { n, Sw, dx, dy, w, wr, wg, wb, wl, tr, tg, tb, varRGB: vr + vg + vb, varL: vl };
}

// patch scorers: (plane(s), top-left x/y) -> NCC in [-1,1]
function scoreLum(P, N, px, py, p) {
  if (p.n < 8) return -1;
  let sx = 0, sxx = 0, sxt = 0;
  for (let k = 0; k < p.n; k++) {
    const x = P[(py + p.dy[k]) * N + px + p.dx[k]];
    const wx = p.w[k] * x;
    sx += wx; sxx += wx * x; sxt += p.wl[k] * x;
  }
  const vx = sxx - (sx * sx) / p.Sw;
  return vx < 1e-9 || p.varL < 1e-9 ? 0 : sxt / Math.sqrt(vx * p.varL);
}

function scoreRGB(W, px, py, p) {
  if (p.n < 8) return -1;
  const N = W.n;
  let sxr = 0, sxg = 0, sxb = 0, sxxr = 0, sxxg = 0, sxxb = 0, num = 0;
  for (let k = 0; k < p.n; k++) {
    const o = (py + p.dy[k]) * N + px + p.dx[k];
    const r = W.r[o], g = W.g[o], b = W.b[o], w = p.w[k];
    sxr += w * r; sxg += w * g; sxb += w * b;
    sxxr += w * r * r; sxxg += w * g * g; sxxb += w * b * b;
    num += p.wr[k] * r + p.wg[k] * g + p.wb[k] * b;
  }
  const vx = sxxr + sxxg + sxxb - (sxr * sxr + sxg * sxg + sxb * sxb) / p.Sw;
  return vx < 1e-9 || p.varRGB < 1e-9 ? 0 : num / Math.sqrt(vx * p.varRGB);
}

/** Root-mean-square colour error between the screen and a template over its weighted pixels. */
function rmseRGB(W, px, py, p) {
  if (!p || p.n < 8) return 1;
  const N = W.n;
  let se = 0, sw = 0;
  for (let k = 0; k < p.n; k++) {
    const o = (py + p.dy[k]) * N + px + p.dx[k];
    const dr = W.r[o] - p.tr[k], dg = W.g[o] - p.tg[k], db = W.b[o] - p.tb[k];
    se += p.w[k] * (dr * dr + dg * dg + db * db) / 3;
    sw += p.w[k];
  }
  return Math.sqrt(se / sw);
}

/** Mean of plane P over the template's pixels minus its mean over the ring of pixels just outside the box. */
function regionDelta(P, N, px, py, T, p) {
  if (!p || p.n < 8) return 0;
  let inner = 0, sw = 0;
  for (let k = 0; k < p.n; k++) { inner += p.w[k] * P[(py + p.dy[k]) * N + px + p.dx[k]]; sw += p.w[k]; }
  inner /= sw;
  const m = Math.max(4, Math.round(0.4 * T));
  let outer = 0, cnt = 0;
  for (let y = Math.max(0, py - m); y < Math.min(N, py + T + m); y += 2) {
    for (let x = Math.max(0, px - m); x < Math.min(N, px + T + m); x += 2) {
      if (x >= px && x < px + T && y >= py && y < py + T) continue;
      outer += P[y * N + x]; cnt++;
    }
  }
  return cnt ? inner - outer / cnt : 0;
}

/** Blurred luminance template for the coarse search (tolerates a 1px miss). */
function coarsePrep(templates, name, T) {
  const key = 'coarse:' + name + '@' + T;
  let hit = templates.cache.get(key);
  if (hit) return hit;
  const t = scaledTemplate(templates, name, T);
  const pl = new Float32Array(T * T), pa = new Float32Array(T * T);
  for (let i = 0; i < T * T; i++) { pa[i] = t.a[i]; pl[i] = t.a[i] * (0.299 * t.r[i] + 0.587 * t.g[i] + 0.114 * t.b[i]); }
  const bl = blur3(pl, T, T), ba = blur3(pa, T, T), lb = new Float32Array(T * T);
  for (let i = 0; i < T * T; i++) lb[i] = ba[i] > 1e-6 ? bl[i] / ba[i] : 0;
  hit = prepChan(t, ba, 0.1, lb);
  templates.cache.set(key, hit);
  return hit;
}

// ---------------------------------------------------------------------------
// extra evidence beyond the plain whole-icon match
// ---------------------------------------------------------------------------
const chromaOf = t => {
  const c = new Float32Array(t.T * t.T);
  for (let i = 0; i < c.length; i++) c[i] = t.b[i] - 0.5 * (t.r[i] + t.g[i]);
  return c;
};

/** Single-channel weighted representation (used on the "blueness" plane). */
function prepChan(t, weights, minW, chan) {
  const T = t.T, idx = [];
  for (let i = 0; i < T * T; i++) if (weights[i] >= minW) idx.push(i);
  const n = idx.length;
  const dx = new Int32Array(n), dy = new Int32Array(n), w = new Float32Array(n), wl = new Float32Array(n);
  let Sw = 0, m = 0;
  for (let k = 0; k < n; k++) { const i = idx[k]; dx[k] = i % T; dy[k] = (i / T) | 0; w[k] = weights[i]; Sw += w[k]; m += w[k] * chan[i]; }
  if (Sw < 1e-6) return { n: 0, Sw: 0 };
  m /= Sw;
  let v = 0;
  for (let k = 0; k < n; k++) { const c = chan[idx[k]] - m; wl[k] = w[k] * c; v += w[k] * c * c; }
  return { n, Sw, dx, dy, w, wl, varL: v };
}

/** Pixels a variant adds on top of its base icon (an element badge, a glow). */
function extraRegion(templates, name, T) {
  const v = scaledTemplate(templates, name, T);
  const base = scaledTemplate(templates, v.family, T);
  const wts = new Float32Array(T * T);
  for (let i = 0; i < T * T; i++) {
    const added = v.a[i] - base.a[i];
    const dc = Math.abs(v.r[i] - base.r[i]) + Math.abs(v.g[i] - base.g[i]) + Math.abs(v.b[i] - base.b[i]);
    if (added >= 0.25) wts[i] = added;
    else if (v.a[i] >= 0.5 && base.a[i] >= 0.5 && dc > 0.35) wts[i] = v.a[i];
  }
  return { v, wts };
}

/** Non-base variants of a family (ruins_fire ...). church_spawn is not one: its glow is judged by colour. */
const variantsOf = (templates, family) =>
  Object.keys(templates.icons).filter(n => templates.icons[n].family === family && n !== family && n !== 'church_spawn');

/**
 * The variants of a family share one layout (body + a badge square) and differ only in the badge, so
 * they are told apart on the pixels where they differ from EACH OTHER. (The plain base icon is
 * positioned differently; the whole-icon match already separates base from variants.)
 */
function variantPrep(templates, name, T) {
  const family = templates.icons[name].family;
  const maskKey = 'vmask:' + family + '@' + T;
  let mask = templates.cache.get(maskKey);
  if (!mask) {
    const ts = variantsOf(templates, family).map(n => scaledTemplate(templates, n, T));
    mask = new Float32Array(T * T);
    for (let i = 0; i < T * T; i++) {
      if (!ts.every(t => t.a[i] >= 0.5)) continue;
      let maxD = 0;
      for (let x = 0; x < ts.length; x++) for (let y = x + 1; y < ts.length; y++) {
        const d = Math.abs(ts[x].r[i] - ts[y].r[i]) + Math.abs(ts[x].g[i] - ts[y].g[i]) + Math.abs(ts[x].b[i] - ts[y].b[i]);
        if (d > maxD) maxD = d;
      }
      if (maxD > 0.6) mask[i] = 1;
    }
    templates.cache.set(maskKey, mask);
  }
  const key = 'vprep:' + name + '@' + T;
  let hit = templates.cache.get(key);
  if (hit !== undefined) return hit;
  const p = prep(scaledTemplate(templates, name, T), mask, 0.5);
  hit = p.n >= 10 ? p : null;
  templates.cache.set(key, hit);
  return hit;
}

function ringPrep(templates, T) { // the blue spawn ring, on the blueness plane
  const key = 'ring@' + T;
  let hit = templates.cache.get(key);
  if (hit) return hit;
  const t = scaledTemplate(templates, 'spawn', T);
  hit = prepChan(t, t.a, 0.1, chromaOf(t));
  templates.cache.set(key, hit);
  return hit;
}

function glowPrep(templates, T) { // the blue glow church_spawn adds around a church
  const key = 'glow@' + T;
  let hit = templates.cache.get(key);
  if (hit) return hit;
  const { v, wts } = extraRegion(templates, 'church_spawn', T);
  hit = prepChan(v, wts, 0.2, chromaOf(v));
  templates.cache.set(key, hit);
  return hit;
}

// ---------------------------------------------------------------------------
// per-slot classification
// ---------------------------------------------------------------------------
function classifySlot(work, centre, nominalT, templates, opts) {
  const N = work.n, R = opts.searchRadius;
  const names = Object.keys(templates.icons).filter(n => n !== 'spawn'); // the ring is handled separately
  const sizes = [...new Set(opts.scaleFactors.map(k => Math.max(12, Math.round(nominalT * k))))];
  const half = Math.ceil(Math.max(...sizes) / 2) + R + 3;
  const none = extra => ({ label: 'empty', score: 0, family: 'empty', alts: [], blue: 0, ...extra });
  if (centre.x - half < 0 || centre.y - half < 0 || centre.x + half >= N || centre.y + half >= N) return none({ skipped: true });

  // Stage A: luminance only, coarse offsets, all templates and sizes
  const cands = [];
  for (const name of names) {
    for (const T of sizes) {
      const cp = coarsePrep(templates, name, T);
      const cx = centre.x - (T >> 1), cy = centre.y - (T >> 1);
      let bestC = null;
      for (let oy = -R; oy <= R; oy += 2) for (let ox = -R; ox <= R; ox += 2) {
        const sc = scoreLum(work.lumB, N, cx + ox, cy + oy, cp);
        if (!bestC || sc > bestC.score) bestC = { name, T, ox, oy, score: sc };
      }
      if (bestC) cands.push(bestC);
    }
  }
  cands.sort((a, b) => b.score - a.score);

  // Stage B: the best few, refined in colour with neighbouring sizes and offsets
  // every icon family gets its best two coarse candidates refined (near-identical variants such as the
  // ten ruins icons must not crowd out a church or a fort)
  const finalists = [];
  const perFamily = new Map();
  for (const c of cands) {
    const f = templates.icons[c.name].family;
    const n = perFamily.get(f) || 0;
    if (n >= 2) continue;
    perFamily.set(f, n + 1);
    finalists.push(c);
  }
  const bestByName = new Map();
  for (const c of finalists) {
    for (const dT of [-2, 0, 2]) {
      const T = Math.max(12, c.T + dT);
      const t = scaledTemplate(templates, c.name, T);
      const cx = centre.x - (T >> 1), cy = centre.y - (T >> 1);
      for (let oy = c.oy - 2; oy <= c.oy + 2; oy++) for (let ox = c.ox - 2; ox <= c.ox + 2; ox++) {
        const sc = scoreRGB(work, cx + ox, cy + oy, t.full);
        const cur = bestByName.get(c.name);
        if (!cur || sc > cur.score) bestByName.set(c.name, { name: c.name, T, x: cx + ox, y: cy + oy, score: sc });
      }
    }
  }
  const ranked = [...bestByName.values()].sort((a, b) => b.score - a.score);
  if (!ranked.length) return none({});
  const top = ranked[0];
  const family = templates.icons[top.name].family;
  const alts = ranked.slice(0, 3).map(c => ({ label: c.name, score: round(c.score) }));
  const geom = { T: top.T, x: top.x, y: top.y };

  // blue evidence for the spawn decision made later (ring on open ground, glow on a church)
  const blueAt = (prepared, T, x0, y0, rad) => {
    let bestN = -1, bx = x0, by = y0;
    for (let oy = -rad; oy <= rad; oy++) for (let ox = -rad; ox <= rad; ox++) {
      const nc = scoreLum(work.cb, N, x0 + ox, y0 + oy, prepared);
      if (nc > bestN) { bestN = nc; bx = x0 + ox; by = y0 + oy; }
    }
    if (bestN <= 0) return 0;
    const delta = regionDelta(work.cb, N, bx, by, T, prepared);
    return bestN * Math.min(1, Math.max(0, delta) / opts.blueDelta); // right shape AND clearly bluer
  };
  let blue = 0;
  for (const T of sizes) blue = Math.max(blue, blueAt(ringPrep(templates, T), T, centre.x - (T >> 1), centre.y - (T >> 1), R));
  if (family === 'church' && templates.icons.church_spawn) blue = Math.max(blue, blueAt(glowPrep(templates, top.T), top.T, top.x, top.y, 2));

  if (top.score < opts.minIconScore) return { label: 'empty', score: round(top.score), family: 'empty', alts, geom, blue: round(blue) };

  // Base vs variant was decided by the whole-icon match. If it is a badge variant, pick WHICH one by comparing
  // colours on the badge square (searching a little in size and position, since a corner badge is sensitive).
  let label = top.name === 'church_spawn' ? 'church' : top.name; // church_spawn is decided later, from the blue glow
  let badge = null;
  const candidates = variantsOf(templates, family);
  if (candidates.includes(top.name) && candidates.length >= 2) {
    const ccx = top.x + (top.T >> 1), ccy = top.y + (top.T >> 1);
    for (const v of candidates) {
      let e = 9;
      for (const dT of [-2, 0, 2]) {
        const T = Math.max(12, top.T + dT);
        const bp = variantPrep(templates, v, T);
        if (!bp) continue;
        for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
          e = Math.min(e, rmseRGB(work, ccx - (T >> 1) + ox, ccy - (T >> 1) + oy, bp));
        }
      }
      if (!badge || e < badge.rmse) badge = { name: v, rmse: e };
    }
    if (badge && badge.rmse < 9) label = badge.name;
  }
  return { label, score: round(top.score), family, alts, geom, blue: round(blue), badge: badge ? { name: badge.name, rmse: round(badge.rmse) } : null };
}
const round = v => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------
/** Quick check, used while waiting for the player to open the map. */
function checkMapOpen(frame, templates, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const a = align(toWork(frame), templates);
  return { open: a.score >= opts.minMapScore, score: round(a.score), map: a.map, align: a };
}

/** Classify every slot of ONE screenshot. */
function classifyFrame(frame, templates, slots, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const work = toWork(frame);
  const a = align(work, templates);
  const result = { align: a, open: a.score >= opts.minMapScore, slots: {} };
  if (!result.open) return result;
  const N = work.n;
  const nominalT = Math.max(12, Math.round(N * a.s * ICON_FRACTION));
  for (const slot of slots) {
    if (slot.id === 'nightlord') continue;
    const u = 0.5 + a.s * (slot.x / 1000 - 0.5) + a.tx;
    const v = 0.5 + a.s * (slot.y / 1000 - 0.5) + a.ty;
    result.slots[slot.id] = classifySlot(work, { x: Math.round(u * N), y: Math.round(v * N) }, nominalT, templates, opts);
  }
  return result;
}

/**
 * Combine the readings of several screenshots, then apply the one structural rule we know:
 * every seed has exactly ONE spawn marker, so the slot with the strongest blue glow gets it.
 */
function fuse(results, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const ids = new Set();
  results.forEach(r => Object.keys(r.slots || {}).forEach(id => ids.add(id)));
  const slots = {};
  for (const id of ids) {
    const readings = results.map(r => r.slots?.[id]).filter(Boolean);
    if (!readings.length) continue;
    const best = readings.reduce((a, b) => (b.score > a.score ? b : a));
    const blue = readings.reduce((sum, r) => sum + (r.blue || 0), 0) / readings.length;
    slots[id] = {
      label: best.label, score: round(best.score), family: best.family, blue: round(blue),
      agree: readings.every(r => r.label === readings[0].label), alts: best.alts,
    };
  }
  let spawnId = null, spawnBlue = opts.minSpawn;
  for (const [id, r] of Object.entries(slots)) {
    const eligible = r.family === 'church' || r.family === 'empty' || r.score < opts.spawnMaxOtherScore;
    if (eligible && r.blue >= spawnBlue) { spawnId = id; spawnBlue = r.blue; }
  }
  if (spawnId) {
    const r = slots[spawnId];
    r.label = r.family === 'church' ? 'church_spawn' : 'spawn';
    r.spawn = true;
  }
  return slots;
}

module.exports = {
  WORK, DEFAULTS, loadTemplates, toWork, align, classifyFrame, checkMapOpen, fuse, familyOf,
  // exposed for tests
  _internals: { resizePlane, nccTransform, scaledTemplate, variantPrep, ringPrep, glowPrep, scoreRGB, scoreLum, rmseRGB },
};
