(() => {
  // The borderless finder (second monitor) has no title bar, so give it minimise / close buttons.
  if (typeof window === 'undefined' || !window.document || !window.app?.finderWindow) return;

  function build() {
    const box = document.createElement('div');
    box.className = 'window-controls';
    const mk = (text, title, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.title = title;
      b.addEventListener('click', onClick);
      box.appendChild(b);
    };
    mk('–', 'Minimize', () => window.app.finderWindow.minimize());
    mk('✕', 'Close (quits the app)', () => window.app.finderWindow.close());
    document.body.appendChild(box);
  }

  window.app.finderWindow
    .info()
    .then(info => {
      if (info && info.borderless) {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build, { once: true });
        else build();
      }
    })
    .catch(() => {});
})();
