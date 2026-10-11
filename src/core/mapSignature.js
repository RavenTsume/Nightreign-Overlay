/**
 * mapSignature.js  (pure logic, no Electron / DOM dependencies)
 *
 * Decides "is the in-game map open?" from a screenshot.
 *
 * Idea: crop the area where the game draws the map panel (the same rectangle the
 * overlay uses to place labels), shrink it to a small luminance grid, and compare
 * that grid with grids the user recorded while the map was open (calibration).
 * Pearson correlation makes the comparison independent of brightness/contrast.
 */
(function (rootFactory) {
  const root =
    typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this;
  if (typeof module === 'object' && module.exports) {
    module.exports = rootFactory();
  } else {
    const Seedfinder = (root.Seedfinder = root.Seedfinder || {});
    Seedfinder.core = Seedfinder.core || {};
    Seedfinder.core.mapSignature = rootFactory();
  }
})(function () {
  // Keep in sync with public/overlay/overlay-canvas.js (refPanel + getSurfaceRect).
  const REF_PANEL = { x: 0.567871, y: 0.150174, width: 0.387695, height: 0.676215 };
  const GRID_W = 16;
  const GRID_H = 20;

  function frame16x9(W, H) {
    const TARGET = 16 / 9;
    if (W / H >= TARGET) {
      const width = Math.round(H * TARGET);
      return { x: Math.round((W - width) / 2), y: 0, width, height: H };
    }
    const height = Math.round(W / TARGET);
    return { x: 0, y: Math.round((H - height) / 2), width: W, height };
  }

  function surfaceRect(W, H) {
    return Math.abs(W / H - 16 / 9) < 0.02 ? { x: 0, y: 0, width: W, height: H } : frame16x9(W, H);
  }

  function panelRect(W, H) {
    const s = surfaceRect(W, H);
    return {
      x: Math.round(s.x + REF_PANEL.x * s.width),
      y: Math.round(s.y + REF_PANEL.y * s.height),
      width: Math.round(REF_PANEL.width * s.width),
      height: Math.round(REF_PANEL.height * s.height),
    };
  }

  /**
   * @param {Uint8Array|Buffer} bgra  raw pixels, 4 bytes per pixel, order B,G,R,A
   * @param {number} width
   * @param {number} height
   * @param {{x,y,width,height}} [rect] region in pixels (default: the map panel)
   * @returns {Float32Array} gridW*gridH mean luminance values (0..255)
   */
  function computeSignature(bgra, width, height, rect, gridW = GRID_W, gridH = GRID_H) {
    if (!bgra || bgra.length < width * height * 4) {
      throw new Error('computeSignature: pixel buffer is smaller than width*height*4');
    }
    const r = rect || panelRect(width, height);
    const sig = new Float32Array(gridW * gridH);
    for (let gy = 0; gy < gridH; gy++) {
      const y0 = Math.max(0, r.y + Math.floor((gy * r.height) / gridH));
      const y1 = Math.min(height, r.y + Math.floor(((gy + 1) * r.height) / gridH));
      for (let gx = 0; gx < gridW; gx++) {
        const x0 = Math.max(0, r.x + Math.floor((gx * r.width) / gridW));
        const x1 = Math.min(width, r.x + Math.floor(((gx + 1) * r.width) / gridW));
        let sum = 0;
        let n = 0;
        for (let y = y0; y < y1; y++) {
          let i = (y * width + x0) * 4;
          for (let x = x0; x < x1; x++, i += 4) {
            sum += 0.114 * bgra[i] + 0.587 * bgra[i + 1] + 0.299 * bgra[i + 2];
            n++;
          }
        }
        sig[gy * gridW + gx] = n ? sum / n : 0;
      }
    }
    return sig;
  }

  function stats(a) {
    let mean = 0;
    for (let i = 0; i < a.length; i++) mean += a[i];
    mean /= a.length || 1;
    let varSum = 0;
    for (let i = 0; i < a.length; i++) varSum += (a[i] - mean) * (a[i] - mean);
    return { mean, std: Math.sqrt(varSum / (a.length || 1)) };
  }

  /** Pearson correlation in [-1, 1]; 0 when either grid is flat (e.g. black screen). */
  function correlation(a, b) {
    if (!a || !b || a.length !== b.length || a.length === 0) return 0;
    const sa = stats(a);
    const sb = stats(b);
    if (sa.std < 1e-6 || sb.std < 1e-6) return 0;
    let acc = 0;
    for (let i = 0; i < a.length; i++) acc += (a[i] - sa.mean) * (b[i] - sb.mean);
    return acc / (a.length * sa.std * sb.std);
  }

  /** Best similarity of `sig` against all reference grids. */
  function bestScore(sig, refs) {
    let score = -1;
    let index = -1;
    (refs || []).forEach((ref, i) => {
      const c = correlation(sig, ref);
      if (c > score) {
        score = c;
        index = i;
      }
    });
    return { score: index === -1 ? null : score, index };
  }

  /** A frame is usable as a reference only if it has real picture content. */
  function hasContent(sig, minStd = 4) {
    return stats(sig).std >= minStd;
  }

  /**
   * Hysteresis + debounce, so one noisy frame can't flip the overlay.
   * Opening needs `openFrames` frames >= openThreshold in a row;
   * closing needs `closeFrames` frames < closeThreshold in a row.
   * (closeThreshold < openThreshold so the overlay's own presence can't cause flicker.)
   */
  function createDetector(opts = {}) {
    const cfg = { openThreshold: 0.85, closeThreshold: 0.7, openFrames: 2, closeFrames: 3, ...opts };
    let open = false;
    let streak = 0;
    return {
      get isOpen() {
        return open;
      },
      configure(patch) {
        Object.assign(cfg, patch);
      },
      reset() {
        open = false;
        streak = 0;
      },
      /** @returns {'open'|'close'|null} */
      update(score) {
        if (typeof score !== 'number' || Number.isNaN(score)) return null;
        if (!open) {
          streak = score >= cfg.openThreshold ? streak + 1 : 0;
          if (streak >= cfg.openFrames) {
            open = true;
            streak = 0;
            return 'open';
          }
        } else {
          streak = score < cfg.closeThreshold ? streak + 1 : 0;
          if (streak >= cfg.closeFrames) {
            open = false;
            streak = 0;
            return 'close';
          }
        }
        return null;
      },
    };
  }

  return {
    REF_PANEL,
    GRID_W,
    GRID_H,
    surfaceRect,
    panelRect,
    computeSignature,
    correlation,
    bestScore,
    hasContent,
    createDetector,
  };
});
