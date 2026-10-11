// Run with:  node tests/gameProcess.test.js   (also part of `npm test`)
const assert = require('assert');
const { createGameProcessCheck, sanitize } = require('../app/main/gameProcess');

// Fake child_process.execFile: records calls, answers with canned tasklist output.
function fakeRun(output, error = null) {
  const calls = [];
  const run = (cmd, args, opts, cb) => { calls.push({ cmd, args, opts }); setImmediate(() => cb(error, output)); };
  run.calls = calls;
  return run;
}
const RUNNING = '"nightreign.exe","12345","Console","1","2,345,678 K"\r\n';
const NOT_RUNNING_EN = 'INFO: No tasks are running which match the specified criteria.\r\n';
const NOT_RUNNING_DE = 'INFORMATION: Es werden keine Aufgaben mit den angegebenen Kriterien ausgeführt.\r\n';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ok  -', name); };
const win = (run, extra = {}) => createGameProcessCheck({ processName: 'nightreign.exe', platform: 'win32', run, ...extra });

(async () => {
  await test('detects a running game', async () => {
    assert.strictEqual(await win(fakeRun(RUNNING)).isRunning(), true);
  });
  await test('detects a closed game (English and German tasklist messages)', async () => {
    assert.strictEqual(await win(fakeRun(NOT_RUNNING_EN)).isRunning(), false);
    assert.strictEqual(await win(fakeRun(NOT_RUNNING_DE)).isRunning(), false);
  });
  await test('is case-insensitive about the process name', async () => {
    const c = createGameProcessCheck({ processName: 'NightReign.EXE', platform: 'win32', run: fakeRun(RUNNING) });
    assert.strictEqual(await c.isRunning(), true);
  });
  await test('does not mistake a similarly named process for the game', async () => {
    const other = '"nightreign_launcher.exe","1","Console","1","10 K"\r\n';
    assert.strictEqual(await win(fakeRun(other)).isRunning(), false);
  });
  await test('asks Windows without a shell and without a console window', async () => {
    const run = fakeRun(RUNNING); await win(run).isRunning();
    assert.strictEqual(run.calls[0].cmd, 'tasklist');
    assert.deepStrictEqual(run.calls[0].args, ['/FI', 'IMAGENAME eq nightreign.exe', '/FO', 'CSV', '/NH']);
    assert.strictEqual(run.calls[0].opts.windowsHide, true);
  });
  await test('caches the answer, so the process list is not queried on every tick', async () => {
    const run = fakeRun(RUNNING); const c = win(run);
    for (let i = 0; i < 6; i++) await c.isRunning();
    assert.strictEqual(run.calls.length, 1);
  });
  await test('concurrent callers share one query', async () => {
    const run = fakeRun(RUNNING); const c = win(run);
    await Promise.all([c.isRunning(), c.isRunning(), c.isRunning()]);
    assert.strictEqual(run.calls.length, 1);
  });
  await test('re-checks after the cache expires', async () => {
    const run = fakeRun(RUNNING); const c = win(run, { ttlMs: 0 });
    await c.isRunning(); await c.isRunning();
    assert.strictEqual(run.calls.length, 2);
  });
  await test('if tasklist fails, it fails open (assumes running) instead of disabling the feature', async () => {
    const origWarn = console.warn; console.warn = () => {};
    try { assert.strictEqual(await win(fakeRun('', new Error('nope'))).isRunning(), true); }
    finally { console.warn = origWarn; }
  });
  await test('empty name or non-Windows platform: never gates', async () => {
    const run = fakeRun(NOT_RUNNING_EN);
    assert.strictEqual(await createGameProcessCheck({ processName: '', platform: 'win32', run }).isRunning(), true);
    assert.strictEqual(await createGameProcessCheck({ processName: 'x.exe', platform: 'linux', run }).isRunning(), true);
    assert.strictEqual(run.calls.length, 0);
  });
  await test('process names are sanitised', async () => {
    assert.ok(!/["&|<>%^]/.test(sanitize('a.exe" & calc | del *.* > x %PATH% ^')));
    assert.strictEqual(sanitize('  nightreign.exe '), 'nightreign.exe');
  });

  console.log(`\n${passed} tests passed`);
})().catch(err => { console.error(err); process.exit(1); });
