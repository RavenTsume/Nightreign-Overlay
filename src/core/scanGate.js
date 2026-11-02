/**
 * scanGate.js  (pure logic)
 *
 * Decides WHEN the map watcher is allowed to take screenshots.
 *
 *  - A watched key (e.g. M, Esc) going from "up" to "down" opens a short scanning
 *    burst (`burstMs`), long enough for the map to open or close.
 *  - While the map is open, scanning stays allowed so we notice when it closes.
 *  - Otherwise (normal gameplay) no screenshots are taken at all.
 */
function createScanGate({ burstMs = 2500 } = {}) {
  let prevDown = new Set();
  let burstUntil = -Infinity;
  let duration = burstMs;

  return {
    configure({ burstMs: next }) {
      if (Number.isFinite(next) && next > 0) duration = next;
    },
    /**
     * Feed the set of watched keys that are currently held down.
     * @returns {boolean} true if a key was newly pressed (a burst was started)
     */
    sample(now, down) {
      let pressed = false;
      for (const key of down) {
        if (!prevDown.has(key)) pressed = true;
      }
      prevDown = new Set(down);
      if (pressed) burstUntil = now + duration;
      return pressed;
    },
    /** Which watched keys went from up to down since the last call (does NOT start a burst). */
    edges(now, down) {
      const pressed = [];
      for (const key of down) if (!prevDown.has(key)) pressed.push(key);
      prevDown = new Set(down);
      return pressed;
    },
    /** Start a scanning burst of `ms` milliseconds (default: the configured length). */
    start(now, ms) {
      burstUntil = now + (Number.isFinite(ms) && ms > 0 ? ms : duration);
    },
    allows(now, mapOpen) {
      return Boolean(mapOpen) || now < burstUntil;
    },
    reset() {
      prevDown = new Set();
      burstUntil = -Infinity;
    },
  };
}

module.exports = { createScanGate };
