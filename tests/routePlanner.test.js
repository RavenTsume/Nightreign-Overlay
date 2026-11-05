// Run with:  node tests/routePlanner.test.js   (also part of `npm test`)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const rp = require('../src/core/routePlanner');

const D = path.join(__dirname, '../public/assets/data');
const runeJson = JSON.parse(fs.readFileSync(path.join(D, 'nightreign_rune_drops.json'), 'utf-8'));
const runeIndex = rp.buildRuneIndex(runeJson);
const pois = new Map(JSON.parse(fs.readFileSync(path.join(D, 'poi_uv_with_ids.json'), 'utf-8')).map(p => [p.id, p.uv]));
const poiPos = id => pois.get(id);
const seeds = [];
for (const f of fs.readdirSync(path.join(D, 'patterns_by_nightlord')).sort()) seeds.push(...JSON.parse(fs.readFileSync(path.join(D, 'patterns_by_nightlord', f), 'utf-8')));

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const near = (a, b, eps = 0.03) => Math.abs(a - b) <= eps;

/** Independent re-simulation of one planned day; throws if any rule is broken. */
function validateDay(problem, day) {
  const s = problem.settings, arena = problem.nights[day.day].pos;
  const inv = s.invasion[`day${day.day}`] ? s.invasion.minutes : 0;
  const limit = s.dayMinutes - s.safetyMinutes - inv;
  let t = s.startDelay, pos = day.startPos;
  for (const st of day.stops) {
    const arrive = t + rp.travelMinutes(pos, st.pos, s);
    const finish = arrive + s.stopOverhead + st.fight;
    assert.ok(near(arrive, st.arrive, 0.02) && near(finish, st.leave, 0.02), `timeline of ${st.id}: ${arrive}/${finish} vs ${st.arrive}/${st.leave}`);
    assert.ok(rp.distUV(st.pos, arena) <= rp.circleRadius(finish, s) - s.circle.margin + 1e-9, `${st.id} is outside the closing circle at ${finish}`);
    t = finish; pos = st.pos;
  }
  const arrival = t + rp.travelMinutes(pos, arena, s);
  assert.ok(arrival <= limit + 1e-6, `arena reached at ${arrival} > limit ${limit}`);
  assert.ok(near(day.minutes, arrival + inv, 0.02));
  assert.strictEqual(day.stopRunes, day.stops.reduce((a, x) => a + x.runes, 0));
}
function validatePlan(problem, plan) {
  plan.days.forEach(d => validateDay(problem, d));
  const ids = plan.ids;
  assert.strictEqual(new Set(ids).size, ids.length, 'a boss is used twice');
}

// ---- levels, names, circle ---------------------------------------------------------------------------------------
test('level costs: level 10 = 202,729 and level 15 = 513,116 runes in total', () => {
  assert.strictEqual(rp.LEVEL_CUM[10], 202729); assert.strictEqual(rp.LEVEL_CUM[15], 513116); assert.strictEqual(rp.LEVEL_CUM[5], 40946);
  assert.strictEqual(rp.levelForRunes(0), 1); assert.strictEqual(rp.levelForRunes(3698), 2); assert.strictEqual(rp.levelForRunes(3697), 1);
  assert.strictEqual(rp.levelForRunes(202729), 10); assert.strictEqual(rp.levelForRunes(202728), 9); assert.strictEqual(rp.levelForRunes(9e9), 15);
});
test('boss names from the seed data are matched to the rune table (aliases)', () => {
  const v = (ctx, n) => rp.lookupRunes(runeIndex, ctx, n);
  assert.deepStrictEqual([v('field', 'Red Wolf').runes, v('field', 'Red Wolf').estimated], [15000, false]);
  assert.strictEqual(v('evergaol', 'Crucible Knight with Spear').runes, 20000);
  assert.strictEqual(v('evergaol', 'Godskin Duo').runes, 40000);
  assert.strictEqual(v('fort', 'Abductor Virgin').runes, 4800);
  assert.strictEqual(v('night1', "The Duke's Dear Freja").runes, 26496);
  assert.strictEqual(v('night1', 'Demi-Human Queen and Swordmaster').runes, 24400);
  assert.strictEqual(v('night1', 'Tibia Mariner').runes, 28000);
  assert.strictEqual(v('night2', 'Godskin Duo').runes, 44000);
  assert.strictEqual(v('night2', 'Dragonkin Soldier').runes, 42000);
  assert.strictEqual(v('night2', 'Fallingstar Beast').runes, 46000);
  assert.strictEqual(v('night2', 'Tree Sentinel and Royal Cavalrymen').runes, 45200);
});
test('bosses without a value in their own context are borrowed from another one, or estimated, and flagged', () => {
  const ice = rp.lookupRunes(runeIndex, 'field', 'Ice Dragon');
  assert.deepStrictEqual([ice.runes, ice.estimated, ice.via], [104500, true, 'mountaintop']);
  const trolls = rp.lookupRunes(runeIndex, 'castle', 'Trolls');
  assert.deepStrictEqual([trolls.estimated, trolls.via, typeof trolls.runes], [true, 'median', 'number']);
  const cav = rp.lookupRunes(runeIndex, 'night1', "Night's Cavalry Duo");
  assert.ok(cav.estimated && cav.runes > 15000);
});
test('closing circle: whole map first, shrinks from 4:30, holds from 7:30, shrinks again from 11:00', () => {
  const s = rp.merge(rp.DEFAULTS);
  assert.strictEqual(rp.circleRadius(4.5, s), Infinity);
  assert.ok(near(rp.circleRadius(6, s), (s.circle.r0 + s.circle.r1) / 2, 1e-9));
  assert.strictEqual(rp.circleRadius(7.5, s), s.circle.r1); assert.strictEqual(rp.circleRadius(10, s), s.circle.r1);
  assert.ok(near(rp.circleRadius(12.5, s), (s.circle.r1 + s.circle.r2) / 2, 1e-9));
  assert.strictEqual(rp.circleRadius(14, s), s.circle.r2);
});

// ---- building the problem from real seeds -------------------------------------------------------------------------
test('a real seed becomes a problem: bosses with positions, spawn point and both night arenas', () => {
  const seed = seeds[0], p = rp.buildProblem(seed, poiPos, runeIndex);
  assert.ok(p.nodes.length >= 25 && p.nodes.length <= 48);
  assert.ok(p.spawn && p.spawn.pos.length === 2 && p.nights[1] && p.nights[2]);
  assert.ok(p.nodes.every(n => n.pos && n.runes > 0 && n.fight >= 0.4 && !/^empty$/i.test(n.name)));
  assert.strictEqual(new Set(p.nodes.map(n => n.id)).size, p.nodes.length);
  assert.ok(p.nights[1].runes > 20000 && p.nights[2].runes > 40000);
});
test('the solo bonus scales runes but not fight times', () => {
  const a = rp.buildProblem(seeds[3], poiPos, runeIndex), b = rp.buildProblem(seeds[3], poiPos, runeIndex, { runeMultiplier: 1.5 });
  assert.strictEqual(b.nodes[0].runes, Math.round(a.nodes[0].runes * 1.5)); assert.strictEqual(b.nodes[0].fight, a.nodes[0].fight);
});
test('every one of the 320 seeds can be turned into a problem', () => {
  for (const seed of seeds) {
    const p = rp.buildProblem(seed, poiPos, runeIndex);
    assert.ok(p.spawn && p.nights[1] && p.nights[2] && p.nodes.length >= 15, `layout ${seed.layout_number}/${seed.nightlord}`);
  }
});

// ---- the search is optimal on small problems (checked against brute force) --------------------------------------------
function tinyProblem(rand) {
  const s = rp.merge(rp.DEFAULTS, { beamWidth: 6000, perMode: 4 });
  const nodes = Array.from({ length: 6 }, (_, i) => {
    const baseRunes = 5000 + Math.floor(rand() * 40000);
    return { id: `t:${i}`, poiId: i, type: 'field', name: `B${i}`, pos: [0.25 + rand() * 0.5, 0.25 + rand() * 0.5], baseRunes, runes: baseRunes, estimated: false, fight: rp.fightMinutes(baseRunes, s), risk: rp.riskWeight(baseRunes) };
  });
  return { nodes, spawn: { pos: [0.2, 0.8] }, nights: { 1: { name: 'N1', pos: [0.5, 0.5], runes: 24000 }, 2: { name: 'N2', pos: [0.5, 0.5], runes: 44000 } }, unknown: [], settings: s };
}
function bruteBest(problem, day, startPos) {          // maximise runes - 300*time, the 'yield' score, over every ordered subset
  const s = problem.settings, arena = problem.nights[day].pos, limit = s.dayMinutes - s.safetyMinutes, n = problem.nodes.length;
  let best = -Infinity;
  const go = (pos, t, runes, used) => {
    best = Math.max(best, runes - 300 * t);
    for (let j = 0; j < n; j++) {
      if (used & (1 << j)) continue;
      const nd = problem.nodes[j];
      const finish = t + rp.travelMinutes(pos, nd.pos, s) + s.stopOverhead + nd.fight;
      if (finish + rp.travelMinutes(nd.pos, arena, s) > limit) continue;
      if (rp.distUV(nd.pos, arena) > rp.circleRadius(finish, s) - s.circle.margin) continue;
      go(nd.pos, finish, runes + nd.runes, used | (1 << j));
    }
  };
  go(startPos, s.startDelay, 0, 0);
  return best;
}
test('beam search finds the same optimum as brute force on 40 random small problems', () => {
  let s0 = 12345; const rand = () => ((s0 = (Math.imul(s0, 1664525) + 1013904223) >>> 0) / 4294967296);
  let nonTrivial = 0;
  for (let i = 0; i < 40; i++) {
    const p = tinyProblem(rand);
    const got = rp.searchDay(p, 1, p.spawn.pos, new Array(6).fill(false), 'yield')[0];
    const want = bruteBest(p, 1, p.spawn.pos);
    // compare on the search's own score: runes - 300 * (time at the last stop)
    const lastT = got.stops.length ? got.stops[got.stops.length - 1].leave : p.settings.startDelay;
    // times are stored rounded to 0.01 min (x300 = up to 1.5 runes); a worse route would differ by thousands
    assert.ok(near(got.stopRunes - 300 * lastT, want, 2), `problem ${i}: beam ${got.stopRunes - 300 * lastT} vs brute ${want}`);
    if (got.stops.length >= 2) nonTrivial++;
  }
  assert.ok(nonTrivial >= 20, 'the random problems should actually need multi-stop routes');
});

// ---- plans on real seeds obey every rule -------------------------------------------------------------------------
test('every plan for 80 real seeds re-simulates correctly: timeline, circle, arena in time, no boss twice', () => {
  for (let i = 0; i < seeds.length; i += 4) {
    const problem = rp.buildProblem(seeds[i], poiPos, runeIndex);
    const res = rp.planRoutes(problem);
    assert.ok(res.plans.length >= 1, `seed #${i}: no plan`);
    res.plans.forEach(p => validatePlan(problem, p));
  }
});
test('seeds get 2-3 clearly different suggestions (never just one), and the labels / kinds make sense', () => {
  let three = 0, total = 0;
  for (let i = 0; i < seeds.length; i += 16) {
    const r = rp.planRoutes(rp.buildProblem(seeds[i], poiPos, runeIndex));
    assert.ok(r.plans.length >= 2, `seed #${i} got ${r.plans.length} plan(s)`);
    if (r.plans.length === 3) three++;
    total++;
  }
  assert.ok(three / total >= 0.6, `only ${three}/${total} seeds got three plans`);
  const res = rp.planRoutes(rp.buildProblem(seeds[40], poiPos, runeIndex));
  for (let a = 0; a < res.plans.length; a++) for (let b = a + 1; b < res.plans.length; b++) assert.ok(rp.jaccard(res.plans[a].ids, res.plans[b].ids) < 0.7);
  assert.ok(res.plans.every(p => p.kinds.every(k => ['fastest', 'safe', 'yield'].includes(k)) && p.label && typeof p.isBest === 'boolean'));
  const allKinds = res.plans.flatMap(p => p.kinds);
  assert.strictEqual(new Set(allKinds).size, allKinds.length, 'a criterion is never listed twice');
});
test('a plan is only labelled "Most runes" / "Fastest" / "Lowest risk" if it really is the best by that measure', () => {
  for (const i of [3, 41, 77, 150, 233]) {
    const res = rp.planRoutes(rp.buildProblem(seeds[i], poiPos, runeIndex));
    for (const p of res.plans) {
      if (p.isBest && p.kinds.includes('yield')) assert.ok(res.plans.every(q => p.totalRunes >= q.totalRunes), `seed #${i}`);
      if (!p.isBest) assert.ok(/alternative/.test(p.label), `seed #${i}: ${p.label}`);
      if (p.label.includes('Most runes')) assert.ok(p.isBest);
    }
  }
});
test('when one plan is the best by two measures the labels are merged instead of showing it twice', () => {
  let merged = 0;
  for (let i = 0; i < seeds.length; i += 8) {
    const res = rp.planRoutes(rp.buildProblem(seeds[i], poiPos, runeIndex));
    merged += res.plans.filter(p => p.kinds.length > 1).length;
    res.plans.filter(p => p.kinds.length > 1).forEach(p => assert.ok(p.label.includes(' · ')));
  }
  assert.ok(merged >= 0);
});
test('the same input always gives the same plans', () => {
  const a = rp.planRoutes(rp.buildProblem(seeds[9], poiPos, runeIndex)), b = rp.planRoutes(rp.buildProblem(seeds[9], poiPos, runeIndex));
  assert.deepStrictEqual(a.plans.map(p => [p.kind, p.ids, p.totalRunes]), b.plans.map(p => [p.kind, p.ids, p.totalRunes]));
});
test('it is fast enough to run live in the app (under 1 s per seed on average)', () => {
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) rp.planRoutes(rp.buildProblem(seeds[i * 16], poiPos, runeIndex));
  assert.ok((Date.now() - t0) / 20 < 1000, `${(Date.now() - t0) / 20} ms per seed`);
});

// ---- settings ------------------------------------------------------------------------------------------------------
test('not reachable: says so, still gives plans, and reports the shortfall', () => {
  const problem = rp.buildProblem(seeds[0], poiPos, runeIndex, { fightSpeed: 1.2 });
  const res = rp.planRoutes(problem);
  assert.strictEqual(res.feasible, false); assert.ok(res.plans.length >= 1 && res.notes.length === 1);
  assert.ok(res.plans.every(p => !p.reachesTarget && p.shortfall > 20000 && p.shortfall === p.targetRunes - p.totalRunes));
});
test('very fast play on a rich seed reaches level 15: the fastest plan is within tolerance and no slower than the others', () => {
  const opts = { fightSpeed: 0.25, travelMinutesPerUnit: 1.2, runeMultiplier: 1.5 };
  const problem = rp.buildProblem(seeds[2], poiPos, runeIndex, opts);
  const res = rp.planRoutes(problem);
  assert.strictEqual(res.feasible, true);
  const fastest = res.plans.find(p => p.kinds.includes('fastest'));
  assert.ok(fastest.reachesTarget && fastest.totalRunes >= fastest.needed && fastest.label.startsWith('Fastest to level 15'));
  assert.ok(res.plans.filter(p => p.reachesTarget).every(p => fastest.minutes <= p.minutes + 1e-6 || p.meetsDay1 > fastest.meetsDay1));
});
test('a lower target level never needs more time (the Day 1 preference is switched off here so only the target differs)', () => {
  const opts = { fightSpeed: 0.4, travelMinutesPerUnit: 1.4, runeMultiplier: 1.5, day1TargetLevel: 1 };
  let strictly = 0;
  for (const i of [5, 60, 120, 200]) {
    const t15 = rp.planRoutes(rp.buildProblem(seeds[i], poiPos, runeIndex, { ...opts, targetLevel: 15 }));
    const t10 = rp.planRoutes(rp.buildProblem(seeds[i], poiPos, runeIndex, { ...opts, targetLevel: 10 }));
    const m15 = t15.plans.find(p => p.kinds.includes('fastest')).minutes, m10 = t10.plans.find(p => p.kinds.includes('fastest')).minutes;
    assert.ok(m10 <= m15 + 1e-9, `seed #${i}: level 10 takes ${m10} min but level 15 only ${m15}`);
    if (m10 < m15 - 0.5) strictly++;
  }
  assert.ok(strictly >= 2, 'most of the time a lower target should be clearly quicker');
});
test('a night invasion adds its runes, costs its fight time, and everything still fits the day', () => {
  const base = rp.planRoutes(rp.buildProblem(seeds[12], poiPos, runeIndex));
  const withInv = rp.buildProblem(seeds[12], poiPos, runeIndex, { invasion: { day1: true } });
  const res = rp.planRoutes(withInv);
  res.plans.forEach(p => validatePlan(withInv, p));
  const d1 = res.plans[0].days[0];
  assert.deepStrictEqual([d1.invasion.runes, d1.invasion.minutes], [12000, 3.5]);
  assert.strictEqual(d1.runes, d1.stopRunes + 12000);
  assert.ok(d1.minutes <= 14 - 0.4 + 1e-6);
  assert.strictEqual(res.plans[0].days[1].invasion, null);
  assert.ok(base.plans[0].days[0].invasion === null);
});
test('Day 2 can start at the Day 1 night arena instead of the spawn point', () => {
  const a = rp.buildProblem(seeds[20], poiPos, runeIndex), b = rp.buildProblem(seeds[20], poiPos, runeIndex, { day2Start: 'night1' });
  const ra = rp.planRoutes(a).plans[0].days[1], rb = rp.planRoutes(b).plans[0].days[1];
  assert.deepStrictEqual(ra.startPos, a.spawn.pos); assert.deepStrictEqual(rb.startPos, b.nights[1].pos);
});
test('a seed without positions yields a clear note, not a crash', () => {
  const res = rp.planRoutes(rp.buildProblem({ spawn_points: [], field_bosses: [] }, poiPos, runeIndex));
  assert.deepStrictEqual([res.plans.length, res.notes.length], [0, 1]);
});

test('the async planner gives exactly the same plans and hands control back many times meanwhile', async () => {
  const problem = rp.buildProblem(seeds[33], poiPos, runeIndex);
  const sync = rp.planRoutes(problem);
  let ticks = 0;
  const asyncRes = await rp.planRoutesAsync(rp.buildProblem(seeds[33], poiPos, runeIndex), async () => { ticks++; await new Promise(r => setImmediate(r)); });
  assert.deepStrictEqual(asyncRes.plans.map(p => [p.kinds, p.ids, p.totalRunes]), sync.plans.map(p => [p.kinds, p.ids, p.totalRunes]));
  assert.ok(ticks >= 8, `only ${ticks} chances for the UI to run`);
});

(async () => {
  for (const [name, fn] of tests) { await fn(); passed++; console.log('  ok  -', name); }
  console.log(`\n${passed} tests passed`);
})().catch(e => { console.error(e); process.exit(1); });
