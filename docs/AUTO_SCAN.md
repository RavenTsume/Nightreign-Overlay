# Automatic map scan (fork addition)

This fork adds a **Scan map** button. It switches to Nightreign, waits until you open the in-game map,
takes two screenshots, reads the icons on the map and shows the matching seed (map type and Nightlord
are detected automatically). The overlay then draws the POI labels on top of the map as before.

Original overlay and seed data: shahf215/Nightreign-Overlay (see CREDITS.md).

## Using it

1. Start Nightreign (borderless windowed, on your primary monitor) and the overlay.
2. Click **Scan map**. The app brings the game to the front.
3. Open the map (**M**). Two screenshots are taken, the finder shows the seed, the overlay shows the POIs.
4. After the first successful scan the overlay opens/closes by itself with the map
   (checkbox "Show overlay automatically…"). Press **M** to open; **M**, **Esc** or the **right mouse button**
   close it. While the map is open the app does not poll the screen; a close key triggers one confirming
   screenshot (so a right-click that does not close the map does not hide the labels).
5. Every POI is marked with a small circle on its exact spot, with the label just above it. The **same POIs are drawn
   on the finder map** too (same POI settings, colours and font size as the overlay; switch them off with
   "Show the POIs on this finder map" in the Overlay Options).
6. If a scan is unsure, the finder map is pre-filled with the slots it recognised (the ones that agree with the best
   guess). Click the remaining slots to correct or complete it, like the manual workflow. **Reset** clears it.

If a scan fails, click **Scan files**: the last 10 scans are saved there (`panel-1.png`, `panel-2.png`,
`result.json`) so you can see what the app saw.

## Route suggestions

Once a seed is shown, the finder suggests **up to three boss routes** for Day 1 and Day 2 that collect enough runes
for level 15 (or the goal you pick). They appear as small maps on the right; click one to draw it on the big map
(numbered stops per day, blue = Day 1, orange = Day 2, S = spawn, N1/N2 = the night boss arenas).

* **Fastest to level 15** (if it can be reached), **Most runes**, **Lowest risk**. When one plan is the best by two
  measures the labels are merged; a plan that is only "similar" is shown as an *alternative* and labelled so.
* If level 15 cannot be reached from bosses alone, the panel says so and shows how far each plan falls short.
  Level 15 needs 513,116 runes in total; plans count as reaching it when normal enemies only have to add up to
  20,000. Your Day 1 goal (level 10) is preferred when ranking.
* **Settings** (saved): *Pace* (relaxed / team / fast), *Goal* level, *Solo* (+50% runes), and *Night invasion on
  Day 1 / Day 2*. An invasion (about one expedition in five) adds the invader's 12,000 runes and about 3.5 minutes
  of fighting; they come to you, so there is no travel. Tick it when an invader shows up and the routes re-plan.
* Switch the panel off with Overlay Options > "Show route suggestions beside the map".

What is real and what is assumed (also written under the panel):

| Real | Assumed (adjustable in `src/core/routePlanner.js` `DEFAULTS`) |
|---|---|
| boss positions, spawn point, night arenas (from the seed); rune values (`nightreign_rune_drops.json`, wiki data from June 2025); level costs; 14-minute days with the circle closing from 4:30 | travel speed (crossing the map takes 2.2 min), fight time per boss (0.5 min + 0.06 min per 1,000 runes, times the pace), the size of the closing circles (centred on the night arena), Day 2 starting at the spawn point |

So the minutes are estimates. If your own fights are faster or slower, change the pace. Bosses with no published
value use an estimate and are marked with ≈. Not modelled: the extra night boss some seeds have, the evergaol
"Rune of the Strong" bonus, runes from ordinary enemies beyond the 20,000 tolerance, and routes in the in-game overlay.

How it works: for each day a beam search over (bosses visited, position, time) finds good routes under the day's
time and circle limits, in several modes (most runes, efficient, quick, lowest risk). The best Day 1 routes, including
ones that deliberately avoid the best route's area, are combined with the best Day 2 routes over the bosses that are
left. On small problems it finds the same optimum as brute force (tested), and on real seeds it stays within about 2%
of a ten times slower search. It runs in small steps so the window never freezes.

## The finder window

* **One monitor:** a normal window, as before.
* **Two or more monitors:** the finder opens as a **borderless window covering the second monitor** (the largest
  monitor that is not the primary one), so the game keeps the primary screen and the finder is a big second screen.
  It has small minimise (–) and close (✕) buttons in the top-right corner, since there is no title bar. Closing it quits
  the app, like closing the normal window. Plug a monitor in or out and the finder moves/rebuilds itself and shows the
  last scanned seed again.
* **Forget map** puts everything back to the start: stops a running scan, drops the remembered seed, clears the map and
  POIs in the finder and the labels in the overlay. **Reset auto-open** only forgets what the open map looks like (the
  next scan teaches it again).
* **Overlay Options > "Show the POI overlay over the game map automatically"**: when switched off the overlay never
  opens or closes by itself and no screenshots are taken to watch the map (the overlay hotkey still shows it by hand).
  The setting is saved in `config/autodetect.json` (`enabled`).

## How it works

```
Scan map -> game running? -> focus window -> wait for the map -> 2 screenshots
         -> worker thread: align to the map art -> read 27 slots -> match 320 seeds -> seed id
         -> finder applies the seed (selectMap / updateSelection / applySelections) -> overlay
```

| File | Job |
|---|---|
| `app/main/autoScan.js` | the whole scan session (status updates, waiting, screenshots, result) |
| `app/main/scanWorker.js` | runs the heavy analysis in a worker thread (no stutter) |
| `app/main/windowFocus.js` | brings the game window to the front (PowerShell `SetForegroundWindow`) |
| `app/main/gameProcess.js` | "is nightreign.exe running?" via `tasklist` |
| `app/main/keyState.js` | reads whether M/Esc/a mouse button is held (`GetAsyncKeyState` via optional `koffi`; the key still reaches the game) |
| `app/main/mapWatcher.js` | optional auto-open of the overlay; takes screenshots only after M/Esc or while the map is open |
| `src/core/mapScan.js` | the image analysis: alignment, per-slot icon matching, spawn rule |
| `src/core/seedMatch.js` | finds the best of the 320 seeds, tolerates misreads |
| `src/core/mapSignature.js`, `scanGate.js` | cheap "is the map open?" check and the key trigger logic |
| `src/core/png.js` | PNG writer used in the worker thread for the debug screenshots |
| `src/overlay/runtime/renderer.js` | draws the labels and the POI circles |
| `src/finder/runtime/autodetect.js` | the Scan panel in the finder window (Scan, Forget map, results) |
| `src/core/routePlanner.js` | the route planner (pure logic; see "Route suggestions") |
| `src/finder/runtime/route-view.js` | the route panel, the mini maps and the route on the big map |
| `src/finder/runtime/poi-view.js` | draws the POIs on the finder map using the overlay's own modules |
| `src/finder/runtime/window-controls.js` | minimise / close buttons for the borderless finder |
| `src/core/finderPlacement.js` | decides normal window vs. borderless on the second monitor |
| `src/core/overlayPolicy.js` | when the overlay may show / hide itself (honours the automatic-overlay option) |
| `tools/build_scan_templates.py` | rebuilds `public/assets/data/scan_templates.json` from the icon and map art |

Ideas the scanner relies on:

* The overlay's POI coordinates equal the finder's slot coordinates / 1000, so the in-game panel shows the
  same 1000x1000 map. The scanner finds how that panel is shifted/scaled by correlating the terrain with
  the known map art (this also tells the map type).
* Each of the 27 slots is matched against all icon templates (alpha-weighted correlation). Variants of one
  icon family (ruins_fire, ruins_frostbite…) are told apart on their badge square.
* Every seed has exactly one spawn marker; it is faint, so the slot with the strongest blue glow gets it.
* All 320 layouts are unique and differ by at least 11 slots, so a few misreads do not change the winner.

## Settings (`config/autodetect.json`)

| Key | Meaning |
|---|---|
| `gameProcess` | game exe name (check Task Manager > Details). `""` = don't check |
| `mapKey` | the in-game map key the scan waits for (default `M`) |
| `trigger` | `"keys"` = look only after a key press, `"always"` = keep looking (controller-only players) |
| `openKeys` | keys that start a look while the map is closed (default `["M"]`; the Scan button waits for the first) |
| `closeKeys` | keys that check for a close while the map is open (default `M`, `Escape`, `RightMouse`; also `LeftMouse`, `MiddleMouse`, `Mouse4`, `Mouse5`, letters, `F1`..`F24`) |
| `burstMs`, `closeBurstMs` | how long to look after an open key / a close key |
| `openPollMs` | map open and nothing pressed: one slow safety look this often (default 5000) |
| `captureWidth` | width of the screenshots used for watching (default 640; smaller = lighter) |
| `openThreshold`, `closeThreshold` | similarity needed to call the map open / closed |

Scan tuning (icon size range, thresholds) is in `DEFAULTS` at the top of `src/core/mapScan.js`.

## Tests

`npm test` runs everything (about 100 tests, ~1 minute). The end-to-end test needs Python with Pillow and
numpy to render synthetic map screenshots (`tests/tools/make_panels.py`); without them it is skipped.
The synthetic screenshots reuse the finder's own art, so they prove the pipeline, not that the real game
looks identical. If real scans misbehave, the files in **Scan files** show why.

## Why the mouse used to stutter, and what was changed

* The overlay window was created with `setIgnoreMouseEvents(true, { forward: true })`. On Windows that installs a
  system-wide low-level mouse hook in the app's main thread, so any hiccup in that thread freezes the cursor for
  everything. The overlay has no mouse handling at all, so the option was removed.
* The map watcher no longer polls while the map is open (close keys + one slow safety look instead) and uses smaller
  screenshots. Nothing is captured during normal gameplay.
* Heavy work (image analysis, PNG encoding) runs in a worker thread, never on the main thread.
