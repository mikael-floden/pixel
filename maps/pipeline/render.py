"""Composite a World into a single isometric PNG.

Terrain is drawn as true 2.5D: every cell has an integer elevation level, and
where a raised cell meets a lower one toward the camera, we draw a **tall cliff
tile** (the tiles agent's 64x128 elevation set) for the exposed rock wall — the
ALTTP "hill wall" look — instead of stacking flat blocks into a ziggurat.

The alignment is the whole game: a tile's TOP SURFACE is pinned to the level
grid via `tiles.surface_offset`, so a tall cliff tile lands its top at exactly
the same screen-Y as N stacked 64x64 tiles would. Back-to-front painting clips
the (deliberately over-tall) cliff faces with whatever is drawn in front.
"""

from __future__ import annotations

from tileset import TileSet
from world import World

# biome -> its cliff/rock-wall set (the tall 64x128 tiles). Falls back to
# cliff_stone (then to stacking) when a set is missing.
_BIOME_CLIFF = {
    "grass": "cliff_grass", "plains": "cliff_grass", "forest": "cliff_forest",
    "farm": "cliff_dirt", "dirt": "cliff_dirt", "woodland": "cliff_dirt",
    "sand": "cliff_sand", "beach": "cliff_sand", "desert": "cliff_desert",
    "stone": "cliff_stone", "mountains": "cliff_stone", "highland": "cliff_stone",
    "snow": "cliff_snow", "snowfield": "cliff_snow", "peak": "cliff_snow",
}


def _sea_color(tiles: TileSet) -> tuple:
    """Average opaque colour of the deep-water tile, so the flat sea background
    matches the coastal water tiles seamlessly."""
    import numpy as np
    if not tiles.has("water"):
        return (40, 90, 150, 255)
    a = np.asarray(tiles.tile("water", 0))
    m = a[:, :, 3] > 200
    if not m.any():
        return (40, 90, 150, 255)
    r, g, b = (int(a[:, :, i][m].mean()) for i in range(3))
    return (r, g, b, 255)


def _cliff_for(cell, tiles: TileSet) -> str | None:
    for key in (cell.role, cell.terrain):
        cat = _BIOME_CLIFF.get(key)
        if cat and tiles.has(cat):
            return cat
    return "cliff_stone" if tiles.has("cliff_stone") else None


def render(world: World, tiles: TileSet, *, scale: int = 1,
           background=(24, 28, 40, 255)) -> "object":
    from PIL import Image

    g = tiles.geometry
    dx, dy, lh = g["grid_dx"], g["grid_dy"], g["level_height"]
    th = 64

    max_level = max((c.level for _, _, c in world.cells()), default=0)

    margin = 8
    ox = (world.height - 1) * dx + margin
    oy = max_level * lh + margin
    canvas_w = (world.width + world.height) * dx + margin * 2
    # tall cliff tiles hang ~64px below a plain tile's box; pad the bottom
    canvas_h = (world.width + world.height) * dy + th + max_level * lh + margin * 2 + 72

    # Deep open ocean is ~half the map and all identical, so instead of pasting
    # thousands of duplicate water tiles we fill the sea as one flat background
    # and only draw water tiles in the coastal band (near land). Big speedup.
    import numpy as np
    land = np.zeros((world.height, world.width), dtype=bool)
    for x, y, c in world.cells():
        if c.terrain != "water":
            land[y, x] = True
    coast = land.copy()
    for _ in range(2):  # dilate land by 2 cells -> the band that still draws water
        c = coast.copy()
        c[:-1] |= coast[1:]; c[1:] |= coast[:-1]
        c[:, :-1] |= coast[:, 1:]; c[:, 1:] |= coast[:, :-1]
        coast = c
    sea = _sea_color(tiles)
    canvas = Image.new("RGBA", (canvas_w, canvas_h), sea)

    order = sorted(
        ((x, y) for y in range(world.height) for x in range(world.width)),
        key=lambda p: (p[0] + p[1], p[1]),
    )

    def front_min_level(x: int, y: int) -> int:
        """Lowest of the two camera-facing neighbours; off-map or water reads as
        below sea level so coastal/edge bluffs get a face."""
        lows = []
        for nx, ny in ((x + 1, y), (x, y + 1)):
            if not world.in_bounds(nx, ny):
                lows.append(-1)
            else:
                nc = world.at(nx, ny)
                lows.append(nc.level if nc.terrain != "water" else 0)
        return min(lows)

    for x, y in order:
        cell = world.at(x, y)
        if not tiles.has(cell.terrain):
            continue
        if cell.terrain == "water" and not coast[y, x]:
            continue  # deep ocean: the flat sea background already covers it
        L = cell.level
        base_x = ox + (x - y) * dx
        base_y = oy + (x + y) * dy

        drop = L - front_min_level(x, y) if L > 0 else 0
        cliff = _cliff_for(cell, tiles) if drop > 0 else None

        if cliff:
            # If the cliff's face can't reach the whole drop (e.g. short
            # cliff_snow on a deep step), fill the lower, uncovered levels with
            # stacked ground blocks first so no transparent gap shows; then cap
            # with the cliff for the rock wall + top surface.
            cover = tiles.face_height(cliff) // lh
            if cover < drop:
                ground = tiles.tile(cell.terrain, cell.variant)
                goff = tiles.surface_offset(cell.terrain)
                for fl in range(max(0, L - drop + 1), L - cover + 1):
                    canvas.paste(ground, (base_x, base_y - fl * lh + goff), ground)
            img = tiles.tile(cliff, 0)
            canvas.paste(img, (base_x, base_y - L * lh + tiles.surface_offset(cliff)), img)
        else:
            img = tiles.tile(cell.terrain, cell.variant)
            off = tiles.surface_offset(cell.terrain)
            canvas.paste(img, (base_x, base_y - L * lh + off), img)

    if scale != 1:
        canvas = canvas.resize((canvas_w * scale, canvas_h * scale), Image.NEAREST)
    return canvas
