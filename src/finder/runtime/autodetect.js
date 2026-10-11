(() => {
  // Auto map detection panel: toggle, calibrate, live similarity readout.
  // Self-contained; talks to the main process through window.app.autodetect.
  const api = window.app?.autodetect;
  if (!api) return;

  function el(tag, props = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    children.forEach(c => node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return node;
  }

  function build() {
    const host = document.getElementById('controls');
    if (!host) return;

    const toggle = el('input', { type: 'checkbox', id: 'autodetect-enabled' });
    const toggleLabel = el('label', { htmlFor: 'autodetect-enabled', className: 'hint' }, [
      ' Show overlay automatically when the map is open',
    ]);
    const status = el('div', { className: 'hint', id: 'autodetect-status' });
    status.style.marginTop = '6px';
    const calibrateBtn = el('button', { className: 'control-btn', type: 'button' }, ['Calibrate (5 s)']);
    const clearBtn = el('button', { className: 'control-btn', type: 'button' }, ['Clear']);
    const help = el('div', { className: 'hint' }, [
      'Click Calibrate, switch to the game and open the map. A snapshot is taken after 5 s. ' +
        'Repeat once per map type if detection misses one.',
    ]);
    help.style.marginTop = '6px';

    const section = el('div', {}, [
      el('hr', { className: 'panel-divider' }),
      el('div', { className: 'section-spacing' }, [el('b', {}, ['Auto map detection'])]),
      el('div', {}, [toggle, toggleLabel]),
      el('div', {}, [calibrateBtn, clearBtn]),
      status,
      help,
    ]);
    section.style.marginTop = '12px';
    host.appendChild(section);

    let latest = null;
    function render(state, note) {
      latest = state || latest;
      const s = latest;
      if (!s) {
        status.textContent = 'Auto detection unavailable.';
        return;
      }
      toggle.checked = !!s.enabled;
      if (note) {
        status.textContent = note;
      } else if (!s.refs) {
        status.textContent = 'Not calibrated yet. Open the map in-game, then click Calibrate.';
      } else if (!s.enabled) {
        status.textContent = `Off · ${s.refs} reference(s) saved.`;
      } else if (s.gameRunning === false) {
        status.textContent =
          `Waiting for ${s.gameProcess || 'the game'} to start… (no screen capture until then)`;
      } else {
        const score = typeof s.score === 'number' ? s.score.toFixed(2) : '–';
        status.textContent =
          `Map: ${s.open ? 'OPEN' : 'closed'} · similarity ${score} ` +
          `(opens ≥ ${s.openThreshold}) · ${s.refs} reference(s)`;
      }
    }

    toggle.addEventListener('change', async () => render(await api.set({ enabled: toggle.checked })));
    clearBtn.addEventListener('click', async () => render(await api.clear()));
    calibrateBtn.addEventListener('click', async () => {
      calibrateBtn.disabled = true;
      render(null, 'Switch to the game and open the map… (this window steps aside for 5 s)');
      let result;
      try {
        result = await api.calibrate({ delayMs: 5000 });
      } catch (err) {
        result = { ok: false, error: String(err) };
      }
      calibrateBtn.disabled = false;
      if (result?.ok) {
        render(result, `Saved! ${result.refs} reference(s). Open the map to test it.`);
      } else {
        const why =
          result?.error === 'blank-frame'
            ? 'The screenshot was blank. Is the game visible and in borderless-window mode?'
            : 'Could not take the snapshot.';
        render(null, why);
      }
    });

    api.onStatus(state => {
      if (!calibrateBtn.disabled) render(state);
    });
    api.get().then(state => render(state));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build, { once: true });
  else build();
})();
