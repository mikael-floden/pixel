"""Composite a World into a single isometric PNG.

Pure function of (world, tileset): walks the grid back-to-front and pastes each
cell's tile, stacking elevated cells into raised blocks. No design decisions
live here — this only draws what world.py holds.
"""

from __future__ import annotations

from PIL import Image

from tileset import TileSet
from world import World


def render(world: World, tiles: TileSet, *, scale: int = 1,
           background=(24, 28, 40, 255)) -> Image.Image:
    g = tiles.geometry
    dx, dy, lh = g["grid_dx"], g["grid_dy"], g["level_height"]
    tw, th = 64, 64  # tile box

    max_level = max((c.level for _, _, c in world.cells()), default=0)

    # Origin so every tile lands at positive coordinates, with headroom above
    # for the tallest stacks and a little margin all around.
    margin = 8
    ox = (world.height - 1) * dx + margin
    oy = max_level * lh + margin
    canvas_w = (world.width + world.height) * dx + margin * 2
    canvas_h = (world.width + world.height) * dy + th + max_level * lh + margin * 2

    canvas = Image.new("RGBA", (canvas_w, canvas_h), background)

    # Painter's order: back (small x+y) to front (large x+y).
    order = sorted(
        ((x, y) for y in range(world.height) for x in range(world.width)),
        key=lambda p: (p[0] + p[1], p[1]),
    )

    for x, y in order:
        cell = world.at(x, y)
        if not tiles.has(cell.terrain):
            continue
        base_x = ox + (x - y) * dx
        base_y = oy + (x + y) * dy
        # The designer sets a deliberate variant per cell (see designer._paint),
        # so render just trusts it — no random jitter that would scatter a
        # material into a checkerboard.
        img = tiles.tile(cell.terrain, cell.variant)

        # Stack from ground (level 0) up to the surface so side faces build a
        # solid raised block; the top tile shows its diamond face.
        for lvl in range(cell.level + 1):
            sy = base_y - lvl * lh
            canvas.paste(img, (base_x, sy), img)

    if scale != 1:
        canvas = canvas.resize(
            (canvas_w * scale, canvas_h * scale), Image.NEAREST
        )
    return canvas
