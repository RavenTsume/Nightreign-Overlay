/**
 * seedMatch.js  (pure logic)
 *
 * Given what the scanner saw on each slot, find the seed whose layout fits best.
 * All 320 known layouts are unique and any two seeds on the same map differ in at least
 * 11 of 27 slots, so a few misreads don't change the winner.
 *
 * Scoring per slot:  exact match = 1 point,  same icon family but a different variant
 * (ruins vs ruins_fire) = PARTIAL points,  anything else = 0.
 */
'use strict';

const PARTIAL = 0.35;
const norm = label => (!label || label === 'empty' ? 'empty' : label);
const familyOf = label => String(label).split('_')[0];

/**
 * @param {Object<string,{label:string}>} detected  slot id -> reading
 * @param {Array} seeds                               seed_data.json entries
 * @param {{minExact?:number, minMargin?:number}} [opts]
 */
function matchSeeds(detected, seeds, opts = {}) {
  const { minExact = 14, minMargin = 3 } = opts;
  const ids = Object.keys(detected || {});
  const ranked = [];
  for (const seed of seeds) {
    let score = 0, exact = 0;
    for (const id of ids) {
      const d = norm(detected[id]?.label);
      const s = norm(seed.slots?.[id]);
      if (d === s) { score += 1; exact += 1; }
      else if (d !== 'empty' && s !== 'empty' && familyOf(d) === familyOf(s)) score += PARTIAL;
    }
    ranked.push({ seed, score, exact });
  }
  ranked.sort((a, b) => b.score - a.score || b.exact - a.exact);
  const best = ranked[0] || null;
  const second = ranked[1] || null;
  const margin = best && second ? best.score - second.score : best ? best.score : 0;
  const ok = !!best && best.exact >= minExact && margin >= minMargin;
  return {
    ok,
    seedId: best ? best.seed.seed_id : null,
    mapType: best ? best.seed.map_type : null,
    nightlord: best ? best.seed.nightlord : null,
    exact: best ? best.exact : 0,
    score: best ? Math.round(best.score * 100) / 100 : 0,
    margin: Math.round(margin * 100) / 100,
    compared: ids.length,
    top: ranked.slice(0, 3).map(r => ({
      seedId: r.seed.seed_id, mapType: r.seed.map_type, nightlord: r.seed.nightlord,
      exact: r.exact, score: Math.round(r.score * 100) / 100,
    })),
  };
}

module.exports = { matchSeeds, PARTIAL };
