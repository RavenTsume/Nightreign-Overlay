/**
 * gameProcess.js  (Electron main process)
 *
 * Answers "is the game running?" by asking Windows for its process list (`tasklist`,
 * the same thing Task Manager shows). It only looks at whether a process with that
 * name exists; it never opens, reads or touches the game process itself.
 *
 * The map watcher uses this so it takes NO screenshots while the game is closed.
 */
const { execFile } = require('child_process');

// Only characters that can appear in an .exe file name (no shell is involved anyway).
const sanitize = name => String(name || '').trim().replace(/[^A-Za-z0-9._ -]/g, '');

function createGameProcessCheck({
  processName,
  ttlMs = 3000,
  platform = process.platform,
  run = execFile,
} = {}) {
  const name = sanitize(processName);

  // No name configured (or not Windows): don't gate anything.
  if (!name || platform !== 'win32') {
    return { name, isRunning: async () => true };
  }

  let cached = { at: -Infinity, value: false };
  let pending = null;
  let warned = false;

  function query() {
    return new Promise(resolve => {
      run(
        'tasklist',
        ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'],
        { windowsHide: true, timeout: 4000 },
        (err, stdout) => {
          if (err) {
            // If we can't ask, don't break the feature: assume the game is running.
            if (!warned) {
              warned = true;
              console.warn('[gameProcess] tasklist failed; assuming the game is running', err);
            }
            return resolve(true);
          }
          // CSV output quotes the image name; the "no tasks" message (any language) does not.
          resolve(String(stdout).toLowerCase().includes(`"${name.toLowerCase()}"`));
        }
      );
    });
  }

  async function isRunning() {
    if (Date.now() - cached.at < ttlMs) return cached.value;
    if (!pending) {
      pending = query().then(value => {
        cached = { at: Date.now(), value };
        pending = null;
        return value;
      });
    }
    return pending;
  }

  return { name, isRunning };
}

module.exports = { createGameProcessCheck, sanitize };
