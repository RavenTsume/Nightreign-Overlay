/**
 * routePlanner.js  (pure logic; Node and browser)
 *
 * Suggests boss routes for Day 1 and Day 2 that collect enough runes to reach the target level (default 15).
 *
 * What is real data and what is an assumption:
 *   REAL      boss positions, spawn point and night-boss arenas come from the seed; rune values from
 *             nightreign_rune_drops.json; level costs; the day timings (14 min, circle closing from 4:30).
 *   ASSUMED   travel speed, fight times, circle sizes and where Day 2 starts. They are in DEFAULTS, shown in the
 *             app and adjustable. Treat the suggested times as estimates.
 *
 * Method: a beam search per day finds good (time, runes, risk) routes under the day's time and circle limits; the best
 * Day-1 routes are combined with the best Day-2 routes over the bosses that are left; three plans are picked:
 * fastest, lowest risk, most runes.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    const ns = (root.Seedfinder = root.Seedfinder || {});
    ns.routing = api;
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // ---- levels -------------------------------------------------------------------------------------------------
  const LEVEL_COST = { 2: 3698, 3: 7922, 4: 12348, 5: 16978, 6: 21818, 7: 26869, 8: 32137, 9: 37624, 10: 43335, 11: 49271, 12: 55439, 13: 61840, 14: 68479, 15: 75358 };
  const LEVEL_CUM = { 1: 0 };
  for (let l = 2, sum = 0; l <= 15; l++) LEVEL_CUM[l] = sum += LEVEL_COST[l];

  /** Highest level (1..15) that `runes` total runes pay for. */
  function levelForRunes(runes) {
    let level = 1;
    for (let l = 2; l <= 15; l++) if (runes >= LEVEL_CUM[l]) level = l;
    return level;
  }

  // ---- assumptions (all adjustable) ---------------------------------------------------------------------------
  const DEFAULTS = {
    targetLevel: 15,
    day1TargetLevel: 10, // preferred: be this level after the Day 1 night boss (plans that manage it are ranked first)
    tolerance: 20000, // normal enemies on the way are expected to cover about this many runes
    runeMultiplier: 1, // 1.5 when playing solo (the source says solo gets +50% runes)
    // day timing (minutes) - from published measurements
    dayMinutes: 14,
    safetyMinutes: 0.4, // be at the arena this much before the circle has closed
    free1: 4.5, close1: 3.0, free2: 3.5, close2: 3.0,
    // movement (ASSUMED)
    travelMinutesPerUnit: 2.2, // minutes to cross the whole map in a straight line
    detour: 1.2, // real paths are longer than straight lines
    startDelay: 0.4,
    stopOverhead: 0.4, // getting in, looting, getting out
    // fights (ASSUMED): bigger rune value = longer / harder fight
    fightBaseMinutes: 0.5,
    fightMinutesPerThousand: 0.06,
    fightSpeed: 0.6, // 1 = relaxed, 0.6 = a coordinated team (default), 0.4 = fast; lower = you kill faster
    // night circle (ASSUMED): radius in map units around the night boss arena
    circle: { r0: 1.0, r1: 0.42, r2: 0.1, margin: 0.03 },
    day2Start: 'spawn', // or 'night1'
    invasion: { day1: false, day2: false, runes: 12000, minutes: 3.5 }, // night invaders come to you
    // search
    beamWidth: 300, // search effort: within ~2% of a 10x slower exhaustive search
    perMode: 10,
    day1Candidates: 14,
    day2PerCandidate: 5,
    maxNodes: 48,
  };

  const merge = (base, over) => {
    const out = { ...base, ...(over || {}) };
    out.circle = { ...base.circle, ...((over && over.circle) || {}) };
    out.invasion = { ...base.invasion, ...((over && over.invasion) || {}) };
    return out;
  };

  // ---- names and rune values ----------------------------------------------------------------------------------
  const norm = s => String(s || '').toLowerCase().replace(/\band\b/g, '&').replace(/^the\s+/, '').replace(/\s+/g, ' ').trim();

  // The seed data and the rune table spell some names differently.
  const ALIASES = {
    field: { 'red wolf': 'red wolf of the king consort' },
    evergaol: { 'crucible knight with spear': 'crucible knight', 'crucible knight with sword': 'crucible knight', 'godskin duo': 'godskin noble & apostle' },
    fort: { 'abductor virgin': 'abducator virgin' },
    night1: { 'tibia mariner': 'tibia mariner & those who live in death' },
    night2: { 'godskin duo': 'godskin noble & apostle', 'dragonkin soldier': 'nox dragonkin soldier', 'fallingstar beast': 'full-grown fallingstar beast' },
    any: { 'ice dragon': 'mountaintop ice dragon' },
  };
  // If a boss has no value in its own context, borrow the same boss from these (flagged as an estimate).
  const FALLBACK = {
    field: ['crater', 'mountaintop', 'rotted_woods', 'castle', 'evergaol', 'night1', 'night2'],
    evergaol: ['field', 'castle'],
    castle: [], encampment: [], fort: [], ruins: [], great_church: [], night1: [], night2: [],
  };

  function buildRuneIndex(runeJson) {
    const byCtx = {};
    for (const e of (runeJson && runeJson.entries) || []) {
      (byCtx[e.context] = byCtx[e.context] || new Map()).set(norm(e.boss), e.runes);
    }
    const median = {};
    for (const [ctx, map] of Object.entries(byCtx)) {
      const vals = [...map.values()].filter(v => typeof v === 'number').sort((a, b) => a - b);
      median[ctx] = vals.length ? vals[Math.floor((vals.length - 1) / 2)] : null;
    }
    return { byCtx, median };
  }

  /** @returns {{runes:number|null, estimated:boolean, via:string}} */
  function lookupRunes(index, ctx, rawName) {
    let n = norm(rawName);
    n = (ALIASES[ctx] && ALIASES[ctx][n]) || ALIASES.any[n] || n;
    const own = index.byCtx[ctx] && index.byCtx[ctx].get(n);
    if (typeof own === 'number') return { runes: own, estimated: false, via: ctx };
    for (const other of FALLBACK[ctx] || []) {
      const v = index.byCtx[other] && index.byCtx[other].get(n);
      if (typeof v === 'number') return { runes: v, estimated: true, via: other };
    }
    return { runes: index.median[ctx] ?? null, estimated: true, via: 'median' };
  }

  // ---- geometry and time --------------------------------------------------------------------------------------
  const distUV = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const travelMinutes = (a, b, s) => distUV(a, b) * s.travelMinutesPerUnit * s.detour;
  const fightMinutes = (baseRunes, s) => Math.max(0.4, (s.fightBaseMinutes + (s.fightMinutesPerThousand * baseRunes) / 1000) * s.fightSpeed);
  /** How risky a fight is: grows with the boss's rune value. */
  const riskWeight = r => (r <= 10000 ? 0.5 : r <= 20000 ? 1 : r <= 35000 ? 1.6 : r <= 50000 ? 2.4 : 3.5);

  /** Radius (map units) of the closing circle at minute t of a day. */
  function circleRadius(t, s) {
    const a = s.free1, b = a + s.close1, c = b + s.free2, d = c + s.close2;
    const { r0, r1, r2 } = s.circle;
    if (t <= a) return Infinity; // before the first circle starts to close
    if (t < b) return r0 + (r1 - r0) * ((t - a) / s.close1);
    if (t <= c) return r1;
    if (t < d) return r1 + (r2 - r1) * ((t - c) / s.close2);
    return r2;
  }

  // ---- building the problem from a seed -----------------------------------------------------------------------
  const SOURCES = [
    ['field_bosses', 'field', e => e.boss],
    ['castle', 'castle', e => e.boss],
    ['evergaols', 'evergaol', e => e.boss],
    ['ruins', 'ruins', e => e.value],
    ['camps', 'encampment', e => e.value],
    ['forts', 'fort', e => e.value],
    ['great_churches', 'great_church', e => e.value],
  ];
  const stripPrefix = n => String(n).replace(/^(Ruins|Camp|Fort|Great Church) - /, '');

  /**
   * @param seed       a seed entry from patterns_by_nightlord (spawn_points, night1, night2, field_bosses, ...)
   * @param poiPos     id -> [u, v] (map units 0..1)
   * @param runeIndex  from buildRuneIndex()
   */
  function buildProblem(seed, poiPos, runeIndex, options) {
    const s = merge(DEFAULTS, options);
    const nodes = [];
    const unknown = [];
    for (const [cat, ctx, nameOf] of SOURCES) {
      for (const e of seed[cat] || []) {
        const raw = nameOf(e);
        if (!raw || raw === 'empty') continue;
        const pos = poiPos(e.poi_id);
        if (!pos) continue;
        const name = stripPrefix(raw);
        const v = lookupRunes(runeIndex, ctx, name);
        if (typeof v.runes !== 'number') continue;
        if (v.estimated) unknown.push(`${name} (${ctx})`);
        nodes.push({
          id: `${ctx}:${e.poi_id}`, poiId: e.poi_id, type: ctx, name, pos,
          baseRunes: v.runes, runes: Math.round(v.runes * s.runeMultiplier), estimated: v.estimated,
          fight: fightMinutes(v.runes, s), risk: riskWeight(v.runes),
        });
      }
    }
    nodes.sort((a, b) => b.baseRunes - a.baseRunes);
    const kept = nodes.slice(0, s.maxNodes);

    const spawn = (seed.spawn_points || [])[0];
    const spawnPos = spawn && poiPos(spawn.poi_id);
    const nights = {};
    for (const d of [1, 2]) {
      const n = seed[`night${d}`];
      const pos = n && poiPos(n.poi_id);
      if (!pos) continue;
      const v = lookupRunes(runeIndex, `night${d}`, n.boss);
      nights[d] = { name: n.boss, location: n.circle_location, pos, baseRunes: v.runes || 0, runes: Math.round((v.runes || 0) * s.runeMultiplier), estimated: v.estimated };
      if (v.estimated) unknown.push(`${n.boss} (night ${d})`);
    }
    return { nodes: kept, spawn: spawnPos ? { pos: spawnPos, location: seed.spawn_points[0].location } : null, nights, unknown, settings: s };
  }

  // ---- beam search for one day --------------------------------------------------------------------------------
  // How a search values a minute (in runes) and risk. The high time weights find the short routes that reach a
  // modest rune total quickly, which a pure "most runes" search never produces.
  const MODE_WEIGHTS = {
    yield: { time: 300, risk: 0 },
    speed: { time: 4000, risk: 0 },
    safe: { time: 4000, risk: 1500 },
    quick: { time: 12000, risk: 0 },
    sprint: { time: 40000, risk: 0 },
  };
  const bit = (mask, i) => (i < 26 ? (mask.lo >>> i) & 1 : (mask.hi >>> (i - 26)) & 1);
  const withBit = (mask, i) => (i < 26 ? { lo: mask.lo | (1 << i), hi: mask.hi } : { lo: mask.lo, hi: mask.hi | (1 << (i - 26)) });
  const maskKey = m => m.hi * 67108864 + m.lo;

  function searchDay(problem, day, startPos, blocked, mode) {
    const s = problem.settings;
    const arena = problem.nights[day];
    const nodes = problem.nodes;
    const n = nodes.length;
    const inv = s.invasion[`day${day}`] ? s.invasion.minutes : 0;
    const limit = s.dayMinutes - s.safetyMinutes - inv;
    const w = MODE_WEIGHTS[mode];
    const arenaPos = arena ? arena.pos : startPos;

    const fromStart = nodes.map(x => travelMinutes(startPos, x.pos, s));
    const toArena = nodes.map(x => travelMinutes(x.pos, arenaPos, s));
    const between = nodes.map(a => nodes.map(b => travelMinutes(a.pos, b.pos, s)));
    const inside = nodes.map(x => (t, extra) => distUV(x.pos, arenaPos) <= circleRadius(t, s) - s.circle.margin - (extra || 0));
    const score = st => st.runes - w.time * st.t - w.risk * st.risk;

    const root = { mask: { lo: 0, hi: 0 }, last: -1, t: s.startDelay, runes: 0, risk: 0, prev: null, node: -1, depth: 0 };
    root.score = score(root);
    const pool = [root];
    let layer = [root];

    while (layer.length) {
      const next = new Map();
      for (const st of layer) {
        for (let j = 0; j < n; j++) {
          if (blocked[j] || bit(st.mask, j)) continue;
          const arrive = st.t + (st.last < 0 ? fromStart[j] : between[st.last][j]);
          const finish = arrive + s.stopOverhead + nodes[j].fight;
          if (finish + toArena[j] > limit) continue; // cannot be at the arena in time
          if (!inside[j](finish)) continue; // would be outside the closing circle
          const ns = { mask: withBit(st.mask, j), last: j, t: finish, runes: st.runes + nodes[j].runes, risk: st.risk + nodes[j].risk * nodes[j].fight, prev: st, node: j, arrive, depth: st.depth + 1 };
          ns.score = score(ns);
          const key = maskKey(ns.mask) * 64 + j;
          const old = next.get(key);
          if (!old || ns.score > old.score) next.set(key, ns);
        }
      }
      layer = [...next.values()].sort((a, b) => b.score - a.score).slice(0, s.beamWidth);
      pool.push(...layer);
    }
    // the best distinct routes of this mode (by set of bosses)
    pool.sort((a, b) => b.score - a.score);
    const seen = new Set();
    const best = [];
    for (const st of pool) {
      const k = maskKey(st.mask);
      if (seen.has(k)) continue;
      seen.add(k);
      best.push(st);
      if (best.length >= s.perMode) break;
    }
    return best.map(st => finishDay(problem, day, startPos, st, arenaPos, inv, limit));
  }

  function finishDay(problem, day, startPos, st, arenaPos, inv, limit) {
    const s = problem.settings;
    const chain = [];
    for (let c = st; c && c.node >= 0; c = c.prev) chain.push(c);
    chain.reverse();
    const stops = chain.map(c => {
      const node = problem.nodes[c.node];
      return { ...node, arrive: round(c.arrive), leave: round(c.t) };
    });
    const lastPos = stops.length ? stops[stops.length - 1].pos : startPos;
    const arenaArrive = (stops.length ? chain[chain.length - 1].t : s.startDelay) + travelMinutes(lastPos, arenaPos, s);
    const arena = problem.nights[day];
    const invasion = s.invasion[`day${day}`] ? { runes: Math.round(s.invasion.runes * s.runeMultiplier), minutes: s.invasion.minutes } : null;
    const stopRunes = stops.reduce((a, x) => a + x.runes, 0);
    return {
      day, stops, startPos, arenaPos, invasion,
      minutes: round(arenaArrive + (invasion ? invasion.minutes : 0)), slack: round(limit - arenaArrive), // limit already excludes the safety margin and the invasion fight
      stopRunes, runes: stopRunes + (invasion ? invasion.runes : 0), nightBoss: arena ? { name: arena.name, runes: arena.runes, estimated: arena.estimated, location: arena.location } : null,
      risk: round(st.risk), ids: stops.map(x => x.id),
    };
  }
  const round = v => Math.round(v * 100) / 100;
  const AREA_RADIUS = 0.18; // "that area" when looking for a different route (map units)

  // ---- combining the days --------------------------------------------------------------------------------------
  const jaccard = (a, b) => {
    const A = new Set(a), B = new Set(b);
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    const uni = A.size + B.size - inter;
    return uni ? inter / uni : 1;
  };

  function evaluate(problem, d1, d2) {
    const s = problem.settings;
    const n1 = d1.nightBoss ? d1.nightBoss.runes : 0, n2 = d2.nightBoss ? d2.nightBoss.runes : 0;
    const afterDay1 = d1.runes + n1;
    const total = afterDay1 + d2.runes + n2;
    return {
      days: [d1, d2], totalRunes: total, runesAfterDay1: afterDay1,
      levelAfterDay1: levelForRunes(afterDay1), levelAfterDay2: levelForRunes(total),
      minutes: round(d1.minutes + d2.minutes), risk: round(d1.risk + d2.risk), ids: [...d1.ids, ...d2.ids],
      needed: LEVEL_CUM[s.targetLevel] - s.tolerance, targetRunes: LEVEL_CUM[s.targetLevel],
      meetsDay1: afterDay1 >= LEVEL_CUM[s.day1TargetLevel] - s.tolerance ? 1 : 0,
    };
  }

  // The planner is a generator that yields between search steps, so the app can run it without freezing the window
  // (planRoutesAsync) while tests and scripts simply run it to the end (planRoutes). Same algorithm, same result.
  function* planCore(problem) {
    const s = problem.settings;
    const t0 = Date.now();
    const result = { plans: [], feasible: false, settings: s, unknown: problem.unknown, nodes: problem.nodes.length, ms: 0, notes: [] };
    if (!problem.spawn || !problem.nights[1] || !problem.nights[2]) {
      result.notes.push('This seed has no spawn point or night boss positions, so no route can be planned.');
      return result;
    }
    const n = problem.nodes.length;
    const noBlock = new Array(n).fill(false);
    const start1 = problem.spawn.pos;
    const start2 = s.day2Start === 'night1' ? problem.nights[1].pos : problem.spawn.pos;

    // Day-1 candidates. First the plain search in all three modes, then "what if we skip that area": each of the best
    // route's three richest bosses (and the bosses around it) is excluded in turn, which forces genuinely different
    // routes into the pool instead of small variations of one plan.
    const day1 = [];
    const seen = new Set();
    const gather = (blocked, group) => {
      for (const mode of Object.keys(MODE_WEIGHTS)) {
        for (const d of searchDay(problem, 1, start1, blocked, mode)) {
          const k = d.ids.slice().sort().join('|');
          if (!seen.has(k)) { seen.add(k); day1.push(Object.assign(d, { group })); }
        }
      }
    };
    gather(noBlock, 0);
    yield;
    const lead = day1.slice().sort((a, b) => b.runes / Math.max(1, b.minutes) - a.runes / Math.max(1, a.minutes))[0];
    const byId = new Map(problem.nodes.map((x, i) => [x.id, i]));
    const anchors = lead ? lead.stops.slice().sort((a, b) => b.runes - a.runes).slice(0, 3) : [];
    anchors.forEach((anchor, g) => {
      const blocked = noBlock.slice();
      problem.nodes.forEach((x, i) => { if (distUV(x.pos, anchor.pos) <= AREA_RADIUS) blocked[i] = true; });
      blocked[byId.get(anchor.id)] = true;
      gather(blocked, g + 1);
    });
    yield;
    // keep a spread: per group the richest and the most time-efficient routes
    const pick = new Map();
    const perGroup = Math.max(2, Math.ceil(s.day1Candidates / 4));
    for (let g = 0; g <= anchors.length; g++) {
      const group = day1.filter(d => d.group === g);
      for (const d of group.slice().sort((a, b) => b.runes - a.runes).slice(0, perGroup)) pick.set(d.ids.join('|'), d);
      for (const d of group.slice().sort((a, b) => b.runes / Math.max(1, b.minutes) - a.runes / Math.max(1, a.minutes)).slice(0, perGroup)) pick.set(d.ids.join('|'), d);
    }
    const index = byId;

    const plans = [];
    for (const d1 of pick.values()) {
      yield;
      const blocked = noBlock.slice();
      d1.ids.forEach(id => { blocked[index.get(id)] = true; });
      const seen2 = new Set();
      for (const mode of Object.keys(MODE_WEIGHTS)) {
        for (const d2 of searchDay(problem, 2, start2, blocked, mode).slice(0, s.day2PerCandidate)) {
          const k = d2.ids.slice().sort().join('|');
          if (seen2.has(k)) continue;
          seen2.add(k);
          plans.push(evaluate(problem, d1, d2));
        }
      }
    }

    const needed = LEVEL_CUM[s.targetLevel] - s.tolerance;
    const feasible = plans.filter(p => p.totalRunes >= needed);
    result.feasible = feasible.length > 0;
    result.bestPossibleRunes = plans.reduce((m, p) => Math.max(m, p.totalRunes), 0);

    // Meaningful trade-offs, measured against the best plan. If the target level is reachable, "good" = plans that reach it.
    // If not, "good" = plans that still collect at least 90% of the best total, so "quickest" and "lowest risk" are real
    // alternatives (finish earlier / avoid dangerous bosses) and not the same richest plan again.
    const floor = result.feasible ? needed : 0.9 * result.bestPossibleRunes;
    const good = plans.filter(p => p.totalRunes >= floor);
    const criteria = {
      fastest: {
        kind: 'fastest',
        label: result.feasible ? `Fastest to level ${s.targetLevel}` : 'Quickest (time to spare)',
        altLabel: 'Fast alternative',
        pool: good,
        better: (a, b) => b.meetsDay1 - a.meetsDay1 || a.minutes - b.minutes || b.totalRunes - a.totalRunes,
      },
      yield: { kind: 'yield', label: 'Most runes', altLabel: 'Rich alternative', pool: plans, better: (a, b) => b.totalRunes - a.totalRunes || a.minutes - b.minutes },
      safe: {
        kind: 'safe',
        label: 'Lowest risk',
        altLabel: 'Safer alternative',
        pool: good,
        better: (a, b) => b.meetsDay1 - a.meetsDay1 || a.risk - b.risk || a.minutes - b.minutes,
      },
    };
    // The headline plan is processed first (it keeps its label even if it also wins another measure).
    const order = result.feasible ? ['fastest', 'yield', 'safe'] : ['yield', 'fastest', 'safe'];
    // A label is only given to the plan that really is the best by that criterion. If that plan is already in the list,
    // the labels are merged; if it is merely similar to one, the next clearly different plan is shown as an "alternative".
    const chosen = [];
    for (const c of order.map(k => criteria[k])) {
      const ranked = c.pool.slice().sort(c.better);
      if (!ranked.length) continue;
      const top = ranked[0];
      const same = chosen.find(q => jaccard(top.ids, q.ids) === 1);
      if (same) {
        same.kinds.push(c.kind);
        same.label += ` · ${c.label}`;
        continue;
      }
      let pick = top, isBest = true;
      if (chosen.some(q => jaccard(top.ids, q.ids) >= 0.7)) {
        pick = ranked.find(p => chosen.every(q => jaccard(p.ids, q.ids) < 0.7));
        isBest = false;
      }
      if (!pick) continue;
      Object.assign(pick, { kind: c.kind, kinds: [c.kind], label: isBest ? c.label : c.altLabel, isBest });
      chosen.push(pick);
    }
    for (const p of chosen) {
      p.shortfall = Math.max(0, p.targetRunes - p.totalRunes); // normal enemies have to supply this
      p.withinTolerance = p.shortfall <= s.tolerance;
      p.reachesTarget = p.totalRunes >= p.needed;
    }
    result.plans = chosen;
    result.ms = Date.now() - t0;
    if (!result.feasible) result.notes.push(`Level ${s.targetLevel} is not reachable from bosses alone on this seed with the current assumptions (best: ${result.bestPossibleRunes.toLocaleString('en-US')} of ${LEVEL_CUM[s.targetLevel].toLocaleString('en-US')} runes). The plans below are the most efficient ones.`);
    return result;
  }

  function planRoutes(problem) {
    const run = planCore(problem);
    let step = run.next();
    while (!step.done) step = run.next();
    return step.value;
  }

  /** Same as planRoutes, but gives the event loop a turn between search steps. */
  async function planRoutesAsync(problem, tick) {
    const wait = tick || (() => new Promise(resolve => setTimeout(resolve, 0)));
    const run = planCore(problem);
    let step = run.next();
    while (!step.done) {
      await wait();
      step = run.next();
    }
    return step.value;
  }

  return {
    DEFAULTS, LEVEL_COST, LEVEL_CUM, levelForRunes, merge, norm, buildRuneIndex, lookupRunes,
    buildProblem, planRoutes, planRoutesAsync, searchDay, circleRadius, travelMinutes, fightMinutes, riskWeight, distUV, jaccard,
  };
});
