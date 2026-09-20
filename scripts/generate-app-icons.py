"""Package the tracked Synax master PNG as desktop/web icons (requires Pillow)."""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
RESOURCES = ROOT / 'electron/resources'
PUBLIC = ROOT / 'web/public'

with Image.open(RESOURCES / 'icon.png') as master:
    source = master.convert('RGBA')

if source.size != (1024, 1024):
    raise ValueError('Expected the approved 1024×1024 Synax master PNG')

source.save(RESOURCES / 'icon.icns')
source.save(RESOURCES / 'icon.ico', sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])
source.save(PUBLIC / 'favicon.ico', sizes=[(n, n) for n in (16, 32, 48)])
for filename, size in [('favicon-16x16.png', 16), ('favicon-32x32.png', 32),
                       ('apple-touch-icon.png', 180), ('icon-192.png', 192)]:
    source.resize((size, size), Image.Resampling.LANCZOS).save(PUBLIC / filename)
