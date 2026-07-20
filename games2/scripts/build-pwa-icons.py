#!/usr/bin/env python3
"""Generate the PWA icons (client/public/icons/) from the Nangijala emblem —
the maintainer's rune-ringed medallion (scripts/assets/icon-medallion-src.png),
the standalone icon form of the title logo. Baked onto a square near-black field
(matching the emblem's own backdrop) so it reads as the home-screen icon AND the
Android launch splash (which centres the 512 icon on background_color).

Two framings:
  * STANDARD (192 / 512 / apple-touch) — emblem ~92% of the width, a slim margin;
    shown un-cropped, so it fills the tile.
  * MASKABLE (icon-maskable-512) — emblem ~70% of the width, centred, so a
    launcher's circular / squircle crop keeps the whole ring + sword + staff
    inside the safe zone.

PIXEL ART rule (maintainer): downscaling the ~1172px master to the final icon
sizes is a BAKE to display resolution, so box-average (Image.BOX) is the right,
sanctioned filter — never a smoothing upscale. Deterministic: re-running with the
same source produces identical files.

Run from games2/:  python3 scripts/build-pwa-icons.py
"""
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "scripts" / "assets" / "icon-medallion-src.png"
OUT = ROOT / "client" / "public" / "icons"
BG = (6, 8, 15, 255)  # #06080f — the emblem's own near-black backdrop


def emblem() -> Image.Image:
    """The source cropped tight to its visible art (ring + weapons + glow),
    trimming the dead near-black border so framing is predictable."""
    im = Image.open(SRC).convert("RGBA")
    lum = np.array(im)[:, :, :3].astype(int).sum(axis=2)
    ys, xs = np.where(lum > 60)
    return im.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))


def framed(art: Image.Image, frac: float) -> Image.Image:
    """Centre `art` on a square near-black field, sized so the art's WIDTH is
    `frac` of the side (the emblem is widest across the sword<->staff)."""
    ew, eh = art.size
    side = round(ew / frac)
    canvas = Image.new("RGBA", (side, side), BG)
    canvas.alpha_composite(art, ((side - ew) // 2, (side - eh) // 2))
    return canvas


def bake(master: Image.Image, size: int, name: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    master.resize((size, size), Image.BOX).save(OUT / name)
    print(f"  icons/{name} ({size}x{size})")


def main() -> None:
    art = emblem()
    print(f"emblem art {art.size} from {SRC.name}")
    std = framed(art, 0.92)   # fills the tile
    mask = framed(art, 0.70)  # safe zone for circular crops
    bake(std, 512, "icon-512.png")
    bake(std, 192, "icon-192.png")
    bake(std, 180, "apple-touch-icon.png")
    bake(mask, 512, "icon-maskable-512.png")


if __name__ == "__main__":
    main()
