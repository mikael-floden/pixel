"""The world master plan — the *bigger picture*, authored before any detail.

This is the design bible for **Aldermoor, Kingdom of Falling Water** — the
synthesis of a three-lens design panel (exploration/game-feel, visual
composition, environmental storytelling). The whole map is one readable
composition:

  * a **crescent continent** curling around the Gulf of Glass (SE), so the
    silhouette itself is the first landmark;
  * one grand **diagonal descent** — blinding snow at the top of the frame
    (level 6) down terraced cliffs to black marsh water at the bottom (level 0)
    — so height itself is a compass;
  * the **Silverrill** river as the map's spine: born in a glacial tarn, it
    plunges over triple falls, cascades down the flank of Castle Aldermoor
    (the "Stair of Veils"), fills the Mirrormere, and braids out through the
    Lantern Delta into the gulf;
  * a **road loop** (the King's Round) around the Mirrormere so no journey
    retraces itself, gated by real chokepoints: the Wyrmgate stair at the
    fjord head, and Kingsbridge — the only crossing south of the lake;
  * **secrets off the road network**: a ruined monastery on Hoarfell's frozen
    tarn, the Sunken Court on a gulf isle, the Kingstone Ring on its hill,
    a stepping-stone ford that shortcuts the loop.

The plan is *data*, not a picture: `render_schematic()` draws the bird's-eye
overview a human reviews, and the detail builder samples the SAME plan, so the
sketch and the built world can never drift apart. Coordinates are top-down tile
coordinates (x = east, y = south); the iso renderer transforms when drawing.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass, field

from noise import fbm

_FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]

# The world is deliberately vertical — the level/stacking system is used HARD.
# Peaks tower 6 blocks over the coast; every region has its own base height and
# the map terraces in discrete steps (cliff faces between levels), ALTTP-style.
MAX_LEVEL = 6

# per-biome base height (0..1) and roughness
_BASE_HEIGHT = {
    "mountains": 0.95, "snow": 0.88, "forest": 0.46, "desert": 0.30,
    "plains": 0.22, "farm": 0.16, "lake": 0.0,
}
_RUGGED = {
    "mountains": 0.38, "snow": 0.30, "forest": 0.18, "desert": 0.22,
    "plains": 0.07, "farm": 0.05, "lake": 0.0,
}
# How fully each biome sinks to sea level at the coast. 1.0 = full sink (sand
# beaches); low values keep the land high right up to the water so mountains
# and snowfields meet the sea as CLIFFS (the fjord walls, the Palisade coast).
_COAST_SINK = {
    "mountains": 0.25, "snow": 0.30, "forest": 0.85,
    "desert": 0.95, "plains": 1.0, "farm": 1.0,
}


def _seg_dist(px, py, ax, ay, bx, by) -> float:
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


@dataclass
class District:
    name: str
    kind: str            # mountains snow forest desert plains farm lake
    cx: float
    cy: float
    radius: float
    layer: str = "terrain"


@dataclass
class Node:
    """A placed landmark. `road: False` nodes are deliberate secrets —
    reachable, visible, but never pointed at by the road network."""

    name: str
    kind: str
    x: float
    y: float
    label: str


@dataclass
class River:
    points: list[tuple[float, float]]
    width: float = 1.6


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
    # coastline authoring: (cx, cy, rx, ry, amp) gaussian blobs added to the
    # land field — negative carves bays/fjords, positive raises peninsulas/isles
    blobs: list[tuple[float, float, float, float, float]] = field(default_factory=list)
    # (x, y, radius) of the Lantern Delta marshes
    marsh: tuple[float, float, float] | None = None
    # radius of the shrine islet excluded from the lake
    lake_island_r: float = 0.0

    # -- terrain field (shared by schematic + detail builder) ------------------

    def land_value(self, x: float, y: float) -> float:
        nx = (x / self.width - 0.5) * 2.0
        ny = (y / self.height - 0.5) * 2.0
        d = math.hypot(nx / 0.94, ny / 0.94)
        base = 1.0 - d
        broad = fbm(x, y, self.seed, self.width * 0.13, 4) - 0.5
        coast = fbm(x, y, self.seed + 5, self.width * 0.045, 3) - 0.5
        v = base + broad * 0.85 + coast * 0.32
        for cx, cy, rx, ry, amp in self.blobs:
            dxn = (x - cx) / rx
            dyn = (y - cy) / ry
            v += amp * math.exp(-(dxn * dxn + dyn * dyn))
        return v

    def is_land(self, x: float, y: float) -> bool:
        return self.land_value(x, y) > 0.16

    def lake_here(self, x: float, y: float) -> bool:
        for dsc in self.districts:
            if dsc.kind != "lake":
                continue
            d = math.hypot(x - dsc.cx, y - dsc.cy)
            if d < self.lake_island_r:            # the shrine islet
                return False
            edge = dsc.radius * (0.8 + (fbm(x, y, self.seed + 9, 14.0) - 0.5) * 0.5)
            if d < edge:
                return True
        return False

    def biome_at(self, x: float, y: float) -> str:
        best, kind = 1e9, "plains"
        for dsc in self.districts:
            if dsc.layer != "terrain":
                continue
            d = math.hypot(x - dsc.cx, y - dsc.cy) / dsc.radius
            d -= (fbm(x, y, self.seed + 7, self.width * 0.06) - 0.5) * 0.7
            if d < best:
                best, kind = d, dsc.kind
        return kind if best < 1.0 else "plains"

    def in_marsh(self, x: float, y: float) -> bool:
        if not self.marsh:
            return False
        mx, my, mr = self.marsh
        r = mr * (1.0 + (fbm(x, y, self.seed + 15, 9.0) - 0.5) * 0.7)
        return math.hypot(x - mx, y - my) < r

    # -- elevation --------------------------------------------------------------

    def dist_to_rivers(self, x: float, y: float) -> float:
        best = 1e9
        for r in self.rivers:
            for (ax, ay), (bx, by) in zip(r.points, r.points[1:]):
                best = min(best, _seg_dist(x, y, ax, ay, bx, by))
        return best

    def _pass_notch(self, x: float, y: float) -> float:
        """Carve the Wyrmgate corridor DOWN so the road crosses the Palisades
        through the pass rather than over the peaks."""
        pas = self.nodes.get("pass")
        if not pas:
            return 0.0
        dx = abs(x - pas.x)
        dy = abs(y - pas.y)
        return max(0.0, 1.0 - dx / 8.0) * max(0.0, 1.0 - dy / 26.0)

    def height_field(self, x: float, y: float) -> float:
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

        h = base + (fbm(x, y, self.seed + 13, self.width * 0.08, 4) - 0.5) * 1.5 * rough

        # movement-shaping hill shelves in the lowlands (ALTTP hill walls)
        hill = fbm(x, y, self.seed + 31, self.width * 0.15, 2)
        if hill > 0.58:
            shelf = 1 if hill < 0.72 else 2
            h += shelf * (1.0 / MAX_LEVEL) * (1.0 - base * 0.6)

        # coastal profile: beaches where the land is soft, cliffs where it is
        # hard (Palisade coast, fjord walls, Hoarfell rim)
        lv = self.land_value(x, y)
        if lv < 0.42:
            t = max(0.0, (lv - 0.16) / 0.26)
            s = _COAST_SINK.get(self.biome_at(x, y), 1.0)
            h *= t * s + (1.0 - s)

        # river valleys cut down toward the water course
        dr = self.dist_to_rivers(x, y)
        if dr < 6:
            h -= (1.0 - dr / 6.0) * 0.55

        # the marsh delta is dead flat at sea level
        if self.in_marsh(x, y):
            h = 0.0

        # Castle Crag: a deliberate level-4 mesa at the rule-of-thirds point;
        # the Silverrill brushes its taper ring and cascades down the flank
        castle = self.nodes.get("castle")
        if castle:
            dc = math.hypot(x - castle.x, y - castle.y)
            if dc < 6:
                h = max(h, 4.0 / MAX_LEVEL)
            elif dc < 11:
                h = max(h, (4.0 / MAX_LEVEL) * (1 - (dc - 6) / 5))

        # Kingstone hill: a small commanding rise for the stone circle vista
        ks = self.nodes.get("kingstone")
        if ks:
            dk = math.hypot(x - ks.x, y - ks.y)
            if dk < 4:
                h = max(h, 3.0 / MAX_LEVEL)
            elif dk < 8:
                h = max(h, (3.0 / MAX_LEVEL) * (1 - (dk - 4) / 4))

        h -= self._pass_notch(x, y) * 0.50
        return max(0.0, min(1.0, h))

    def elevation_at(self, x: float, y: float) -> int:
        if not self.is_land(x, y) or self.lake_here(x, y):
            return 0
        return int(round(self.height_field(x, y) * MAX_LEVEL))


# ---------------------------------------------------------------------------
# The authored plan
# ---------------------------------------------------------------------------


def default_plan(width: int = 128, height: int = 112, seed: int = 7) -> WorldPlan:
    """Aldermoor, Kingdom of Falling Water.

    North: the Crown Palisades — a rampart of bare stone terraces meeting the
    sea as cliffs, breached only at the Wyrmgate. Beyond the fjord: Hoarfell,
    a hushed snow peninsula holding the ruined Monastery of the Pale Bell.
    Center: Castle Aldermoor on its crag, the Silverrill cascading down its
    flank into the Mirrormere. West: Goldenfall Vale, the kingdom's golden
    breadbasket around walled Wheatstead. East: Eastwood and the Kingstone
    Ring. South: Saltmere Harbor inside the Gulf of Glass, the Lantern Delta
    marshes, and the Emberdunes with the Hourglass Oasis, Sunspire Outpost and
    the Emberlight lighthouse. In the gulf: drowned isles and the Sunken Court."""
    W, H = width, height
    R = max(W, H)

    def T(fx, fy):
        return (fx * W, fy * H)

    districts = [
        District("Crown Palisades", "mountains", *T(0.46, 0.13), 0.30 * R),
        District("Hoarfell",        "snow",      *T(0.84, 0.11), 0.16 * R),
        District("Eastwood",        "forest",    *T(0.83, 0.50), 0.22 * R),
        District("Emberdunes",      "desert",    *T(0.14, 0.78), 0.22 * R),
        District("Goldenfall Vale", "farm",      *T(0.19, 0.45), 0.15 * R),
        District("Green Vale",      "plains",    *T(0.48, 0.55), 0.55 * R),
        District("Mirrormere",      "lake",      *T(0.52, 0.53), 0.105 * R, layer="feature"),
    ]

    nodes = {
        "castle":     Node("castle",    "castle",     *T(0.49, 0.30), "Castle Aldermoor"),
        "pass":       Node("pass",      "pass",       *T(0.70, 0.215), "The Wyrmgate"),
        "monastery":  Node("monastery", "monastery",  *T(0.84, 0.12), "Pale Bell Monastery"),
        "wheatstead": Node("wheatstead","town",       *T(0.21, 0.44), "Wheatstead"),
        "saltmere":   Node("saltmere",  "town",       *T(0.42, 0.86), "Saltmere Harbor"),
        "kingsbridge":Node("kingsbridge","village",   *T(0.56, 0.66), "Kingsbridge"),
        "woodhollow": Node("woodhollow","hamlet",     *T(0.84, 0.55), "Woodhollow"),
        "oasis":      Node("oasis",     "oasis",      *T(0.15, 0.79), "Hourglass Oasis"),
        "sunspire":   Node("sunspire",  "outpost",    *T(0.09, 0.69), "Sunspire Outpost"),
        "lighthouse": Node("lighthouse","lighthouse", *T(0.10, 0.93), "The Emberlight"),
        "kingstone":  Node("kingstone", "stones",     *T(0.75, 0.38), "Kingstone Ring"),
        "shrine":     Node("shrine",    "shrine",     *T(0.52, 0.53), "Mirrormere Shrine"),
        "ruinisle":   Node("ruinisle",  "ruins",      *T(0.87, 0.78), "The Sunken Court"),
    }

    # the Silverrill: tarn source -> triple falls -> castle flank (Stair of
    # Veils) -> Mirrormere -> Kingsbridge -> Lantern Delta -> Gulf of Glass
    rivers = [
        River([T(0.545, 0.09), T(0.535, 0.16), T(0.545, 0.23), T(0.55, 0.30),
               T(0.54, 0.38), T(0.525, 0.45), T(0.52, 0.50)]),
        River([T(0.53, 0.58), T(0.555, 0.66), T(0.56, 0.76), T(0.565, 0.85),
               T(0.575, 0.93)], width=1.5),
        # delta arms braiding through the Lantern Marshes
        River([T(0.565, 0.85), T(0.61, 0.91), T(0.63, 0.96)], width=1.1),
        River([T(0.565, 0.85), T(0.52, 0.92), T(0.50, 0.97)], width=1.1),
    ]

    # the King's Round (loop) + spurs. Secrets get NO roads: kingstone,
    # shrine, ruinisle, monastery's tarn chest, the ford.
    roads = [
        ("castle", "wheatstead"),
        ("castle", "kingsbridge"),
        ("kingsbridge", "saltmere"),
        ("saltmere", "wheatstead"),
        ("castle", "pass"),
        ("pass", "monastery"),
        ("saltmere", "oasis"),
        ("oasis", "sunspire"),
        ("oasis", "lighthouse"),
        ("kingsbridge", "woodhollow"),
    ]

    # coastline authoring
    blobs = [
        # the Gulf of Glass: the great SE bay the crescent curls around
        (0.80 * W, 0.90 * H, 0.26 * W, 0.20 * H, -1.05),
        (0.70 * W, 0.99 * H, 0.14 * W, 0.10 * H, -0.55),
        # Hoarfell: raise the snow peninsula in the NE corner so it exists at
        # all (the base ellipse gives out up there), THEN sever it with the fjord
        (0.84 * W, 0.13 * H, 0.11 * W, 0.09 * H, +0.85),
        # Wyrm's Throat fjord: a narrow slash severing Hoarfell from the mainland
        (0.72 * W, 0.07 * H, 0.022 * W, 0.15 * H, -1.35),
        # west lighthouse peninsula
        (0.09 * W, 0.92 * H, 0.085 * W, 0.05 * H, +0.60),
        # gulf isles (the Sunken Court + two nameless skerries)
        (0.87 * W, 0.78 * H, 0.035 * W, 0.030 * H, +0.62),
        (0.79 * W, 0.86 * H, 0.020 * W, 0.018 * H, +0.45),
        (0.94 * W, 0.66 * H, 0.022 * W, 0.020 * H, +0.45),
        # pinch the mid-west coast for silhouette rhythm
        (0.02 * W, 0.30 * H, 0.07 * W, 0.09 * H, -0.35),
    ]

    plan = WorldPlan(W, H, seed, "Aldermoor — Kingdom of Falling Water",
                     districts, nodes, rivers, roads, blobs)
    plan.marsh = (0.565 * W, 0.90 * H, 0.075 * R)
    plan.lake_island_r = 2.6
    return plan


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
    "marsh":     (72, 112, 96),
    "ocean":     (36, 92, 168),
    "deep":      (26, 66, 128),
}
_NODE_COLOR = {
    "castle":     (206, 60, 60),
    "town":       (232, 150, 52),
    "village":    (196, 132, 74),
    "hamlet":     (196, 132, 74),
    "outpost":    (196, 132, 74),
    "pass":       (150, 150, 158),
    "monastery":  (170, 140, 200),
    "oasis":      (80, 200, 180),
    "lighthouse": (240, 240, 250),
    "stones":     (180, 180, 190),
    "shrine":     (120, 200, 220),
    "ruins":      (150, 120, 160),
}
# secrets are drawn hollow (no road ever points at them)
_SECRET_KINDS = {"stones", "shrine", "ruins", "monastery"}


def _font(size: int):
    from PIL import ImageFont
    for path in _FONT_CANDIDATES:
        if os.path.isfile(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()


def render_schematic(plan: WorldPlan, cell: int = 7):
    from PIL import Image, ImageDraw

    W, H = plan.width, plan.height
    pad = 40
    img = Image.new("RGB", (W * cell + pad * 2, H * cell + pad * 2 + 30),
                    _BIOME_COLOR["deep"])
    px = Image.new("RGB", (W, H), _BIOME_COLOR["deep"])
    pmap = px.load()

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
            if plan.in_marsh(x, y):
                pmap[x, y] = _BIOME_COLOR["marsh"]
                continue
            elev = plan.elevation_at(x, y)
            levels[y][x] = elev
            biome = plan.biome_at(x, y)
            if lv < 0.22 and _COAST_SINK.get(biome, 1.0) > 0.6:
                base = _BIOME_COLOR["beach"]
            else:
                base = _BIOME_COLOR[biome]
            f = 0.74 + 0.10 * elev
            pmap[x, y] = tuple(min(255, int(c * f)) for c in base)

    px = px.resize((W * cell, H * cell), Image.NEAREST)
    img.paste(px, (pad, pad))
    draw = ImageDraw.Draw(img, "RGBA")

    def S(pt):
        return (pad + pt[0] * cell, pad + pt[1] * cell)

    # terrace contour lines — the signature of the level system
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

    for r in plan.rivers:
        pts = [S(p) for p in r.points]
        draw.line(pts, fill=(70, 140, 220, 255),
                  width=max(2, int(r.width * cell * 0.5)), joint="curve")

    for a, b in plan.roads:
        na, nb = plan.nodes[a], plan.nodes[b]
        draw.line([S((na.x, na.y)), S((nb.x, nb.y))],
                  fill=(214, 196, 150, 235), width=max(2, cell // 2))

    f = _font(13)
    for node in plan.nodes.values():
        cx, cy = S((node.x, node.y))
        col = _NODE_COLOR.get(node.kind, (230, 230, 230))
        r = 7 if node.kind == "castle" else 5
        if node.kind in _SECRET_KINDS:
            draw.ellipse([cx - r, cy - r, cx + r, cy + r],
                         outline=col + (255,), width=2)
        else:
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col + (255,),
                         outline=(20, 20, 30, 255), width=2)
        tw = draw.textlength(node.label, font=f)
        lx = min(max(cx - tw / 2, 2), img.width - tw - 2)
        draw.text((lx + 1, cy + r + 2), node.label, font=f, fill=(0, 0, 0, 180))
        draw.text((lx, cy + r + 1), node.label, font=f, fill=(245, 248, 255, 255))

    fd = _font(15)
    for dsc in plan.districts:
        cx, cy = S((dsc.cx, dsc.cy))
        tw = draw.textlength(dsc.name, font=fd)
        draw.text((cx - tw / 2 + 1, cy + 1), dsc.name, font=fd, fill=(0, 0, 0, 150))
        draw.text((cx - tw / 2, cy), dsc.name, font=fd, fill=(255, 255, 255, 210))

    draw.rectangle([pad - 2, pad - 2, pad + W * cell + 1, pad + H * cell + 1],
                   outline=(230, 230, 240, 255), width=2)
    ft = _font(20)
    draw.text((pad, img.height - 26),
              f"{plan.title} — world plan (terraced, {MAX_LEVEL} levels)",
              font=ft, fill=(235, 240, 250, 255))
    return img


if __name__ == "__main__":
    p = default_plan()
    print(p.title, f"{p.width}x{p.height}", len(p.districts), "districts",
          len(p.nodes), "landmarks", len(p.roads), "roads")
