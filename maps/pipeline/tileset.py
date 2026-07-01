"""Tile library loader for the Maps agent.

Reads the focused tile sets produced by the tiles agent
(`tiles/<category>/tiles.json` + `tile_NN.png`), measures the isometric
alignment geometry directly from the pixels, and hands the Maps assembler a
uniform way to look up any tile image.

Every ground tile is a 64x64 transparent PNG holding one isometric block
(diamond top + two 50%-thickness side faces). Because every category is drawn
to the *same* house format (64px / 28 deg / 50%), one measured geometry applies
to all of them, so categories mix freely on a single grid.

Nothing here talks to PixelLab: assembling a map is pure compositing of tiles
the tiles agent already generated. The Maps agent owns orchestration and the
viewer; it never re-draws art.
"""

from __future__ import annotations

import json
import os
from functools import lru_cache

import numpy as np
from PIL import Image

# maps/ -> pixel/ ; tiles live at pixel/tiles/
_PIPELINE_DIR = os.path.dirname(os.path.abspath(__file__))
MAPS_DIR = os.path.dirname(_PIPELINE_DIR)
REPO_ROOT = os.path.dirname(MAPS_DIR)
TILES_ROOT = os.path.join(REPO_ROOT, "tiles")


def measure_geometry(img: Image.Image, tile_size: int = 64) -> dict:
    """Measure the iso alignment of one rendered tile.

    Returns the grid steps and the per-level vertical rise, all in pixels,
    anchored to the tile's full 64x64 box (its top-left corner is the anchor).
    Placement for grid cell (col, row):

        screen_x = origin_x + (col - row) * grid_dx
        screen_y = origin_y + (col + row) * grid_dy

    Raising a cell one elevation level subtracts ``level_height`` from screen_y.
    Draw back-to-front by increasing (col + row), and within a stacked cell draw
    bottom level first, so side faces overlap correctly.
    """
    a = np.asarray(img.convert("RGBA"))
    alpha = a[:, :, 3] > 16
    cols = np.where(alpha.any(axis=0))[0]
    if len(cols) == 0:
        return {}
    xmin, xmax = int(cols.min()), int(cols.max())
    cx = (xmin + xmax) // 2
    apex_y = int(np.where(alpha[:, cx])[0].min())
    left_col = np.where(alpha[:, xmin])[0]
    left_corner_y = int(left_col.min())
    level_height = int(left_col.max() - left_col.min() + 1)  # side-face height
    dy = left_corner_y - apex_y                              # half diamond-top height
    return {
        "grid_dx": tile_size // 2,
        "grid_dy": dy,
        "diamond_top_height": dy * 2,
        "level_height": level_height,
    }


class TileSet:
    """All tile categories on disk, plus the shared iso geometry.

    Lazily loads and caches tile PNGs. A *category* is any ``tiles/<id>/`` with
    a ``tiles.json``; each exposes ``count`` interchangeable variant tiles.
    """

    def __init__(self, tiles_root: str = TILES_ROOT):
        self.tiles_root = tiles_root
        self.categories: dict[str, dict] = {}
        self._load_manifests()
        self.geometry = self._measure_shared_geometry()

    # -- loading --------------------------------------------------------------

    def _load_manifests(self) -> None:
        for name in sorted(os.listdir(self.tiles_root)):
            manifest = os.path.join(self.tiles_root, name, "tiles.json")
            if not os.path.isfile(manifest):
                continue  # config/, pipeline/ and stray dirs have no manifest
            with open(manifest) as f:
                data = json.load(f)
            # tiles/config/tiles.json is the tiles-agent config, not a tile set;
            # a real set declares the schema and a per-tile list.
            if data.get("schema") != "pixel-tiles/set@1" or "tiles" not in data:
                continue
            data["_dir"] = os.path.join(self.tiles_root, name)
            self.categories[name] = data

    def _measure_shared_geometry(self) -> dict:
        """Measure from a plain ground tile (they all share the format)."""
        for pref in ("grass", "dirt", "stone", "sand"):
            if pref in self.categories:
                img = self.tile(pref, 0)
                g = measure_geometry(img)
                if g:
                    return g
        # fall back to whatever exists
        for name in self.categories:
            img = self.tile(name, 0)
            g = measure_geometry(img)
            if g:
                return g
        raise RuntimeError("no tiles found to measure geometry from")

    # -- lookup ---------------------------------------------------------------

    def has(self, category: str) -> bool:
        return category in self.categories

    def count(self, category: str) -> int:
        return int(self.categories[category].get("count", 0))

    def is_elevation(self, category: str) -> bool:
        return self.categories.get(category, {}).get("kind") == "elevation"

    def tile_height(self, category: str) -> int:
        return int(self.categories[category].get("tile_height") or 64)

    @lru_cache(maxsize=128)
    def top_ref(self, category: str) -> int:
        """Y (within the tile's box) of the top-diamond's side corners — the
        stable landmark for the tile's TOP SURFACE. Aligning this to the level
        grid makes a tall tile land its surface exactly where stacked 64x64
        tiles would. Measured from tile_00 (all variants share the format)."""
        img = self.tile(category, 0)
        a = np.asarray(img)
        alpha = a[:, :, 3] > 16
        cols = np.where(alpha.any(axis=0))[0]
        xmin = int(cols.min())
        return int(np.where(alpha[:, xmin])[0].min())

    @lru_cache(maxsize=128)
    def face_height(self, category: str) -> int:
        """Height in px of the tile's exposed vertical face at a corner (how far
        down its rock wall reaches). Lets the renderer know when a short cliff
        tile won't cover a deep drop and needs fill beneath it."""
        img = self.tile(category, 0)
        a = np.asarray(img)
        alpha = a[:, :, 3] > 16
        cols = np.where(alpha.any(axis=0))[0]
        xmin = int(cols.min())
        col = np.where(alpha[:, xmin])[0]
        return int(col.max() - col.min() + 1)

    def surface_offset(self, category: str, ref_category: str = "grass") -> int:
        """Pixels to add to paste-y so `category`'s top surface aligns with the
        ground reference tile's surface at the same level (0 for ground tiles)."""
        ref = ref_category if ref_category in self.categories else next(iter(self.categories))
        return self.top_ref(ref) - self.top_ref(category)

    @lru_cache(maxsize=512)
    def tile(self, category: str, index: int) -> Image.Image:
        """Return the RGBA image for ``tiles/<category>/tile_NN.png``.

        Index wraps within the category so callers can scatter variants freely.
        """
        cat = self.categories[category]
        n = int(cat.get("count", 1)) or 1
        idx = index % n
        path = os.path.join(cat["_dir"], f"tile_{idx:02d}.png")
        return Image.open(path).convert("RGBA")

    def available(self) -> list[str]:
        return sorted(self.categories.keys())


if __name__ == "__main__":  # quick self-check
    ts = TileSet()
    print("categories:", ts.available())
    print("geometry:", ts.geometry)
