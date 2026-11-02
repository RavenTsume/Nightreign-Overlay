#!/usr/bin/env python3
"""
Makes SYNTHETIC "in-game map panel" screenshots for testing the scanner.

  python tests/tools/make_panels.py <outdir> <n> [rngseed]

For random seeds it composites the finder's own map art + icons the way the game would
draw them (shifted/scaled map, icons at an unknown size, glow, blur, noise, JPEG, colour
shift, distractor markers) and writes   <outdir>/<seed_id>_<variant>.bgra  plus index.json.
This only exercises the pipeline; it cannot prove the real game looks the same.
"""
import io, json, os, random, sys
from PIL import Image, ImageFilter, ImageDraw, ImageEnhance
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
A = os.path.join(ROOT, 'public/assets')
out, n = sys.argv[1], int(sys.argv[2])
rng = random.Random(int(sys.argv[3]) if len(sys.argv) > 3 else 7)
os.makedirs(out, exist_ok=True)

seeds = json.load(open(f'{A}/data/seed_data.json'))
coords = {c['id']: (c['x'], c['y']) for c in json.load(open(f'{A}/data/coordsXY.json'))}
MAPFILE = {'Default': 'Default', 'Crater': 'Crater', 'Mountaintop': 'Mountaintop',
           'Rotted Woods': 'Rotted Woods', 'Noklateo, the Shrouded City': 'Noklateo, the Shrouded City'}
maps = {k: Image.open(f'{A}/mapTypes/{v}.webp').convert('RGB') for k, v in MAPFILE.items()}
icons = {}
def icon(name):
    if name not in icons: icons[name] = Image.open(f'{A}/buildingIcons/{name}.webp').convert('RGBA')
    return icons[name]
nl = {}
def nightlord(name):
    if name not in nl: nl[name] = Image.open(f'{A}/nightlordIcons/{name}.webp').convert('RGBA')
    return nl[name]

STRESS = os.environ.get('STRESS') == '1'      # harsher conditions
PW, PH = 993, 974            # panel size on a 2560x1440 screen
index = []
pool = rng.sample(seeds, n)
for i, seed in enumerate(pool):
    # --- how the "game" frames the map (unknown to the scanner) ---
    s = rng.uniform(0.97, 1.04); tx = rng.uniform(-0.012, 0.012); ty = rng.uniform(-0.012, 0.012)
    k = rng.choice([0.85, 1.0, 1.15])              # icon size vs the finder's 1/14
    gain = rng.uniform(0.9, 1.1)
    blur = rng.uniform(0.4, 0.9); noise = 3; jq = 82
    if STRESS:
        s = rng.uniform(0.93, 1.07); tx = rng.uniform(-0.05, 0.05); ty = rng.uniform(-0.05, 0.05)
        k = rng.choice([0.7, 0.8, 1.3, 1.4]); gain = rng.uniform(0.75, 1.25)
        blur = rng.uniform(0.9, 1.6); noise = 6; jq = 60

    bg = maps[seed['map_type']].copy()
    # panel_uv = 0.5 + s*(map_uv-0.5) + t   ->  affine on the 1000px map
    sx, sy = PW / (1000 * s), PH / (1000 * s)
    ox = -(0.5 + tx - 0.5 * s) * PW / s * 1.0
    oy = -(0.5 + ty - 0.5 * s) * PH / s * 1.0
    # PIL affine maps OUTPUT pixel (x,y) -> INPUT pixel (a*x+b*y+c, d*x+e*y+f)
    a = 1000 / (PW * s); e = 1000 / (PH * s)
    c = 500 - (0.5 + tx) * PW * a
    f = 500 - (0.5 + ty) * PH * e
    panel = bg.transform((PW, PH), Image.AFFINE, (a, 0, c, 0, e, f), resample=Image.BICUBIC, fillcolor=(18, 18, 20)).convert('RGBA')

    def uv(x, y):  # slot (1000px map coords) -> panel pixel
        return ((0.5 + s * (x / 1000 - 0.5) + tx) * PW, (0.5 + s * (y / 1000 - 0.5) + ty) * PH)

    isize = int(round(PW * s * k / 14))
    for sid, (x, y) in coords.items():
        if sid == 'nightlord':
            px, py = uv(x, y); big = int(isize * 1.9)
            im = nightlord(seed['nightlord']).resize((big, big), Image.LANCZOS)
            panel.alpha_composite(im, (int(px - big / 2), int(py - big / 2)))
            continue
        v = seed['slots'].get(sid, '')
        if v in ('', 'empty'): continue
        px, py = uv(x, y)
        px += rng.uniform(-3, 3); py += rng.uniform(-3, 3)
        im = icon(v).resize((isize, isize), Image.LANCZOS)
        panel.alpha_composite(im, (int(px - isize / 2), int(py - isize / 2)))

    # distractors: player marker + a couple of light blobs (fog / UI)
    d = ImageDraw.Draw(panel, 'RGBA')
    for _ in range(2):
        cx, cy = rng.uniform(150, PW - 150), rng.uniform(150, PH - 150)
        d.polygon([(cx, cy - 12), (cx - 9, cy + 10), (cx + 9, cy + 10)], fill=(240, 240, 255, 230))
    panel = panel.convert('RGB')
    panel = panel.filter(ImageFilter.GaussianBlur(blur))
    panel = ImageEnhance.Brightness(panel).enhance(gain)
    arr = np.asarray(panel).astype(np.float32) + np.random.RandomState(i).normal(0, noise, (PH, PW, 3))
    panel = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    buf = io.BytesIO(); panel.save(buf, 'JPEG', quality=jq); buf.seek(0); panel = Image.open(buf).convert('RGB')

    rgb = np.asarray(panel)
    for v in range(2):                                 # two "screenshots" with different noise
        a2 = np.clip(rgb.astype(np.float32) + np.random.RandomState(100 + i * 2 + v).normal(0, 2, rgb.shape), 0, 255).astype(np.uint8)
        bgra = np.dstack([a2[:, :, 2], a2[:, :, 1], a2[:, :, 0], np.full((PH, PW), 255, np.uint8)])
        open(os.path.join(out, f"{seed['seed_id']}_{v}.bgra"), 'wb').write(bgra.tobytes())
    index.append({'seed_id': seed['seed_id'], 'map_type': seed['map_type'], 'k': k, 's': round(s, 3), 'tx': round(tx, 4), 'ty': round(ty, 4), 'w': PW, 'h': PH})
json.dump(index, open(os.path.join(out, 'index.json'), 'w'))
print(f'wrote {n} seeds x2 frames to {out}')
