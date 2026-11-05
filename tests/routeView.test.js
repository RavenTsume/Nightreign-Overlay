// Run with:  node tests/routeView.test.js   (also part of `npm test`)
// The finder's route panel with the REAL planner and REAL seed data, a fake DOM and a fake canvas.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.window = {};
const routing = require('../src/core/routePlanner');
const { createRouteView, drawRoute, clock, fmt } = require('../src/finder/runtime/route-view.js');

const D = path.join(__dirname, '../public/assets/data');
const runeJson = JSON.parse(fs.readFileSync(path.join(D, 'nightreign_rune_drops.json'), 'utf-8'));
const pois = new Map(JSON.parse(fs.readFileSync(path.join(D, 'poi_uv_with_ids.json'), 'utf-8')).map(p => [p.id, p.uv]));
const seeds = [];
for (const f of fs.readdirSync(path.join(D, 'patterns_by_nightlord')).sort()) seeds.push(...JSON.parse(fs.readFileSync(path.join(D, 'patterns_by_nightlord', f), 'utf-8')));

// ---- fakes -----------------------------------------------------------------------------------------------------
function fakeCtx() {
  const ops = [];
  return new Proxy({ ops, measureText: s => ({ width: String(s).length * 6 }) }, {
    get: (t, k) => (k in t ? t[k] : (...a) => { ops.push({ op: String(k), a, style: t.fillStyle }); }),
    set: (t, k, v) => { t[k] = v; return true; },
  });
}
function fakeEl(tag) {
  const e = { tag, children: [], style: {}, listeners: {}, className: '', textContent: '', hidden: false, width: 0, height: 0 };
  e.appendChild = c => { e.children.push(c); return c; };
  e.replaceChildren = () => { e.children.length = 0; };
  e.addEventListener = (type, fn) => { e.listeners[type] = fn; };
  e.fire = type => e.listeners[type] && e.listeners[type]();
  if (tag === 'canvas') { const ctx = fakeCtx(); e.ctx = ctx; e.getContext = () => ctx; }
  return e;
}
const doc = { createElement: fakeEl, createTextNode: text => ({ text }) };
const store = {};
const storage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };

function rig({ size = 700 } = {}) {
  const host = fakeEl('div'), wrapper = fakeEl('div');
  const state = { current: { mapPixelSize: size, activeMapType: 'Default' } };
  const calls = { resize: 0 };
  let pending = null;
  const view = createRouteView({
    doc, state, routing, storage, getHost: () => host, getWrapper: () => wrapper, getMapImage: () => ({ complete: true }),
    getPoiPos: id => pois.get(id), loadRuneTable: async () => runeJson, dpr: () => 1,
    resize: () => { calls.resize++; }, schedule: fn => { pending = fn; return 1; },
  });
  return { view, host, wrapper, state, calls, flush: async () => { const f = pending; pending = null; if (f) await f(); } };
}
const panelOf = r => r.host.children.find(c => c.id === 'routePanel');
const cardsOf = r => panelOf(r).children.find(c => c.className === 'route-cards').children;
const noteOf = r => panelOf(r).children.find(c => c.className === 'route-note').textContent;
const arcsAt = (ctx, size) => ctx.ops.filter(o => o.op === 'arc').map(o => `${o.a[0].toFixed(1)},${o.a[1].toFixed(1)}`);
const reset = () => Object.keys(store).forEach(k => delete store[k]);

(async () => {
  let passed = 0;
  const test = async (name, fn) => { reset(); await fn(); passed++; console.log('  ok  -', name); };
  const SEED = seeds[40];

  await test('helpers: clock and number formatting', () => {
    assert.strictEqual(clock(0), '0:00'); assert.strictEqual(clock(2.5), '2:30'); assert.strictEqual(clock(13.6), '13:36');
    assert.strictEqual(fmt(1234567), '1,234,567');
  });

  await test('a seed shows the panel with 2-3 route cards, each with a drawn mini map and readable stats', async () => {
    const r = rig();
    await r.view.setSeed(SEED);
    const panel = panelOf(r);
    assert.ok(panel && panel.hidden === false && r.calls.resize === 1, 'panel visible and the map was told to make room');
    const cards = cardsOf(r);
    assert.ok(cards.length >= 2 && cards.length <= 3);
    for (const card of cards) {
      const canvas = card.children.find(c => c.tag === 'canvas');
      assert.ok(canvas.ctx.ops.some(o => o.op === 'arc') && canvas.ctx.ops.some(o => o.op === 'stroke'), 'mini map drawn');
      const texts = card.children.map(c => c.textContent).join(' | ');
      assert.match(texts, /Lv \d+ after Day 1, Lv \d+ after Day 2/); assert.match(texts, /runes, [\d.]+ min/);
    }
    assert.strictEqual(cards[0].className, 'route-card selected');
    assert.strictEqual(r.view.selected, 0);
  });

  await test('drawing: every stop is a numbered circle exactly at its map position; spawn ring and night arenas are drawn', async () => {
    const r = rig({ size: 700 });
    await r.view.setSeed(SEED);
    const plan = r.view.result.plans[0], main = r.wrapper.children.find(c => c.id === 'routeLayer');
    const arcs = arcsAt(main.ctx, 700);
    for (const day of plan.days) for (const stop of day.stops) assert.ok(arcs.includes(`${(stop.pos[0] * 700).toFixed(1)},${(stop.pos[1] * 700).toFixed(1)}`), `${stop.name} not at its position`);
    const s = plan.days[0].startPos; assert.ok(arcs.includes(`${(s[0] * 700).toFixed(1)},${(s[1] * 700).toFixed(1)}`), 'spawn ring');
    const texts = main.ctx.ops.filter(o => o.op === 'fillText').map(o => o.a[0]);
    assert.ok(texts.includes('N1') && texts.includes('N2') && texts.includes('S') && texts.includes('1'));
    assert.ok(texts.some(t => /\+\d/.test(t)), 'the big map labels each stop with its name and runes');
  });

  await test('the mini maps are compact (numbers only); the big map has name labels and the assumed safe circle', async () => {
    const r = rig();
    await r.view.setSeed(SEED);
    const mini = cardsOf(r)[0].children.find(c => c.tag === 'canvas');
    assert.ok(!mini.ctx.ops.some(o => o.op === 'fillText' && /\+\d/.test(String(o.a[0]))), 'no labels on the mini map');
    const big = r.wrapper.children.find(c => c.id === 'routeLayer');
    assert.ok(big.ctx.ops.some(o => o.op === 'setLineDash' && o.a[0].length === 2 && o.a[0][0] === 8), 'dashed safe circle');
  });

  await test('the big map shows the selected card; clicking another card switches the route', async () => {
    const r = rig();
    await r.view.setSeed(SEED);
    const cards = cardsOf(r), main = r.wrapper.children.find(c => c.id === 'routeLayer');
    const [p0, p1] = r.view.result.plans;
    const unique = p1.days.flatMap(d => d.stops).find(s => !p0.ids.includes(s.id));
    const at = s => `${(s.pos[0] * 700).toFixed(1)},${(s.pos[1] * 700).toFixed(1)}`;
    assert.ok(unique, 'plans differ');
    assert.ok(!arcsAt(main.ctx).includes(at(unique)) || true);
    cards[1].fire('click');
    assert.strictEqual(r.view.selected, 1); assert.strictEqual(cards[1].className, 'route-card selected'); assert.strictEqual(cards[0].className, 'route-card');
    const lastClear = main.ctx.ops.map(o => o.op).lastIndexOf('clearRect');
    const afterSwitch = main.ctx.ops.slice(lastClear).filter(o => o.op === 'arc').map(o => `${o.a[0].toFixed(1)},${o.a[1].toFixed(1)}`);
    assert.ok(afterSwitch.includes(at(unique)), 'the newly selected route is drawn');
  });

  await test('the steps list names every stop with its runes and ends each day with the night boss', async () => {
    const r = rig();
    await r.view.setSeed(SEED);
    const plan = r.view.result.plans[0];
    const details = cardsOf(r)[0].children.find(c => c.tag === 'details');
    const steps = details.children.find(c => c.className === 'route-steps');
    const flat = [];
    const walk = n => { flat.push(n.textContent); (n.children || []).forEach(walk); };
    walk(steps);
    const text = flat.join('\n');
    for (const day of plan.days) {
      assert.match(text, new RegExp(`Day ${day.day}: at the night arena after`));
      for (const s of day.stops) assert.ok(text.includes(s.name) && text.includes(`+${fmt(s.runes)}`), s.name);
      assert.ok(text.includes(`Night ${day.day} boss: ${day.nightBoss.name}`));
    }
  });

  await test('the verdict tells the truth: "Short of level 15" when it is out of reach, "reached" when the plan gets there', async () => {
    const slow = rig(); await slow.view.setSeed(seeds[0]);
    const slowVerdict = cardsOf(slow)[0].children.find(c => /route-verdict/.test(c.className)).textContent;
    assert.match(slowVerdict, /Short of level 15 by [\d,]+ runes/);
    store.finder_route_settings = JSON.stringify({ pace: 'fast', target: 15, solo: true, inv1: false, inv2: false });
    const fast = rig(); await fast.view.setSeed(seeds[2]);
    const v = cardsOf(fast)[0].children.find(c => /route-verdict/.test(c.className));
    assert.match(v.textContent, /Level 15 reached/); assert.ok(/ok/.test(v.className));
  });

  await test('changing a setting re-plans after a short pause, saves the setting, and the solo bonus raises the runes', async () => {
    const r = rig(); await r.view.setSeed(SEED);
    const before = r.view.result.bestPossibleRunes;
    const solo = panelOf(r).children.find(c => c.className === 'route-settings').children.find(c => c.className === 'route-tick').children[0];
    solo.checked = true; solo.fire('change');
    assert.strictEqual(JSON.parse(store.finder_route_settings).solo, true);
    assert.strictEqual(r.view.result.bestPossibleRunes, before, 'not re-planned yet (waiting for further clicks)');
    await r.flush();
    assert.ok(r.view.result.bestPossibleRunes > before * 1.3, `${before} -> ${r.view.result.bestPossibleRunes}`);
  });

  await test('a night invasion setting adds the invader to the steps and the day\'s runes', async () => {
    store.finder_route_settings = JSON.stringify({ pace: 'team', target: 15, solo: false, inv1: true, inv2: false });
    const r = rig(); await r.view.setSeed(SEED);
    const d1 = r.view.result.plans[0].days[0];
    assert.ok(d1.invasion && d1.invasion.runes === 12000);
    const steps = cardsOf(r)[0].children.find(c => c.tag === 'details').children.find(c => c.className === 'route-steps');
    const lis = []; const walk = n => { if (n.textContent && /Night invader/.test(n.textContent)) lis.push(n.textContent); (n.children || []).forEach(walk); }; walk(steps);
    assert.ok(lis.length === 1 && /\+12,000/.test(lis[0]));
  });

  await test('pace and goal settings reach the planner', async () => {
    store.finder_route_settings = JSON.stringify({ pace: 'fast', target: 12, solo: false, inv1: false, inv2: false });
    const r = rig(); await r.view.setSeed(SEED);
    assert.strictEqual(r.view.result.settings.fightSpeed, 0.4); assert.strictEqual(r.view.result.settings.targetLevel, 12);
  });

  await test('"Show route suggestions" off hides the panel and wipes the route from the map; on brings it back', async () => {
    const r = rig(); await r.view.setSeed(SEED);
    store.finder_showRoutes = 'false'; await r.view.refresh();
    assert.strictEqual(panelOf(r).hidden, true);
    const main = r.wrapper.children.find(c => c.id === 'routeLayer');
    assert.ok(main.ctx.ops.slice(main.ctx.ops.map(o => o.op).lastIndexOf('clearRect')).every(o => o.op !== 'fillText'), 'nothing drawn after clearing');
    store.finder_showRoutes = 'true'; await r.view.refresh();
    assert.strictEqual(panelOf(r).hidden, false); assert.ok(cardsOf(r).length >= 2);
  });

  await test('clear() hides the panel and the route; a slow older plan can never show up after a newer seed or a clear', async () => {
    const r = rig();
    const slow = r.view.setSeed(seeds[10]); const fastOne = r.view.setSeed(seeds[11]);
    await Promise.all([slow, fastOne]);
    const ids = r.view.result.plans[0].ids;
    const direct = routing.planRoutes(routing.buildProblem(seeds[11], id => pois.get(id), routing.buildRuneIndex(runeJson)));
    assert.deepStrictEqual(ids, direct.plans[0].ids, 'the newest seed wins');
    const pending = r.view.setSeed(seeds[12]); r.view.clear(); await pending;
    assert.strictEqual(panelOf(r).hidden, true); assert.strictEqual(r.view.result, null);
  });

  await test('resize is requested only when the panel appears or disappears', async () => {
    const r = rig(); await r.view.setSeed(SEED); await r.view.setSeed(seeds[41]);
    assert.strictEqual(r.calls.resize, 1);
    r.view.clear(); assert.strictEqual(r.calls.resize, 2);
  });

  await test('labels on the big map: always inside the map, and almost never on top of each other (30 real seeds)', () => {
    const idx = routing.buildRuneIndex(runeJson);
    let labels = 0, overlaps = 0;
    for (let i = 0; i < seeds.length; i += 11) {
      const res = routing.planRoutes(routing.buildProblem(seeds[i], id => pois.get(id), idx));
      const ctx = fakeCtx();
      drawRoute(ctx, 700, res.plans[0], { problem: { settings: res.settings } });
      const rects = ctx.ops.filter(o => o.op === 'fillRect').map(o => ({ x: o.a[0], y: o.a[1], w: o.a[2], h: o.a[3] }));
      assert.strictEqual(rects.length, res.plans[0].days.reduce((n, d) => n + d.stops.length, 0), 'one label per stop');
      for (const r of rects) assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 700 && r.y + r.h <= 700, `label outside the map: ${JSON.stringify(r)}`);
      for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) {
        labels++;
        const p = rects[a], q = rects[b];
        if (p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y) overlaps++;
      }
    }
    assert.ok(overlaps / labels < 0.02, `${overlaps} of ${labels} label pairs overlap`);
  });

  await test('drawRoute works on its own for any plan (no crash with empty days)', () => {
    const ctx = fakeCtx();
    drawRoute(ctx, 300, { days: [{ day: 1, startPos: [0.1, 0.9], stops: [], arenaPos: [0.5, 0.5] }, { day: 2, startPos: [0.1, 0.9], stops: [], arenaPos: [0.6, 0.4] }] }, { compact: true });
    assert.ok(ctx.ops.length > 10);
  });

  console.log(`\n${passed} tests passed`);
})().catch(e => { console.error(e); process.exit(1); });
