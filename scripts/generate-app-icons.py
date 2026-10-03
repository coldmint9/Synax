"""Generate Synax desktop and notification icons from the canonical SVG mark.

The SVG stays the source of truth for browser theme adaptation. The generated
PNG, ICO, and ICNS files are compatibility derivatives for Electron and OS
surfaces that do not accept SVG input.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "client/public"
RESOURCES = ROOT / "electron/resources"
SOURCE = PUBLIC / "synax-icon.svg"
PUBLIC_PNG = PUBLIC / "synax-icon.png"
RESOURCE_PNG = RESOURCES / "synax-icon.png"
RESOURCE_ICO = RESOURCES / "synax-icon.ico"
RESOURCE_ICNS = RESOURCES / "synax-icon.icns"


def find_rsvg_convert() -> str:
    executable = shutil.which("rsvg-convert")
    if not executable:
        raise RuntimeError(
            "rsvg-convert is required to rasterize synax-icon.svg; "
            "install librsvg and retry."
        )
    return executable


def main() -> None:
    if not SOURCE.exists():
        raise FileNotFoundError(f"Missing canonical Synax icon: {SOURCE}")

    # The SVG defaults to the dark artwork for native surfaces. Browsers
    # consume the same canonical SVG and apply its light/dark media query.
    subprocess.run(
        [
            find_rsvg_convert(),
            "-w",
            "1024",
            "-h",
            "1024",
            "-o",
            str(PUBLIC_PNG),
            str(SOURCE),
        ],
        check=True,
    )
    shutil.copyfile(PUBLIC_PNG, RESOURCE_PNG)

    with Image.open(PUBLIC_PNG) as master:
        source = master.convert("RGBA")
        if source.size != (1024, 1024):
            raise ValueError("Expected a 1024×1024 Synax raster derivative")
        source.save(
            RESOURCE_ICNS,
            sizes=[
                (16, 16),
                (32, 32),
                (128, 128),
                (256, 256),
                (512, 512),
                (1024, 1024),
            ],
        )
        source.save(
            RESOURCE_ICO,
            sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)],
        )


if __name__ == "__main__":
    main()
