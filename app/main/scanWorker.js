/**
 * scanWorker.js  (worker thread)
 *
 * Runs the heavy image analysis off the main thread so the app (and your mouse) never stalls.
 * All data arrives as strings in workerData; the worker needs no file access.
 *
 *   job.type 'check' -> {open, score, map}                         (is the map on screen?)
 *   job.type 'scan'  -> {ok, mapOpen, align, slots, match, ms}     (read icons, find the seed)
 *   job.type 'png'   -> {pngs}                                     (encode screenshots for the debug folder)
 */
const { parentPort, workerData } = require('worker_threads');
const scan = require('../../src/core/mapScan');
const { matchSeeds } = require('../../src/core/seedMatch');
const { encodePng } = require('../../src/core/png');

function run({ job, templatesJson, seedsJson, slotsJson }) {
  const t0 = Date.now();
  if (job.type === 'png') return { pngs: job.frames.map(f => encodePng(f)) };
  const templates = scan.loadTemplates(JSON.parse(templatesJson));
  const frames = job.frames.map(f => ({ width: f.width, height: f.height, data: f.data }));

  if (job.type === 'check') {
    const r = scan.checkMapOpen(frames[0], templates, job.options);
    return { open: r.open, score: r.score, map: r.map, ms: Date.now() - t0 };
  }

  const slots = JSON.parse(slotsJson);
  const results = frames.map(f => scan.classifyFrame(f, templates, slots, job.options));
  const opened = results.filter(r => r.open);
  const align = results[0].align;
  const alignInfo = { map: align.map, score: Math.round(align.score * 1000) / 1000, s: align.s, tx: align.tx, ty: align.ty };
  if (opened.length === 0) {
    return { ok: false, reason: 'map-not-visible', mapOpen: false, align: alignInfo, ms: Date.now() - t0 };
  }
  const slotsFused = scan.fuse(opened, job.options);
  const match = matchSeeds(slotsFused, JSON.parse(seedsJson), job.match);
  return { ok: match.ok, reason: match.ok ? null : 'low-confidence', mapOpen: true, align: alignInfo, slots: slotsFused, match, framesUsed: opened.length, ms: Date.now() - t0 };
}

try {
  parentPort.postMessage({ ok: true, result: run(workerData) });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String((err && err.stack) || err) });
}
