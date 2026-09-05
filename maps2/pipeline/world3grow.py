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

import collections
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
from sceneryscale import drawn_px_for_piece


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
        # THE LEGEND GROWS WITH THE MAP. A ground the base build never used
        # (the town's paving, a new roof material) is appended rather than
        # asserted: the base is the island, this pass adds a town.
        for g in ("grass", "light_beach", "dark_mud", "grey_stone", "water",
                  "deep_water", "parquet_floor", "brown_paving_stone",
                  "grey_paving_stone", "light_soil", "black_rock", "snow"):
            if g not in self.gi:
                self.gi[g] = len(self.G)
                self.G.append(g)
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
            # THE ROOF RIDES THE WALL TOP, AND THE DECK NO LONGER COVERS THE
            # WALL. A roof deck spans the INTERIOR only (that is what tells
            # the game you are indoors without roofing the walls as well), so
            # taking the max over the deck's own cells reads the FLOOR - and
            # dropped the spawn cottage's roof to level 0, leaving the room
            # open to the sky and the player drawn over his own wall, live
            # (maintainer 2026-08-30: "THIS WORKED IN V2! DON'T DESTROY THE
            # GAME!"). The wall is one cell outside the deck, so the ring is
            # measured too.
            wl = 0
            for c in dk["cells"]:
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        x, y = c["x"] + dx, c["y"] + dy
                        if 0 <= x < NEW and 0 <= y < NEW:
                            wl = max(wl, self.lvl[y][x])
            dk["level"] = wl
            dk["thickness"] = 0
            assert wl > min(self.lvl[c["y"]][c["x"]] for c in dk["cells"]), \
                "a roof deck must ride ABOVE the floor it covers"

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

    # ---- themes: a place looks like a place ------------------------------
    # (maintainer 2026-08-30) "When you place outdoor stuff in the nature
    # (rocks, etc) you should try to stay at a given theme and use that rock
    # with different variations and hflip. The reason I did so many variations
    # was to be able to create a place that looks a certain way so it doesn't
    # feel random. Random is what we don't want anything to feel."
    #
    # A FAMILY IS ONE SCULPT plus its own variations (its NOT_LIT_* states)
    # and hflip. Verified on a contact sheet before writing a line of this:
    # stones/stone_001's four states are the same vine-bound boulder redrawn,
    # while stone_009 is a barnacled rock and stone_010 a carved slab. Mixing
    # SCULPTS is what reads as random; mixing VARIATIONS of one sculpt reads
    # as a place. The old pass did the former - it drew a group at random and
    # then a piece at random out of the whole group, per cell.
    #
    # Every family carries its OWN low-frequency field with its own scale and
    # phase, so families fade in and out ON DIFFERENT SCHEDULES ("you can also
    # fade out the usage of one object and fade in a usage of another object
    # ... but they fade in/out differently"). At any point the two strongest
    # families are in play and each placement picks between them in proportion
    # to their strength, so a boundary is a BAND where both appear, never a
    # line.
    # ---- don't hide a thing behind a bigger thing -------------------------
    # (maintainer 2026-08-30) "Try also to think where you place them. Some
    # objects are big and you should ofc not hide an object behind a big/tall
    # object."
    #
    # Scenery is painter-ordered by x+y, so a piece with the LARGER x+y is
    # drawn later and stands in front. A placement is refused when a piece
    # already in front of it would cover most of it - and equally when it
    # would itself bury something already standing there. Both directions
    # matter: the second is how a tree ends up planted on top of a mushroom.
    HIDE = 0.55            # refuse at more than this fraction covered

    def _art_rect(self, piece, x, y, state=None):
        """The piece's drawn rectangle in screen px, anchored bottom-centre at
        the projection of (x,y) - the same fit the game uses: the art is
        scaled so its ALPHA BBOX height equals world_px_height."""
        if not hasattr(self, "_bx"):
            self._bx = json.load(open(os.path.join(
                REPO, "games2", "config", "scenery-bbox.json")))
        facts = (self._bx.get("pieces") or {}).get(piece)
        spr = ((facts or {}).get("states") or {}).get(state) if state else None
        bb = (self._bx.get("boxes") or {}).get(spr or (facts or {}).get("sprite"))
        if not facts or not facts.get("wph") or not bb:
            return None
        bx0, by0, bx1, by1 = bb[:4]
        # THE SIZE THE GAME DRAWS, not the contract's raw number - see
        # sceneryscale.drawn_px. At the contract's number every piece in this
        # test was 27% small and nothing ever looked buried.
        h = drawn_px_for_piece(piece)
        w = max(1, bx1 - bx0) * h / max(1, by1 - by0)
        sx = (x - y) * 32.0
        sy = (x + y) * 14.0
        return (sx - w / 2, sy - h, sx + w / 2, sy)

    def _hidden(self, piece, x, y):
        """True when this placement is mostly buried, or would mostly bury a
        neighbour. Only nearby pieces can overlap, so the search is the 5x5
        cell block around the spot."""
        a = self._art_rect(piece, x, y)
        if a is None:
            return False
        aw, ah = a[2] - a[0], a[3] - a[1]
        if aw <= 0 or ah <= 0:
            return False
        mine = x + y
        for q in self.doc["scenery"]:
            if abs(q["x"] - x) > 6 or abs(q["y"] - y) > 6:
                continue
            b = self._art_rect(q["piece"], q["x"], q["y"])
            if b is None:
                continue
            ox = min(a[2], b[2]) - max(a[0], b[0])
            oy = min(a[3], b[3]) - max(a[1], b[1])
            if ox <= 0 or oy <= 0:
                continue
            inter = ox * oy
            if q["x"] + q["y"] > mine:            # it is drawn in FRONT of me
                if inter / (aw * ah) > self.HIDE:
                    return True
            else:                                  # I would be drawn over it
                bw, bh = b[2] - b[0], b[3] - b[1]
                if bw > 0 and bh > 0 and inter / (bw * bh) > self.HIDE:
                    return True
        return False

    FADE = 0.02        # width of the band where two families interleave

    # HIS RATINGS DECIDE WHO GETS THE GROUND. live/feedback/objects.json is
    # the scenery verdict channel - 5,075 approved entries, each rated 1 to 5,
    # keyed per piece AND per variation ("scenery/stones/stone_013#not_lit_2
    # #south"). A rating is taste, so a 5 should headline a place and a 1
    # should be rare; the bias is added to the family's field, which buys or
    # loses it territory rather than just nudging a dice roll.
    RATING_BIAS = {5: 0.10, 4: 0.05, 3: 0.0, 2: -0.08, 1: -0.20}

    def _verdicts(self):
        if not hasattr(self, "_vd"):
            self._vd = json.load(open(os.path.join(
                REPO, "live", "feedback", "objects.json")))["entries"]
        return self._vd

    def _rated(self, piece, state=None):
        """(ok, rating). ok is False only for something he REJECTED - a
        missing record is unrated, not rejected, and stays usable."""
        v = self._verdicts()
        k = f"scenery/{piece}" + (f"#{state.lower()}#south" if state else "")
        rec = v.get(k)
        if rec is None:
            return True, 3
        if rec.get("status") not in (None, "approved"):
            return False, 0
        return True, int(rec.get("rating") or 3)

    def _fam_w(self, fi, x, y):
        # BIG TERRITORIES. The first cut ran at 0.013-0.058 (periods of 17 to
        # 77 cells) and a 24-cell block still straddled several families:
        # measured 7 distinct pieces per block, barely better than the 10 the
        # random pass gave. A family's territory has to be larger than the
        # view, so these are periods of 90 to 250 cells.
        f = 0.004 + 0.003 * (fi % 4)          # its own scale...
        ph = fi * 97.3                        # ...and its own phase
        return _fbm(x * f + ph, y * f + ph * 0.61, 0x5EED + fi * 17)

    def _variations(self, piece):
        """The piece's own variations: its NOT_LIT_* states. [] when it ships
        none, and then the base still is the only look it has."""
        if not hasattr(self, "_varc"):
            self._varc = {}
        if piece not in self._varc:
            f = os.path.join(REPO, "scenery", piece, "scenery.json")
            j = json.load(open(f))
            self._varc[piece] = [k for k in sorted(j.get("states") or {})
                                 if k.startswith("NOT_LIT")
                                 and self._rated(piece, k)[0]]
        return self._varc[piece]

    THEME_SPAN = 0.0055     # ~180 cells across per province
    THEME_SIZE = 3          # families that share a province
    EDGE = 0.14             # fraction of a province that is blend band

    def theme_pick(self, families, x, y, r):
        """(piece, state) for this spot.

        TWO LEVELS, because one was not enough. Giving all 54 candidates their
        own field and taking the top two sounds right and is not: the ARGMAX
        of many random fields has much finer structure than any one of them,
        so a 42-cell view still showed four different rock sculpts. A place is
        a PROVINCE that owns a few families:

          level 1  a coarse field cuts the map into provinces (~180 cells) and
                   each province owns THEME_SIZE families. Near a province
                   edge the placements blend into the neighbour's set, so the
                   change is a band and never a seam.
          level 2  inside the province the families compete on their own
                   fields, each with its own scale and phase, so they fade in
                   and out on DIFFERENT schedules - his words exactly.

        Within a family the variation is its own NOT_LIT_* state plus hflip,
        which is the axis the variations were drawn for."""
        families = [f for f in families if self._rated(f)[0]]
        if not families:
            return None, None
        nth = max(1, len(families) // self.THEME_SIZE)
        u = _fbm(x * self.THEME_SPAN + 3.1, y * self.THEME_SPAN + 3.1,
                 0x71E3) * nth
        t = min(nth - 1, int(u))
        frac = u - t
        # the blend band: only near an edge, and only toward that neighbour
        if frac < self.EDGE and t > 0 and r() < 0.5 * (1 - frac / self.EDGE):
            t -= 1
        elif frac > 1 - self.EDGE and t < nth - 1 \
                and r() < 0.5 * (1 - (1 - frac) / self.EDGE):
            t += 1
        pool = [families[i] for i in range(len(families)) if i % nth == t]
        if not pool:
            pool = families
        w = sorted(((self._fam_w(i, x, y)
                     + self.RATING_BIAS.get(self._rated(pool[i])[1], 0.0), i)
                    for i in range(len(pool))), reverse=True)
        (w1, i1) = w[0]
        (w2, i2) = w[1] if len(w) > 1 else w[0]
        # THE FADE IS A BAND OF KNOWN WIDTH. Blending by the RATIO of the two
        # field values made it far too wide - fbm values sit close together,
        # so a clear leader (0.60 against 0.55) still ceded 40% of its ground.
        # A logistic on the GAP puts the width in one number.
        p1 = 1.0 / (1.0 + math.exp(-(w1 - w2) / self.FADE))
        piece = pool[i1 if r() < p1 else i2]
        var = self._variations(piece)
        return piece, (var[int(r() * len(var)) % len(var)] if var else None)

    def put(self, piece, x, y, on=None, hflip=False, lit=False, dir=None,
            state=None, flush=False):
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
        # NOTHING OUTDOOR STANDS ON AN INDOOR FLOOR, and the gate is here
        # rather than in a sweep afterwards: the eviction pass runs before
        # `nature`, so a bush planted later kept its place in the sitting
        # room (maintainer 2026-09-05, standing in an empty house with one:
        # "Why did you remive the furnitures in the house and replaced it
        # with a bush?").
        if (int(x), int(y)) in self._indoor_now():
            if not piece.startswith(self.INDOOR_OK):
                self.fail += 1
                return False
        else:
            # outdoor pieces stay out of the up-screen shadow behind a roof —
            # a washing line 2 cells behind the cottage rendered ON its roof
            if (int(x), int(y)) in getattr(self, "no_place", set()):
                self.fail += 1
                return False
        # SNAP THE FOOTPRINT TO A CELL CENTRE NOW, and judge the piece where
        # it will actually stand. (snap_hitboxes still runs last for the
        # pieces that do not come through put - the base build's trees.)
        if not hasattr(self, "_bbox"):
            self._bbox = json.load(open(os.path.join(
                REPO, "games2", "config", "scenery-bbox.json")))
            self._hit = json.load(open(os.path.join(
                REPO, "live", "tuning", "scenery_hitbox.json")))["overrides"]
        probe = {"piece": piece, "x": x, "y": y, "hflip": hflip,
                 "state": state, "dir": dir}
        sh = self._fp_shape(probe)
        if sh:
            kind, dwx, dwy, hx, hy = sh
            if flush:
                # PIXEL-PERFECT AGAINST THE WALL: the caller has already put
                # the footprint exactly where it wants it, so do not snap.
                wx, wy = x + dwx, y + dwy
            else:
                cx, cy = math.floor(x + dwx), math.floor(y + dwy)
                x, y = cx + 0.5 - dwx, cy + 0.5 - dwy
                wx, wy = cx + 0.5, cy + 0.5
            R, HY = (hx, hy) if kind == "rect" else (hx, None)
        else:
            wx, wy = int(x) + 0.5, int(y) + 0.5
            R, HY = self.FP_DEFAULT, None
        if on is not None and self.g(int(x), int(y)) not in on:
            self.fail += 1
            return False
        flat = self._flat(probe)
        if not flat and not self._art_clear(piece, x, y, state):
            self.fail += 1
            self.fp_refused = getattr(self, "fp_refused", 0) + 1
            return False
        if not self._footprint_ok(wx, wy, R, HY, flush=flush, flat=flat):
            self.fail += 1
            self.fp_refused = getattr(self, "fp_refused", 0) + 1
            return False
        p = {"piece": piece, "x": round(x, 4), "y": round(y, 4)}
        if hflip:
            p["hflip"] = True
        if lit:
            p["lit"] = True
        if state and state in (self._variations(piece) or ()):
            p["state"] = state          # the variation axis; unknown states
                                        # fall through to the base still
        if dir and os.path.isfile(os.path.join(REPO, "scenery", piece,
                                                "rotations", dir + ".webp")):
            p["dir"] = dir      # not every piece ships rotations; the base
                                # south sprite is the fallback
        self.doc["scenery"].append(p)
        if flush:
            # SNAPPING WOULD UNDO THE FLUSH PLACEMENT. snap_hitboxes centres
            # every footprint on a cell centre; a piece put deliberately
            # against a wall is already exactly where it belongs, and snapping
            # it moved the back edge up to a quarter cell off the wall.
            if not hasattr(self, "_flush_ids"):
                self._flush_ids = set()
            self._flush_ids.add(id(p))
        if not flat:                  # floor claims no ground - see _flat
            self._fp_add(wx, wy, R, HY)
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
        # wall material, then the thin roof course above it
        # WOOD WALLS, THIN BLACK ROCK ROOF (his call, 2026-08-30)
        # A HOUSE IS SIZED BY WHAT STANDS IN IT (maintainer 2026-09-05: "if
        # you make a house this ultra small you can't expect to fit much
        # inside it ... make sure the furnitures in all houses look good and
        # the size of the house is what you want it to be"). At the scale the
        # game actually draws, a bed's footprint is 2.37 x 1.33 cells, a
        # hearth 1.51 x 1.65, a dresser 1.72 x 0.72 - so a 6x5 house, whose
        # INTERIOR is 4x3, was a bed and a corridor. These are outside
        # measurements including the wall ring: 8x7 and 9x7 give a 6x5 and 7x5
        # room, which takes a bed on one wall, a dresser and a hearth on the
        # other, and still has floor to walk on.
        # A STREET IS NOT A TERRACE OF ONE HOUSE - see HOUSE_STYLES. The
        # town is timber and brick with a stone hall; the outlying houses take
        # the other styles.
        specs = [(cx - 15, cy - 10, 8, 7, "timber"),
                 (cx - 16, cy + 2, 9, 7, "brick"),
                 (cx + 8, cy - 10, 9, 7, "longhouse"),
                 (cx + 9, cy + 2, 8, 7, "timber"),
                 (cx - 5, cy - 14, 10, 8, "stone"),
                 (cx - 3, cy + 7, 8, 6, "brick")]
        built = 0
        for si, (hx, hy, w, h, style) in enumerate(specs):
            wall, roof, floor = self.HOUSE_STYLES[style]
            side = "south" if si % 2 == 0 else "east"
            try:
                px, py = self.find_pad(hx, hy, w, h, r=16, widen=False, dry=3)
            except AssertionError:
                self.fail += 1
                continue
            self.house(px, py, w, h, wall, roof, floor, door_side=side)
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
        """world3.retype_woods over the WHOLE grown map — every wood asks the
        FOREST MAP where it stands, so north/east/south/west woods and the
        snowline/bog/coast woods are all different forests."""
        ctx = world3.ForestCtx(
            NEW, NEW, self.g,
            lambda x, y: self.lvl[y][x] if 0 <= x < NEW and 0 <= y < NEW else 0)
        tally = world3.retype_woods(self.doc["scenery"], ctx)
        # NOW that every tree knows what it is, enforce the clearance ITS OWN
        # species needs - a hawthorn hides two and a half times the screen a
        # juniper does and cannot stand as close.
        dropped, left = world3.thin_by_species(self.doc["scenery"])
        self.placed += [("trees thinned by species spacing", dropped),
                        ("trees left", left)]
        self.placed += [(f"forest {k}", v) for k, v in sorted(tally.items())]

    # the floors a room is made of - the same set render3 treats as indoor
    INDOOR_GROUNDS = ("parquet_floor", "brown_paving_stone", "grey_paving_stone")

    INDOOR_OK = ("beds/", "tables/", "chairs_and_benches/", "hearths/",
                 "cupboards_and_shelves/", "barrels/", "rugs_and_hides/",
                 "house_clutter/", "wall_hangings/", "anvils/",
                 "flower_stands/", "lantern_stands/", "braziers/")

    def _indoor_now(self):
        """indoor_floors(), cached until a house or deck is added - put() asks
        it for every placement and it walks every deck."""
        key = (len(self.doc["decks"]), len(getattr(self, "floor_cells", {})))
        if getattr(self, "_if_key", None) != key:
            self._if_key, self._if_map = key, self.indoor_floors()
        return self._if_map

    def indoor_floors(self):
        """{cell: floor ground} for EVERY indoor floor in the world - one
        definition, because three passes need the same one.

        A cell counts when house() recorded it (the only way to know a dark
        mud or paving floor is a floor rather than a fen or a road) OR when it
        lies under a roof/cave deck, below it, carries no wall and is made of
        an indoor material - which is how the v2 island's ported houses and
        the cave lids qualify, since they were never built by house().

        Reading only the recorded cells is what emptied the ported houses:
        the furnish pass flooded them and found nothing, so the fisher's house
        shipped with a bush in it and no furniture at all (maintainer
        2026-09-05: "Why did you remive the furnitures in the house and
        replaced it with a bush?")."""
        walls = {(c["x"], c["y"]) for w in self.doc["walls"] for c in w["cells"]}
        under = {}
        for dk in self.doc["decks"]:
            if dk.get("kind") in ("roof", "cave"):
                for c in dk["cells"]:
                    under[(c["x"], c["y"])] = int(dk["level"])
        out = dict(getattr(self, "floor_cells", {}))
        for c, lv in under.items():
            if c in out or c in walls:
                continue
            g = self.g(*c)
            if g in self.INDOOR_GROUNDS and self.lvl[c[1]][c[0]] < lv:
                out[c] = g
        return out

    def rooms(self):
        """PUBLISH THE ROOMS. "The same room should only have one type of
        Parquet Floor" (maintainer, 2026-08-30, twice) - and a renderer can
        only obey that if it knows where a room ends. It cannot be inferred
        from a chunk grid (buildings straddle chunk borders) and it cannot be
        inferred from a roof deck either (this town hall is four rooms under
        one deck). So the world states it: every connected patch of indoor
        floor is a room, and a consumer picks ONE base tile for the whole
        patch instead of one per cell.

        Additive - no cell, deck, wall or level changes, so nothing about
        collision, indoor detection or draw order moves."""
        # A ROOM IS FLOOR, NOT WALL. The deck covers the whole footprint, so
        # its cells include the wall ring - whose tops are brown_paving_stone
        # at the deck's own level and would otherwise be published as a room.
        # A floor cell lies BELOW its deck and carries no wall.
        walls = {(c["x"], c["y"]) for w in self.doc["walls"] for c in w["cells"]}
        indoor = {}
        for dk in self.doc["decks"]:
            if dk.get("kind") not in ("roof", "cave"):
                continue
            for c in dk["cells"]:
                indoor[(c["x"], c["y"])] = int(dk["level"])
        # A FLOOR IS A CELL A HOUSE LAID, not a cell whose material happens
        # to look indoor: a floor may be dark mud (a fen outdoors) or paving
        # stone (a road), so house() records them and this reads the record.
        # The cave lids have no record, so they keep the material test.
        fc = self.indoor_floors()

        def floor(c):
            return c in fc and c in indoor and c not in walls

        # A DOORWAY IS NOT A ROOM BOUNDARY YOU CAN WALK THROUGH TWICE.
        # The maintainer counts rooms by their WALLS - shown the town hall as
        # one 116-cell patch he answered "that looks like 3 rooms to me", and
        # it is: two chambers north of the dividing wall and one hall south.
        # Flooding through the door gaps merged all three. A doorway is a
        # floor cell with wall on BOTH opposite sides; it does not conduct,
        # and it joins the room with the lower anchor afterwards so it still
        # gets a tile.
        doors = {c for c in indoor if floor(c)
                 and (((c[0] - 1, c[1]) in walls and (c[0] + 1, c[1]) in walls)
                      or ((c[0], c[1] - 1) in walls
                          and (c[0], c[1] + 1) in walls))}
        seen, out = set(), []
        for (x, y) in sorted(indoor):
            if (x, y) in seen or not floor((x, y)) or (x, y) in doors:
                continue
            grd = self.g(x, y)
            comp, stack = [], [(x, y)]
            seen.add((x, y))
            while stack:
                cx, cy = stack.pop()
                comp.append((cx, cy))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    n = (cx + dx, cy + dy)
                    if n not in seen and n not in doors and floor(n) \
                            and self.g(*n) == grd:
                        seen.add(n)
                        stack.append(n)
            comp.sort()
            out.append({"ground": grd,
                        "cells": [{"x": cx, "y": cy} for (cx, cy) in comp]})
        # every doorway joins a neighbouring room (lowest anchor wins), so no
        # indoor floor cell is left without one
        home = {}
        for i, r in enumerate(out):
            for c in r["cells"]:
                home[(c["x"], c["y"])] = i
        for c in sorted(doors):
            cand = sorted(home[n] for n in
                          ((c[0] + 1, c[1]), (c[0] - 1, c[1]),
                           (c[0], c[1] + 1), (c[0], c[1] - 1)) if n in home)
            if cand:
                out[cand[0]]["cells"].append({"x": c[0], "y": c[1]})
                home[c] = cand[0]
        for r in out:
            r["cells"].sort(key=lambda c: (c["x"], c["y"]))
        self.doc["rooms"] = out
        # BUILD ASSERT: THE BACK IS TO THE WALL AND THE PIECE IS FLUSH.
        # Judges exactly what against() placed - not every piece in the room,
        # since the hall's table and its chairs stand in the middle by design.
        # The facing is the WALL's (west -> south-east, north -> south-west,
        # measured from the backrest centroid), and the near edge of the
        # footprint sits on the wall face, for an ellipse piece as much as a
        # rect one.
        bad, odd = [], []
        for (piece, px, py, d, axis, face) in getattr(self, "_against", []):
            want = "south-east" if axis == "x" else "south-west"
            if d != want:
                bad.append((piece, (px, py), f"facing {d}, this wall wants {want}"))
                continue
            sh = self._fp_shape({"piece": piece, "x": px, "y": py, "dir": d})
            if not sh:
                continue
            kind, cx, cy, hx, hy = sh
            edge = (px + cx - hx) if axis == "x" else (py + cy - hy)
            if abs(edge - face) > 0.02:
                bad.append((piece, (px, py),
                            f"not flush: edge {edge:.3f} vs wall face {face}"))
                continue
            # REPORTED, NOT ENFORCED: a well-formed piece is longer ALONG its
            # wall in the facing that wall wants, and the ones that are not
            # are the ones whose published box does not describe the art (an
            # ellipse on a bookshelf, a square box on a dresser). Their facing
            # is still the wall's - that is what "back to the wall" means -
            # but they are the list to hand the wiki when a shelf looks wrong.
            if kind != "rect" or (hy - hx if axis == "x" else hx - hy) < 0:
                odd.append(piece)
        assert not bad, ("furniture against the wall: "
                         + "; ".join(f"{p} at {c}: {why}"
                                     for p, c, why in bad[:6]))
        if odd:
            self.placed += [("wall pieces whose box does not lie along it",
                             len(set(odd)))]
        # every indoor floor cell belongs to exactly one room
        n = sum(len(r["cells"]) for r in out)
        assert n == len({(c["x"], c["y"]) for r in out for c in r["cells"]}), \
            "a cell is in two rooms"
        self.placed += [("rooms published", len(out)),
                        ("room floor cells", n)]

    # the game's own numbers for maps3 scenery collision
    # (games2/shared/src/index.ts, ISO_GEOMETRY_MAPS3)
    HIT_DX, HIT_DY = 32, 14
    # THE HITBOX CENTRE STANDS ON THE CELL CENTRE, AND THE SCALE IS WHAT PUT
    # IT OFF. The offset the maintainer keeps seeing with the overlay on -
    # "the hitbox touches the top and have a small distance left to the
    # bottom" (2026-09-04), 4.2 screen px straight down on his earlier
    # annotated screenshot - was maps2 reading `world_px_height` raw while the
    # game re-bases every piece to its 88-px person. The ellipse sits at a
    # SCALED offset from the art's anchor, so at 1/1.375 of the real scale the
    # footprint landed up-screen of the cell it blocks: measured over
    # the_game's 892 placements, median 3.0 px, always up. `_fit` now uses the
    # drawn height (sceneryscale.drawn_px) and the error is 0.00.
    #
    # DO NOT COMPENSATE WITH A DROP - measured twice, before the cause was
    # found. Dropping every placement down-screen moves the centre OFF the cell
    # centre and thin footprints then cover no cell centre at all: 10 px ->
    # 71% of pieces block nothing (3240 cells -> 477), 4.2 px -> 16.5% (1132).
    HITBOX_DROP = 0.0    # screen px, down-screen - see above before changing

    # ---- the rect footprint -------------------------------------------------
    # (maintainer 2026-09-03) "The scenery now has a special hitbox called rect
    # for things like tables and bookshelfs. Use this rect to make sure the
    # back of the shelf (the long edge) is against the wall, and to place the
    # rect furniture exactly at the wall/corner."
    #
    # A rect box carries shape:"rect" and half-extents rx, ry along the piece's
    # OWN GROUND AXES for its facing - the wiki solves them that way
    # (wiki/tools/rect-hitbox-pass.py: GROUND = south 0, south-east +45,
    # south-west -45; K = dy/dx). pos_by_dir gives the centre per facing. So
    # the four corners are centre +- rx*eu +- (ry/K)*ev in frame px, and each
    # corner maps to world cells through the same projection the game inverts
    # to place the footprint. The world axis-aligned box of those corners is
    # the footprint: for the two wall facings it IS axis-aligned, because eu at
    # +-45 degrees is exactly the world x or y axis on screen.
    _K = 14.0 / 32.0

    # ---- one box, read the way the wiki writes it ---------------------------
    # (maintainer 2026-09-03/04) A box carries THREE per-facing channels, and a
    # consumer that reads only some of them draws a different rectangle from
    # the one he drew (wiki/site/wiki.js boxPos / boxSize / boxRot):
    #   pos_by_dir[d]  -> ax, ay   "the move tool is per direction"
    #   size_by_dir[d] -> rx, ry   "we need a dedicated W and D for the S
    #                               direction ... as an opt-in" - 54 of 131
    #                               rect pieces have a south view whose
    #                               footprint disagrees with its turned views,
    #                               so one rectangle cannot serve every facing
    #   rot_by_dir[d]  -> degrees, else the box's own rot MINUS the facing's
    #                     ground turn (rect only; an ellipse just takes rot)
    # Absent means the shared value - that is still the answer for most of the
    # library, and reading the shared one where an override exists is silently
    # the wrong size rather than an error.
    GROUND_DEG = {"south": 0.0, "south-east": 45.0, "east": 90.0,
                  "north-east": 135.0, "north": 180.0, "north-west": -135.0,
                  "west": -90.0, "south-west": -45.0}

    @staticmethod
    def _box_pos(b, d):
        o = (b.get("pos_by_dir") or {}).get(d) or {}
        ax, ay = o.get("ax"), o.get("ay")
        return (b.get("ax", 0.0) if ax is None else ax,
                b.get("ay", 0.0) if ay is None else ay)

    @staticmethod
    def _box_size(b, d):
        o = (b.get("size_by_dir") or {}).get(d) or {}
        rx, ry = o.get("rx"), o.get("ry")
        return (b.get("rx", 0.0) if rx is None else rx,
                b.get("ry", 0.0) if ry is None else ry)

    def _box_rot(self, b, d, rect):
        o = (b.get("rot_by_dir") or {}).get(d)
        if isinstance(o, (int, float)):
            return float(o)
        base = float(b.get("rot") or 0.0)
        # THE SIGN IS NEGATIVE, and getting it wrong rotates every rect 90
        # degrees off its own art (maintainer 2026-09-03, looking at my own
        # overlay: "It looks like you are rotating the rect hitbox the wrong
        # way"). south-east is +45 on the ground and -45 here.
        return base - self.GROUND_DEG.get(d, 0.0) if rect else base

    def _rec(self, p):
        """The hitbox record the game will resolve for this placement: the
        drawn variation first, then the piece, then any variation's - the same
        order and the same fallbacks as games2 (sceneryHitboxFor and the
        stamp's recCache)."""
        rec = None
        if p.get("state"):
            rec = self._hit.get(f"scenery/{p['piece']}#{p['state']}") \
                or self._hit.get(f"scenery/{p['piece']}#{p['state'].lower()}")
        rec = rec or self._hit.get("scenery/" + p["piece"])
        if not rec:
            pfx = "scenery/" + p["piece"] + "#"
            rec = next((v for k, v in self._hit.items() if k.startswith(pfx)),
                       None)
        return rec

    def _fit(self, p):
        """(k, anchor_fx, anchor_fy, fw, fh): the transform that carries this
        placement's published ellipse from FRAME px to SCREEN px, and it is
        the game's own (client fitSprite + the overlay's hbX/hbY), copied
        exactly:

          * k is the DRAWN height over the BASE sprite's bbox height. Both
            halves matter. The drawn height is `world_px_height` re-based to
            the game's 88-px person (sceneryscale.drawn_px) - reading the raw
            contract number put every footprint ~3 screen px up-screen of the
            cell it blocks. The BASE bbox is what keeps a variation's own size
            difference: dividing by the drawn sprite's own height would squash
            every variation to one height (fitSprite's `scaleH`).
          * the anchor is the DRAWN sprite's bbox - bottom-centre - and its
            frame is the drawn sprite's canvas, because the ellipse was
            measured on that art.

        (games2's collision stamp divides by the DRAWN sprite's bbox instead,
        so for the 337 placements here whose variation is not the base height
        its ellipse lands somewhere the art is not - up to 42% off on
        driftwood_log_901. Reported; the art is what maps2 aims at, because
        the art is what the maintainer sees and what draw order uses.)"""
        facts = (self._bbox.get("pieces") or {}).get(p["piece"])
        if not facts:
            return None
        base = (self._bbox.get("boxes") or {}).get(facts.get("sprite"))
        want = drawn_px_for_piece(p["piece"])
        if not base or not want:
            return None
        spr = (facts.get("states") or {}).get(p["state"]) if p.get("state") \
            else None
        bb = (self._bbox.get("boxes") or {}).get(spr or facts["sprite"]) or base
        bx0, by0, bx1, by1, fw, fh = bb[:6]
        return (want / max(1, base[3] - base[1]),
                bx0 + (bx1 - bx0) / 2.0, float(by1), float(fw), float(fh))

    def _rect_boxes(self, p):
        """The piece's rect boxes for its placed facing, or None."""
        rec = self._rec(p)
        if not rec:
            return None
        boxes = [b for b in (rec.get("boxes") or [])
                 if (b.get("shape") or "").lower() == "rect"]
        return boxes or None

    def _fp_shape(self, p):
        """(kind, cx, cy, hx, hy) in world cells relative to the PLACEMENT:
        a rect piece gives its world box, anything else its circle."""
        geo = self._hitbox_geom(p)
        if geo is None:
            return None
        boxes = self._rect_boxes(p)
        if not boxes:
            return ("circle", geo[0], geo[1], geo[2], geo[2])
        fit = self._fit(p)
        if fit is None:
            return ("circle", geo[0], geo[1], geo[2], geo[2])
        k, afx, afy, fw, fh = fit
        d = p.get("dir") or "south"
        xs, ys = [], []
        for b in boxes:
            # every per-facing channel, each from its own override
            th = math.radians(self._box_rot(b, d, True))
            eu = (math.cos(th), math.sin(th) * self._K)
            ev = (-math.sin(th), math.cos(th) * self._K)
            ax, ay = self._box_pos(b, d)
            if p.get("hflip"):
                ax = -ax
            rx, ry = self._box_size(b, d)
            for su in (-1, 1):
                for sv in (-1, 1):
                    fx = fw / 2 + ax + su * rx * eu[0] + sv * (ry / self._K) * ev[0]
                    fy = fh / 2 + ay + su * rx * eu[1] + sv * (ry / self._K) * ev[1]
                    sx, sy = (fx - afx) * k, (fy - afy) * k
                    xs.append((sx / self.HIT_DX + sy / self.HIT_DY) / 2)
                    ys.append((sy / self.HIT_DY - sx / self.HIT_DX) / 2)
        cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        return ("rect", cx, cy, (max(xs) - min(xs)) / 2, (max(ys) - min(ys)) / 2)

    def _hitbox_geom(self, p):
        """(dwx, dwy, R): where the piece's footprint centre sits relative to
        the placement, in cells, and the footprint's radius in cells. The
        published ellipse is a WORLD CIRCLE seen in iso (the game's own
        reading: rx = R*dx*sqrt2), so a circle is exact for round footprints
        and conservative - the larger axis - for long ones. None when the
        piece publishes no footprint."""
        off = self._hitbox_offset(p)
        if off is None:
            return None
        k = self._fit(p)[0]
        rec = self._rec(p)
        d = p.get("dir") or "south"
        R = 0.0
        for b in rec["boxes"]:
            rx, ry = self._box_size(b, d)       # his per-facing W and D
            R = max(R, rx * k / (self.HIT_DX * math.sqrt(2)),
                    ry * k / (self.HIT_DY * math.sqrt(2)))
        return off[0], off[1], R

    # ---- the footprint law -------------------------------------------------
    # (maintainer 2026-09-02) "never place a scenery so that the scenery's
    # hitbox interfere with another scenery hitbox or touches the wall or hang
    # over a cliff. The scenery hitbox must be placed on ground in a way it
    # doesn't touch a wall, hang over a cliff/slope or intersect another
    # scenery's hitbox."
    #
    # Measured on the build before this: 68 intersecting pairs, 73 footprints
    # touching a wall cell, 60 hanging over a level change - out of 1,046.
    # All three are checked HERE, at placement, on the snapped footprint, so a
    # violating piece is refused rather than shipped and policed later.
    FP_MARGIN = 0.15      # cells of clearance; "touches" means within this
    FP_DEFAULT = 0.30     # radius for a piece with no published footprint
    # AND FOOTPRINTS KEEP A GAP FROM EACH OTHER, not merely fail to overlap
    # (maintainer 2026-09-05: "it looks like you have placed furnitures very
    # very tight so the render inside/on top of each other"). A published
    # footprint hugs the piece's BASE while its art rises over a cell above
    # it, so two boxes a hundredth of a cell apart still read as one heap.
    # 0.20 of a cell is 6.4 screen px between the two bases.
    FP_GAP = 0.20

    def _walls(self):
        n = sum(len(w["cells"]) for w in self.doc["walls"])
        if getattr(self, "_wallset_n", -1) != n:
            self._wallset = {(c["x"], c["y"]) for w in self.doc["walls"]
                             for c in w["cells"]}
            self._wallset_n = n
        return self._wallset

    def _fp_near(self, wx, wy):
        g = getattr(self, "_fp", None)
        if g is None:
            self._fp = g = {}
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for e in g.get((int(wx) // 4 + dx, int(wy) // 4 + dy), ()):
                    yield e

    def _fp_add(self, wx, wy, R, hy=None):
        if getattr(self, "_fp", None) is None:
            self._fp = {}
        self._fp.setdefault((int(wx) // 4, int(wy) // 4), []).append(
            (wx, wy, R, R if hy is None else hy))

    # A RUG IS FLOOR, NOT AN OBSTACLE (maintainer 2026-09-04, on the collision
    # overlay in his own house: "Why does the show collision mode show the
    # collision on a carpet that doesn't even have a collision?"). The piece
    # says so itself - scenery.json `collision: false` - and the tuning file
    # may override it per variation with `no_collision`, which is the wiki's
    # own resolution order (hitboxFlat: the override, else the piece's tag).
    # A flat piece therefore CLAIMS NO GROUND: it may lie against a wall and
    # under a table, and nothing is refused for standing on it. It still may
    # not span a level change - a rug torn across a step reads as a bug - and
    # it still may not straddle the shore.
    # NOTHING HANGS OVER THE EDGE (maintainer 2026-09-05, on a rowboat at a
    # cliff top: "Why did you place the boat on the wall?"). The footprint law
    # already refuses a footprint that SPANS a level change, and the boat did
    # not span one - it stood wholly on the ledge, and its ART, three times
    # wider than its published footprint, hung out over the drop. So the ART
    # gets its own test: the two horizontal extremes of the drawn sprite,
    # projected onto the ground the piece stands on, must be cells at the
    # same level. A screen offset of dx px is dx/64 of a cell in +x and the
    # same in -y, so half the drawn width is the reach.
    def _art_clear(self, piece, x, y, state=None):
        a = self._art_rect(piece, x, y, state)
        if a is None:
            return True
        r = min((a[2] - a[0]) / 128.0, 3.0)      # cells, capped
        if r < 0.5:
            return True
        cx, cy = int(x), int(y)
        if not (0 <= cx < NEW and 0 <= cy < NEW):
            return False
        lv = self.lvl[cy][cx]
        for (ex, ey) in ((x + r, y - r), (x - r, y + r)):
            ix, iy = int(ex), int(ey)
            if not (0 <= ix < NEW and 0 <= iy < NEW):
                return False
            if self.lvl[iy][ix] != lv or self.liquid(ix, iy) != self.liquid(cx, cy):
                return False
        return True

    def _flat(self, p):
        if not hasattr(self, "_flatc"):
            self._flatc = {}
        rec = self._rec(p) or {}
        if isinstance(rec.get("no_collision"), bool):
            return rec["no_collision"]
        piece = p["piece"]
        if piece not in self._flatc:
            try:
                j = json.load(open(os.path.join(
                    REPO, "scenery", piece, "scenery.json")))
            except OSError:
                j = {}
            self._flatc[piece] = (j.get("collision") is False
                                  or j.get("no_collision") is True)
        return self._flatc[piece]

    def _footprint_ok(self, wx, wy, R, hy=None, flush=False, flat=False):
        """The three rules on one footprint. A circle when hy is None, else a
        world box of half-extents (R, hy). `flush` is for furniture placed
        deliberately AGAINST a wall: the box may TOUCH the wall face but still
        may not enter it (maintainer 2026-09-03: "place the rect furniture
        exactly at the wall/corner, pixel perfect"). `flat` is a piece with no
        collision - see above: ground rules only, no wall test, no neighbour
        test, and the caller does not register it."""
        cx, cy = int(wx), int(wy)
        if not (0 <= cx < NEW and 0 <= cy < NEW):
            return False
        lvl = self.lvl[cy][cx]
        wet = self.liquid(cx, cy)
        walls = self._walls()
        m = 0.0 if flush else self.FP_MARGIN
        hxm, hym = R + m, (R if hy is None else hy) + m
        rr = int(math.ceil(max(hxm, hym)))
        # THE TOLERANCE HAS TO CLEAR THE STORED PRECISION. A placement is
        # written to world.json rounded to 4 decimals, so a piece put exactly
        # flush can come back up to 5e-5 of a cell INSIDE the wall - and this
        # pass runs again over what was written. At 1e-6 that read as "touches
        # a wall" and police_footprints deleted the piece: a table placed
        # perfectly against the wall vanished from the room, the bed beside it
        # survived only because its rounding fell the other way. 1e-3 of a
        # cell is 0.03 screen px - below a pixel, and far below any overlap
        # that could matter.
        eps = 1e-3
        for yy in range(cy - rr, cy + rr + 1):
            for xx in range(cx - rr, cx + rr + 1):
                if hy is None:
                    nx = min(max(wx, xx), xx + 1)
                    ny = min(max(wy, yy), yy + 1)
                    if (nx - wx) ** 2 + (ny - wy) ** 2 > hxm * hxm:
                        continue
                else:
                    # a box overlaps the cell when the spans overlap; flush
                    # placement touches the boundary, which is not an overlap
                    if xx + 1 <= wx - hxm + eps or xx >= wx + hxm - eps:
                        continue
                    if yy + 1 <= wy - hym + eps or yy >= wy + hym - eps:
                        continue
                if not (0 <= xx < NEW and 0 <= yy < NEW):
                    return False
                if (xx, yy) in walls and not flat:    # touches a wall
                    return False
                if (xx, yy) in getattr(self, "door_cells", ()):
                    return False                     # blocks a doorway
                if self.lvl[yy][xx] != lvl:           # hangs over a cliff/slope
                    return False
                if self.liquid(xx, yy) != wet:        # straddles the shore
                    return False
        if flat:
            return True                    # floor: it claims no ground at all
        gap = self.FP_GAP
        for (ox, oy, orx, ory) in self._fp_near(wx, wy):
            # box vs box on the world axes; a circle is its own square here,
            # which is conservative and keeps one test for every pair
            if abs(ox - wx) < R + orx + gap - eps \
                    and abs(oy - wy) < (R if hy is None else hy) + ory + gap - eps:
                return False                          # too close to a footprint
        return True

    def _hitbox_offset(self, p):
        """Where a piece's HITBOX CENTRE sits, in world cells, relative to the
        placement itself. A hitbox is an ellipse in FRAME pixels from the
        frame's centre; `_fit` carries it to screen px exactly as the game
        does, and the projection brings it back to cells. Returns None when the
        piece publishes no footprint - then there is nothing to centre."""
        fit = self._fit(p)
        if fit is None:
            return None
        # THE RECORD THE GAME WILL ACTUALLY USE. The hitbox channel is keyed
        # per variation ("scenery/stones/stone_013#not_lit_2") and the game
        # resolves the DRAWN state's record, so a placement that names a
        # variation must be centred on THAT ellipse, not the piece's. Measured
        # on the_game: 19 placements differ, all fallen_log_020, by up to 7
        # frame px - small, but it is exactly the kind of drift that shows up
        # as "the hitbox is off" with the overlay on.
        boxes = (self._rec(p) or {}).get("boxes")
        if not boxes:
            return None
        k, anchor_fx, anchor_fy, fw, fh = fit
        # SEVERAL ELLIPSES ARE ONE FOOTPRINT (an entrance with two pillars is
        # two): centre the AREA-WEIGHTED centroid, which is the single ellipse
        # for the common case and the sensible middle for the rest.
        d = p.get("dir") or "south"
        sized = [(self._box_pos(b, d), self._box_size(b, d)) for b in boxes]
        tw = sum(rx * ry for _, (rx, ry) in sized) or 1.0
        ax = sum((-pa if p.get("hflip") else pa) * rx * ry
                 for (pa, _), (rx, ry) in sized) / tw
        ay = sum(pb * rx * ry for (_, pb), (rx, ry) in sized) / tw
        sx = (fw / 2 + ax - anchor_fx) * k
        sy = (fh / 2 + ay - anchor_fy) * k
        return ((sx / self.HIT_DX + sy / self.HIT_DY) / 2,
                (sy / self.HIT_DY - sx / self.HIT_DX) / 2)

    def snap_hitboxes(self):
        """THE HITBOX CENTRE STANDS IN THE MIDDLE OF A TILE (maintainer,
        2026-08-30): "try to always place the hitbox center ... centered on the
        top/ground of a tile ... the game will mark that spot in the nav as a
        tile we must navigate around - so we want that ground we now have to
        navigate around to match the scenery hitbox as good as possible."

        A placement is the art's anchor, not its footprint, so the two are
        offset by however far the piece's ellipse sits from where it stands -
        and the cell the game blocks was landing wherever that offset fell.
        Every piece that publishes a footprint is nudged (less than one cell)
        so its centre lands on a cell centre, which the game writes as
        (col+0.5, row+0.5)."""
        self._bbox = json.load(open(os.path.join(
            REPO, "games2", "config", "scenery-bbox.json")))
        self._hit = json.load(open(os.path.join(
            REPO, "live", "tuning", "scenery_hitbox.json"))).get("overrides", {})
        moved = skipped = kept = 0
        worst = 0.0
        for p in self.doc["scenery"]:
            if id(p) in getattr(self, "_flush_ids", ()):
                continue                 # placed flush against a wall
            off = self._hitbox_offset(p)
            if off is None:
                skipped += 1
                continue
            wx, wy = p["x"] + off[0], p["y"] + off[1]
            cx, cy = math.floor(wx), math.floor(wy)
            t = 0.5 + self.HITBOX_DROP / (2.0 * self.HIT_DY)
            nx, ny = cx + t - off[0], cy + t - off[1]
            # the nudge may not walk a piece off its own ground or into a wall
            if not (0 <= cx < NEW and 0 <= cy < NEW) or self.liquid(cx, cy) \
                    or not self.g(int(nx), int(ny)):
                kept += 1
                continue
            d = max(abs(nx - p["x"]), abs(ny - p["y"]))
            worst = max(worst, d)
            if d > 1e-9:
                moved += 1
            p["x"], p["y"] = round(nx, 4), round(ny, 4)
        # BUILD ASSERT: every piece we accepted really is centred. Measured
        # against the game's own collision test, pieces whose ellipse covers
        # no cell centre at all - and which therefore block nothing - fall
        # from 550 of 1,421 (39%) to 11, while the total cells blocked barely
        # moves (3,158 -> 3,188), so the footprints got ACCURATE, not bigger.
        for p in self.doc["scenery"]:
            if id(p) in getattr(self, "_flush_ids", ()):
                continue
            off = self._hitbox_offset(p)
            if off is None:
                continue
            wx, wy = p["x"] + off[0], p["y"] + off[1]
            if not (0 <= int(wx) < NEW and 0 <= int(wy) < NEW):
                continue
            if self.liquid(int(wx), int(wy)):
                continue
            # 1e-3 of a cell is 0.03 screen px - the coordinates are rounded
            # to 4 decimals in the file, and the projection amplifies that.
            t = 0.5 + self.HITBOX_DROP / (2.0 * self.HIT_DY)
            assert abs(wx - math.floor(wx) - t) < 1e-3 \
                and abs(wy - math.floor(wy) - t) < 1e-3, \
                f"{p['piece']} at {p['x']},{p['y']}: hitbox centre {wx},{wy} " \
                "is not on a tile centre"
        self.placed += [("hitboxes centred on a tile", moved),
                        ("no footprint published", skipped),
                        ("nudge refused (water/void)", kept)]
        print(f"  [snap_hitboxes: {moved} centred, worst nudge "
              f"{worst:.2f} cells]", flush=True)

    def police_footprints(self):
        """The footprint law over EVERY piece, including the ones that never
        came through put() - the base build's trees and the ported v2 props.
        Deterministic: pieces are judged in (x+y, piece) order and the first
        to claim ground keeps it. Ends with the audit that must read zero."""
        self._fp = {}
        keep, dropped = [], 0
        order = sorted(range(len(self.doc["scenery"])),
                       key=lambda i: (round(self.doc["scenery"][i]["x"]
                                            + self.doc["scenery"][i]["y"], 3),
                                      self.doc["scenery"][i]["piece"]))
        for i in order:
            p = self.doc["scenery"][i]
            sh = self._fp_shape(p)
            if sh:
                kind, dwx, dwy, hx, hy = sh
                wx, wy = p["x"] + dwx, p["y"] + dwy
                R, HY = (hx, hy) if kind == "rect" else (hx, None)
            else:
                wx, wy, R, HY = int(p["x"]) + 0.5, int(p["y"]) + 0.5, \
                    self.FP_DEFAULT, None
            flat = self._flat(p)
            if self._footprint_ok(wx, wy, R, HY, flush=True, flat=flat) \
                    and (flat or self._art_clear(p["piece"], p["x"], p["y"],
                                                 p.get("state"))):
                keep.append(i)
                if not flat:
                    self._fp_add(wx, wy, R, HY)
            else:
                dropped += 1
        keep.sort()
        self.doc["scenery"] = [self.doc["scenery"][i] for i in keep]
        self._reindex()
        self.placed += [("footprint law: pieces removed", dropped),
                        ("footprint law: refused at placement",
                         getattr(self, "fp_refused", 0))]
        # BUILD ASSERT: the world is clean under all three rules.
        self._fp = {}
        for p in self.doc["scenery"]:
            sh = self._fp_shape(p)
            if sh:
                kind, dwx, dwy, hx, hy = sh
                wx, wy = p["x"] + dwx, p["y"] + dwy
                R, HY = (hx, hy) if kind == "rect" else (hx, None)
            else:
                wx, wy, R, HY = int(p["x"]) + 0.5, int(p["y"]) + 0.5, \
                    self.FP_DEFAULT, None
            flat = self._flat(p)
            assert self._footprint_ok(wx, wy, R, HY, flush=True, flat=flat), \
                f"{p['piece']} at {p['x']},{p['y']} breaks the footprint law"
            assert flat or self._art_clear(p["piece"], p["x"], p["y"],
                                           p.get("state")), \
                f"{p['piece']} at {p['x']},{p['y']} hangs over a level change"
            if not flat:
                self._fp_add(wx, wy, R, HY)

    def relight(self):
        """FILL THE LIGHT BUDGET, NEVER EXCEED IT (maintainer 2026-08-29:
        "push the limit so we get as much light as we can before the tech
        fails us"). Every hearth, brazier and lamp is a CANDIDATE; they are
        lit greedily, nearest-the-player-first, and a candidate is only lit
        if the worst camera window still holds at most the engine's 8 slots
        after it. Lighting them all blew the budget at 14 in one window the
        moment every room got a hearth."""
        import math as _m
        VIEW_W, VIEW_H, SLOTS, RAD = 899, 774, 8, 7
        RX, RY = _m.sqrt(2) * 32 * RAD, _m.sqrt(2) * 15 * RAD
        LIGHTABLE = ("hearths/", "braziers/", "torch_posts/", "lantern_posts/",
                     "lantern_stands/", "streetlights/", "flame_niches/",
                     "campfire", "cauldron_camps/")
        lit = [((p["x"] - p["y"]) * 32, (p["x"] + p["y"]) * 15)
               for p in self.doc["scenery"] if p.get("lit")]

        def fits(c):
            for a in (c, *lit):
                n = sum(1 for b in (c, *lit)
                        if abs(b[0] - a[0]) <= VIEW_W / 2 + RX
                        and abs(b[1] - a[1]) <= VIEW_H / 2 + RY)
                if n > SLOTS:
                    return False
            return True

        added = 0
        cands = [p for p in self.doc["scenery"]
                 if not p.get("lit") and p["piece"].startswith(LIGHTABLE)
                 and any(k.startswith("LIT") for k in (json.load(open(
                     os.path.join(REPO, "scenery", p["piece"],
                                  "scenery.json"))).get("states") or {}))]
        sx, sy = self.doc["spawn"]
        cands.sort(key=lambda p: abs(p["x"] - sx) + abs(p["y"] - sy))
        for p in cands:
            c = ((p["x"] - p["y"]) * 32, (p["x"] + p["y"]) * 15)
            if fits(c):
                p["lit"] = True
                lit.append(c)
                added += 1
        self.placed += [("lights added by the budget pass", added),
                        ("lit total", len(lit))]

    def npcs(self):
        """THE CAST (maintainer 2026-08-30: "why didn't you add the NPCs to
        the new map?"). the_game shipped monsters but no people, and the town
        was built FOR people - "we have lots of NPCs that look good in a city".

        Two sources, one file:
          * the island's own 22, translated cell-for-cell (+OFF) - every
            anchor they were cast for still exists: the chess table, the two
            houses, the cave mouth, the bridges, the roads, the shore;
          * a NEW town cast - merchants at the market stalls and townsfolk
            around the plaza and the houses.

        characters2 owns WHO they are; this file never restates their art or
        lore, only where they stand and which way they look. MERCHANT_LOOK is
        the v2 pipeline's own hand-curated table: only characters whose sprite
        visibly presents wares, because "looks like a merchant" is a
        judgement about art no terrain rule can make."""
        import npcs as NP
        roster = json.load(open(os.path.join(
            REPO, "characters2", "npcs", "index.json")))["npcs"]
        ox, oy = OFF
        out, used = [], set()

        def facing(dx, dy):
            """characters2' 8 rotations in grid terms - south is +x+y, the
            way the chess master faces over his board in the v2 file."""
            if dx > 0 and dy > 0: return "south"
            if dx < 0 and dy < 0: return "north"
            if dx > 0 and dy < 0: return "east"
            if dx < 0 and dy > 0: return "west"
            if dx > 0: return "south-east"
            if dy > 0: return "south-west"
            if dx < 0: return "north-west"
            return "north-east"

        def standable(x, y):
            g = self.g(x, y)
            return bool(g) and g not in ("water", "deep_water")

        def covered(x, y):
            """How much of a body standing at (x,y) is covered by scenery
            drawn IN FRONT of it (larger x+y), plus whether it stands on a
            footprint. Body is 36x88 screen px."""
            sx, sy = (x + 0.5 - (y + 0.5)) * 32.0, (x + 0.5 + y + 0.5) * 14.0
            a = (sx - 18, sy - 88, sx + 18, sy)
            import numpy as np
            m = np.zeros((16, 32), bool)
            for q in self.doc["scenery"]:
                if q["x"] + q["y"] <= x + 0.5 + y + 0.5:
                    continue
                if abs(q["x"] - x) > 7 or abs(q["y"] - y) > 7:
                    continue
                b = self._art_rect(q["piece"], q["x"], q["y"])
                if b is None:
                    continue
                ox0, ox1 = max(a[0], b[0]), min(a[2], b[2])
                oy0, oy1 = max(a[1], b[1]), min(a[3], b[3])
                if ox1 <= ox0 or oy1 <= oy0:
                    continue
                c0 = int((ox0 - a[0]) / 36 * 32); c1 = int(math.ceil((ox1 - a[0]) / 36 * 32))
                r0 = int((oy0 - a[1]) / 88 * 16); r1 = int(math.ceil((oy1 - a[1]) / 88 * 16))
                m[max(0, r0):min(16, r1), max(0, c0):min(32, c1)] = True
            on_fp = any(abs(ox - x - 0.5) < orx and abs(oy - y - 0.5) < ory
                        for (ox, oy, orx, ory)
                        in self._fp_near(x + 0.5, y + 0.5))
            return float(m.mean()), on_fp

        NPC_HIDE = 0.30       # more than this covered = hidden, move him

        def in_the_open(x, y):
            """The nearest standable cell where the body is not hidden and
            not on a footprint. Ties go to SCREEN-LEFT (smaller x - y) - the
            chess player stands to the left of his board, not behind it
            (maintainer 2026-09-02). Same level as the asked cell, so nobody
            is moved off a terrace."""
            x, y = int(x), int(y)
            lvl = self.lvl[y][x]
            best = None
            for r in range(0, 5):
                cands = [(x + dx, y + dy) for dx in range(-r, r + 1)
                         for dy in range(-r, r + 1)
                         if max(abs(dx), abs(dy)) == r]
                scored = []
                for (cx, cy) in cands:
                    if not (0 <= cx < NEW and 0 <= cy < NEW):
                        continue
                    if not standable(cx, cy) or self.lvl[cy][cx] != lvl:
                        continue
                    if (cx, cy) in self._walls():
                        continue
                    cov, on_fp = covered(cx, cy)
                    if on_fp:
                        continue
                    scored.append((cov > NPC_HIDE, cov, cx - cy, cx, cy))
                scored.sort()
                if scored and not scored[0][0]:
                    return scored[0][3], scored[0][4]
                if scored and best is None:
                    best = (scored[0][3], scored[0][4])
            return best or (x, y)

        def place(cid, kind, x, y, face, anchor, wares=None, idp="npc",
                  allow_reuse=False):
            if cid not in roster or not standable(x, y):
                return False
            if cid in used and not allow_reuse:
                return False
            # NEVER BEHIND THE SCENERY (maintainer 2026-09-02: "you should
            # also not place an NPC behind a scenery ... it's ok if the NPC is
            # somewhat behind the scenery graphics, but they should not be
            # hidden by it"). Measured before: 8 of 34 more than 30% covered,
            # two of them fully.
            x, y = in_the_open(x, y)
            # THE CHESS PLAYER STANDS BESIDE HIS BOARD, NOT BEHIND IT - his
            # example, verbatim: "that NPC can stand to the left side of the
            # chess board in order to not stand behind". Of the cells around
            # the table, take the least covered, ties to screen-left.
            if anchor == "chess":
                tables = [q for q in self.doc["scenery"]
                          if q["piece"].startswith("chess_tables/")]
                if tables:
                    t = min(tables, key=lambda q: (q["x"] - x) ** 2 + (q["y"] - y) ** 2)
                    tx, ty = int(t["x"]), int(t["y"])
                    best = None
                    for dx in (-1, 0, 1):
                        for dy in (-1, 0, 1):
                            cx, cy = tx + dx, ty + dy
                            if (dx, dy) == (0, 0) or not standable(cx, cy):
                                continue
                            if self.lvl[cy][cx] != self.lvl[ty][tx]:
                                continue
                            cov, on_fp = covered(cx, cy)
                            if on_fp:
                                continue
                            key = (cov > NPC_HIDE, cx - cy, cov)
                            if best is None or key < best[0]:
                                best = (key, cx, cy)
                    if best:
                        x, y = best[1], best[2]
                        face = facing(tx - x, ty - y)     # and looks at it
            used.add(cid)
            e = {"id": f"{idp}-{len(out) + 1}", "character": cid,
                 "name": roster[cid]["display_name"], "type": kind,
                 "x": int(x), "y": int(y), "elev": int(self.lvl[int(y)][int(x)]),
                 "facing": face, "anchor": anchor}
            if wares:
                e["wares"] = list(wares)
            out.append(e)
            return True

        # 1) the island's own cast, moved with the island
        src = json.load(open(os.path.join(
            MAPS2, "worlds", "the_island2", "npcs.json")))["npcs"]
        moved = 0
        for n in src:
            x, y = n["x"] + ox, n["y"] + oy
            if place(n["character"], n["type"], x, y, n["facing"],
                     n.get("anchor", "road"), n.get("wares"), "isle"):
                moved += 1

        # 2) the town: merchants at the stalls, townsfolk on the plaza
        cx, cy = self.plaza
        stalls = sorted((p for p in self.doc["scenery"]
                         if p["piece"].startswith("market_stalls/")),
                        key=lambda p: (p["y"], p["x"]))
        # ONLY SEVEN CHARACTERS IN THE WHOLE LIBRARY LOOK LIKE MERCHANTS, and
        # the island's own cast already uses all seven. A town with no shop is
        # worse than the same vendor appearing twice a hundred cells apart, so
        # a merchant may be reused in the town if his island copy is far away.
        # Asked characters2 for more vendor art.
        FAR = 60
        here = {e["character"]: (e["x"], e["y"]) for e in out}
        merch = [(c, w) for c, (w, _look) in NP.MERCHANT_LOOK.items()
                 if c in roster
                 and (c not in here
                      or abs(here[c][0] - cx) + abs(here[c][1] - cy) > FAR)]
        sold = 0
        for st, (cid, wares) in zip(stalls, merch):
            sx, sy = int(st["x"]), int(st["y"]) + 1     # behind his own stall
            if place(cid, "MERCHANT", sx, sy, facing(cx - sx, cy - sy),
                     "market", wares, "town", allow_reuse=True):
                sold += 1
        # townsfolk: the roles that belong in a town, ringing the plaza
        want = ("commoner", "villager", "artisan", "craftsman", "herbalist",
                "alchemist", "noble", "scholar")
        folk = [c for c in sorted(roster)
                if roster[c].get("role") in want and c not in used]
        spots = [(cx - 5, cy - 3), (cx + 5, cy + 3), (cx - 4, cy + 4),
                 (cx + 4, cy - 4), (cx - 2, cy + 5), (cx + 2, cy - 5),
                 (cx - 6, cy + 1), (cx + 6, cy - 1)]
        town = 0
        for cid, (sx, sy) in zip(folk, spots):
            if place(cid, "AMBIENT", sx, sy, facing(cx - sx, cy - sy),
                     "town", None, "town"):
                town += 1

        # EVERY REFERENCE RESOLVES AND EVERY ONE STANDS ON GROUND — asserted,
        # so a terrain change breaks the build instead of stranding somebody.
        seen = set()
        hidden = 0
        for e in out:
            assert e["character"] in roster, e
            assert e["name"] == roster[e["character"]]["display_name"], e
            assert standable(e["x"], e["y"]), e
            assert e["id"] not in seen, e
            seen.add(e["id"])
            cov, on_fp = covered(e["x"], e["y"])
            if cov > NPC_HIDE or on_fp:
                hidden += 1
        # BUILD ASSERT: nobody is hidden. A cell may be boxed in on every side
        # (the smithy floor is 3x3), so the rule is "nobody", measured, not
        # "always found a spot" - if this fires, the scenery around that NPC
        # is the thing to fix.
        assert hidden == 0, f"{hidden} NPCs still hidden behind scenery"
        json.dump({"schema": "pixel-maps3/npcs@1", "world": "the_game",
                   "npcs": out},
                  open(os.path.join(OUT, "npcs.json"), "w"),
                  separators=(",", ":"))
        self.placed += [("npcs: island cast moved", moved),
                        ("npcs: town merchants", sold),
                        ("npcs: townsfolk", town),
                        ("npcs total", len(out))]

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
        """Storey reference. Roof decks are gone (the roof is the wall's own
        top course), so with none present the house is three storeys tall."""
        roofs = [dk for dk in self.doc["decks"] if dk["kind"] == "roof"]
        if not roofs:
            return 0, 0, self.HOUSE_RISE, 0
        return self._roof_ref_from(roofs)

    def _roof_ref_from(self, roofs):
        roofs = sorted(roofs, key=lambda dk: len(dk["cells"]))
        big = roofs[-1]
        lv, th = int(big["level"]), int(big.get("thickness", 1))
        wl = max(self.lvl[c["y"]][c["x"]] for c in big["cells"])
        fl = min(self.lvl[c["y"]][c["x"]] for c in big["cells"])
        return lv, th, wl, fl

    WALL_MATERIALS = ("parquet_floor", "brown_paving_stone", "grey_paving_stone")
    # HOUSES ARE NOT ALL THE SAME HOUSE (maintainer 2026-09-05: "I also feel
    # all houses look very very similar. You can use paving stone as well to
    # create a house out of stone. You can also place them on top of the
    # mountain with snow on the roof. What about dark mud as floor? What about
    # tree as the roof and paving stone in the rooms?").
    #
    # The WALL is one of the three he named and nothing else - that rule is
    # his (2026-08-30). The ROOF and the FLOOR are free, so the variety lives
    # there: parquet_floor IS the timber, so "tree as the roof" is a
    # parquet_floor roof over paving-stone rooms, and snow is a roof like any
    # other ground. (wall, roof, floor):
    HOUSE_STYLES = {
        "timber":    ("parquet_floor", "brown_paving_stone", "parquet_floor"),
        "stone":     ("grey_paving_stone", "grey_stone", "dark_mud"),
        "longhouse": ("parquet_floor", "parquet_floor", "grey_paving_stone"),
        "brick":     ("brown_paving_stone", "grey_paving_stone", "parquet_floor"),
        "highland":  ("grey_paving_stone", "snow", "dark_mud"),
    }
    # SIX TILES, AND V2 SAID SO ALL ALONG (islandworld2.HOUSE_WALL = 6).
    # The maintainer's own breakdown, 2026-08-30: "the door is 5 tiles and the
    # roof is 1, so a house should be 6 tiles in height". The wall ring rides
    # at base + HOUSE_RISE and its top course IS the roof, so the doorway
    # stands 5 clear and the roof is the sixth.
    HOUSE_RISE = 6

    def house(self, x0, y0, w, h, wall, roof, floor="parquet_floor",
              door_side="south"):
        """A house is a RING OF X-OVER-Y WALLS, and the roof is the thin band
        on top of them (maintainer 2026-08-30).

        "Use Parquet Floor or Brown Paving Stone or Grey Paving Stone as the
        wall. And use the x-over-y feature to make the roof texture thin (not
        take up an entire cell). A good roof can be Light Soil over Parquet
        Floor."

        So the wall ring's cells carry roof-over-wall: their TOP is the roof
        material and their FACE is the wall material, which makes the roof a
        thin course around the top of the walls instead of a slab covering
        whole cells. There is no roof deck any more - a deck is a full cell
        of roof, which is exactly what he does not want."""
        assert wall in self.WALL_MATERIALS, f"{wall} is not a wall material"
        if not hasattr(self, "floor_cells"):
            self.floor_cells = {}
            self.door_cells = set()
        # A HOUSE IS SIX TILES TALL - five of door, one of roof. Three levels
        # stood 45px against a 64px hero and read as a bunker; eight overshot.
        rise = self.HOUSE_RISE
        gi, grd, lvl = self.gi, self.grd, self.lvl
        base = self.lvl[y0][x0]
        rect = [(x, y) for y in range(y0, y0 + h) for x in range(x0, x0 + w)]
        for (x, y) in rect:      # the pad must be dry land, flat enough
            assert not self.liquid(x, y) and self.g(x, y), (x, y, self.g(x, y))
        # THE DOOR IS NOT ALWAYS ON THE SAME WALL (maintainer 2026-09-05: "I
        # see you also always place the door at the bottom left and never
        # bottom right"). South is the screen's bottom-LEFT face and east its
        # bottom-RIGHT; both are front walls the player walks in through, and
        # both keep the doorway visible from outside - a north or west door
        # opens into the back of the house, which the camera never sees.
        sides = [door_side, "east" if door_side == "south" else "south"]
        door_side = next((sd for sd in sides
                          if self._approach_ok(x0, y0, w, h, sd, base, 4)),
                         sides[0])
        door = (x0 + w // 2, y0 + h - 1) if door_side == "south" \
            else (x0 + w - 1, y0 + h // 2)
        wcells = []
        for (x, y) in rect:
            ring = x in (x0, x0 + w - 1) or y in (y0, y0 + h - 1)
            if ring and (x, y) != door:
                grd[y][x] = gi[roof]; lvl[y][x] = base + rise
                wcells.append({"x": x, "y": y})
            else:
                grd[y][x] = gi[floor]; lvl[y][x] = base
                # WHICH CELLS ARE A FLOOR IS RECORDED, NOT INFERRED FROM THE
                # MATERIAL. Rooms used to be "every connected patch of
                # parquet_floor", which stops being true the moment a house
                # has a dark mud or paving-stone floor - and dark mud is a fen
                # outdoors. The house says so instead.
                self.floor_cells[(x, y)] = floor
        self.doc["walls"].append({"side": wall, "cells": wcells})
        # THE ROOF DECK IS WHAT MAKES A HOUSE INDOORS. The game's indoor
        # system keys on a kind:"roof" deck over the player - it is what
        # blacks out the world outside and fixes the draw order. Dropping the
        # decks to make the roof thin broke every interior in the live game
        # (2026-08-30). The deck now covers the INTERIOR ONLY, so the roof is
        # still not a slab over the walls: the wall ring keeps its thin
        # roof-over-wall course and the deck roofs the room it encloses.
        # THE ROOF COVERS THE WHOLE FOOTPRINT, exactly as v2 did
        # (islandworld2._house_near_spawn: cells = list(foot)). Narrowing it to
        # the interior left the DOORWAY unroofed - the door is a gap in the
        # wall ring, so with no wall there is no roof course there either, and
        # the house got a notch cut out of its roof and a full-height hole
        # (maintainer 2026-08-30: "the door on this house look fucked up! You
        # did it the entire V2!"). The roof is still THIN because thin is
        # about x-over-y, not about footprint: brown_paving_stone over parquet_floor.
        self.doc["decks"].append(
            {"kind": "roof", "level": base + rise, "thickness": 0,
             "ground": roof, "side": wall,
             "cells": [{"x": x, "y": y} for (x, y) in rect]})
        # NOTHING STANDS IN THE DOORWAY (maintainer 2026-09-05: "I tried to
        # walk into this house, but you have placed a barrel exactly at the
        # entrance so I can't get in"). The threshold is three cells - the
        # gap in the wall, the step outside it and the cell inside - and no
        # footprint may touch any of them. The barrel had every right to be
        # there under the footprint law: it was against a wall, on free floor,
        # clear of its neighbours. A door is not a wall.
        # AND THE DOOR MUST OPEN ONTO GROUND YOU CAN STAND ON (maintainer
        # 2026-09-05, at the town hall whose doorway opened straight onto a
        # drop: "How do you expect a player to even get in?! Do you even look
        # and thing when you place stuff?"). Three cells straight out from the
        # threshold, at the floor's own level and dry - which is what the pad
        # ELBOW buys, asserted here so a future pad rule cannot lose it.
        step = (door[0], door[1] + 1) if door_side == "south" \
            else (door[0] + 1, door[1])
        back = (door[0], door[1] - 1) if door_side == "south" \
            else (door[0] - 1, door[1])
        self.door_cells.update({door, step, back})
        # doorstep
        dx, dy = step
        if self.g(dx, dy) == "grass":
            grd[dy][dx] = gi["brown_paving_stone"]
        for k in range(1, 4):
            ax = door[0] + (0 if door_side == "south" else k)
            ay = door[1] + (k if door_side == "south" else 0)
            assert 0 <= ax < NEW and 0 <= ay < NEW \
                and self.lvl[ay][ax] == base and not self.liquid(ax, ay), \
                (f"the door of the house at {(x0, y0)} opens onto "
                 f"{(ax, ay)}: level {self.lvl[ay][ax] if 0 <= ax < NEW and 0 <= ay < NEW else '-'} "
                 f"against the floor's {base}")
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

    ELBOW = 2      # cells of FLAT ground a house wants on every side
                   # (maintainer 2026-09-05: "Why do you place the house so
                   # close to the hill. Feel the balance please. You could
                   # have placed it a little big up to get some space." A pad
                   # that is flat itself can still have a cliff against its
                   # back wall, and then there is nowhere to stand and the
                   # hill grows out of the roof.)

    def _approach_ok(self, x0, y0, w, h, side, z, n=4):
        """n cells straight out from the middle of a front face, at level `z`
        and dry - the ground a player walks up to that door on."""
        for i in range(n):
            if side == "south":
                ax, ay = x0 + w // 2, y0 + h + i
            else:
                ax, ay = x0 + w + i, y0 + h // 2
            if not (0 <= ax < NEW and 0 <= ay < NEW):
                return False
            if self.lvl[ay][ax] != z or self.liquid(ax, ay) or not self.g(ax, ay):
                return False
        return True

    def find_pad(self, tx, ty, w, h, on=("grass",), r=60, widen=True, dry=None,
                 elbow=None):
        """Nearest flat clear w*h pad to (tx,ty): every cell `on`-ground at one
        level and DRY (further than DRY_R from water/beach, via the BFS
        field), no paving/road adjacent, no non-tree scenery in the rect+1
        (trees get evicted by the house build), and `elbow` cells of ground at
        the SAME LEVEL all the way round it."""
        if not hasattr(self, "wd"):
            self._wdist()
        if not hasattr(self, "occ"):
            self._reindex()
        best, D = None, self.DRY_R if dry is None else dry
        E = self.ELBOW if elbow is None else elbow
        for y in range(max(1, ty - r), min(NEW - h - 1, ty + r)):
            for x in range(max(1, tx - r), min(NEW - w - 1, tx + r)):
                z = self.lvl[y][x]
                ok = True
                # THE ELBOW: flat ground round the house, so there is
                # somewhere to walk and the hill is not against the wall.
                for yy in range(y - E, y + h + E):
                    for xx in range(x - E, x + w + E):
                        if not (0 <= xx < NEW and 0 <= yy < NEW) \
                                or self.lvl[yy][xx] != z \
                                or self.liquid(xx, yy):
                            ok = False; break
                    if not ok:
                        break
                if not ok:
                    continue
                # AND THE HOUSE MUST HAVE A FRONT YOU CAN WALK UP TO. The
                # elbow keeps the walls clear; this keeps a DOOR reachable -
                # four cells straight out from the middle of the south face
                # or the east one, at the pad's level and dry. house() then
                # puts the door on a side that passed.
                if not any(self._approach_ok(x, y, w, h, sd, z, 4)
                           for sd in ("south", "east")):
                    continue
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

    def highest_pad(self, w, h):
        """A flat w*h pad on the HIGHEST ground that has one - the mountain,
        not the field. Searches the snow and rock materials from the top level
        down, and takes the first level that yields a pad (find_pad's own
        rules still apply: one level, no road or floor adjacent, nothing
        standing in it). AssertionError when the massif has no flat shelf that
        big, which is a real answer - not every island has room up there."""
        HIGH = ("snow", "grey_stone", "black_rock", "ice")
        best = {}
        for y in range(NEW):
            for x in range(NEW):
                g = self.g(x, y)
                if g in HIGH:
                    best.setdefault(self.lvl[y][x], []).append((x, y))
        for lv in sorted(best, reverse=True):
            if lv < 8:                    # not a mountain any more
                break
            xs = [c[0] for c in best[lv]]; ys = [c[1] for c in best[lv]]
            tx, ty = sum(xs) // len(xs), sum(ys) // len(ys)
            try:
                return self.find_pad(tx, ty, w, h, on=HIGH, r=40,
                                     widen=False, dry=0)
            except AssertionError:
                continue
        raise AssertionError(f"no {w}x{h} shelf on the mountain")

    def houses(self):
        sx, sy = self.doc["spawn"]
        # fisher's hut: timber (turf over parquet faces) — on the grass field
        # ABOVE the pier landing, never on the sand itself
        lx, ly = self.landing
        hx, hy = self.find_pad(lx - 7, ly - 7, 8, 7)
        self.int_fisher = self.house(hx, hy, 8, 7,
                                     *self.HOUSE_STYLES["timber"],
                                     door_side="east")
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
        wx, wy = self.find_pad(best[1], best[2], 9, 7)
        # the woodcutter roofs in timber, which is what he cuts
        self.int_wood = self.house(wx, wy, 9, 7,
                                   *self.HOUSE_STYLES["longhouse"])
        # the smithy: stone (slate over cobble), in the village near spawn
        mx, my = self.find_pad(sx + 8, sy - 7, 8, 7)
        # the smithy is stone, with a dark mud floor - it holds a forge
        self.int_smith = self.house(mx, my, 8, 7, *self.HOUSE_STYLES["stone"])
        self.smithy = (mx, my)
        self.woodcutter = (wx, wy)
        self.fisher = (hx, hy)
        # AND ONE UP ON THE MOUNTAIN, WITH SNOW ON ITS ROOF (his ask). It
        # stands on whatever the high ground is made of, not on grass, so
        # find_pad is given the mountain's own materials; if the massif has no
        # flat 8x7 anywhere the house is simply not built, like the town's.
        n_high = 0
        try:
            hix, hiy = self.highest_pad(8, 7)
            self.int_high = self.house(hix, hiy, 8, 7,
                                       *self.HOUSE_STYLES["highland"],
                                       door_side="east")
            self.highland = (hix, hiy)
            n_high = 1
        except AssertionError:
            self.fail += 1
        self.placed += [("new houses", 3 + n_high)]

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
        self._against = []
        """Furnish EVERY parquet room (the indoor-scenery ask). The renderer
        hides pieces under roofs; the GAME discards every roofed placement
        outright (scenery3.ts returns early for a cell under a roof or cave
        deck), so indoor furniture is visible in render3 output only until
        that changes - reported to games."""
        # NOTHING OUTDOOR STANDS ON AN INDOOR FLOOR. Building a house over
        # ground that already had a tree or a bush left it growing in the
        # sitting room.
        floors0 = self.indoor_floors()
        before = len(self.doc["scenery"])
        self.doc["scenery"] = [
            p for p in self.doc["scenery"]
            if not ((int(p["x"]), int(p["y"])) in floors0
                    and not p["piece"].startswith(self.INDOOR_OK))]
        self._reindex()
        self.placed += [("outdoor scenery evicted from rooms",
                         before - len(self.doc["scenery"]))]

        # A ROOM IS A CONNECTED PATCH OF ONE HOUSE'S FLOOR. Roof decks used to
        # define them; the roof is the wall's own top course now, so the floor
        # is what says "this is a room" - and WHICH cells are a floor is
        # recorded by house(), not inferred from the material, now that a
        # floor can be dark mud (which is also a fen) or paving stone (which
        # is also a road).
        floors = floors0
        seen, rooms = set(), []
        for y in range(NEW):
            for x in range(NEW):
                if (x, y) not in floors or (x, y) in seen:
                    continue
                comp, stack = [], [(x, y)]
                seen.add((x, y))
                while stack:
                    cx3, cy3 = stack.pop()
                    comp.append((cx3, cy3))
                    for dx3, dy3 in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        n = (cx3 + dx3, cy3 + dy3)
                        if n not in seen and n in floors \
                                and floors[n] == floors[(x, y)]:
                            seen.add(n)
                            stack.append(n)
                if len(comp) >= 4:
                    rooms.append(comp)
        for hi, floor in enumerate(sorted(rooms, key=lambda f: (f[0][1], f[0][0]))):
            cells = set(floor)
            xs = sorted(x for x, _ in floor)
            ys = sorted(y for _, y in floor)
            x0, x1, y0, y1 = xs[0], xs[-1], ys[0], ys[-1]
            cx, cy = (x0 + x1) / 2 + 0.5, (y0 + y1) / 2 + 0.5
            r = _rng32(hi * 7919 ^ 0xfeed)

            def pk(group, d=None):
                """Prefer a piece that HAS the rotation we need, so furniture
                against a wall actually faces the room."""
                pool = self.pool(group)
                if d:
                    have = [q for q in pool
                            if os.path.isfile(os.path.join(
                                REPO, "scenery", q, "rotations", d + ".webp"))]
                    pool = have or pool
                return pool[int(r() * len(pool)) % len(pool)]

            IN = (floors.get(floor[0], "parquet_floor"),)
            n = 0
            # FURNITURE GOES AGAINST THE BACK WALLS, FACING THE ROOM
            # (maintainer 2026-08-30: "pick the correct SW vs SE so a
            # bookshelf is against the wall and not pointing into the room").
            #
            #   back to the WEST  wall (low x, upper LEFT)  -> south-east
            #   back to the NORTH wall (low y, upper RIGHT) -> south-west
            #
            # `dir` is the direction the piece LOOKS, and south-east looks
            # DOWN-RIGHT (+x), south-west DOWN-LEFT (+y) - the same convention
            # as characters2 and as games2' vectorToDirection, not the
            # opposite one I briefly talked myself into.
            #
            # MEASURED, because the eye got it backwards. A chair's backrest
            # is unambiguous: the x-centroid of the top 35% of rows against
            # the whole silhouette gives chair_010 south-east 24.0 vs 28.4
            # (back LEFT, so it faces down-right) and south-west 39.6 vs 34.8
            # (back RIGHT). chair_001 agrees, and bed_002 lays its long axis
            # along y under south-east - flush to a low-x wall. Judging it
            # instead from a rendered test room inverted every piece in every
            # house; do not re-decide this by looking at a render.
            #
            # The east and south walls get no back-to-wall furniture: that
            # needs north-west / north-east art and no scenery piece ships it.
            west = [(x, y) for (x, y) in floor if x == x0]      # upper-left wall
            north = [(x, y) for (x, y) in floor if y == y0]     # upper-right wall
            west.sort(key=lambda c: c[1])
            north.sort(key=lambda c: c[0])

            def against(group, wall, idx, **kw):
                """BACK TO THE WALL, FLUSH AGAINST IT, SLIDING INTO THE CORNER.

                THE WALL DECIDES THE FACING, always: west wall -> south-east,
                north wall -> south-west. That is the measured rule (the
                backrest centroid, see above), and it is what "the back is
                against the wall" MEANS. Deriving it instead from which way
                the piece's rect is longer looks equivalent - a well-formed
                shelf is long along its wall - and breaks on the pieces that
                are not well formed: cupboard_010 publishes an ELLIPSE, so
                both facings measured the same, the tie took the first one,
                and a dresser stood in the middle of the room with its back to
                nothing (maintainer 2026-09-04: "It sticks out straight into
                the room and is not against a wall or corner! Some shelfs are
                good, but this one is horrible!").

                THE FOOTPRINT DECIDES THE GEOMETRY, for every piece and not
                only the rect ones. The near edge of the footprint is put
                exactly ON the wall face - the wall cells sit at x0 (or y0)
                and the floor starts one cell in, so a flush piece touches
                that boundary and never enters it, which is what the footprint
                law allows in flush mode. For an ellipse piece the "near edge"
                is its radius, which is as close as its published footprint
                lets it stand; before this it was dropped on the wall cell's
                CENTRE and then snapped to a cell centre like any loose prop,
                which is half a cell of gap and no facing rule at all.

                AND IT SLIDES ALONG THE WALL UNTIL IT FITS, INTO THE CORNER
                FIRST (maintainer 2026-09-04: "I told you to place furnitures
                edge to edge with the wall/corner"). Centring the piece on the
                wall cell it was handed is only right for a piece shorter than
                one cell: a bed is 1.4 cells long, so on the first cell of the
                wall half of it lay in the wall ROUND THE CORNER, the footprint
                law refused it, and the room lost its bed altogether. The
                along-wall centre is clamped inside the wall's own run - which
                IS the corner when the slot asked for is the end of it - and
                then walked outward in half cells until the whole footprint is
                on free floor."""
                if not wall:
                    return 0
                wx, wy = wall[min(idx, len(wall) - 1)]
                along_y = wall is west
                d = "south-east" if along_y else "south-west"
                # pk() prefers a piece that actually ships this rotation
                piece = pk(group, d)
                sh = self._fp_shape({"piece": piece, "x": 0, "y": 0, "dir": d})
                if not sh:
                    return 0
                kind, cx, cy, hx, hy = sh
                deep = hx if along_y else hy      # into the room
                span = hy if along_y else hx      # along the wall
                run = [c[1] if along_y else c[0] for c in wall]
                lo, hi = min(run) + span, max(run) + 1 - span
                if lo > hi:                       # too long for this wall
                    return 0
                want = (wy if along_y else wx) + 0.5
                first = min(max(want, lo), hi)
                cands, t = [first], 0.5
                while t <= hi - lo:
                    for sgn in (1, -1):
                        v = first + sgn * t
                        if lo - 1e-9 <= v <= hi + 1e-9:
                            cands.append(v)
                    t += 0.5
                for v in cands:
                    if along_y:
                        x, y = x0 + deep - cx, v - cy
                    else:
                        x, y = v - cx, y0 + deep - cy
                    if self.put(piece, x, y, on=IN, dir=d, flush=True, **kw):
                        self._against.append(
                            (piece, round(x, 4), round(y, 4), d,
                             "x" if along_y else "y",
                             x0 if along_y else y0))
                        return 1
                return 0

            # DRESS THE WHOLE WALL, not one piece of it: a room's furniture
            # count follows its size, so a hall is furnished like a hall.
            for k in range(max(1, len(west) // 3)):
                n += against("beds", west, k * 3)
            for k in range(max(1, len(north) // 3)):
                n += against("cupboards_and_shelves", north, k * 3 + 1)
            if len(north) > 2:
                n += against("hearths", north, len(north) // 2)
            if len(west) > 2:
                n += against("barrels", west, len(west) - 1)
            for k in range(len(cells) // 24):
                n += against("chairs_and_benches", north, 2 + k * 4)
            # A TABLE GOES AGAINST A WALL TOO (maintainer 2026-09-04, on a
            # table standing in the middle of a 13-cell bedroom, in front of
            # the bed: "Who in their right mind places a table like this! Why
            # didn't you use SW and placed it against the wall?"). A table in
            # the MIDDLE of the floor is a dining arrangement and needs a room
            # to be a dining room: the centre spot plus a chair on two sides
            # is three cells of clear floor, which a bedroom does not have and
            # a hall does. So the middle table is for rooms of 20+ cells, and
            # every smaller room puts its table against a wall like the rest
            # of its furniture - north for a south-west table, west for a
            # south-east one, whichever has room.
            if len(cells) >= 20:
                # A CHAIR FACES ITS TABLE. With only two rotations a chair can
                # look down-right (+x, south-west) or down-left (+y,
                # south-east), so both chairs sit UP-SCREEN of the table - one
                # west of it, one north of it - and each looks at it. Seating
                # them east and west put one chair's back to the table.
                n += self.put(pk("tables"), cx, cy, on=IN)
                n += self.put(pk("chairs_and_benches", "south-east"),
                              cx - 1.0, cy, on=IN, dir="south-east")
                n += self.put(pk("chairs_and_benches", "south-west"),
                              cx, cy - 1.0, on=IN, dir="south-west")
            elif len(cells) >= 6:
                mark = len(self._against)
                if against("tables", north, len(north) // 2) \
                        or against("tables", west, len(west) // 2):
                    n += 1
                    # AND A CHAIR DRAWN UP TO IT, on the side it can face
                    # from: a chair only looks down-screen, so it sits west of
                    # a north-wall table (looking south-east at it) and north
                    # of a west-wall one (south-west).
                    # (only the rect branch logs a placement; a round table
                    # goes through the inset loop and gets no chair)
                    if len(self._against) <= mark:
                        continue_chair = False
                    else:
                        continue_chair = True
                        _, tx, ty, _, axis, _ = self._against[mark]
                    if not continue_chair:
                        pass
                    elif axis == "y":        # table stands on the north wall
                        n += self.put(pk("chairs_and_benches", "south-east"),
                                      tx - 1.0, ty, on=IN, dir="south-east")
                    else:                    # ... on the west wall
                        n += self.put(pk("chairs_and_benches", "south-west"),
                                      tx, ty - 1.0, on=IN, dir="south-west")
            if len(cells) >= 12:
                n += against("wall_hangings", north, max(0, len(north) - 2))
                n += self.put(pk("rugs_and_hides"), cx, cy + 1.0, on=IN)
                n += self.put(pk("house_clutter"), x1 + 0.5, y1 + 0.5, on=IN)
            for k in range(len(cells) // 20):
                rx = x0 + 1 + int(r() * max(1, x1 - x0 - 1))
                ry = y0 + 1 + int(r() * max(1, y1 - y0 - 1))
                grp = ("barrels", "house_clutter", "tables",
                       "rugs_and_hides")[k % 4]
                n += self.put(pk(grp), rx + 0.5, ry + 0.5, on=IN)
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
    # ---- scenery stands in PLACES, not on a field -------------------------
    # (maintainer 2026-09-02) "The outdoor scenery placement still feel random
    # and not clustered enough. You should think about the placement.
    # Different places should be remembered and never feel random."
    #
    # HE WAS RIGHT AND THE FIELD PASS WAS MEASURABLY RANDOM. Clark-Evans on
    # the previous build: R = 1.122, where 1.0 IS a random Poisson pattern and
    # below 1 is clustered - so the old nature pass was very slightly MORE
    # EVEN than random, the opposite of clustered, and 81% of all placeable
    # 8-cell blocks held something. Two things caused it: sampling a cell grid
    # spreads by construction, and the anti-burial rule refuses exactly the
    # close pairs that make a cluster.
    #
    # A PLACE IS COMPOSED, NOT SAMPLED. Sites are scattered with a minimum
    # separation, each site is one KIND chosen from its own terrain, and a
    # kind is a recipe: a dominant family, an optional HERO piece at the
    # centre, a radius, and a count. Density falls off from the middle, so a
    # place reads as a thing with an inside and an edge. Between places the
    # ground is EMPTY, which is what makes a cluster legible at all.
    #
    # The province theming above still chooses WHICH family a place draws
    # from, so neighbouring places differ and a region keeps one character.
    PLACE_KINDS = (
        # name             groups (dominant first)              hero                  n      radius
        ("boulder field",  ("stones",),                         "stones",            (7, 14), (3.5, 6.0)),
        ("cairn ridge",    ("cairns", "stones"),                "cairns",            (4, 8),  (3.0, 5.0)),
        ("fern hollow",    ("ferns", "moss_clumps"),            None,                (9, 16), (3.0, 5.5)),
        ("mushroom ring",  ("mushrooms", "toadstool_rings"),    "toadstool_rings",   (6, 12), (2.5, 4.0)),
        ("deadfall",       ("fallen_logs", "stumps"),           "fallen_logs",       (4, 8),  (3.0, 5.0)),
        ("thicket",        ("bushes",),                         None,                (8, 15), (3.0, 5.5)),
        ("tussock meadow", ("grass_tufts", "bushes"),           None,                (10, 18),(4.0, 7.0)),
        ("reed bed",       ("reed_beds", "cattail_clumps"),     None,                (8, 15), (3.0, 5.5)),
        ("driftwood spit", ("driftwood_logs",),                 None,                (3, 6),  (3.0, 5.0)),
        ("lily pool",      ("water_lily_clumps",),              None,                (4, 8),  (2.5, 4.0)),
    )
    # CELLS BETWEEN TWO PLACES, and the setting that matters. Measured with
    # Clark-Evans, where 1.0 is a random Poisson pattern and below 1 is
    # clustered - the empty ground between places is what makes each one read
    # as one place:
    #     the old field pass        R = 1.122  (MORE EVEN than random)
    #     gap 26, places tiled land R = 1.024  (still random)
    #     gap 30, 70 places         R = 0.476  <- shipped, 720 pieces
    #     gap 36, 48 places         R = 0.455  (barer for little gain)
    # Land is only 13% of this map, so the gap is a LAND packing limit: past
    # ~36 the island runs out of room and goes bare rather than clustered.
    PLACE_GAP = 30
    SCATTER = 0.006       # a few loose pieces outside every place, so the map
                          # is not sterile between them

    def _kind_for(self, x, y, wet, shore, wooded, high):
        """A place is what its ground makes it."""
        if shore:
            return "lily pool" if self.liquid(x, y) else "driftwood spit"
        if wet:
            return "reed bed"
        if high:
            return "cairn ridge" if (x + y) % 3 == 0 else "boulder field"
        if wooded:
            return ("fern hollow", "mushroom ring", "deadfall",
                    "fern hollow", "thicket")[(x * 7 + y) % 5]
        # THE OPEN GROUND STILL GETS VARIETY. Keying only on terrain gave 38
        # boulder fields against 1 deadfall and no fern hollow at all, because
        # almost nothing outside the woods read as anything but open - and a
        # map of boulder fields is the same complaint in a different shape.
        return ("thicket", "tussock meadow", "boulder field", "fern hollow",
                "mushroom ring", "boulder field", "deadfall",
                "tussock meadow")[(x * 5 + y * 3) % 8]

    def nature(self):
        """Compose places. See PLACE_KINDS above for the why and the recipe."""
        kinds = {k[0]: k for k in self.PLACE_KINDS}
        trees = {(int(p["x"]) // 3, int(p["y"]) // 3)
                 for p in self.doc["scenery"] if p["piece"].startswith("trees/")}
        pools = {}

        def pool(group):
            if group not in pools:
                try:
                    pools[group] = [g for g in self.pool(group)
                                    if self._rated(g)[0]]
                except FileNotFoundError:
                    pools[group] = []
            return pools[group]

        # 1) SITES, with a minimum separation. Scanned on a coarse lattice with
        #    jitter so the sites themselves are not on a grid.
        sites = []
        # CANDIDATES MUST OUTNUMBER PLACES. The separation test does the real
        # work, so the lattice only has to offer enough dry candidates to fill
        # the land: at step = gap//3 over a map that is 87% ocean, only 28
        # places survived and the island went bare.
        step = max(4, self.PLACE_GAP // 6)
        for y in range(4, NEW - 4, step):
            for x in range(4, NEW - 4, step):
                r = _rng32((x * 2246822519) ^ (y * 3266489917) ^ 0x9A17E)
                jx = x + int(r() * step); jy = y + int(r() * step)
                if not (0 <= jx < NEW and 0 <= jy < NEW):
                    continue
                g = self.g(jx, jy)
                if not g or g in ("parquet_floor", "brown_paving_stone",
                                  "grey_paving_stone", "light_soil"):
                    continue
                if (int(jx), int(jy)) in getattr(self, "no_place", set()):
                    continue
                if r() > 0.85:
                    continue
                if any((jx - sx) ** 2 + (jy - sy) ** 2
                       < self.PLACE_GAP * self.PLACE_GAP for sx, sy, _ in sites):
                    continue
                # A PLACE STANDS ON LAND unless it is a water place. Without
                # this the open-ground rotation composed thickets, fern
                # hollows and boulder fields OUT AT SEA - the kind test only
                # ever diverted SHORE cells, and a deep-water cell is not
                # shore, so it fell through to the land recipes.
                wet = g == "dark_mud"
                # SHORE MEANS SHORE. Accepting any water cell put lily pools
                # out in open sea, tens of cells from land - a cluster nobody
                # will ever stand next to. Water qualifies only with land
                # within two cells; beach always does.
                shore = g == "light_beach" or (
                    g == "water" and any(
                        not self.liquid(jx + dx, jy + dy)
                        for dx in (-2, -1, 0, 1, 2)
                        for dy in (-2, -1, 0, 1, 2)))
                wooded = any((jx // 3 + dx, jy // 3 + dy) in trees
                             for dx in (-2, -1, 0, 1, 2)
                             for dy in (-2, -1, 0, 1, 2))
                high = self.lvl[jy][jx] >= 6 or self.near_ground(jx, jy) if False \
                    else self.lvl[jy][jx] >= 6
                if self.liquid(jx, jy) and not shore:
                    continue
                kind = self._kind_for(jx, jy, wet, shore, wooded, high)
                # and a land recipe never runs on liquid ground
                if self.liquid(jx, jy) and kind != "lily pool":
                    continue
                sites.append((jx, jy, kind))

        # 2) COMPOSE each site.
        tally = {}
        placed = 0
        for (sx, sy, kind) in sites:
            name, groups, hero, (n0, n1), (r0, r1) = kinds[kind]
            r = _rng32((sx * 40503) ^ (sy * 2654435761) ^ 0xC0FFEE)
            fams = [p for grp in groups for p in pool(grp)]
            if not fams:
                continue
            # the province decides WHICH family this place is built from
            piece, state = self.theme_pick(fams, sx, sy, r)
            if not piece:
                continue
            rad = r0 + r() * (r1 - r0)
            want = n0 + int(r() * (n1 - n0 + 1))
            ground = (self.g(sx, sy),)
            got = 0
            if hero:
                hp = pool(hero)
                if hp:
                    h, hs = self.theme_pick(hp, sx, sy, r)
                    if h and self.put(h, sx + 0.5, sy + 0.5, on=ground,
                                      hflip=r() < 0.5, state=hs):
                        got += 1
            for _ in range(want * 3):
                if got >= want:
                    break
                # DENSER IN THE MIDDLE: u**0.8 pulls samples toward the centre
                # (u**0.5 would be a flat disc), so a place has a core.
                a = r() * 6.28318
                rr = rad * (r() ** 0.8)
                px, py = sx + 0.5 + math.cos(a) * rr, sy + 0.5 + math.sin(a) * rr
                if not (0 <= px < NEW and 0 <= py < NEW):
                    continue
                if self.g(int(px), int(py)) not in ground:
                    continue
                # inside a place things MAY overlap - a cluster is meant to.
                # The anti-burial rule still stops one piece swallowing another.
                if self._hidden(piece, px, py):
                    continue
                if self.put(piece, px, py, on=ground, hflip=r() < 0.5,
                            state=state):
                    got += 1
            if got:
                placed += 1
                tally[name] = tally.get(name, 0) + 1

        # 3) A LITTLE LOOSE SCATTER so the ground between places is not sterile.
        loose = 0
        for y in range(0, NEW, 5):
            for x in range(0, NEW, 5):
                r = _rng32((x * 668265263) ^ (y * 374761393) ^ 0x5CA7)
                if r() > self.SCATTER:
                    continue
                jx, jy = x + int(r() * 5), y + int(r() * 5)
                g = self.g(jx, jy)
                if g not in ("grass", "dark_mud"):
                    continue
                fams = pool("stones") + pool("grass_tufts") + pool("ferns")
                piece, state = self.theme_pick(fams, jx, jy, r)
                if piece and not self._hidden(piece, jx + 0.5, jy + 0.5) \
                        and self.put(piece, jx + 0.5, jy + 0.5, on=(g,),
                                     hflip=r() < 0.5, state=state):
                    loose += 1
        self.placed += [("places composed", placed), ("loose scatter", loose)]
        self.placed += sorted(tally.items())

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

    # A STEP HAS TO BE VISIBLE, AND THE PLAYER MUST NEVER SEE THE FIX
    # (maintainer 2026-09-05, twice). First: "It's really hard for me to know
    # that this is an edge since both levels use the same ground type ... You
    # often draw both the hill and the slope using the same ground when we
    # have so many to choose from." Then, on the soil lip I painted round every
    # drop: "It looks as if you have created a small ring around the hill. Why
    # didn't you just change the entire top of the hill to stone? ... The
    # player should never think 'aah you added stone here to hide this
    # problem'. It should feel as if this is never an issue."
    #
    # THE PROPERTY: a raised cell draws wall faces on its south and east edges
    # only. Its north and west edges have no face - the higher top simply lies
    # over the lower ground behind it - so a step you approach from up-screen
    # exists only where the two GROUNDS differ. Grass on grass is invisible.
    #
    # THE PLAN: no two terraces that touch share a ground. A terrace is a
    # connected patch of one level; the touching graph is coloured largest-
    # first, so the valley floor and the big benches keep the ground they
    # have, and a smaller neighbour that would match them takes the next
    # ground in its own family - a WHOLE terrace, never a rim:
    #
    #   grass family   grass -> dark_mud on a low bench (a damp hollow),
    #                           grey_stone on a high one (a rocky rise)
    #   snow family    snow  -> grey_stone (the bare shoulder), black_rock
    #
    # Roads, floors, paving, beach, fens and ice are never repainted: each is
    # already a contrast and already means something. Ramps are light_soil,
    # the road's own material, because a ramp is where you walk.
    #
    # REJECTED: a one-cell contrasting lip along every drop (this file,
    # 2026-09-05, one build). It read as a ring painted on to hide a bug, and
    # it also ringed the south and east faces, which already show a fall.
    # THE LOWLAND ALTERNATE IS EARTH, NOT ROCK, until the upland. Measured on
    # the first build with grey_stone from level 4 up: the island's grass
    # went 29,303 -> 13,674 cells and the middle benches read as a grey
    # layer cake - that is repainting the meadow, not the hill. Peat under a
    # meadow bench (dark_mud) is what a wet lowland does; bare rock belongs
    # to the upland, where the massif's own grey_stone already begins.
    LOW_ALT = ((15, "dark_mud"), (999, "grey_stone"))
    # AN EDGE IS A RUN, NOT A CORNER. Two terraces that meet face-less along
    # a single cell or two are a corner clipped in passing, not a line a
    # player walks along and misreads; constraining those repainted whole
    # benches for the sake of three cells. Fewer than EDGE_MIN contacts on
    # the face-less side is no constraint.
    EDGE_MIN = 4
    # what each family may become, in order of preference after its own
    FAMILY = {"snow": ("snow", "grey_stone", "black_rock", "ice"),
              "grey_stone": ("grey_stone", "black_rock", "snow"),
              "black_rock": ("black_rock", "grey_stone"),
              "ice": ("ice", "snow")}
    # A ONE-LEVEL STEP IS A SLOPE, NOT A CLIFF: 15 px, walkable both ways,
    # graded by the tiles domain's slope sets where they exist, and nothing is
    # lost by misjudging it. Only a drop of two or more must read.
    STEP = 2

    def terraces(self):
        """[(level, cells, dominant ground)] over land, 4-connected."""
        seen = [[False] * NEW for _ in range(NEW)]
        out = []
        for y in range(NEW):
            for x in range(NEW):
                if seen[y][x] or self.liquid(x, y) or not self.g(x, y):
                    continue
                lv = self.lvl[y][x]
                st, cells = [(x, y)], []
                seen[y][x] = True
                while st:
                    cx, cy = st.pop()
                    cells.append((cx, cy))
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        nx, ny = cx + dx, cy + dy
                        if 0 <= nx < NEW and 0 <= ny < NEW and not seen[ny][nx] \
                                and not self.liquid(nx, ny) and self.g(nx, ny) \
                                and self.lvl[ny][nx] == lv:
                            seen[ny][nx] = True
                            st.append((nx, ny))
                dom = collections.Counter(self.g(*c) for c in cells).most_common(1)[0][0]
                out.append((lv, cells, dom))
        return out

    def terrace_grounds(self):
        ts = self.terraces()
        idx = {}
        for i, (lv, cells, dom) in enumerate(ts):
            for c in cells:
                idx[c] = i
        # ONLY THE FACE-LESS SIDE CONSTRAINS. A raised terrace draws wall
        # faces on its south and east edges - and the grass tile's own wall
        # band is earth, so a drop to the south or east already reads as a
        # fall ("they show a fall", his words on the rims I put there). The
        # north and west edges draw nothing: the higher top lies over the
        # lower ground behind it. So two terraces constrain each other only
        # where the LOWER one lies north or west of the higher.
        contact = collections.Counter()
        for i, (lv, cells, dom) in enumerate(ts):
            for (x, y) in cells:
                for dx, dy in ((-1, 0), (0, -1)):        # north, west of me
                    j = idx.get((x + dx, y + dy))
                    if j is not None and j != i \
                            and lv - ts[j][0] >= self.STEP:  # I am higher
                        contact[(i, j)] += 1
        adj = [set() for _ in ts]
        for (i, j), n in contact.items():
            if n >= self.EDGE_MIN:
                adj[i].add(j)
                adj[j].add(i)
        # colour: fixed families first (they are constraints), then the rest
        # largest-first so the ground the island already has wins wherever it can
        colour, forced_set = {}, set()
        movable = set(self.FAMILY) | {"grass"}
        order = sorted(range(len(ts)), key=lambda i: (ts[i][2] in movable,
                                                      -len(ts[i][1])))
        for i in order:
            lv, cells, dom = ts[i]
            if dom == "grass":
                alt = next(m for lim, m in self.LOW_ALT if lv <= lim)
                other = "grey_stone" if alt == "dark_mud" else "dark_mud"
                pal = ("grass", alt, other, "black_rock")
            elif dom in self.FAMILY:
                pal = self.FAMILY[dom]
            else:
                colour[i] = dom          # beach, road, paving, floor, fen: as is
                continue
            taken = {colour[j] for j in adj[i] if j in colour}
            pick = next((m for m in pal if m not in taken), None)
            if pick is None:             # every option touches - keep, count
                pick = pal[0]
                forced_set.add(i)
            colour[i] = pick
        forced = len(forced_set)
        # apply: only the terrace's dominant cells change
        changed = collections.Counter()
        for i, (lv, cells, dom) in enumerate(ts):
            if colour[i] == dom:
                continue
            for (x, y) in cells:
                if self.g(x, y) == dom and (x, y) not in getattr(self, "floor_cells", {}):
                    self.grd[y][x] = self.gi[colour[i]]
                    changed[f"{dom}->{colour[i]}"] += 1
        # BUILD ASSERT: no two touching terraces share a ground unless one of
        # them had no free colour at all (counted, and it is the exception
        # that says the palette is too small, not a placement slip)
        same = [(i, j) for i in range(len(ts)) for j in adj[i]
                if j > i and colour[i] == colour[j]]
        unforced = [(i, j) for (i, j) in same
                    if i not in forced_set and j not in forced_set
                    and ts[i][2] in movable and ts[j][2] in movable]
        self.placed += [("terraces", len(ts)),
                        ("terrace pairs still matching", len(same)),
                        ("terraces with no free colour", forced)]
        self.placed += [(f"terrace {k}", v) for k, v in sorted(changed.items())]
        assert not unforced, (f"{len(unforced)} touching terraces share a "
                              f"ground with a colour free: "
                              f"{[(ts[i][0], ts[j][0], colour[i]) for i, j in unforced[:5]]}")

    def ramp_paths(self):
        """A ramp is where you walk: light_soil, the road's own material,
        so the way up is a visible path and never grass climbing grass."""
        n = 0
        for r in self.doc.get("ramps", []):
            for c in r.get("cells", []):
                x, y = c["x"], c["y"]
                if self.g(x, y) in ("grass", "snow"):
                    self.grd[y][x] = self.gi["light_soil"]
                    n += 1
        self.placed += [("ramp cells paved", n)]

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


    def widen_roads(self):
        """A ROAD NARROWER THAN THREE CELLS CANNOT RENDER AS A ROAD.

        The boundary system is corner-Wang: a drawn tile blends the four
        cells at its corners, so only a cell whose whole 2x2 quad is road
        comes out SOLID. A one-cell-wide road has no such quad anywhere - it
        is blend tiles end to end, and the mask eats it from both sides into
        disconnected blobs (maintainer, 2026-08-30: "why is this so ugly?").
        Measured before this pass: 54 road runs one cell wide, 34 two cells,
        and only 29% of the road area rendered solid.

        So every road cell that is narrow on BOTH axes is dilated onto the
        grass beside it, at its own level, never over paving, water, mud or a
        building floor."""
        gi, grd, lvl = self.gi, self.grd, self.lvl
        soil = gi["light_soil"]
        KEEP = {gi[g] for g in ("grass",) if g in gi}
        total = 0
        for _ in range(4):
            road = [(x, y) for y in range(NEW) for x in range(NEW)
                    if grd[y][x] == soil]
            roadset = set(road)

            def run(x, y, dx, dy):
                n = 1
                for s_ in (1, -1):
                    k = 1
                    while (x + dx * k * s_, y + dy * k * s_) in roadset:
                        n += 1
                        k += 1
                return n

            # WIDTH IS THE SMALLER RUN, not both. A road running north has an
            # x-run of 1 and a y-run of twenty - it is one cell WIDE, and
            # requiring both runs to be short skipped every straight road on
            # the map (45 of them).
            narrow = [c for c in road
                      if min(run(c[0], c[1], 1, 0), run(c[0], c[1], 0, 1)) < 3]
            if not narrow:
                break
            added = 0
            for (x, y) in narrow:
                z = lvl[y][x]
                got = 0
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if not (0 <= nx < NEW and 0 <= ny < NEW):
                        continue
                    # grass beside the road becomes road, and takes the ROAD's
                    # level: a widened lane at the neighbour's height would
                    # just add another wall across the way
                    if grd[ny][nx] in KEEP and abs(lvl[ny][nx] - z) <= 2:
                        grd[ny][nx] = soil
                        lvl[ny][nx] = z
                        added += 1
                        got += 1
                        if got == 2:
                            break
            total += added
            if not added:
                break
        self.placed += [("road cells widened", total)]

    # -- ramps ----------------------------------------------------------------
    def ramps(self):
        """RAMPS: the authored way up (maintainer 2026-08-30, "slope for
        making it look better when building ramps/paths that go up hill").

        A road crossing a bench changes level in ONE step - 22 of the 41 road
        level changes on this map were 4-bench jumps, a 68px cliff the player
        was expected to walk up. The fix is a MAX-SLOPE RELAXATION over the
        road graph alone: while any two adjacent road cells differ by more
        than one level, move both toward each other by one. It converges to a
        road every step of which is walkable, cut into the hill where it must
        be and banked up where it must be, and it never touches a cell that
        is not road.

        Then every maximal run of road cells whose level actually changes is
        published in the world's `ramps` channel, so the game can make the
        climb walkable without inferring where a climb is legal."""
        gi, lvl = self.gi, self.lvl
        soil = gi["light_soil"]
        road = [(x, y) for y in range(NEW) for x in range(NEW)
                if self.grd[y][x] == soil]
        roadset = set(road)
        moved = 0
        for _ in range(64):
            changed = 0
            for (x, y) in road:
                for dx, dy in ((1, 0), (0, 1)):
                    n = (x + dx, y + dy)
                    if n not in roadset:
                        continue
                    a, b = lvl[y][x], lvl[n[1]][n[0]]
                    if abs(a - b) <= 1:
                        continue
                    if a > b:
                        lvl[y][x] -= 1
                        lvl[n[1]][n[0]] += 1
                    else:
                        lvl[y][x] += 1
                        lvl[n[1]][n[0]] -= 1
                    changed += 2
            moved += changed
            if not changed:
                break
        # SMOOTH THE PROFILE, THEN RE-ENFORCE THE SLOPE. The pairwise
        # relaxation alone converges to "no step over one level" but leaves a
        # SAWTOOTH: a road that goes up-down-up-down is walkable and looks
        # terrible, because every one of those steps draws a wall and chops
        # the road into stepped slabs (maintainer, 2026-08-30: "why is this
        # so ugly?" - 11 overlapping ramps, some 3->6 and some 6->3, over the
        # same four cells). A median over each cell's road neighbourhood
        # removes the local pits and spikes; the slope pass then runs again
        # because smoothing can reintroduce a jump.
        for _ in range(8):
            changed = 0
            for (x, y) in road:
                nb = [lvl[y + dy][x + dx]
                      for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
                      if (x + dx, y + dy) in roadset]
                if len(nb) < 2:
                    continue
                nb.sort()
                med = nb[len(nb) // 2]
                if lvl[y][x] != med and abs(lvl[y][x] - med) <= 2:
                    lvl[y][x] = med
                    changed += 1
            if not changed:
                break
        for _ in range(64):
            changed = 0
            for (x, y) in road:
                for dx, dy in ((1, 0), (0, 1)):
                    n = (x + dx, y + dy)
                    if n not in roadset:
                        continue
                    a, b = lvl[y][x], lvl[n[1]][n[0]]
                    if abs(a - b) <= 1:
                        continue
                    if a > b:
                        lvl[y][x] -= 1
                        lvl[n[1]][n[0]] += 1
                    else:
                        lvl[y][x] += 1
                        lvl[n[1]][n[0]] -= 1
                    changed += 2
            if not changed:
                break

        # the runs: maximal 4-connected chains of road cells that change level
        seen, runs = set(), []
        for (x, y) in road:
            if (x, y) in seen:
                continue
            climb = [n for n in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1))
                     if n in roadset and lvl[n[1]][n[0]] != lvl[y][x]]
            if not climb:
                continue
            # walk the chain in both directions while the level keeps changing
            chain = [(x, y)]
            for step in (0, 1):
                cur = (x, y)
                while True:
                    nxt = None
                    for n in ((cur[0] + 1, cur[1]), (cur[0] - 1, cur[1]),
                              (cur[0], cur[1] + 1), (cur[0], cur[1] - 1)):
                        if n in roadset and n not in chain \
                                and abs(lvl[n[1]][n[0]] - lvl[cur[1]][cur[0]]) == 1:
                            nxt = n
                            break
                    if not nxt:
                        break
                    chain.append(nxt) if step else chain.insert(0, nxt)
                    cur = nxt
            if len(chain) < 2:
                continue
            seen.update(chain)
            # SPLIT AT TURNING POINTS: a run must be a monotone climb, or the
            # published from/to lie about what is between them (a chain that
            # rose 9->6 via 3 up-steps and 3 down-steps was one "ramp")
            ls = [lvl[c[1]][c[0]] for c in chain]
            cut = [0]
            for i in range(1, len(ls) - 1):
                if (ls[i] - ls[i - 1]) * (ls[i + 1] - ls[i]) < 0:
                    cut.append(i)
            cut.append(len(chain) - 1)
            for a, b in zip(cut, cut[1:]):
                seg = chain[a:b + 1]
                if len(seg) < 2:
                    continue
                runs.append({
                    "from": lvl[seg[0][1]][seg[0][0]],
                    "to": lvl[seg[-1][1]][seg[-1][0]],
                    "ground": "light_soil",
                    "cells": [{"x": c[0], "y": c[1]} for c in seg],
                })
        self.doc["ramps"] = runs
        # THE CONTRACT IS BUILD-ASSERTED, because the game implements
        # walkability from it: every run is 4-connected, monotone, and every
        # step is exactly one level.
        for r in runs:
            cs = r["cells"]
            assert len(cs) >= 2, "a ramp run needs at least two cells"
            d0 = None
            for a, b in zip(cs, cs[1:]):
                assert abs(a["x"] - b["x"]) + abs(a["y"] - b["y"]) == 1, \
                    f"ramp run not 4-connected at {a}"
                d = lvl[b["y"]][b["x"]] - lvl[a["y"]][a["x"]]
                assert abs(d) == 1, f"ramp step of {d} levels at {a}"
                assert d0 is None or d == d0, f"ramp run not monotone at {a}"
                d0 = d
            assert r["from"] == lvl[cs[0]["y"]][cs[0]["x"]]
            assert r["to"] == lvl[cs[-1]["y"]][cs[-1]["x"]]
        self.placed += [("ramps", len(runs)), ("ramp level moves", moved)]

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
                     self.terrace_grounds,
                     self.build_no_place, self.interiors, self.village,
                     self.roads, self.nature, self.dress_islets,
                     self.retype, self.widen_roads, self.ramps,
                     self.ramp_paths,
                     self.snap_hitboxes, self.police_footprints,
                     self.relight, self.npcs,
                     self.rooms, self.spawns):
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
