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
