/**
 * overlayPolicy.js  (pure logic)
 *
 * When may the overlay window show or hide ITSELF? The user can switch the automatic POI overlay off in the
 * overlay options; then nothing here shows it (hotkeys still toggle it by hand).
 * Every function answers 'show', 'hide' or 'leave' (do nothing).
 */
'use strict';

/** Re-apply the right state (start-up, display change, option toggled). */
function autoOverlayAction({ enabled, active, open }) {
  if (!enabled) return 'hide'; // automatic overlay switched off: hidden until shown by hand
  if (!active) return 'leave'; // nothing learned yet: keep the original behaviour
  return open ? 'show' : 'hide';
}

/** The map watcher saw the map open or close. */
function watcherEventAction(event, { enabled, active }) {
  if (!enabled || !active) return 'leave';
  return event === 'open' ? 'show' : 'hide';
}

/** A scan just finished. */
function scanResultAction({ enabled, ok }) {
  return ok && enabled ? 'show' : 'leave';
}

module.exports = { autoOverlayAction, watcherEventAction, scanResultAction };
