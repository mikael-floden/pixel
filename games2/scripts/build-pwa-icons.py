#!/usr/bin/env python3
"""Generate the PWA icons (client/public/icons/) — a pixel-art crescent moon
over a night sky, drawn on a 32x32 grid and nearest-neighbour upscaled so it
stays crisp. Deterministic: re-running produces identical files.

Run from games2/:  python3 scripts/build-pwa-icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "client" / "public" / "icons"

BG = (18, 18, 28, 255)  # #12121c — the game's background
MOON = (207, 224, 255, 255)  # #cfe0ff — the title colour
MOON_SHADE = (138, 155, 205, 255)
STAR = (255, 214, 120, 255)  # #ffd678 — the accent colour


def draw_base(size: int = 32, pad: int = 0) -> Image.Image:
    """The 32px master. `pad` insets the artwork (maskable icons need ~20%
    safe zone so launchers can crop to circles without clipping the moon)."""
    img = Image.new("RGBA", (size, size), BG)
    d = ImageDraw.Draw(img)
    cx, cy, r = 16, 16, 10 - pad
    # Crescent = full disc minus an offset disc (classic).
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=MOON)
    d.ellipse([cx - r + 5, cy - r - 2, cx + r + 5, cy + r - 2], fill=BG)
    # A little terminator shading along the inner edge.
    d.ellipse([cx - r + 4, cy - r - 1, cx + r + 4, cy + r - 1], outline=MOON_SHADE)
    d.ellipse([cx - r + 5, cy - r - 2, cx + r + 5, cy + r - 2], fill=BG)
    # Stars (fixed positions, inside the safe zone).
    for x, y in [(7, 6), (24, 5), (26, 24), (6, 25), (22, 12)]:
        d.point((x, y), fill=STAR)
    d.point((7, 5), fill=STAR)
    d.point((24, 4), fill=STAR)
    return img


def save(img: Image.Image, size: int, name: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    img.resize((size, size), Image.NEAREST).save(OUT / name)
    print(f"  icons/{name} ({size}x{size})")


def main() -> None:
    base = draw_base()
    save(base, 192, "icon-192.png")
    save(base, 512, "icon-512.png")
    save(base, 180, "apple-touch-icon.png")
    save(draw_base(pad=3), 512, "icon-maskable-512.png")


if __name__ == "__main__":
    main()
