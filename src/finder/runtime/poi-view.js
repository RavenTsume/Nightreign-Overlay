(() => {
  // POIs on the Seed Finder map: the same labels and circles the overlay draws over the game map, drawn on a
  // canvas that sits on top of the finder map (clicks go straight through to the slot icons below).
  // It reuses the overlay's own modules (data, label builder, renderer), so both always agree, and it follows the
  // same POI settings (which POIs, colours, font size) from the Overlay Options.
  const runtime = (window.SeedfinderRuntime = window.SeedfinderRuntime || {});

  // The overlay's label sizes are tuned for the in-game map panel at 1440p (about 974 px tall).
  const REFERENCE_PANEL_HEIGHT = 974;

  /**
   * deps (all default to the real browser objects, so tests can pass fakes):
   *   state, getMapWrapper(), doc, storage, modules (OverlayModules), overlayRuntime (OverlayRuntime),
   *   ensureI18N(), dpr()
   */
  function createPoiView(deps) {
    const { state, getMapWrapper, doc, storage, modules, overlayRuntime } = deps;
    const ensureI18N = deps.ensureI18N || (async () => {});
    const dpr = deps.dpr || (() => 1);

    let canvas = null;
    let ctx = null;
    let current = null; // { seedData } of the seed that is shown
    let poiLoading = null;
    let token = 0; // bumped by show()/clear() so an older, slower render cannot draw over a newer state

    const poisEnabled = () => storage.getItem('finder_showPois') !== 'false';

    function ensureCanvas() {
      if (canvas) return canvas;
      const wrapper = getMapWrapper();
      if (!wrapper) return null;
      canvas = doc.createElement('canvas');
      canvas.id = 'poiLayer';
      Object.assign(canvas.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' });
      wrapper.appendChild(canvas);
      ctx = canvas.getContext('2d');
      return canvas;
    }

    function sizeCanvas(size) {
      const ratio = dpr() || 1;
      const px = Math.max(1, Math.round(size * ratio));
      if (canvas.width !== px) canvas.width = px;
      if (canvas.height !== px) canvas.height = px;
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    function wipe() {
      if (!ctx || !canvas) return;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }

    const loadPois = () => (poiLoading = poiLoading || modules.data.loadPoiData());

    async function render() {
      const mine = token;
      if (!ensureCanvas()) return;
      const size = state.current.mapPixelSize;
      if (!(size > 0)) return;
      sizeCanvas(size);
      wipe();
      if (!current || !state.current.activeMapType || !poisEnabled()) return;

      await loadPois();
      await ensureI18N();
      if (mine !== token) return; // superseded while loading

      modules.state.loadOverlayPrefsFromStorage();
      const { labelBaseStyle, overlayPrefsState, isStyleVisible, getStyleColor, wrapLabelText, stripTypePrefix } = modules.state;
      const { SORCERERS_RISE_PREFIX, getPoiRecord } = modules.data;
      // Same font size setting as the overlay. The overlay's offsets and scale only align it with the GAME map,
      // so they are not applied here: on the finder map every POI sits exactly on its position.
      const ui = {
        ...overlayRuntime.uiState.deriveUiMetrics({ overlayPrefs: overlayPrefsState, labelBaseStyle, scale: size / REFERENCE_PANEL_HEIGHT }),
        offsetX: 0,
        offsetY: 0,
      };
      const descriptors = overlayRuntime.seedDisplay.buildLabelDescriptors(current.seedData, { stripTypePrefix, SORCERERS_RISE_PREFIX });
      overlayRuntime.renderer.renderDescriptors(ctx, descriptors, {
        panelRect: { x: 0, y: 0, width: size, height: size },
        ui,
        getPoiRecord,
        uvToScreen: (rect, u, v) => ({ x: rect.x + u * rect.width, y: rect.y + v * rect.height }),
        isStyleVisible,
        getStyleColor,
        wrapLabelText,
        globalScale: 1,
        marker: labelBaseStyle.marker !== false,
      });
    }

    /** Show the POIs of a seed. `payload` is the same object that is sent to the overlay. */
    async function show(payload) {
      const mine = ++token;
      try {
        await loadPois();
        const { loadSeedsForNightlord, findSeed, resolveNightlordForSeedId } = modules.data;
        const seedId = payload.seed_id || payload.seed?.seed_id;
        let seedData = payload.seed || payload;
        const nightlord = payload.nightlord || payload.seed?.nightlord || (seedId ? resolveNightlordForSeedId(seedId) : null);
        if (nightlord) {
          const match = findSeed(await loadSeedsForNightlord(nightlord), seedId);
          if (match) seedData = match; // the overlay's own, fully normalised copy of the seed
        }
        if (mine !== token) return;
        current = { seedData };
      } catch (error) {
        console.error('[finder] could not prepare POIs', error);
        current = null;
      }
      await render();
    }

    /** Remove the POIs (the finder was reset, or the seed is no longer unique). */
    function clear() {
      token++;
      current = null;
      if (ensureCanvas()) wipe();
    }

    /** Redraw at the current size / settings (window resized, an option changed). */
    function layout() {
      return render();
    }

    return { show, clear, layout, get hasSeed() { return !!current; } };
  }

  runtime.createPoiView = createPoiView;

  if (typeof window !== 'undefined' && window.document) {
    // The real instance, created on first use so script order does not matter.
    Object.defineProperty(runtime, 'poiViewInstance', {
      configurable: true,
      get() {
        if (!runtime._poiView) {
          runtime._poiView = createPoiView({
            state: window.Seedfinder.state,
            getMapWrapper: () => document.getElementById('mapWrapper'),
            doc: document,
            storage: localStorage,
            modules: window.OverlayModules,
            overlayRuntime: window.OverlayRuntime,
            dpr: () => window.devicePixelRatio || 1,
            ensureI18N: async () => {
              const init = window.OverlayI18N?.init;
              if (typeof init !== 'function') return;
              const locale = localStorage.getItem('locale') || 'en';
              if (runtime._poiLocale === locale) return;
              try {
                await init.call(window.OverlayI18N, locale);
                runtime._poiLocale = locale;
              } catch (error) {
                console.warn('[finder] POI labels could not load locale', locale, error);
              }
            },
          });
          // Options changed in the finder (POI list, colours, font size): redraw.
          window.addEventListener('overlay-prefs-changed', () => runtime._poiView.layout());
        }
        return runtime._poiView;
      },
    });
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createPoiView, REFERENCE_PANEL_HEIGHT };
})();
