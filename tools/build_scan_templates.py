#!/usr/bin/env python3
"""
Builds public/assets/data/scan_templates.json for the in-game map scanner.

Run from the project root (needs Pillow):   python tools/build_scan_templates.py

  icons: every public/assets/buildingIcons/*.webp, downscaled to 64x64 RGBA
  maps : every public/assets/mapTypes/*.webp, downscaled to 128x128 luminance

The app has no WebP decoder in its worker thread, so we store plain pixels (base64).
Re-run this script if the icon or map art changes.
"""
import base64, glob, json, os, sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON = 64
MAP = 128

def b64(b): return base64.b64encode(b).decode('ascii')

icons = {}
for f in sorted(glob.glob(os.path.join(ROOT, 'public/assets/buildingIcons/*.webp'))):
    name = os.path.splitext(os.path.basename(f))[0]
    im = Image.open(f).convert('RGBA').resize((ICON, ICON), Image.LANCZOS)
    icons[name] = {'w': ICON, 'h': ICON, 'rgba': b64(im.tobytes())}

maps = {}
for f in sorted(glob.glob(os.path.join(ROOT, 'public/assets/mapTypes/*.webp'))):
    name = os.path.splitext(os.path.basename(f))[0]
    im = Image.open(f).convert('L').resize((MAP, MAP), Image.LANCZOS)
    maps[name] = {'w': MAP, 'h': MAP, 'lum': b64(im.tobytes())}

out = os.path.join(ROOT, 'public/assets/data/scan_templates.json')
with open(out, 'w') as fh:
    json.dump({'version': 1, 'iconSize': ICON, 'mapSize': MAP, 'icons': icons, 'maps': maps}, fh, separators=(',', ':'))
print(f'wrote {out}: {len(icons)} icons, {len(maps)} maps, {os.path.getsize(out)/1024:.0f} KB')
