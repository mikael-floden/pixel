"""THE GAME, GROWN (maintainer 2026-08-29: "take the map to the next level...
MAKE THE MAP BIGGER (TO SMALL NOW). DON'T FEEL LIMITED. We have lots of new
stuff/scenery — indoor scenery and outdoor scenery").

Runs AFTER world3.py and grows its 248x248 the_game onto a 384x384 canvas —
2.4x the area. THE TUNED ISLAND MOVES INTACT (+34,+30): every judgement
already made about it survives verbatim. The new sea gains an ARCHIPELAGO of
rule-built islets serving the world's own inhabited-then-abandoned canon
(aqueducts, beacons, standing stones, wrecked ships):

  LIGHTHOUSE POINT (SE)   rocky islet, the tall beacon, reached over a TIMBER
                          PIER — a walkable bridge deck from the SE shore,
                          dock pilings alongside, a fisher's hut at the
                          landing. The one islet you can WALK to.
  THE STANDING STONES (E) grass islet: the standing stone in a cairn ring
                          plus one ancient tree. Swim out.
  THE WRECK SHOALS (S)    bare sand bar: shipwreck prow, whale bones,
                          driftwood. Swim out (water is a monster-free
                          sanctuary, so the swim is always safe).
  THE MIST FEN ISLE (SW)  dark_mud bog islet: hanging willows (ONE species —
                          the maintainer's species rule), owl snags, beast
                          skulls, a witch ring.

On the island itself: THREE NEW HOUSES from the x-over-y wall system (the
fisher's hut, a woodcutter's cabin at the forest edge, a smithy in the
village), EVERY interior furnished (hearth/table/chairs/bed/cupboard/barrels/
rug — the indoor scenery ask), the cave lit with braziers, and a VILLAGE +
NATURE dressing pass: wells, market stalls, washing lines, signposts at real
road junctions, waystones along the road, fen cattails, forest-floor ferns
and mushrooms, beach driftwood, pond lilies. Every placement validates its
ground and collisions; the light audit (8 slots/window) gates the build.

    python maps2/pipeline/world3.py       # the base 248 build
    python maps2/pipeline/world3grow.py   # grow to 384 + everything above
"""
from __future__ import annotations

import json
import math
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
MAPS2 = os.path.dirname(_HERE)
REPO = os.path.dirname(MAPS2)
OUT = os.path.join(MAPS2, "worlds3", "the_game")

NEW = 512
OFF = (240, 244)          # the tuned island rides FRONT (down-screen); the
                          # map GROWS OUT OF IT (maintainer 2026-08-30, the
                          # architecture, verbatim: "skip the second island
                          # and extend the first island upwards. Extend the
                          # mountain top in that same height/elevation. Make
                          # it go down a bit in elevation and create the
                          # city in the valley. In the valley you can use
                          # grass again. Then continue and make the island
                          # at least twice as big")
EXT_C = (205, 215)        # the extension blob centre (up-screen of the
                          # original); its far NW rim stays sealed cliff
EXT_R = 118
TOWN_AT = (168, 176)      # fallback town target; the real one derives from
                          # where the ridge ends and the valley opens

import world3


def _rng32(seed):
    s0 = seed & 0xffffffff
    def r():
        nonlocal s0
        s0 = (s0 * 1664525 + 1013904223) & 0xffffffff
        return s0 / 2 ** 32
    return r


def _fbm(x, y, seed, octaves=3):
    def vn(ix, iy, s):
        h = (ix * 374761393 + iy * 668265263 + s * 1274126177) & 0xffffffff
        h = (h ^ (h >> 13)) * 1274126177 & 0xffffffff
        return ((h ^ (h >> 16)) & 0xffff) / 65535
    v, amp, freq, tot = 0.0, 1.0, 1.0, 0.0
    for o in range(octaves):
        xf, yf = x * freq, y * freq
        ix, iy = int(math.floor(xf)), int(math.floor(yf))
        fx, fy = xf - ix, yf - iy
        a = vn(ix, iy, seed + o); b = vn(ix + 1, iy, seed + o)
        c = vn(ix, iy + 1, seed + o); d = vn(ix + 1, iy + 1, seed + o)
        sx, sy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
        v += amp * ((a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy)
        tot += amp; amp *= 0.5; freq *= 2
    return v / tot


class Grow:
    def __init__(self):
        self.doc = json.load(open(os.path.join(OUT, "world.json")))
        d = self.doc
        self.W0 = d["size"]["w"]
        assert self.W0 < 260, (
            f"world.json is already grown ({self.W0}) — run world3.py first; "
            "grow always starts from the fresh base build")
        self.G = d["grounds"]
        self.gi = {g: i for i, g in enumerate(self.G)}
        for g in ("grass", "light_beach", "dark_mud", "grey_stone", "water",
                  "deep_water", "parquet_floor", "brown_paving_stone",
                  "grey_paving_stone", "light_soil"):
            assert g in self.gi, f"base build missing ground {g}"
        self.placed = []          # (label, count) build log
        self.fail = 0

    # -- canvas ---------------------------------------------------------------
    def grow_canvas(self):
        d, gi = self.doc, self.gi
        ox, oy = OFF
        dw = gi["water"]      # new sea starts SHALLOW; the global deep-water
                              # rule reclassifies it after island 2 lands
        grd = [[dw] * NEW for _ in range(NEW)]
        lvl = [[0] * NEW for _ in range(NEW)]
        for y in range(self.W0):
            for x in range(self.W0):
                grd[y + oy][x + ox] = d["ground"][y][x]
                lvl[y + oy][x + ox] = d["level"][y][x]
        d["size"] = {"w": NEW, "h": NEW}
        d["ground"], d["level"] = grd, lvl
        d["spawn"] = [d["spawn"][0] + ox, d["spawn"][1] + oy]
        for dk in d.get("decks", []):
            for c in dk["cells"]:
                c["x"] += ox; c["y"] += oy
        for w_ in d.get("walls", []):
            for c in w_["cells"]:
                c["x"] += ox; c["y"] += oy
        for p in d.get("scenery", []):
            p["x"] += ox; p["y"] += oy
        self.grd, self.lvl = grd, lvl
        self.slim_roofs()

    def slim_roofs(self):
        """SLIM ROOFS (maintainer 2026-08-29: "the big house is not using the
        new x-over-x/y to create a slimmer looking roof"). A roof deck used to
        ride one level ABOVE the wall tops — a fat slab band of extra storey.
        The x-over-y walls already carry the whole height, so the roof plane
        sits flush AT the wall-top level: level = max wall level under the
        deck, thickness 0 — no added layer, exactly the doctrine."""
        for dk in self.doc["decks"]:
            if dk["kind"] != "roof":
                continue
            wl = max(self.lvl[c["y"]][c["x"]] for c in dk["cells"])
            dk["level"] = wl
            dk["thickness"] = 0

    # -- helpers --------------------------------------------------------------
    def g(self, x, y):
        return self.G[self.grd[y][x]] if 0 <= x < NEW and 0 <= y < NEW else ""

    def liquid(self, x, y):
        return self.g(x, y) in ("water", "deep_water")

    def _reindex(self):
        """Grid-bucket index of scenery for O(1) collision checks (a linear
        scan per placement measured the build into the minutes)."""
        self.occ = {}
        for p in self.doc["scenery"]:
            tree = p["piece"].startswith(("trees/", "bushes/", "ancient_trees/"))
            self.occ.setdefault((int(p["x"]), int(p["y"])), []).append(
                (p["x"], p["y"], tree))

    def free(self, x, y, r=0.8):
        if not hasattr(self, "occ"):
            self._reindex()
        cx, cy = int(x), int(y)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for (px, py, _t) in self.occ.get((cx + dx, cy + dy), ()):
                    if (px - x) ** 2 + (py - y) ** 2 <= r * r:
                        return False
        return True

    def _wdist(self):
        """Manhattan distance to the nearest wet/void/beach cell, BFS once —
        the per-candidate DRY_R rescans measured the pad search into the
        minutes."""
        from collections import deque
        D = self.DRY_R + 2
        dist = [[99] * NEW for _ in range(NEW)]
        q = deque()
        for y in range(NEW):
            for x in range(NEW):
                g = self.g(x, y)
                if not g or g in ("water", "deep_water", "light_beach"):
                    dist[y][x] = 0
                    q.append((x, y))
        while q:
            x, y = q.popleft()
            d = dist[y][x]
            if d >= D:
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < NEW and 0 <= ny < NEW and dist[ny][nx] > d + 1:
                    dist[ny][nx] = d + 1
                    q.append((nx, ny))
        self.wd = dist

    def put(self, piece, x, y, on=None, hflip=False, lit=False):
        """One validated placement: the piece dir must exist, the ground must
        be in `on` (if given), the spot must be free. `lit` selects the
        piece's LIT_* state (the piece must ship one) and spends a slot of
        the engine's 8-per-window light budget — the audit gates the build.
        Failures count, never silently vanish."""
        grp = piece.split("/")[0]
        assert os.path.isdir(os.path.join(REPO, "scenery", piece)), piece
        if lit:
            meta = json.load(open(os.path.join(REPO, "scenery", piece,
                                               "scenery.json")))
            assert any(k.startswith("LIT") for k in (meta.get("states") or {})), \
                f"{piece} has no LIT state to select"
        if on is not None and self.g(int(x), int(y)) not in on:
            self.fail += 1
            return False
        if not self.free(x, y):
            self.fail += 1
            return False
        if on is None or "parquet_floor" not in on:
            # outdoor pieces stay out of the up-screen shadow behind a roof —
            # a washing line 2 cells behind the cottage rendered ON its roof
            if (int(x), int(y)) in getattr(self, "no_place", set()):
                self.fail += 1
                return False
        p = {"piece": piece, "x": round(x, 2), "y": round(y, 2)}
        if hflip:
            p["hflip"] = True
        if lit:
            p["lit"] = True
        self.doc["scenery"].append(p)
        if not hasattr(self, "occ"):
            self._reindex()
        else:
            self.occ.setdefault((int(p["x"]), int(p["y"])), []).append(
                (p["x"], p["y"], False))
        return True

    def pool(self, group):
        gp = os.path.join(REPO, "scenery", group)
        return sorted(f"{group}/{d}" for d in os.listdir(gp)
                      if os.path.isdir(os.path.join(gp, d)))

    # -- the archipelago ------------------------------------------------------
    def islet(self, cx, cy, r, ground, seed, beach=True):
        gi, grd, lvl = self.gi, self.grd, self.lvl
        cells = []
        for y in range(cy - r - 3, cy + r + 4):
            for x in range(cx - r - 3, cx + r + 4):
                if not (0 <= x < NEW and 0 <= y < NEW) or not self.liquid(x, y):
                    continue
                ang = math.atan2(y - cy, x - cx)
                wob = _fbm(math.cos(ang) * 2 + 3, math.sin(ang) * 2 + 3, seed)
                rr = r * (0.72 + 0.55 * wob)
                dd = math.hypot(x - cx, y - cy)
                if dd <= rr:
                    grd[y][x] = gi[ground]; lvl[y][x] = 0
                    cells.append((x, y))
                elif beach and dd <= rr + 1.6:
                    grd[y][x] = gi["light_beach"]; lvl[y][x] = 0
                    cells.append((x, y))
        # shallow shelf so a swimmer sees land coming
        for (x, y) in cells:
            for dx in range(-3, 4):
                for dy in range(-3, 4):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < NEW and 0 <= ny < NEW \
                            and self.grd[ny][nx] == gi["deep_water"]:
                        self.grd[ny][nx] = gi["water"]
        return cells

    def archipelago(self):
        # Lighthouse Point sits a SHORT pier off the island's SE-most coast
        # (a 97-cell bridge measured ridiculous; ~12 cells reads as a pier).
        # The other islets live in the CHANNEL between the two islands and in
        # the southern sea — swim destinations (water is a monster-free
        # sanctuary, so the swim is always safe).
        se = max(((x, y) for y in range(NEW) for x in range(NEW)
                  if not self.liquid(x, y) and self.g(x, y)),
                 key=lambda c: c[0] + c[1])
        self.isl_light = self.islet(min(NEW - 12, se[0] + 12),
                                    min(NEW - 12, se[1] + 10), 7, "grey_stone", 71)
        self.isl_stone = self.islet(322, 166, 6, "grass", 72)
        self.isl_shoal = self.islet(356, 478, 9, "light_beach", 73, beach=False)
        self.isl_fen = self.islet(142, 330, 8, "dark_mud", 74)
        for nm, cs in (("lighthouse", self.isl_light), ("stones", self.isl_stone),
                       ("shoal", self.isl_shoal), ("fen", self.isl_fen)):
            assert len(cs) >= 25, f"islet {nm} drowned/collided: {len(cs)} cells"
        self.placed += [("islet cells", sum(map(len, (self.isl_light,
                        self.isl_stone, self.isl_shoal, self.isl_fen))))]

    # -- the second island ----------------------------------------------------
    def island2(self):
        """EXTEND THE MAP, NOT A NEW ISLAND (maintainer 2026-08-30, after
        three blob attempts all read as two islands: "just extend the
        current map, with the same look and feel. You should NOT create a
        new island!"). The island's own coastline is pushed up-screen:
        every new cell INHERITS ground and level from its nearest existing
        land cell (Dijkstra src over the sea), so the terrain continues —
        the massif shoulder elongates at its own height, then decays one
        bench per ~7 cells into the grass VALLEY that holds the city, and
        the frontier falls to a new shore. The far up-screen rim is sealed
        bench-6 cliff (the Zelda rule). Old beach lines that end up inland
        are erased to grass — no ghost coastlines."""
        import heapq
        gi, grd, lvl = self.gi, self.grd, self.lvl
        BENCH = (0, 2, 6, 10, 14, 16, 20, 24, 28, 32, 36, 40)
        land = [(x, y) for y in range(NEW) for x in range(NEW)
                if not self.liquid(x, y) and self.g(x, y)]
        cx0 = sum(c[0] for c in land) / len(land)
        cy0 = sum(c[1] for c in land) / len(land)
        INF = 1 << 30
        dist = [[INF] * NEW for _ in range(NEW)]
        srcc = [[None] * NEW for _ in range(NEW)]
        pq = []
        STEP = ((1, 0, 10), (-1, 0, 10), (0, 1, 10), (0, -1, 10),
                (1, 1, 14), (1, -1, 14), (-1, 1, 14), (-1, -1, 14))
        for (x, y) in land:
            for dx, dy, c in STEP:
                nx, ny = x + dx, y + dy
                if 0 <= nx < NEW and 0 <= ny < NEW and self.liquid(nx, ny) \
                        and dist[ny][nx] > c:
                    dist[ny][nx] = c
                    srcc[ny][nx] = (x, y)
                    heapq.heappush(pq, (c, nx, ny))
        while pq:
            d, x, y = heapq.heappop(pq)
            if d > dist[y][x] or d > 1200:
                continue
            for dx, dy, c in STEP:
                nx, ny = x + dx, y + dy
                if 0 <= nx < NEW and 0 <= ny < NEW and self.liquid(nx, ny) \
                        and dist[ny][nx] > d + c:
                    dist[ny][nx] = d + c
                    srcc[ny][nx] = srcc[y][x]
                    heapq.heappush(pq, (d + c, nx, ny))
        new, sealed = [], 0
        for y in range(NEW):
            for x in range(NEW):
                if not self.liquid(x, y) or dist[y][x] >= INF:
                    continue
                # up-screen gate: full reach to the NW, nothing to the SE —
                # the tuned south/east coasts keep their exact silhouette
                w = ((cx0 + cy0) - (x + y)) / 150 + 0.15
                if w <= 0.03:
                    continue
                wob = 0.75 + 0.5 * _fbm(x * 0.03, y * 0.03, 95)
                reach = 950 * min(1.0, w) * wob
                d = dist[y][x]
                if d > reach:
                    continue
                sx_, sy_ = srcc[y][x]
                z0 = lvl[sy_][sx_]
                over = max(0.0, d / 10 - 18)
                z = max(0, int(z0 - (over / 7) * 4))
                z = max(b for b in BENCH if z >= b)
                rem = reach - d
                far = w > 0.85          # the sealed far rim sector
                if rem < 300:
                    z = min(z, 6 if far else 2)
                if rem < 120 and not far:
                    z = 0
                if far and rem < 200:
                    z = max(z, 6); sealed += 1
                grd[y][x] = gi["snow" if z >= 20 else
                               "grey_stone" if z >= 14 else "grass"]
                lvl[y][x] = z
                new.append((x, y))
        assert len(new) > 22000, f"extension too small: {len(new)}"
        assert sealed > 200, "the far rim must be sealed cliff"
        newset = set(new)
        # beach ring on the OPEN frontier only (never the sealed rim)
        for (x, y) in new:
            if lvl[y][x] == 0 and self.g(x, y) == "grass" \
                    and any(self.liquid(x + dx, y + dy)
                            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                grd[y][x] = gi["light_beach"]
        # ghost coastlines: old beach with no water near it becomes grass
        ghosts = 0
        for y in range(NEW):
            for x in range(NEW):
                if (x, y) not in newset and self.g(x, y) == "light_beach" \
                        and not any(self.liquid(x + dx, y + dy)
                                    for dx in (-2, -1, 0, 1, 2)
                                    for dy in (-2, -1, 0, 1, 2)):
                    grd[y][x] = gi["grass"]
                    ghosts += 1
        # a stream off the extended highland into the valley
        top = max(new, key=lambda c: lvl[c[1]][c[0]])
        seen, riv, (x, y) = set(), [], top
        for _ in range(400):
            seen.add((x, y))
            if self.liquid(x, y):
                break
            if (x, y) in newset:
                grd[y][x] = gi["water"]
                riv.append((x, y))
            opts = [(lvl[y + dy][x + dx], x + dx, y + dy)
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
                    if (x + dx, y + dy) not in seen]
            if not opts:
                break
            _, x, y = min(opts)
        for (rx, ry) in riv:
            lvl[ry][rx] = max(0, lvl[ry][rx] - 4)
        self.ext_cells = newset
        nw = min(new, key=lambda c: c[0] + c[1])
        self.town_target = (nw[0] + 26, nw[1] + 22)
        self.i2_land = len(new)
        self.placed += [("extension land", len(new)),
                        ("ghost beach erased", ghosts)]

    def i2_road(self):
        """The town's south-gate road: out of the valley, along the ridge
        flank, onto the original island's shore — one island, one walk.
        Carved BEFORE forests so the wood keeps off it."""
        gi = self.gi
        ox, oy = OFF
        cx0, _ = self.plaza
        fx, fy = min(((x, y) for y in range(oy, NEW) for x in range(ox, NEW)
                      if not self.liquid(x, y) and self.g(x, y)
                      and (x, y) not in self.ext_cells),
                     key=lambda c: (c[0] - cx0) ** 2 + (c[1] - self.plaza[1]) ** 2)
        cx, _ = self.plaza
        x0t, y0t, TW, TH = self.town
        x, y, n = cx, y0t + TH, 0
        seen = set()
        while abs(x - fx) + abs(y - fy) > 2 and n < 700:
            n += 1
            seen.add((x, y))
            if self.g(x, y) == "grass":
                self.grd[y][x] = gi["light_soil"]
            opts = [(abs(x + dx - fx) + abs(y + dy - fy)
                     + 6 * abs(self.lvl[y + dy][x + dx] - self.lvl[y][x]),
                     x + dx, y + dy)
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
                    if (x + dx, y + dy) not in seen
                    and not self.liquid(x + dx, y + dy)
                    and self.g(x + dx, y + dy)]
            if not opts:
                break
            _, x, y = min(opts)
        self.placed += [("town road cells", n)]

    def town_ground(self):
        """THE TOWN takes the camera-facing south shelf: ground levelled to
        bench 2, a grey-paving plaza, two brown-paving streets crossing at
        it — the city tiles exist now, so the city uses them. The site scan
        maximizes flat grass and flees water."""
        gi = self.gi
        TW, TH = 36, 26
        tx, ty = getattr(self, "town_target", TOWN_AT)
        best = None
        for cy in range(ty - 18, ty + 19, 2):
            for cx in range(tx - 18, tx + 19, 2):
                x0, y0 = cx - TW // 2, cy - TH // 2
                sc = 0
                for y in range(y0, y0 + TH, 2):
                    for x in range(x0, x0 + TW, 2):
                        g = self.g(x, y)
                        if g == "grass" and self.lvl[y][x] <= 9:
                            sc += 1
                        elif g in ("water", "deep_water", ""):
                            sc -= 4
                if best is None or sc > best[0]:
                    best = (sc, x0, y0)
        _, x0, y0 = best
        self.town = (x0, y0, TW, TH)
        for y in range(y0, y0 + TH):
            for x in range(x0, x0 + TW):
                if self.g(x, y) == "grass":
                    self.lvl[y][x] = 2
        cx, cy = x0 + TW // 2, y0 + TH // 2
        self.plaza = (cx, cy)
        for y in range(cy - 4, cy + 5):
            for x in range(cx - 6, cx + 7):
                if self.g(x, y) == "grass":
                    self.grd[y][x] = gi["grey_paving_stone"]
        for y in range(y0 + 1, y0 + TH - 1):
            for x in (cx - 1, cx):
                if self.g(x, y) == "grass":
                    self.grd[y][x] = gi["brown_paving_stone"]
        for x in range(x0 + 1, x0 + TW - 1):
            for y in (cy - 1, cy):
                if self.g(x, y) == "grass":
                    self.grd[y][x] = gi["brown_paving_stone"]
        self.placed += [("town ground", TW * TH)]

    def town(self):
        """Six houses ring the plaza (stone and timber mixed, the hall north
        of the square), and the town PUSHES THE LIGHT BUDGET (maintainer
        2026-08-29: "push the limit to always have as many lit scenery tiles
        as you can for any given scene") — eight LIT posts around plaza and
        gates; the audit proves the worst camera window stays at the engine's
        8 slots, never over."""
        cx, cy = self.plaza
        x0, y0, TW, TH = self.town
        specs = [(cx - 13, cy - 8, 6, 5, "brown_paving_stone",
                  "grey_paving_stone", "grey_paving_stone"),
                 (cx - 14, cy + 2, 7, 5, "parquet_floor", "grass", "grass"),
                 (cx + 8, cy - 8, 7, 5, "parquet_floor", "grass", "grass"),
                 (cx + 9, cy + 2, 6, 5, "brown_paving_stone",
                  "grey_paving_stone", "grey_paving_stone"),
                 (cx - 4, cy - 12, 8, 6, "brown_paving_stone",
                  "grey_paving_stone", "grey_paving_stone"),
                 (cx - 2, cy + 7, 6, 4, "parquet_floor", "grass", "grass")]
        built = 0
        for (hx, hy, w, h, face, top, roof) in specs:
            try:
                px, py = self.find_pad(hx, hy, w, h, r=16, widen=False, dry=3)
            except AssertionError:
                self.fail += 1
                continue
            self.house(px, py, w, h, face, top, roof)
            built += 1
        assert built >= 5, f"the town only fit {built} houses"
        PAVE = ("grey_paving_stone", "brown_paving_stone")
        n = 0
        n += self.put("stone_fountains/stone_fountain_004", cx + 0.5, cy + 0.5,
                      on=PAVE)
        n += self.put("wells/well_008", cx - 4.5, cy - 2.5, on=PAVE)
        for i, (dx, dy) in enumerate(((4, -2), (5, 0), (4, 2))):
            n += self.put(self.pool("market_stalls")[i], cx + dx + 0.5,
                          cy + dy + 0.5, on=PAVE, hflip=i % 2 == 1)
        n += self.put("maypoles/maypole_007", cx - 4.5, cy + 2.5, on=PAVE)
        n += self.put("flower_stands/flower_stand_003", cx + 2.5, cy - 3.5,
                      on=PAVE)
        n += self.put("sundials/sundial_002", cx - 1.5, cy - 3.5, on=PAVE)
        n += self.put("statues/statue_003", cx + 1.5, cy + 3.5, on=PAVE)
        n += self.put("story_posts/story_post_001", cx - 2.5, cy + 3.5, on=PAVE)
        n += self.put("letter_boxes/letter_box_003", cx + 3.5, cy + 3.5, on=PAVE)
        n += self.put("chairs_and_benches/chair_005", cx - 5.5, cy + 0.5, on=PAVE)
        n += self.put("carts/cart_011", cx + 2.5, y0 + TH - 2.5, on=("grass",))
        n += self.put("washing_lines/washing_line_002", cx - 11.5, cy + 8.5,
                      on=("grass",))
        n += self.put("woodpiles/woodpile_001", cx + 7.5, cy + 8.5, on=("grass",))
        # THE LIGHTS: 8 lit posts — plaza corners + the four gates
        lights = [("streetlights/streetlight_007", cx - 5.5, cy - 4.5),
                  ("streetlights/streetlight_011", cx + 6.5, cy - 4.5),
                  ("streetlights/streetlight_013", cx - 5.5, cy + 5.5),
                  ("streetlights/streetlight_007", cx + 6.5, cy + 5.5),
                  ("lantern_posts/lantern_post_001", cx + 1.5, y0 + 1.5),
                  ("lantern_posts/lantern_post_004", cx + 1.5, y0 + TH - 1.5),
                  ("lantern_posts/lantern_post_005", x0 + 1.5, cy + 1.5),
                  ("lantern_posts/lantern_post_001", x0 + TW - 1.5, cy + 1.5)]
        nl = 0
        for (pc, lx, ly) in lights:
            nl += self.put(pc, lx, ly, lit=True)
        self.placed += [("town pieces", n), ("town lights LIT", nl)]

    def i2_cave(self):
        """A CAVE inside island 2's massif (maintainer 2026-08-29: "if a
        mountain becomes to high you can fit an entire cave inside it! This is
        a feature not a bug!") — island 1's own model: black_rock floor cells
        sunk into the rock under a kind-'cave' lid deck that keeps the
        mountain top, the mouth opening the south rim at outside grade."""
        gi, grd, lvl = self.gi, self.grd, self.lvl
        MASS = 14   # the ridge tops at 24; 14+ is its rock body
        mass = {(x, y) for (x, y) in self.ext_cells
                if self.g(x, y) in ("grey_stone", "snow") and lvl[y][x] >= MASS}
        if len(mass) <= 140:
            self.placed += [("cave", "skipped: shoulder too thin")]
            return
        core = {c for c in mass
                if all((c[0] + dx, c[1] + dy) in mass
                       for dx in (-1, 0, 1) for dy in (-1, 0, 1))}
        mouth = max((c for c in mass if (c[0], c[1] + 1) not in mass),
                    key=lambda c: c[0] + c[1])
        mx, my = mouth
        FL = lvl[my + 1][mx]          # walk in at outside grade
        rooms = [(mx - 3, my - 4, 3), (mx - 10, my - 7, 4), (mx - 2, my - 11, 3)]
        floor = set()
        for (rx, ry, rr) in rooms:
            for dy in range(-rr, rr + 1):
                for dx in range(-rr, rr + 1):
                    c = (rx + dx, ry + dy)
                    if dx * dx + dy * dy <= rr * rr and c in core \
                            and self.g(*c) != "water":
                        floor.add(c)
        if len(floor) < 30:
            self.placed += [("cave", f"skipped: rooms {len(floor)}")]
            return
        def corridor(a, b):
            x, y = a
            while x != b[0]:
                x += 1 if b[0] > x else -1
                if (x, y) in core:
                    floor.add((x, y))
            while y != b[1]:
                y += 1 if b[1] > y else -1
                if (x, y) in core:
                    floor.add((x, y))
        corridor((mx, my - 1), (rooms[0][0], rooms[0][1]))
        corridor((rooms[0][0], rooms[0][1]), (rooms[1][0], rooms[1][1]))
        corridor((rooms[0][0], rooms[0][1]), (rooms[2][0], rooms[2][1]))
        lidlv = {}
        for c in floor:
            lidlv[c] = lvl[c[1]][c[0]]
            grd[c[1]][c[0]] = gi["black_rock"]
            lvl[c[1]][c[0]] = FL
        # the mouth: floor pierces the rim, no lid over the doorway cells
        door = [(mx, my), (mx, my - 1)]
        for c in door:
            grd[c[1]][c[0]] = gi["black_rock"]
            lvl[c[1]][c[0]] = FL
            floor.discard(c)
        lid = max(lidlv.values())
        self.new_cave = {
            "kind": "cave", "level": lid, "thickness": 2, "ground": "grey_stone",
            "cells": [{"x": c[0], "y": c[1]} for c in sorted(floor)]}
        self.doc["decks"].append(self.new_cave)
        self.placed += [("island2 cave floor", len(floor) + 2)]

    def i2_systems(self):
        """The first island's own rule functions, re-run scoped to island 2's
        quarter of the canvas (it fits entirely in x,y < 256; the original
        starts past 264, so the crop can never touch it): fen riverbanks,
        x-over-y terrain wall bodies, species-clustered forests."""
        S = 336          # covers the whole extension + join; the original's
                         # NW corner cells it grazes re-derive the SAME walls
        smat = [[(self.G[self.grd[y][x]] if self.grd[y][x] >= 0 else "")
                 for x in range(S)] for y in range(S)]
        slvl = [row[0:S] for row in self.lvl[0:S]]
        fen = world3._fen(S, S, smat, slvl)
        walls = world3._terrain_walls(S, S, smat, slvl)
        self.doc["walls"] += walls
        # forest pre-seeds: 7 grassy spots >=30 apart seed 7 woods, so the
        # second island is at least as wooded as the first
        seeds, best = [], []
        for y in range(6, S - 6, 7):
            for x in range(6, S - 6, 7):
                if smat[y][x] == "grass" and slvl[y][x] <= 8:
                    sc = sum(1 for dx in range(-5, 6, 2) for dy in range(-5, 6, 2)
                             if 0 <= x+dx < S and 0 <= y+dy < S
                             and smat[y+dy][x+dx] == "grass")
                    best.append((sc, x, y))
        for sc, x, y in sorted(best, reverse=True):
            if all(abs(x - a) + abs(y - b) > 24 for a, b in seeds):
                seeds.append((x, y))
            if len(seeds) >= 12:
                break
        fake = [{"piece": "trees/tree_001", "x": float(a), "y": float(b)}
                for a, b in seeds]
        ham = getattr(self, "town_target", TOWN_AT)
        trees = world3._forests(S, S, smat, slvl, fake, ham)
        self.doc["scenery"] += trees
        for y in range(S):          # write the fen's mutations back
            for x in range(S):
                g = smat[y][x]
                if g and self.grd[y][x] != self.gi[g]:
                    self.grd[y][x] = self.gi[g]
        self.placed += [("island2 fen", fen),
                        ("island2 wall sides", sum(len(w["cells"]) for w in walls)),
                        ("island2 trees", len(trees))]

    def retype(self):
        """world3.retype_woods over the WHOLE grown map — the final word on
        which species each wood speaks (per-forest rule)."""
        def is_high(x, y):
            if not (0 <= x < NEW and 0 <= y < NEW):
                return False
            return self.lvl[y][x] >= 6 or any(
                self.g(x + dx, y + dy) in ("grey_stone", "snow", "black_rock")
                for dx, dy in ((8, 0), (-8, 0), (0, 8), (0, -8)))
        n = world3.retype_woods(self.doc["scenery"], is_high)
        self.placed += [("woods retyped", n)]

    def spawns(self):
        """Monsters SPREAD over the doubled land (maintainer 2026-08-29): the
        tuned v2 zones translate verbatim (+OFF); the new land gets NEW zones
        reusing the SAME cast by habitat — meadows the grass cast, the new
        massif the mountain cast, the fens the bog cast, the new cave the
        cave cast. The town, like water, is a sanctuary: no zones near it."""
        src = json.load(open(os.path.join(
            MAPS2, "worlds", "the_island2", "spawns.json")))
        ox, oy = OFF
        zones = []
        for z in src["zones"]:
            zz = dict(z)
            zz["area"] = [[x + ox, y + oy] for x, y in z["area"]]
            zones.append(zz)
        casts = {"grass": [], "mountain": [], "mud": [], "cave": []}
        for z in zones:
            if z["id"].startswith("cave"):
                casts["cave"].append(z["monster"])
                continue
            xs = [p[0] for p in z["area"]]
            ys = [p[1] for p in z["area"]]
            g = self.g(sum(xs) // len(xs), sum(ys) // len(ys))
            if g in ("snow", "ice", "grey_stone", "black_rock"):
                casts["mountain"].append(z["monster"])
            elif g == "dark_mud":
                casts["mud"].append(z["monster"])
            else:
                casts["grass"].append(z["monster"])

        def rect(x0, y0, w, h):
            return [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]]
        tx0, ty0, TW, TH = self.town

        def town_free(x, y):
            return not (tx0 - 12 <= x <= tx0 + TW + 12
                        and ty0 - 14 <= y <= ty0 + TH + 12)
        spots = {"grass": [], "mountain": [], "mud": []}
        for y in range(8, 300, 6):
            for x in range(8, 300, 6):
                g = self.g(x, y)
                if not g or self.liquid(x, y) or not town_free(x, y):
                    continue
                z = self.lvl[y][x]
                if g == "grass" and z <= 9:
                    spots["grass"].append((x, y, [0, 9]))
                elif g in ("snow", "grey_stone") and z >= 16:
                    spots["mountain"].append((x, y, [16, 40]))
                elif g == "dark_mud":
                    spots["mud"].append((x, y, [0, 4]))
        new, ni = [], 0
        for kind, lim in (("grass", 6), ("mountain", 4), ("mud", 2)):
            cast = casts[kind] or casts["grass"]
            picked = []
            for (x, y, el) in spots[kind]:
                if all(abs(x - a) + abs(y - b) > 26 for a, b, _ in picked):
                    picked.append((x, y, el))
                if len(picked) >= lim:
                    break
            for j, (x, y, el) in enumerate(picked):
                new.append({"id": f"n-{kind}-{j + 1}",
                            "monster": cast[(ni + j) % len(cast)],
                            "area": rect(x - 7, y - 5, 14, 10),
                            "elev": el, "num": 2})
            ni += len(picked)
        caves2 = [dk for dk in [getattr(self, "new_cave", None)] if dk]
        for j, dk in enumerate(caves2):
            xs = [c["x"] for c in dk["cells"]]
            ys = [c["y"] for c in dk["cells"]]
            fl = min(self.lvl[c["y"]][c["x"]] for c in dk["cells"])
            cast = casts["cave"] or ["masked_shadow_creature"]
            new.append({"id": f"n-cave-{j + 1}", "monster": cast[j % len(cast)],
                        "area": rect(min(xs) - 1, min(ys) - 1,
                                     max(xs) - min(xs) + 2, max(ys) - min(ys) + 2),
                        "elev": [fl, fl + 2], "num": 2})
        out = {"schema": "pixel-maps3/spawns@1", "world": "the_game",
               "zones": zones + new}
        json.dump(out, open(os.path.join(OUT, "spawns.json"), "w"),
                  separators=(",", ":"))
        self.placed += [("spawn zones", f"{len(zones)} ported + {len(new)} new")]

    # -- the pier -------------------------------------------------------------
    def pier(self):
        """A walkable timber bridge deck from the SE shore to Lighthouse
        Point: kind 'bridge' (render draws the slab, scenery under it is NOT
        hidden — only roof/cave hide), ground parquet_floor, level 0."""
        # islet cell nearest the island, then the ISLAND's nearest land cell —
        # islet cells themselves excluded or the search lands on the islet
        isl = set(self.isl_light) | set(self.isl_stone) \
            | set(self.isl_shoal) | set(self.isl_fen)
        lx, ly = min(self.isl_light, key=lambda c: c[0] + c[1])
        best, land = 10 ** 9, None
        for y in range(NEW):
            for x in range(NEW):
                if (x, y) not in isl and not self.liquid(x, y) and self.g(x, y):
                    d2 = (x - lx) ** 2 + (y - ly) ** 2
                    if d2 < best:
                        best, land = d2, (x, y)
        assert land, "no shore found for the pier"
        cells, x, y = [], land[0], land[1]
        while (x, y) != (lx, ly):
            if x != lx:
                x += 1 if lx > x else -1
            elif y != ly:
                y += 1 if ly > y else -1
            if self.liquid(x, y):
                cells.append({"x": x, "y": y})
        assert 6 <= len(cells) <= 120, f"pier length {len(cells)} out of taste"
        self.doc["decks"].append({"kind": "bridge", "level": 0, "thickness": 1,
                                  "ground": "parquet_floor", "cells": cells})
        pil = self.pool("dock_pilings")
        n = 0
        for i, c in enumerate(cells):
            if i % 3 == 1:
                side = 0.55 if (i // 3) % 2 else -0.55
                horiz = i < len(cells) - abs(ly - land[1])
                px = c["x"] + (0 if horiz else side)
                py = c["y"] + (side if horiz else 0)
                if self.put(pil[(i // 3) % len(pil)], px + 0.5, py + 0.5):
                    n += 1
        self.landing = land
        self.placed += [("pier cells", len(cells)), ("dock pilings", n)]

    # -- houses ---------------------------------------------------------------
    def _roof_ref(self):
        roofs = sorted((dk for dk in self.doc["decks"] if dk["kind"] == "roof"),
                       key=lambda dk: len(dk["cells"]))
        big = roofs[-1]
        lv, th = int(big["level"]), int(big.get("thickness", 1))
        wl = max(self.lvl[c["y"]][c["x"]] for c in big["cells"])
        fl = min(self.lvl[c["y"]][c["x"]] for c in big["cells"])
        return lv, th, wl, fl

    def house(self, x0, y0, w, h, face, top, roof):
        """A new x-over-y house: perimeter cells raised to the reference wall
        level with authored face+top, parquet interior, roof slab, south door.
        Same geometry the two translated houses use, so the renderer needs
        nothing new."""
        lv, th, wl, fl = self._roof_ref()
        rise = max(3, wl - fl)   # storey count is RELATIVE: a house on the
                                 # bench-2 town plaza measured 40% shorter and
                                 # dug its floor 2 below the street when it
                                 # borrowed the meadow house's absolute levels
        gi, grd, lvl = self.gi, self.grd, self.lvl
        base = self.lvl[y0][x0]
        rect = [(x, y) for y in range(y0, y0 + h) for x in range(x0, x0 + w)]
        for (x, y) in rect:      # the pad must be dry land, flat enough
            assert not self.liquid(x, y) and self.g(x, y), (x, y, self.g(x, y))
        door = (x0 + w // 2, y0 + h - 1)
        wcells = []
        for (x, y) in rect:
            ring = x in (x0, x0 + w - 1) or y in (y0, y0 + h - 1)
            if ring and (x, y) != door:
                grd[y][x] = gi[top]; lvl[y][x] = base + rise
                wcells.append({"x": x, "y": y})
            else:
                grd[y][x] = gi["parquet_floor"]; lvl[y][x] = base
        self.doc["walls"].append({"side": face, "cells": wcells})
        self.doc["decks"].append({"kind": "roof", "level": base + rise,
                                  "thickness": 0, "ground": roof,
                                  "cells": [{"x": x, "y": y} for (x, y) in rect]})
        # doorstep
        dx, dy = door[0], door[1] + 1
        if self.g(dx, dy) == "grass":
            grd[dy][dx] = gi["brown_paving_stone"]
        # evict scenery the pad swallowed
        self.doc["scenery"] = [
            p for p in self.doc["scenery"]
            if not (x0 - 1 <= p["x"] <= x0 + w and y0 - 1 <= p["y"] <= y0 + h)]
        self._reindex()
        return [(x, y) for (x, y) in rect
                if not (x in (x0, x0 + w - 1) or y in (y0, y0 + h - 1))]

    DRY_R = 7      # houses stand on the OPEN GRASS FIELD, never by the shore
                   # (maintainer 2026-08-29: "Don't place them to close to the
                   # water! Place them at the open grass field instead!")

    def find_pad(self, tx, ty, w, h, on=("grass",), r=60, widen=True, dry=None):
        """Nearest flat clear w*h pad to (tx,ty): every cell `on`-ground at one
        level and DRY (further than DRY_R from water/beach, via the BFS
        field), no paving/road adjacent, no non-tree scenery in the rect+1
        (trees get evicted by the house build)."""
        if not hasattr(self, "wd"):
            self._wdist()
        if not hasattr(self, "occ"):
            self._reindex()
        best, D = None, self.DRY_R if dry is None else dry
        for y in range(max(1, ty - r), min(NEW - h - 1, ty + r)):
            for x in range(max(1, tx - r), min(NEW - w - 1, tx + r)):
                z = self.lvl[y][x]
                ok = True
                for yy in range(y - 1, y + h + 1):
                    for xx in range(x - 1, x + w + 1):
                        gg = self.g(xx, yy)
                        inside = y <= yy < y + h and x <= xx < x + w
                        if inside and (gg not in on or self.lvl[yy][xx] != z
                                       or self.wd[yy][xx] <= D):
                            ok = False; break
                        if gg in ("light_soil", "brown_paving_stone",
                                  "grey_paving_stone", "parquet_floor"):
                            ok = False; break
                        if any(not t for (_px, _py, t)
                               in self.occ.get((xx, yy), ())):
                            ok = False; break
                    if not ok:
                        break
                if ok:
                    d2 = (x - tx) ** 2 + (y - ty) ** 2
                    if best is None or d2 < best[0]:
                        best = (d2, x, y)
        if not best and widen and r < 200:   # a beachy corner: walk inland
            return self.find_pad(tx, ty, w, h, on, r * 2, widen, dry)
        assert best, f"no {w}x{h} pad near {(tx, ty)}"
        return best[1], best[2]

    def houses(self):
        sx, sy = self.doc["spawn"]
        # fisher's hut: timber (turf over parquet faces) — on the grass field
        # ABOVE the pier landing, never on the sand itself
        lx, ly = self.landing
        hx, hy = self.find_pad(lx - 6, ly - 6, 6, 5)
        self.int_fisher = self.house(hx, hy, 6, 5, "parquet_floor", "grass", "grass")
        # woodcutter's cabin: timber, at the forest edge — the grass cell with
        # the most trees within 12, at least 50 from spawn
        best = None
        for p in self.doc["scenery"]:
            if not p["piece"].startswith("trees/"):
                continue
            x, y = int(p["x"]), int(p["y"])
            if abs(x - sx) + abs(y - sy) < 50:
                continue
            n = sum(1 for q in self.doc["scenery"]
                    if q["piece"].startswith("trees/")
                    and abs(q["x"] - x) <= 12 and abs(q["y"] - y) <= 12)
            if best is None or n > best[0]:
                best = (n, x, y)
        wx, wy = self.find_pad(best[1], best[2], 7, 5)
        self.int_wood = self.house(wx, wy, 7, 5, "parquet_floor", "grass", "grass")
        # the smithy: stone (slate over cobble), in the village near spawn
        mx, my = self.find_pad(sx + 8, sy - 6, 6, 5)
        self.int_smith = self.house(mx, my, 6, 5, "brown_paving_stone",
                                    "grey_paving_stone", "grey_paving_stone")
        self.smithy = (mx, my)
        self.woodcutter = (wx, wy)
        self.fisher = (hx, hy)
        self.placed += [("new houses", 3)]

    def build_no_place(self):
        # a roof buries anything drawn behind it: block outdoor placements in
        # the rect grown 2 sideways and 6 up-screen (strictly-south is FRONT
        # and stays open)
        self.no_place = set()
        for dk in self.doc["decks"]:
            if dk["kind"] != "roof":
                continue
            xs = [c["x"] for c in dk["cells"]]
            ys = [c["y"] for c in dk["cells"]]
            for x in range(min(xs) - 2, max(xs) + 3):
                for y in range(min(ys) - 6, max(ys) + 1):
                    self.no_place.add((x, y))

    # -- interiors ------------------------------------------------------------
    def interiors(self):
        """Furnish EVERY parquet room (the indoor-scenery ask). The renderer
        hides pieces under roofs — the game shows them when you walk in."""
        rooms = []
        for dk in self.doc["decks"]:
            if dk["kind"] != "roof":
                continue
            wl_dk = max(self.lvl[c["y"]][c["x"]] for c in dk["cells"])
            floor = [(c["x"], c["y"]) for c in dk["cells"]
                     if self.lvl[c["y"]][c["x"]] < wl_dk]
            if len(floor) >= 4:
                rooms.append(floor)
        for hi, floor in enumerate(sorted(rooms, key=lambda f: (f[0][1], f[0][0]))):
            xs = sorted(x for x, _ in floor)
            ys = sorted(y for _, y in floor)
            x0, x1, y0, y1 = xs[0], xs[-1], ys[0], ys[-1]
            cx, cy = (x0 + x1) / 2 + 0.5, (y0 + y1) / 2 + 0.5
            r = _rng32(hi * 7919 ^ 0xfeed)
            def pk(group):
                p = self.pool(group)
                return p[int(r() * len(p)) % len(p)]
            IN = ("parquet_floor",)
            n = 0
            n += self.put(pk("hearths"), x0 + 1 + r(), y0 + 0.5, on=IN)
            n += self.put(pk("tables"), cx, cy, on=IN)
            n += self.put(pk("chairs_and_benches"), cx - 1.1, cy + 0.2, on=IN)
            n += self.put(pk("beds"), x1 + 0.4, y0 + 0.6, on=IN)
            area = len(floor)
            if area >= 9:
                n += self.put(pk("chairs_and_benches"), cx + 1.1, cy - 0.2,
                              on=IN, hflip=True)
                n += self.put(pk("cupboards_and_shelves"), x0 + 0.4, y1 + 0.3, on=IN)
                n += self.put(pk("barrels"), x1 + 0.5, y1 + 0.4, on=IN)
                n += self.put(pk("rugs_and_hides"), cx, cy + 1.0, on=IN)
            if area >= 16:
                n += self.put(pk("house_clutter"), x0 + 0.5, cy, on=IN)
                n += self.put(pk("wall_hangings"), cx + 1, y0 + 0.4, on=IN)
            self.placed += [(f"room {hi} furniture", n)]
        # the smithy works outdoors too: anvil + woodpile out FRONT (south —
        # anything beside/behind the house gets buried by the roof slab)
        mx, my = self.smithy
        self.put("anvils/anvil_003", mx + 1.5, my + 5.6, on=("grass",))
        self.put("woodpiles/woodpile_001", mx + 4.5, my + 5.6, on=("grass",))
        # EVERY cave gets braziers — both dungeons have hearth-light
        n = 0
        bz = self.pool("braziers")
        for cave in (dk for dk in self.doc["decks"] if dk["kind"] == "cave"):
            cells = sorted((c["x"], c["y"]) for c in cave["cells"])
            if len(cells) < 12:
                continue              # tunnel segments stay dark
            step = max(1, len(cells) // 5)
            for i, (x, y) in enumerate(cells[::step][:5]):
                n += self.put(bz[i % len(bz)], x + 0.5, y + 0.5)
        self.placed += [("cave braziers", n)]

    # -- village + roads ------------------------------------------------------
    def village(self):
        sx, sy = self.doc["spawn"]
        n = 0
        n += self.put("wells/well_002", sx + 5.5, sy + 3.5, on=("grass",))
        n += self.put("stone_fountains/stone_fountain_001", sx - 4.5, sy - 3.5,
                      on=("grass",))
        n += self.put("market_stalls/market_stall_001", sx + 7.5, sy - 2.5,
                      on=("grass",))
        n += self.put("market_stalls/market_stall_002", sx + 9.5, sy - 0.5,
                      on=("grass",), hflip=True)
        n += self.put("carts/cart_004", sx - 7.5, sy + 5.5, on=("grass",))
        n += self.put("haystacks/haystack_008", sx - 12.5, sy + 8.5, on=("grass",))
        n += self.put("scarecrows/scarecrow_005", sx - 14.5, sy + 11.5, on=("grass",))
        n += self.put("maypoles/maypole_002", sx + 2.5, sy + 8.5, on=("grass",))
        n += self.put("washing_lines/washing_line_001", sx - 8.5, sy + 2.5,
                      on=("grass",))
        n += self.put("beehives/beehive_003", sx + 14.5, sy + 9.5, on=("grass",))
        n += self.put("flower_stands/flower_stand_002", sx + 4.5, sy - 5.5,
                      on=("grass",))
        # streetlights: 2 in the village + 1 at the pier landing — the audit
        # proves the worst window stays within the engine's 8 slots
        n += self.put("streetlights/streetlight_007", sx + 3.5, sy + 1.5,
                      on=("grass",))
        n += self.put("streetlights/streetlight_011", sx - 3.5, sy + 4.5,
                      on=("grass",))
        lx, ly = self.landing
        n += self.put("lantern_posts/lantern_post_001", lx + 0.5, ly - 1.5,
                      on=("grass", "light_beach"))
        n += self.put("fish_drying_racks/fish_drying_rack_002", lx - 2.5, ly + 0.5,
                      on=("grass", "light_beach"))
        n += self.put("beached_rowboats/beached_rowboat_001", lx - 4.5, ly + 1.5,
                      on=("light_beach", "grass"))
        self.placed += [("village pieces", n)]

    def roads(self):
        """Signposts at real 3-way junctions, waystones along straights —
        found on the road itself (light_soil, level<=4), placed on the grass
        shoulder."""
        soil = {(x, y) for y in range(NEW) for x in range(NEW)
                if self.g(x, y) == "light_soil" and self.lvl[y][x] <= 4}
        signs, ways = self.pool("signposts"), self.pool("waystones")
        placed_at, n_s, n_w = [], 0, 0
        for (x, y) in sorted(soil):
            deg = sum((x + dx, y + dy) in soil
                      for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))
            if all(abs(x - px) + abs(y - py) > 22 for px, py in placed_at):
                shoulder = next(((x + dx, y + dy)
                                 for dx, dy in ((1, 1), (-1, 1), (1, -1), (-1, -1))
                                 if self.g(x + dx, y + dy) == "grass"), None)
                if not shoulder:
                    continue
                if deg >= 3 and n_s < 7:
                    if self.put(signs[n_s % len(signs)],
                                shoulder[0] + 0.5, shoulder[1] + 0.5, on=("grass",)):
                        n_s += 1; placed_at.append((x, y))
                elif deg == 2 and n_w < 14:
                    if self.put(ways[n_w % len(ways)],
                                shoulder[0] + 0.5, shoulder[1] + 0.5, on=("grass",)):
                        n_w += 1; placed_at.append((x, y))
        self.placed += [("signposts", n_s), ("waystones", n_w)]

    # -- nature ---------------------------------------------------------------
    def nature(self):
        ferns, mush = self.pool("ferns"), self.pool("mushrooms")
        toads, logs = self.pool("toadstool_rings"), self.pool("fallen_logs")
        stumps = self.pool("stumps")
        cats, reeds = self.pool("cattail_clumps"), self.pool("reed_beds")
        lily = self.pool("water_lily_clumps")
        drift = self.pool("driftwood_logs") + self.pool("giant_snail_shells") \
            + ["whale_bones/whale_bone_001"]
        trees = [(p["x"], p["y"]) for p in self.doc["scenery"]
                 if p["piece"].startswith("trees/")]
        n = {"floor": 0, "fen": 0, "lily": 0, "beach": 0}
        for y in range(0, NEW, 3):
            for x in range(0, NEW, 3):
                r = _rng32((x * 40503) ^ (y * 2654435761) ^ 0xf10a)
                jx, jy = x + r() * 2, y + r() * 2
                g = self.g(int(jx), int(jy))
                if g == "grass":
                    near = sum(1 for tx, ty in trees
                               if abs(tx - jx) <= 3 and abs(ty - jy) <= 3)
                    if near >= 2 and r() < 0.5:
                        u = r()
                        pc = ferns if u < 0.45 else mush if u < 0.75 else \
                            toads if u < 0.85 else logs if u < 0.93 else stumps
                        if self.put(pc[int(r() * len(pc)) % len(pc)],
                                    jx + 0.5, jy + 0.5, on=("grass",),
                                    hflip=r() < 0.5):
                            n["floor"] += 1
                elif g == "dark_mud" and r() < 0.30:
                    wet = any(self.liquid(int(jx) + dx, int(jy) + dy)
                              for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))
                    pc = (cats if r() < 0.6 else reeds) if wet else \
                        (self.pool("cup_fungi") if r() < 0.4 else None)
                    if pc and self.put(pc[int(r() * len(pc)) % len(pc)],
                                       jx + 0.5, jy + 0.5, on=("dark_mud",),
                                       hflip=r() < 0.5):
                        n["fen"] += 1
                elif g == "water" and r() < 0.10:
                    shore = sum(not self.liquid(int(jx) + dx, int(jy) + dy)
                                for dx in (-1, 0, 1) for dy in (-1, 0, 1))
                    if shore >= 2 and n["lily"] < 24:
                        if self.put(lily[int(r() * len(lily)) % len(lily)],
                                    jx + 0.5, jy + 0.5, on=("water",)):
                            n["lily"] += 1
                elif g == "light_beach" and r() < 0.04 and n["beach"] < 14:
                    if self.put(drift[int(r() * len(drift)) % len(drift)],
                                jx + 0.5, jy + 0.5, on=("light_beach",),
                                hflip=r() < 0.5):
                        n["beach"] += 1
        self.placed += sorted(n.items())

    # -- islet dressing -------------------------------------------------------
    def dress_islets(self):
        def centre(cells):
            return (sum(c[0] for c in cells) / len(cells) + 0.5,
                    sum(c[1] for c in cells) / len(cells) + 0.5)
        n = 0
        # Lighthouse Point: the tall beacon + stones
        cx, cy = centre(self.isl_light)
        n += self.put("beacons/beacon_001", cx, cy)
        st = self.pool("stones")
        for i, (dx, dy) in enumerate(((3, 1), (-2, 2), (1, -3))):
            n += self.put(st[(i * 17) % len(st)], cx + dx, cy + dy,
                          on=("grey_stone", "light_beach"))
        # The Standing Stones: cairn ring around the one standing stone
        cx, cy = centre(self.isl_stone)
        n += self.put("standing_stones/standing_stone_001", cx, cy)
        ca = self.pool("cairns")
        for i in range(6):
            a = i * math.pi / 3
            n += self.put(ca[(i * 5) % len(ca)],
                          cx + 2.6 * math.cos(a), cy + 2.1 * math.sin(a),
                          on=("grass", "light_beach"), hflip=i % 2 == 0)
        n += self.put("ancient_trees/ancient_tree_002", cx - 3.5, cy - 2.5,
                      on=("grass",))
        # The Wreck Shoals
        cx, cy = centre(self.isl_shoal)
        n += self.put("shipwreck_prows/shipwreck_prow_002", cx, cy - 1)
        n += self.put("whale_bones/whale_bone_001", cx - 3, cy + 2,
                      on=("light_beach",))
        n += self.put("driftwood_logs/driftwood_log_901", cx + 3, cy + 1,
                      on=("light_beach",), hflip=True)
        n += self.put("beached_rowboats/beached_rowboat_900", cx + 1, cy + 3,
                      on=("light_beach",))
        # The Mist Fen Isle: hanging willows — its own remote mini-wood, ONE
        # species (the per-forest rule allows a different tree elsewhere)
        cx, cy = centre(self.isl_fen)
        hw = self.pool("hanging_willows")
        for i, (dx, dy) in enumerate(((0, -2), (3, 1), (-3, 0), (1, 3))):
            n += self.put(hw[i % len(hw)], cx + dx, cy + dy,
                          on=("dark_mud",), hflip=i % 2 == 0)
        n += self.put("witch_rings/witch_ring_002", cx, cy + 0.5, on=("dark_mud",))
        for i, (dx, dy) in enumerate(((-2, -3), (4, -1))):
            n += self.put(f"owl_snags/owl_snag_00{i+1}", cx + dx, cy + dy,
                          on=("dark_mud",))
        for i, (dx, dy) in enumerate(((2, -2), (-4, 2))):
            n += self.put(f"beast_skulls/beast_skull_00{i+1}", cx + dx, cy + dy,
                          on=("dark_mud",))
        br = self.pool("briar_thickets")
        for i, (dx, dy) in enumerate(((-1, 2), (2, 2), (-3, -2))):
            n += self.put(br[(i * 3) % len(br)], cx + dx, cy + dy,
                          on=("dark_mud", "light_beach"), hflip=i % 2)
        self.placed += [("islet pieces", n)]

    def deepen(self):
        """world3's deep-water rule re-run over the WHOLE grown sea: open
        water further than DEEP_R from any land goes deep, shores stay
        shallow — the channel between the islands classifies itself."""
        smat = [[(self.G[self.grd[y][x]] if self.grd[y][x] >= 0 else "")
                 for x in range(NEW)] for y in range(NEW)]
        for row in smat:              # deep re-derives from scratch: existing
            for x in range(NEW):      # deep_water would otherwise count as
                if row[x] == "deep_water":   # "land" and ring the old canvas
                    row[x] = "water"         # edge with a shallow square
        world3._deep_water(NEW, NEW, smat)
        for y in range(NEW):
            for x in range(NEW):
                g = smat[y][x]
                if g and self.grd[y][x] != self.gi[g]:
                    self.grd[y][x] = self.gi[g]

    # -- run ------------------------------------------------------------------
    def run(self):
        import time
        t0 = time.time()
        for step in (self.grow_canvas, self.island2, self.deepen,
                     # no cross-country tunnel: over the sea it rendered a
                     # 300-cell black spine, along the isthmus a black scar
                     # (both measured). A buried tunnel needs an underground
                     # LAYER in the format — flagged; the isthmus road is
                     # the crossing, each massif keeps its own dungeon.
                     self.town_ground, self.i2_cave,
                     self.i2_road, self.i2_systems, self._reindex,
                     self.archipelago, self.pier, self.houses, self.town,
                     self.build_no_place, self.interiors, self.village,
                     self.roads, self.nature, self.dress_islets,
                     self.retype, self.spawns):
            t = time.time()
            step()
            print(f"  [{step.__name__} {time.time() - t:.1f}s]", flush=True)
        print(f"  [total {time.time() - t0:.1f}s]", flush=True)
        nlit, worst = world3._light_audit(self.doc["scenery"])
        json.dump(self.doc, open(os.path.join(OUT, "world.json"), "w"),
                  separators=(",", ":"))
        print(f"the_game grown: {NEW}x{NEW}, {len(self.doc['scenery'])} scenery "
              f"({nlit} lit, worst window {worst}/8), "
              f"{len(self.doc['decks'])} decks, {self.fail} placements dropped")
        for k, v in self.placed:
            print(f"   {k}: {v}")


if __name__ == "__main__":
    Grow().run()
