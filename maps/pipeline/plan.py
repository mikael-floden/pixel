"""The world master plan — the *bigger picture*, authored before any detail.

This is the "zoom-out sketch": a deliberate, top-down blueprint of the whole
world — where each region sits and why, how rivers run, where the roads go, and
where the landmarks stand. Think of the A Link to the Past overworld: Death
Mountain across the north, the castle dead centre, a forest, a village, a desert,
a lake — each placed on purpose and tied together by logical roads and water.

The plan is *data*, not a picture, so it does two jobs at once:
  1. `render_schematic()` draws the bird's-eye overview a human reviews.
  2. the detail builder (designer.py) samples the SAME plan to place biomes,
     carve rivers, and route roads — so the sketch and the built world can never
     drift apart.

Coordinates are plain top-down tile coordinates (x = east, y = south); the iso
renderer transforms them when it draws the detailed world.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass, field

from noise import fbm

try:
    from PIL import ImageFont
    _FONT_CANDIDATES = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
except Exception:  # pragma: no cover
    _FONT_CANDIDATES = []


# ---------------------------------------------------------------------------
# Plan data model
# ---------------------------------------------------------------------------


@dataclass
class District:
    """A macro-region. `layer` "terrain" districts form the biome field the
    whole map samples; "feature" districts (a lake) carve special ground."""

    name: str
    kind: str            # mountains snow forest desert plains farm lake
    cx: float
    cy: float
    radius: float        # influence radius, in tiles
    layer: str = "terrain"


@dataclass
class Node:
    """A placed landmark the roads connect and the builder renders in detail."""

    name: str
    kind: str            # castle town village hamlet outpost pass lakeside
    x: float
    y: float
    label: str


@dataclass
class River:
    points: list[tuple[float, float]]     # source -> mouth polyline (tiles)
    width: float = 1.6


# The world is deliberately vertical — the level/stacking system is used HARD so
# nothing feels flat. Peaks tower ~6 blocks over the coast; every region has its
# own base height and roughness, and the map terraces in discrete steps (cliffs
# between levels) the ALTTP way.
MAX_LEVEL = 6

# per-biome base height (0..1) and how rugged/rolling it is
_BASE_HEIGHT = {
    "mountains": 0.92, "snow": 0.97, "forest": 0.52, "desert": 0.34,
    "plains": 0.24, "farm": 0.16, "lake": 0.0,
}
_RUGGED = {
    "mountains": 0.55, "snow": 0.45, "forest": 0.30, "desert": 0.34,
    "plains": 0.12, "farm": 0.07, "lake": 0.0,
}


def _seg_dist(px, py, ax, ay, bx, by) -> float:
    """Distance from point to segment AB."""
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


@dataclass
class WorldPlan:
    width: int
    height: int
    seed: int
    title: str
    districts: list[District] = field(default_factory=list)
    nodes: dict[str, Node] = field(default_factory=dict)
    rivers: list[River] = field(default_factory=list)
    roads: list[tuple[str, str]] = field(default_factory=list)

    # -- sampling (shared by schematic + builder) ------------------------------

    def land_value(self, x: float, y: float) -> float:
        """> 0 is land. A big continent (elliptical falloff) with an organic,
        fjord-y coastline from layered noise — not a circle, not noise soup."""
        nx = (x / self.width - 0.5) * 2.0
        ny = (y / self.height - 0.5) * 2.0
        d = math.hypot(nx / 0.94, ny / 0.94)          # 0 centre .. 1 edge
        base = 1.0 - d
        broad = fbm(x, y, self.seed, self.width * 0.13, 4) - 0.5   # bays/capes
        coast = fbm(x, y, self.seed + 5, self.width * 0.045, 3) - 0.5  # crinkle
        return base + broad * 0.95 + coast * 0.35

    def is_land(self, x: float, y: float) -> bool:
        return self.land_value(x, y) > 0.16

    def lake_here(self, x: float, y: float) -> bool:
        for dsc in self.districts:
            if dsc.kind != "lake":
                continue
            d = math.hypot(x - dsc.cx, y - dsc.cy)
            edge = dsc.radius * (0.8 + (fbm(x, y, self.seed + 9, 14.0) - 0.5) * 0.5)
            if d < edge:
                return True
        return False

    def biome_at(self, x: float, y: float) -> str:
        """Nearest terrain district (noisy border), plains as the fallback."""
        best, kind = 1e9, "plains"
        for dsc in self.districts:
            if dsc.layer != "terrain":
                continue
            d = math.hypot(x - dsc.cx, y - dsc.cy) / dsc.radius
            d -= (fbm(x, y, self.seed + 7, self.width * 0.06) - 0.5) * 0.7
            if d < best:
                best, kind = d, dsc.kind
        return kind if best < 1.0 else "plains"

    # -- elevation (the plan is VERY vertical; levels are used hard) -----------

    def dist_to_rivers(self, x: float, y: float) -> float:
        best = 1e9
        for r in self.rivers:
            for (ax, ay), (bx, by) in zip(r.points, r.points[1:]):
                best = min(best, _seg_dist(x, y, ax, ay, bx, by))
        return best

    def _pass_notch(self, x: float, y: float) -> float:
        """How much to carve a corridor DOWN so roads cross the mountains through
        Highgate Pass instead of climbing over peaks (0 = none, 1 = full carve)."""
        pas = self.nodes.get("pass")
        if not pas:
            return 0.0
        # a vertical corridor around the pass, tapering with distance
        dx = abs(x - pas.x)
        dy = abs(y - pas.y)
        corridor = max(0.0, 1.0 - dx / 6.0) * max(0.0, 1.0 - dy / 26.0)
        return corridor

    def height_field(self, x: float, y: float) -> float:
        """Continuous terrain height in [0, 1] for land; 0 for water. Blends each
        region's base height, adds biome-scaled roughness, sinks toward the coast,
        carves river valleys, lifts a castle plateau, and notches the pass."""
        if not self.is_land(x, y) or self.lake_here(x, y):
            return 0.0
        wsum = hb = rug = 0.0
        for dsc in self.districts:
            if dsc.layer != "terrain":
                continue
            w = max(0.0, 1.0 - math.hypot(x - dsc.cx, y - dsc.cy) / (dsc.radius * 1.15))
            w *= w
            hb += _BASE_HEIGHT[dsc.kind] * w
            rug += _RUGGED[dsc.kind] * w
            wsum += w
        if wsum <= 0:
            base, rough = _BASE_HEIGHT["plains"], _RUGGED["plains"]
        else:
            base, rough = hb / wsum, rug / wsum

        h = base + (fbm(x, y, self.seed + 13, self.width * 0.05, 5) - 0.5) * 2.0 * rough

        # sink to sea level along the coast so beaches sit at level 0
        lv = self.land_value(x, y)
        if lv < 0.42:
            h *= max(0.0, (lv - 0.16) / 0.26)

        # river valleys: cut down near the water course
        dr = self.dist_to_rivers(x, y)
        if dr < 6:
            h -= (1.0 - dr / 6.0) * 0.55

        # castle plateau: a deliberate raised, flat mesa under the keep
        castle = self.nodes.get("castle")
        if castle:
            dc = math.hypot(x - castle.x, y - castle.y)
            if dc < 6:
                h = max(h, 0.5)                     # flat tabletop
            elif dc < 10:
                h = max(h, 0.5 * (1 - (dc - 6) / 4))

        # notch the mountain pass down to a crossable level
        h -= self._pass_notch(x, y) * 0.55

        return max(0.0, min(1.0, h))

    def elevation_at(self, x: float, y: float) -> int:
        """Discrete terraced level 0..MAX_LEVEL (0 = sea/coast). Rounding the
        height field produces flat plateaus separated by cliffs — lots of levels
        in play, never a flat plane."""
        if not self.is_land(x, y) or self.lake_here(x, y):
            return 0
        return int(round(self.height_field(x, y) * MAX_LEVEL))


# ---------------------------------------------------------------------------
# The authored plan — this is the design intent for the whole world
# ---------------------------------------------------------------------------


def default_plan(width: int = 128, height: int = 112, seed: int = 7) -> WorldPlan:
    """Author the kingdom of **Aldermoor**: highlands across the north, the
    king's castle at the heart, a fertile vale and harbor to the south, ancient
    woods to the east, a lake in the south-east, and a desert to the south-west
    — all laced together by the King's Road and one river from peak to lake."""
    W, H = width, height
    R = max(W, H)

    def T(fx, fy):
        return (fx * W, fy * H)

    districts = [
        District("The Northreach", "mountains", *T(0.50, 0.12), 0.44 * R),
        District("Frostcap Peaks", "snow",      *T(0.83, 0.09), 0.17 * R),
        District("Eastwood",       "forest",    *T(0.85, 0.50), 0.30 * R),
        District("Sunder Desert",  "desert",    *T(0.14, 0.80), 0.32 * R),
        District("Westmarch",      "farm",      *T(0.17, 0.44), 0.20 * R),
        District("Green Vale",     "plains",    *T(0.48, 0.56), 0.58 * R),
        District("Mirror Lake",    "lake",      *T(0.73, 0.79), 0.17 * R, layer="feature"),
    ]

    nodes = {
        "castle":     Node("castle",   "castle",   *T(0.50, 0.40), "Aldermoor Castle"),
        "pass":       Node("pass",     "pass",     *T(0.50, 0.24), "Highgate Pass"),
        "port":       Node("port",     "town",     *T(0.45, 0.90), "Saltmarsh Harbor"),
        "westvillage":Node("westvillage","village",*T(0.16, 0.46), "Kingsbridge"),
        "easthamlet": Node("easthamlet","hamlet",  *T(0.84, 0.53), "Woodhollow"),
        "desertpost": Node("desertpost","outpost", *T(0.13, 0.73), "Sunspire Outpost"),
        "lakeside":   Node("lakeside", "lakeside", *T(0.63, 0.72), "Lakewatch"),
    }

    rivers = [
        River([T(0.55, 0.11), T(0.53, 0.22), T(0.545, 0.34), T(0.55, 0.42),
               T(0.60, 0.54), T(0.68, 0.66), T(0.72, 0.76)]),          # peaks -> lake
        River([T(0.75, 0.82), T(0.82, 0.90), T(0.88, 0.97)], width=1.4),  # lake -> sea
    ]

    roads = [
        ("castle", "pass"),
        ("castle", "port"),
        ("castle", "westvillage"),
        ("castle", "easthamlet"),
        ("westvillage", "desertpost"),
        ("easthamlet", "lakeside"),
        ("port", "lakeside"),
    ]

    return WorldPlan(W, H, seed, "The Kingdom of Aldermoor",
                     districts, nodes, rivers, roads)


# ---------------------------------------------------------------------------
# Schematic overview render (the bird's-eye sketch)
# ---------------------------------------------------------------------------

_BIOME_COLOR = {
    "mountains": (128, 126, 130),
    "snow":      (232, 238, 248),
    "forest":    (40, 104, 52),
    "desert":    (222, 196, 132),
    "plains":    (104, 168, 84),
    "farm":      (176, 190, 96),
    "lake":      (58, 118, 200),
    "beach":     (226, 214, 166),
    "ocean":     (36, 92, 168),
    "deep":      (26, 66, 128),
}
_NODE_COLOR = {
    "castle":   (206, 60, 60),
    "town":     (232, 150, 52),
    "village":  (196, 132, 74),
    "hamlet":   (196, 132, 74),
    "outpost":  (196, 132, 74),
    "pass":     (150, 150, 158),
    "lakeside": (120, 170, 210),
}


def _font(size: int):
    from PIL import ImageFont
    for path in _FONT_CANDIDATES:
        if os.path.isfile(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()


def render_schematic(plan: WorldPlan, cell: int = 7) -> "object":
    """Top-down bird's-eye overview: coastline, biome regions, lake, rivers,
    the King's Road network, and labelled landmarks — the plan a human reads."""
    from PIL import Image, ImageDraw

    W, H = plan.width, plan.height
    pad = 40
    img = Image.new("RGB", (W * cell + pad * 2, H * cell + pad * 2 + 30),
                    _BIOME_COLOR["deep"])
    px = Image.new("RGB", (W, H), _BIOME_COLOR["deep"])
    pmap = px.load()

    # base terrain field, shaded by ELEVATION so verticality reads at a glance
    levels = [[0] * W for _ in range(H)]
    for y in range(H):
        for x in range(W):
            lv = plan.land_value(x, y)
            if lv <= 0.16:
                pmap[x, y] = _BIOME_COLOR["ocean"] if lv > 0.02 else _BIOME_COLOR["deep"]
                continue
            if plan.lake_here(x, y):
                pmap[x, y] = _BIOME_COLOR["lake"]
                continue
            elev = plan.elevation_at(x, y)
            levels[y][x] = elev
            base = _BIOME_COLOR["beach"] if lv < 0.22 else _BIOME_COLOR[plan.biome_at(x, y)]
            # brighten with height: level 0 dim, high peaks bright (hillshade feel)
            f = 0.74 + 0.10 * elev
            pmap[x, y] = tuple(min(255, int(c * f)) for c in base)

    px = px.resize((W * cell, H * cell), Image.NEAREST)
    img.paste(px, (pad, pad))

    draw = ImageDraw.Draw(img, "RGBA")

    def S(pt):
        return (pad + pt[0] * cell, pad + pt[1] * cell)

    # terrace contour lines: draw a dark edge wherever the level steps up — this
    # is the visual signature of a world built heavily on the level system
    for y in range(H):
        for x in range(W):
            lvl = levels[y][x]
            if lvl <= 0:
                continue
            if x + 1 < W and levels[y][x + 1] < lvl:
                sx = pad + (x + 1) * cell
                draw.line([(sx, pad + y * cell), (sx, pad + (y + 1) * cell)],
                          fill=(20, 24, 30, 150), width=1)
            if y + 1 < H and levels[y + 1][x] < lvl:
                sy = pad + (y + 1) * cell
                draw.line([(pad + x * cell, sy), (pad + (x + 1) * cell, sy)],
                          fill=(20, 24, 30, 150), width=1)

    # rivers
    for r in plan.rivers:
        pts = [S(p) for p in r.points]
        draw.line(pts, fill=(70, 140, 220, 255), width=max(2, int(r.width * cell * 0.5)),
                  joint="curve")

    # roads (King's Road) — dashed tan
    for a, b in plan.roads:
        na, nb = plan.nodes[a], plan.nodes[b]
        draw.line([S((na.x, na.y)), S((nb.x, nb.y))],
                  fill=(214, 196, 150, 235), width=max(2, cell // 2))

    # landmarks
    f = _font(13)
    for node in plan.nodes.values():
        cx, cy = S((node.x, node.y))
        col = _NODE_COLOR.get(node.kind, (230, 230, 230))
        r = 7 if node.kind == "castle" else 5
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col + (255,),
                     outline=(20, 20, 30, 255), width=2)
        label = node.label
        tw = draw.textlength(label, font=f)
        lx = min(max(cx - tw / 2, 2), img.width - tw - 2)
        draw.text((lx + 1, cy + r + 2), label, font=f, fill=(0, 0, 0, 180))
        draw.text((lx, cy + r + 1), label, font=f, fill=(245, 248, 255, 255))

    # district names (faint, centred)
    fd = _font(15)
    for dsc in plan.districts:
        cx, cy = S((dsc.cx, dsc.cy))
        tw = draw.textlength(dsc.name, font=fd)
        draw.text((cx - tw / 2 + 1, cy + 1), dsc.name, font=fd, fill=(0, 0, 0, 150))
        draw.text((cx - tw / 2, cy), dsc.name, font=fd, fill=(255, 255, 255, 210))

    # frame + title
    draw.rectangle([pad - 2, pad - 2, pad + W * cell + 1, pad + H * cell + 1],
                   outline=(230, 230, 240, 255), width=2)
    ft = _font(20)
    draw.text((pad, img.height - 26),
              f"{plan.title} — world plan (bird's-eye · terraced, {MAX_LEVEL} levels)",
              font=ft, fill=(235, 240, 250, 255))
    return img


if __name__ == "__main__":
    p = default_plan()
    print(p.title, f"{p.width}x{p.height}", len(p.districts), "districts",
          len(p.nodes), "landmarks", len(p.roads), "roads")
