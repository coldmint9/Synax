"""Generate app icons from the approved Sketch preview (requires Pillow)."""
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
RESOURCES = ROOT / 'electron/resources'
PUBLIC = ROOT / 'web/public'

with ZipFile(RESOURCES / 'Synax-Liquid-Glass.sketch') as sketch:
    with Image.open(BytesIO(sketch.read('previews/preview.png'))) as preview:
        source = preview.convert('RGBA')

if source.size != (1024, 1024):
    raise ValueError('Expected the approved 1024×1024 Sketch preview')

source.save(RESOURCES / 'icon.png')
source.save(RESOURCES / 'icon.icns')
source.save(RESOURCES / 'icon.ico', sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])
source.save(PUBLIC / 'favicon.ico', sizes=[(n, n) for n in (16, 32, 48)])
for filename, size in [('favicon-16x16.png', 16), ('favicon-32x32.png', 32),
                       ('apple-touch-icon.png', 180), ('icon-192.png', 192)]:
    source.resize((size, size), Image.Resampling.LANCZOS).save(PUBLIC / filename)
