/**
 * finderPlacement.js  (pure logic)
 *
 * Decides where the Seed Finder window goes:
 *   one monitor            -> a normal window (as before)
 *   two or more monitors   -> a borderless window covering the second monitor, so the game keeps the primary
 *                             one (the overlay lives there) and the finder is a big second screen.
 * "Second monitor" = the largest display that is not the primary one.
 */
'use strict';

/** @param {Array<{id:number,bounds:{x,y,width,height}}>} displays  @param {number} primaryId */
function chooseFinderPlacement(displays, primaryId) {
  const others = (displays || []).filter(
    d => d && d.id !== primaryId && d.bounds && d.bounds.width > 0 && d.bounds.height > 0
  );
  if (others.length === 0) return { mode: 'normal' };
  const area = d => d.bounds.width * d.bounds.height;
  const best = others.reduce((a, b) => (area(b) > area(a) ? b : a)); // ties: the first one wins
  const { x, y, width, height } = best.bounds;
  return { mode: 'borderless', displayId: best.id, bounds: { x, y, width, height } };
}

function samePlacement(a, b) {
  if (!a || !b || a.mode !== b.mode) return false;
  if (a.mode === 'normal') return true;
  const p = a.bounds, q = b.bounds;
  return a.displayId === b.displayId && p.x === q.x && p.y === q.y && p.width === q.width && p.height === q.height;
}

module.exports = { chooseFinderPlacement, samePlacement };
