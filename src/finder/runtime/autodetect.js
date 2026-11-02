(() => {
  // "Scan map" panel in the finder window.
  //  - Scan map: switches to Nightreign, waits until you open the map, takes two screenshots,
  //    and shows the seed that was found (the map and Nightlord are detected automatically).
  //  - Auto overlay: shows / hides the overlay by itself when the in-game map opens or closes.
  // Talks to the main process through window.app.autoscan / window.app.autodetect.

  /**
   * Show a seed in the finder exactly as if every slot had been clicked by hand.
   * Exposed for tests: deps = { state, selection } (the finder's state and selection controller).
   */
  function applySeedResult({ state, selection }, result) {
    const seed = (state.current.seeds || []).find(s => s.seed_id === result.seedId);
    if (!seed) return { ok: false, reason: 'unknown-seed' };

    state.setActiveMapType(seed.shiftingEarth || seed.map_type || 'Default'); // same field the finder's filters use
    state.setSelectionBySlot({});
    for (const [slotId, value] of Object.entries(seed.slots || {})) state.updateSelection(slotId, value);
    if (seed.nightlord) state.updateSelection('nightlord', seed.nightlord);
    selection.applySelections();

    const resolved = state.current.resolvedSeed;
    if (!resolved || resolved.seed_id !== seed.seed_id) return { ok: false, reason: 'not-resolved' };
    selection.dispatchSeedToOverlay(); // (re)send to the overlay even if this seed was already shown
    return { ok: true, seed };
  }

  /**
   * The scan was not sure. Instead of leaving the map blank, pre-fill the finder with the slots that agree with the
   * best guess (so the filled slots are consistent and the map stays editable). The user clicks the remaining slots,
   * or corrects a wrong one, exactly like the manual workflow.
   */
  function applyPartialResult({ state, selection }, result) {
    const seed = (state.current.seeds || []).find(s => s.seed_id === result.seedId);
    if (!seed) return { ok: false, reason: 'unknown-seed' };

    state.setActiveMapType(seed.shiftingEarth || seed.map_type || 'Default');
    state.setSelectionBySlot({});
    let filled = 0;
    for (const [slotId, reading] of Object.entries(result.slots || {})) {
      const want = seed.slots?.[slotId];
      if (!want || want === 'empty') continue;
      if (reading && reading.label === want) {
        state.updateSelection(slotId, want);
        filled++;
      }
    }
    selection.applySelections();
    return { ok: true, filled, candidates: (state.current.candidateSeeds || []).length };
  }

  /**
   * "Forget map": stop a running scan, drop the remembered result and put the finder back into its default state:
   * no map, no seed, and the overlay's labels cleared (resetFinderState also clears the POIs on the finder map).
   */
  async function forgetMap({ scanApi, selection }) {
    if (scanApi && scanApi.cancel) await scanApi.cancel();
    if (scanApi && scanApi.forget) await scanApi.forget();
    selection.resetFinderState();
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { applySeedResult, applyPartialResult, forgetMap };
  if (typeof window === 'undefined') return;

  const scanApi = window.app?.autoscan;
  const detectApi = window.app?.autodetect;
  if (!scanApi || !detectApi) return;

  function el(tag, props = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    children.forEach(c => node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return node;
  }

  function build() {
    const host = document.getElementById('controls');
    if (!host) return;

    const scanBtn = el('button', { className: 'control-btn', type: 'button', id: 'scanMapButton' }, ['Scan map']);
    const forgetBtn = el('button', { className: 'control-btn', type: 'button', title: 'Forget the current map and seed and go back to the start' }, ['Forget map']);
    const resetLookBtn = el('button', { className: 'control-btn', type: 'button', title: 'Forget what the open map looks like; the next scan teaches it again' }, ['Reset auto-open']);
    const folderBtn = el('button', { className: 'control-btn', type: 'button', title: 'Screenshots and readings of recent scans' }, ['Scan files']);
    const toggle = document.getElementById('autodetect-enabled'); // lives in the Overlay Options
    const scanLine = el('div', { className: 'hint', id: 'scan-status' });
    const watchLine = el('div', { className: 'hint', id: 'autodetect-status' });
    scanLine.style.marginTop = '8px';
    watchLine.style.marginTop = '4px';

    const section = el('div', {}, [
      el('hr', { className: 'panel-divider' }),
      el('div', { className: 'section-spacing' }, [el('b', {}, ['Scan the in-game map'])]),
      el('div', {}, [scanBtn, forgetBtn]),
      scanLine,
      watchLine,
      el('div', {}, [resetLookBtn, folderBtn]),
    ]);
    section.style.marginTop = '12px';
    host.appendChild(section);

    let scanning = false;
    let watcher = null;

    function renderWatch() {
      const s = watcher;
      if (!s) { watchLine.textContent = ''; return; }
      if (toggle) toggle.checked = !!s.enabled;
      if (!s.enabled) watchLine.textContent = 'Auto overlay: off (Overlay Options). Use the overlay hotkey to show it by hand.';
      else if (!s.refs) watchLine.textContent = 'Auto overlay: starts working after your first successful scan.';
      else if (s.gameRunning === false) watchLine.textContent = `Auto overlay: waiting for ${s.gameProcess || 'the game'} to start (no screen capture until then).`;
      else if (s.trigger === 'keys' && s.idle && !s.open) watchLine.textContent = `Auto overlay: idle, looks briefly after you press ${(s.openKeys || []).join(' / ')} (map closed).`;
      else {
        const score = typeof s.score === 'number' ? s.score.toFixed(2) : '–';
        watchLine.textContent = `Auto overlay: map ${s.open ? 'OPEN' : 'closed'} · similarity ${score}` +
          (s.keysUnavailable ? ' · key trigger unavailable (run "npm install"), scanning continuously' : '');
      }
    }

    function setScanning(on) {
      scanning = on;
      scanBtn.textContent = on ? 'Cancel scan' : 'Scan map';
    }

    scanBtn.addEventListener('click', async () => {
      if (scanning) {
        await scanApi.cancel();
        return;
      }
      setScanning(true);
      scanLine.textContent = 'Starting…';
      const started = await scanApi.start();
      if (!started?.ok) {
        setScanning(false);
        scanLine.textContent = started?.reason === 'busy' ? 'A scan is already running.' : 'Scanning is not available.';
      }
    });

    scanApi.onStatus(s => {
      if (!scanning) return;
      if (s.message) scanLine.textContent = s.message;
      else if (s.detail && typeof s.detail.similarity === 'number') {
        scanLine.textContent = `Open the in-game map… (looking, similarity ${s.detail.similarity.toFixed(2)})`;
      }
    });

    // A result can arrive before the finder has loaded its seed data (e.g. right after the window was rebuilt).
    function whenFinderReady(fn, tries = 100) {
      const ready = (window.Seedfinder.state.current.seeds || []).length > 0 && window.SeedfinderRuntime.selectionInstance;
      if (ready || tries <= 0) return fn();
      setTimeout(() => whenFinderReady(fn, tries - 1), 150);
    }

    scanApi.onResult(r => whenFinderReady(() => handleResult(r)));

    function handleResult(r) {
      setScanning(false);
      if (!r.ok) {
        scanLine.textContent = r.message || 'Scan failed.';
        if (r.reason === 'low-confidence' && r.seedId && r.slots) {
          const part = applyPartialResult(
            { state: window.Seedfinder.state, selection: window.SeedfinderRuntime.selectionInstance },
            r
          );
          if (part.ok) {
            scanLine.textContent =
              `Not sure about this one (best guess: seed ${r.seedId}, ${r.exact}/27 slots matched). ` +
              `I filled in the ${part.filled} slots I recognised. Click the map to correct or add the rest.`;
          }
        }
        return;
      }
      const applied = applySeedResult(
        { state: window.Seedfinder.state, selection: window.SeedfinderRuntime.selectionInstance },
        r
      );
      scanLine.textContent = applied.ok
        ? `${r.message} ${r.mapType} · ${r.nightlord}`
        : `Found seed ${r.seedId}, but could not show it in the finder (${applied.reason}).`;
    }

    if (toggle) toggle.addEventListener('change', async () => { watcher = await detectApi.set({ enabled: toggle.checked }); renderWatch(); });
    forgetBtn.addEventListener('click', async () => {
      setScanning(false);
      await forgetMap({ scanApi, selection: window.SeedfinderRuntime.selectionInstance });
      scanLine.textContent = 'Forgot the current map. Press “Scan map” to detect it again.';
    });
    resetLookBtn.addEventListener('click', async () => {
      watcher = await detectApi.clear();
      renderWatch();
      scanLine.textContent = 'Forgot what the open map looks like. The next scan teaches it again.';
    });
    folderBtn.addEventListener('click', () => scanApi.openDebugFolder());
    detectApi.onStatus(s => { watcher = s; renderWatch(); });
    detectApi.get().then(s => { watcher = s; renderWatch(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build, { once: true });
  else build();
})();
