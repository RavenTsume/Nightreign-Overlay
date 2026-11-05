(() => {
  // Route suggestions in the Seed Finder: up to three routes as small maps on the right, and the selected one drawn
  // on the big finder map. The planning itself lives in src/core/routePlanner.js.
  const runtime = (window.SeedfinderRuntime = window.SeedfinderRuntime || {});

  const DAY_COLORS = { 1: '#38bdf8', 2: '#fb923c' };
  const PACES = { relaxed: 1.0, team: 0.6, fast: 0.4 };
  const DEFAULT_SETTINGS = { pace: 'team', target: 15, solo: false, inv1: false, inv2: false };
  const SETTINGS_KEY = 'finder_route_settings';

  const fmt = n => Math.round(n).toLocaleString('en-US');
  const clock = minutes => {
    const total = Math.round(minutes * 60);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };

  // ---------------------------------------------------------------------------------------------------------------
  // drawing (works on any 2D context, so the mini maps and the big map share it)
  // ---------------------------------------------------------------------------------------------------------------
  function arrow(ctx, x1, y1, x2, y2, size) {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    ctx.beginPath();
    ctx.moveTo(mx + Math.cos(angle) * size, my + Math.sin(angle) * size);
    ctx.lineTo(mx + Math.cos(angle + 2.5) * size, my + Math.sin(angle + 2.5) * size);
    ctx.lineTo(mx + Math.cos(angle - 2.5) * size, my + Math.sin(angle - 2.5) * size);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * @param plan   a plan from the planner
   * @param opts   { compact, image, problem }  compact = small map (numbers only), image = map picture for the background
   */
  function drawRoute(ctx, size, plan, opts = {}) {
    const compact = !!opts.compact;
    const px = ([u, v]) => ({ x: u * size, y: v * size });
    ctx.save();
    ctx.clearRect(0, 0, size, size);
    if (opts.image) {
      ctx.globalAlpha = compact ? 0.5 : 1;
      ctx.drawImage(opts.image, 0, 0, size, size);
      ctx.globalAlpha = 1;
    }
    const lineW = compact ? 2 : 4, dot = compact ? 6.5 : 13, font = compact ? 9 : 13;
    ctx.lineJoin = 'round';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const day of plan.days) {
      const color = DAY_COLORS[day.day];
      const pts = [day.startPos, ...day.stops.map(s => s.pos), day.arenaPos].map(px);
      // legs
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = lineW;
      for (let i = 0; i < pts.length - 1; i++) {
        const last = i === pts.length - 2;
        ctx.setLineDash(last ? [lineW * 2, lineW * 1.5] : []);
        ctx.beginPath();
        ctx.moveTo(pts[i].x, pts[i].y);
        ctx.lineTo(pts[i + 1].x, pts[i + 1].y);
        ctx.stroke();
        ctx.setLineDash([]);
        arrow(ctx, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, compact ? 4 : 7);
      }
    }

    // night boss arenas (and, on the big map, the assumed safe circle)
    for (const day of plan.days) {
      const a = px(day.arenaPos), color = DAY_COLORS[day.day];
      if (!compact && opts.problem) {
        ctx.save();
        ctx.setLineDash([8, 8]);
        ctx.globalAlpha = 0.3;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(a.x, a.y, opts.problem.settings.circle.r1 * size, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      const r = compact ? 6 : 12;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y - r); ctx.lineTo(a.x + r, a.y); ctx.lineTo(a.x, a.y + r); ctx.lineTo(a.x - r, a.y);
      ctx.closePath();
      ctx.fillStyle = '#111827';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = `bold ${font - 2}px sans-serif`;
      ctx.fillText(`N${day.day}`, a.x, a.y + 1);
    }

    // stops, numbered per day (all circles first, so no label can ever cover one)
    const stops = [];
    for (const day of plan.days) {
      day.stops.forEach((stop, i) => stops.push({ day: day.day, n: i + 1, stop, p: px(stop.pos) }));
    }
    for (const s of stops) {
      ctx.beginPath();
      ctx.arc(s.p.x, s.p.y, dot, 0, Math.PI * 2);
      ctx.fillStyle = DAY_COLORS[s.day];
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#0b1220';
      ctx.stroke();
      ctx.fillStyle = '#0b1220';
      ctx.font = `bold ${font}px sans-serif`;
      ctx.fillText(String(s.n), s.p.x, s.p.y + 0.5);
    }

    // name labels on the big map, placed so they stay inside the map and avoid circles and each other
    if (!compact) {
      ctx.font = `bold ${font - 1}px sans-serif`;
      const taken = stops.map(s => ({ x: s.p.x - dot - 2, y: s.p.y - dot - 2, w: dot * 2 + 4, h: dot * 2 + 4 }));
      const arenas = plan.days.map(d => px(d.arenaPos));
      arenas.forEach(a => taken.push({ x: a.x - 14, y: a.y - 14, w: 28, h: 28 }));
      const hit = (r, o) => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y;
      const fits = r => r.x >= 1 && r.y >= 1 && r.x + r.w <= size - 1 && r.y + r.h <= size - 1;
      // the richest stops choose first
      for (const s of stops.slice().sort((a, b) => b.stop.runes - a.stop.runes)) {
        const label = `${s.stop.name}${s.stop.estimated ? ' ≈' : ''}  +${fmt(s.stop.runes)}`;
        const w = ctx.measureText(label).width + 10, h = 18;
        const { x, y } = s.p;
        const options = [
          { x: x + dot + 3, y: y - h / 2 }, { x: x - dot - 3 - w, y: y - h / 2 },
          { x: x - w / 2, y: y - dot - h - 3 }, { x: x - w / 2, y: y + dot + 3 },
          { x: x + dot + 3, y: y - h - dot }, { x: x - dot - 3 - w, y: y + dot - 2 },
        ].map(o => ({ ...o, w, h }));
        let spot = options.find(o => fits(o) && !taken.some(r => hit(o, r)));
        if (!spot) spot = options.find(fits) || { ...options[0], x: Math.min(Math.max(1, options[0].x), size - w - 1), y: Math.min(Math.max(1, options[0].y), size - h - 1), w, h };
        taken.push(spot);
        ctx.fillStyle = 'rgba(11, 18, 32, 0.82)';
        ctx.fillRect(spot.x, spot.y, spot.w, spot.h);
        ctx.fillStyle = '#f3f4f6';
        ctx.textAlign = 'left';
        ctx.fillText(label, spot.x + 5, spot.y + h / 2 + 0.5);
        ctx.textAlign = 'center';
      }
    }

    // spawn point
    const s = px(plan.days[0].startPos);
    ctx.beginPath();
    ctx.arc(s.x, s.y, compact ? 7 : 14, 0, Math.PI * 2);
    ctx.lineWidth = compact ? 2.5 : 4;
    ctx.strokeStyle = '#a78bfa';
    ctx.stroke();
    ctx.fillStyle = '#a78bfa';
    ctx.font = `bold ${font - 2}px sans-serif`;
    ctx.fillText('S', s.x, s.y + 1);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // the view
  // ---------------------------------------------------------------------------------------------------------------
  function createRouteView(deps) {
    const { doc, state, routing, getHost, getWrapper, getMapImage, storage, getPoiPos, loadRuneTable } = deps;
    const dpr = deps.dpr || (() => 1);
    const ensurePois = deps.ensurePois || (async () => {});
    const schedule = deps.schedule || ((fn, ms) => setTimeout(fn, ms));
    const resize = deps.resize || (() => window.dispatchEvent(new Event('resize')));

    let panel = null, cardsEl = null, noteEl = null, footEl = null, mainCanvas = null, mainCtx = null;
    let controls = {};
    let seedData = null, result = null, problem = null, selected = 0, token = 0, runeIndex = null, timer = null;

    const enabled = () => storage.getItem('finder_showRoutes') !== 'false';
    const loadSettings = () => {
      try { return { ...DEFAULT_SETTINGS, ...JSON.parse(storage.getItem(SETTINGS_KEY) || '{}') }; } catch (e) { return { ...DEFAULT_SETTINGS }; }
    };
    const saveSettings = s => storage.setItem(SETTINGS_KEY, JSON.stringify(s));

    function el(tag, props = {}, kids = []) {
      const node = Object.assign(doc.createElement(tag), props);
      kids.forEach(k => node.appendChild(typeof k === 'string' ? doc.createTextNode(k) : k));
      return node;
    }

    function ensurePanel() {
      if (panel) return panel;
      const settings = loadSettings();
      const select = (id, options, value) => {
        const s = el('select', { id });
        options.forEach(([v, text]) => s.appendChild(el('option', { value: String(v), textContent: text })));
        s.value = String(value);
        s.addEventListener('change', onSettingsChanged);
        return s;
      };
      const check = (id, checked) => {
        const c = el('input', { type: 'checkbox', id, checked });
        c.addEventListener('change', onSettingsChanged);
        return c;
      };
      controls = {
        pace: select('routePace', [['relaxed', 'Relaxed'], ['team', 'Team (default)'], ['fast', 'Fast']], settings.pace),
        target: select('routeTarget', [10, 11, 12, 13, 14, 15].map(l => [l, `Level ${l}`]), settings.target),
        solo: check('routeSolo', settings.solo),
        inv1: check('routeInv1', settings.inv1),
        inv2: check('routeInv2', settings.inv2),
      };
      noteEl = el('div', { className: 'route-note' });
      cardsEl = el('div', { className: 'route-cards' });
      footEl = el('div', { className: 'route-foot' });
      const row = (label, control) => el('label', { className: 'route-row' }, [label, control]);
      const tick = (control, text) => el('label', { className: 'route-tick' }, [control, ` ${text}`]);
      panel = el('aside', { id: 'routePanel', className: 'route-panel', hidden: true }, [
        el('div', { className: 'route-head' }, ['Suggested routes']),
        el('div', { className: 'route-settings' }, [
          row('Pace ', controls.pace), row('Goal ', controls.target),
          tick(controls.solo, 'Solo (+50% runes)'),
          tick(controls.inv1, 'Night invasion on Day 1'),
          tick(controls.inv2, 'Night invasion on Day 2'),
        ]),
        noteEl, cardsEl, footEl,
      ]);
      getHost().appendChild(panel);
      return panel;
    }

    function readSettings() {
      return { pace: controls.pace.value, target: Number(controls.target.value), solo: !!controls.solo.checked, inv1: !!controls.inv1.checked, inv2: !!controls.inv2.checked };
    }
    function onSettingsChanged() {
      saveSettings(readSettings());
      clearTimeout(timer);
      timer = schedule(() => replan(), 250); // wait a moment so several quick clicks plan only once
    }
    const plannerOptions = s => ({
      targetLevel: s.target, fightSpeed: PACES[s.pace] ?? PACES.team, runeMultiplier: s.solo ? 1.5 : 1,
      invasion: { day1: s.inv1, day2: s.inv2 },
    });

    function show(visible) {
      if (!panel) return;
      if (panel.hidden === !visible) return;
      panel.hidden = !visible;
      resize(); // the map makes (or gives back) room for the panel
    }

    function ensureMainCanvas() {
      if (mainCanvas) return mainCanvas;
      const wrapper = getWrapper();
      if (!wrapper) return null;
      mainCanvas = el('canvas', { id: 'routeLayer' });
      Object.assign(mainCanvas.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' });
      wrapper.appendChild(mainCanvas);
      mainCtx = mainCanvas.getContext('2d');
      return mainCanvas;
    }
    function wipeMain() {
      if (!mainCtx || !mainCanvas) return;
      mainCtx.save();
      mainCtx.setTransform(1, 0, 0, 1, 0, 0);
      mainCtx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
      mainCtx.restore();
    }

    function drawMain() {
      if (!ensureMainCanvas()) return;
      const size = state.current.mapPixelSize;
      if (!(size > 0)) return;
      const ratio = dpr() || 1;
      mainCanvas.width = Math.max(1, Math.round(size * ratio));
      mainCanvas.height = mainCanvas.width;
      mainCanvas.style.width = `${size}px`;
      mainCanvas.style.height = `${size}px`;
      mainCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
      wipeMain();
      if (result && result.plans[selected] && state.current.activeMapType && enabled()) {
        drawRoute(mainCtx, size, result.plans[selected], { problem });
      }
    }

    function drawMini(canvas, plan) {
      const size = 200, ratio = dpr() || 1;
      canvas.width = Math.round(size * ratio);
      canvas.height = canvas.width;
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const img = getMapImage();
      const ready = img && img.complete !== false;
      drawRoute(ctx, size, plan, { compact: true, image: ready ? img : null });
      if (img && !ready && img.addEventListener) img.addEventListener('load', () => drawMini(canvas, plan), { once: true });
    }

    function stepsOf(plan) {
      const list = el('div', { className: 'route-steps' });
      for (const day of plan.days) {
        list.appendChild(el('div', { className: 'route-day', textContent: `Day ${day.day}: at the night arena after ${clock(day.minutes)} of 14:00` }));
        const ol = el('ol');
        if (day.invasion) ol.appendChild(el('li', { textContent: `Night invader (comes to you): +${fmt(day.invasion.runes)}, about ${day.invasion.minutes} min` }));
        day.stops.forEach(s => ol.appendChild(el('li', { textContent: `${s.name}${s.estimated ? ' ≈' : ''} (${s.type.replace('_', ' ')}) +${fmt(s.runes)}  ${clock(s.arrive)}-${clock(s.leave)}` })));
        if (day.nightBoss) ol.appendChild(el('li', { className: 'route-night', textContent: `Night ${day.day} boss: ${day.nightBoss.name}${day.nightBoss.estimated ? ' ≈' : ''} +${fmt(day.nightBoss.runes)}` }));
        list.appendChild(ol);
      }
      return list;
    }

    function renderCards() {
      cardsEl.replaceChildren();
      const plans = result ? result.plans : [];
      plans.forEach((plan, i) => {
        const canvas = el('canvas', { className: 'route-mini' });
        const target = result.settings.targetLevel;
        const verdict = plan.reachesTarget
          ? (plan.shortfall > 0 ? `Level ${target} reached if normal enemies add about ${fmt(plan.shortfall)} (limit ${fmt(result.settings.tolerance)})` : `Level ${target} reached from bosses alone`)
          : `Short of level ${target} by ${fmt(plan.shortfall)} runes`;
        const card = el('div', { className: `route-card${i === selected ? ' selected' : ''}` }, [
          el('div', { className: 'route-card-title', textContent: plan.label }),
          canvas,
          el('div', { className: 'route-stats', textContent: `Lv ${plan.levelAfterDay1} after Day 1, Lv ${plan.levelAfterDay2} after Day 2` }),
          el('div', { className: 'route-stats', textContent: `${fmt(plan.totalRunes)} runes, ${plan.minutes.toFixed(1)} min on the way` }),
          el('div', { className: `route-verdict${plan.reachesTarget ? ' ok' : ' short'}`, textContent: verdict }),
          el('details', {}, [el('summary', { textContent: 'Steps' }), stepsOf(plan)]),
        ]);
        card.addEventListener('click', () => select(i));
        cardsEl.appendChild(card);
        drawMini(canvas, plan);
      });
    }

    function select(i) {
      selected = i;
      Array.from(cardsEl.children).forEach((c, k) => { c.className = `route-card${k === i ? ' selected' : ''}`; });
      drawMain();
    }

    function renderNotes() {
      const parts = [...(result.notes || [])];
      if (result.unknown.length) parts.push(`${result.unknown.length} boss(es) have no published rune value and use an estimate (marked ≈).`);
      noteEl.textContent = parts.join(' ');
      const s = result.settings;
      footEl.textContent = `Estimates, not guarantees: fights ${Math.round((s.fightBaseMinutes + s.fightMinutesPerThousand * 30) * s.fightSpeed * 10) / 10} min for a 30,000-rune boss, crossing the map ${s.travelMinutesPerUnit} min, night circle sizes assumed. Rune values from wiki data (June 2025).`;
    }

    async function replan() {
      if (!seedData) return;
      const mine = ++token;
      const data = seedData; // the seed can be cleared or replaced while we wait, so work on our own copy
      ensurePanel();
      if (!enabled()) { show(false); drawMain(); return; }
      show(true);
      noteEl.textContent = 'Planning routes…';
      cardsEl.replaceChildren();
      try {
        await ensurePois();
        if (mine !== token) return;
        runeIndex = runeIndex || routing.buildRuneIndex(await loadRuneTable());
        if (mine !== token) return;
        const built = routing.buildProblem(data, getPoiPos, runeIndex, plannerOptions(readSettings()));
        const res = await routing.planRoutesAsync(built);
        if (mine !== token) return; // a newer seed / setting arrived (or the finder was reset) while planning
        problem = built;
        result = res;
        selected = 0;
        renderNotes();
        renderCards();
        drawMain();
      } catch (error) {
        if (mine !== token) return;
        console.error('[finder] route planning failed', error);
        result = null;
        noteEl.textContent = 'Could not plan routes for this seed.';
      }
    }

    return {
      setSeed(data) { seedData = data; ensurePanel(); return replan(); },
      clear() { token++; seedData = null; result = null; problem = null; show(false); wipeMain(); },
      layout() { drawMain(); },
      /** An option changed (e.g. "show route suggestions"): apply it to the current seed. */
      refresh() { return seedData ? replan() : undefined; },
      select,
      get result() { return result; },
      get selected() { return selected; },
      settings: () => (panel ? readSettings() : loadSettings()),
    };
  }

  runtime.createRouteView = createRouteView;
  runtime.routeDrawing = { drawRoute, clock, fmt };

  if (typeof window !== 'undefined' && window.document) {
    Object.defineProperty(runtime, 'routeViewInstance', {
      configurable: true,
      get() {
        if (!runtime._routeView) {
          let poiLoading = null;
          runtime._routeView = createRouteView({
            doc: document, state: window.Seedfinder.state, routing: window.Seedfinder.routing, storage: localStorage,
            getHost: () => document.querySelector('.wrap') || document.body,
            getWrapper: () => document.getElementById('mapWrapper'),
            getMapImage: () => document.getElementById('mapImage'),
            getPoiPos: id => { const r = window.OverlayModules.data.getPoiRecord(id); return r && r.uv; },
            ensurePois: () => (poiLoading = poiLoading || window.OverlayModules.data.loadPoiData()),
            loadRuneTable: async () => (await fetch('../assets/data/nightreign_rune_drops.json')).json(),
            dpr: () => window.devicePixelRatio || 1,
          });
          window.addEventListener('overlay-prefs-changed', () => runtime._routeView.refresh());
        }
        return runtime._routeView;
      },
    });
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createRouteView, drawRoute, clock, fmt, PACES, DEFAULT_SETTINGS };
})();
