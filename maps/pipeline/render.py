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
    if cell.terrain == "water":
        return None  # water drops stack water tiles -> blue waterfall faces
    if cell.role == "house":
        return None  # houses stack their own wood_floor -> timber cottages
    for key in (cell.role, cell.terrain):
        cat = _BIOME_CLIFF.get(key)
        if cat and tiles.has(cat):
            return cat
    return "cliff_stone" if tiles.has("cliff_stone") else None


class _Props:
    """Object sprites (trees, barrels, ...) from the objects/ domain, pasted
    bottom-center on a cell's top diamond. Read-only consumption of a sibling
    domain, same as tiles/."""

    def __init__(self, repo_root: str):
        import os
        self.root = os.path.join(repo_root, "objects")
        self.cache: dict = {}

    def get(self, name: str):
        import os
        from PIL import Image
        if name not in self.cache:
            p = os.path.join(self.root, name, "sprite.png")
            self.cache[name] = Image.open(p).convert("RGBA") if os.path.isfile(p) else None
        return self.cache[name]


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

    # Deep open OCEAN is ~half the map and all identical, so instead of pasting
    # thousands of duplicate water tiles we fill the sea as one flat background
    # and only draw water tiles in the coastal band. Crucially this applies ONLY
    # to border-connected sea — lakes, rivers and fjord interiors always draw
    # real tiles (a flood fill from the map border finds the true ocean).
    import numpy as np
    from collections import deque
    land = np.zeros((world.height, world.width), dtype=bool)
    for x, y, c in world.cells():
        if c.terrain != "water":
            land[y, x] = True
    sea = np.zeros_like(land)
    dq = deque()
    for x in range(world.width):
        for y in (0, world.height - 1):
            if not land[y, x] and not sea[y, x]:
                sea[y, x] = True
                dq.append((x, y))
    for y in range(world.height):
        for x in (0, world.width - 1):
            if not land[y, x] and not sea[y, x]:
                sea[y, x] = True
                dq.append((x, y))
    while dq:
        x, y = dq.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < world.width and 0 <= ny < world.height \
                    and not land[ny, nx] and not sea[ny, nx]:
                sea[ny, nx] = True
                dq.append((nx, ny))
    coast = land.copy()
    for _ in range(2):  # coastal band still draws real water tiles
        c = coast.copy()
        c[:-1] |= coast[1:]; c[1:] |= coast[:-1]
        c[:, :-1] |= coast[:, 1:]; c[:, 1:] |= coast[:, :-1]
        coast = c
    draw_water = ~sea | coast   # everything except deep border-connected ocean
    sea = _sea_color(tiles)
    canvas = Image.new("RGBA", (canvas_w, canvas_h), sea)

    import os as _os
    props = _Props(_os.path.dirname(_os.path.dirname(_os.path.dirname(
        _os.path.abspath(__file__)))))

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
        if cell.terrain == "water" and not draw_water[y, x]:
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
            cover = max(1, tiles.face_height(cliff) // lh)
            img = tiles.tile(cliff, 0)
            coff = tiles.surface_offset(cliff)
            if cover < drop:
                # repeat the cliff face itself down the drop (bottom-up) so deep
                # walls keep the rock texture instead of plain stacked cubes
                fl = L - cover
                fills = []
                while fl > L - drop - 1 and fl >= 0:
                    fills.append(fl)
                    fl -= cover
                for f in reversed(fills):
                    canvas.paste(img, (base_x, base_y - f * lh + coff), img)
            canvas.paste(img, (base_x, base_y - L * lh + coff), img)
        elif drop > 0:
            # no cliff set (water): stack the cell's own tile down the drop —
            # stacked water faces read as a waterfall / cascading river terrace
            img = tiles.tile(cell.terrain, cell.variant)
            off = tiles.surface_offset(cell.terrain)
            for fl in range(max(0, L - drop), L + 1):
                canvas.paste(img, (base_x, base_y - fl * lh + off), img)
        else:
            img = tiles.tile(cell.terrain, cell.variant)
            off = tiles.surface_offset(cell.terrain)
            canvas.paste(img, (base_x, base_y - L * lh + off), img)

        # prop sprite (tree, barrel, ...) anchored bottom-center on the diamond
        if cell.object:
            spr = props.get(cell.object)
            if spr is not None:
                px = base_x + 32 - spr.width // 2
                py = base_y - L * lh + 21 - spr.height + 8
                canvas.paste(spr, (px, py), spr)

    if scale != 1:
        canvas = canvas.resize((canvas_w * scale, canvas_h * scale), Image.NEAREST)
    return canvas
