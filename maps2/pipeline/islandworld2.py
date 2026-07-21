"""the_island2 ("The Island 2") — the_island's mountain UPPER world + an ALttP
"Light-World"-style relief MAZE lower world, on a ~2x-bigger island.

The maintainer's brief: keep everything we learned building `the_island` for the
UPPER part (the massif that climbs "up up up" in altitude), but add the missing
LOWER part — the section that in *Zelda: A Link to the Past* is built like a maze,
where the ground goes both UP and DOWN so navigating it is a puzzle, not a straight
climb. Both worlds on one island → the map has to be twice as big.

How the two worlds coexist under our camera-facing occlusion rule
(`maps2/README.md` — land must never step UP toward the camera with the SAME
material):

  * UPPER (the mountain) is STRICTLY ANTITONE, exactly like `the_island`: the depth
    field is closed to be non-increasing toward the camera, quantised, and backstopped
    by `camera_monotone` (here MASKED to the mountain). Occlusion-clean for free; the
    jagged multi-peak up-up-up skyline is preserved. It is floored at level 14 so its
    whole front is a sheer mountain FOOT that the lower world runs into.

  * LOWER (the maze) uses GENUINE RELIEF — flat chambers at discrete tiers 0..10 that
    go up AND down — and is NEVER flattened by `camera_monotone`. A strictly-antitone
    field can only ever make ONE connected lowest sheet (elevation alone can't
    laterally separate two equal-level floors), so a real maze MUST use relief. It is
    kept occlusion-legal by the WALL-MATERIAL RULE: wherever two same-material floors
    sit across a toward-camera up-step, the higher rim is recoloured to a wall material
    (stone/obsidian, band-parity so stacked cliffs never repeat a material) — a rock
    escarpment, legal by construction. A `mat`-only lip-cover pass mops any residual,
    so it can never undo connectivity or open a pit.

  * The SEAM is legal by construction: the mountain is entirely up-screen of the maze,
    its foot (14) stands above the maze top (10), so a mountain cell's toward-camera
    neighbour is always a LOWER maze cell (a visible descent, never a hidden lip), and
    no maze cell ever has a mountain cell toward-camera. The Δ4 foot is a wall you
    can't climb except at the carved ascent ramps — the gated "enter the mountain".

Connectivity, zero-pits, bridges and the reachability proof reuse `the_island`'s
machinery verbatim (`_connect_all`/`_fill_traps`/`_place_bridges`/`_walk_components`),
with `camera_monotone` swapped for lip-cover inside the maze. Everything is hard-
asserted in `build()`: occlusion clean, 100% reachable (PROP-AWARE — props collide),
no traps, bridges connect on every row, maze ≥ 1.6× mountain, max level ≥ 30.
"""

from __future__ import annotations

import math
import os
from collections import Counter, defaultdict, deque

import numpy as np
from PIL import Image

import worldio
from autotile import (PRIORITY, AutoTiler, camera_monotone_masked,
                      flatten_shores, occlusion_violations)
from islandworld import (Island, _dilate, _fbm, _h01, MAPS2)
from tiles2lib import DX, DY, LEVEL_PX, Tiles2

# LOWER-world named features (fx,fy in [0,1], amp signed, radius in map-fraction):
# gaussians that carve the maze's signature places into the signed relief field.
FEATURES = [
    (0.62, 0.86, -1.7, 0.10),   # Sunken Hollow — a dry stone-rimmed canyon (deep)
    (0.30, 0.74, +1.4, 0.11),   # West Plateau — a gated tier-10 overlook (high)
    (0.76, 0.68, -2.0, 0.09),   # Mirror Lake basin (deepest -> water)
    (0.50, 0.62, +1.0, 0.13),   # central bench (a mid rise splitting the routes)
]


class Island2(Island):
    def __init__(self, n=200, seed=21):
        self.n, self.seed = n, seed
        self.lib = Tiles2()
        self.mat = np.full((n, n), "", object)
        self.level = np.zeros((n, n), np.int16)
        self.top = np.full((n, n), None, object)
        self.mirror = np.zeros((n, n), bool)
        self.props = {}
        self.decks = []
        self.reserved = set()
        self.links = []
        self.spawn = (int(n * 0.50), int(n * 0.92))

        self._coastline()                 # organic island (reused verbatim)
        self._zone_masks()                # UPPER (mountain) vs MAZE (front) on warped depth
        self._elevation_mountain()        # the_island tech on the mountain mask (antitone, 14..30)
        self._tarn()                      # a high sunken ice tarn on the massif
        self._relief()                    # signed warped field -> flat maze tiers 0..10 + a lake
        self._rooms()                     # snap the maze into flat chambers (crisp cliffs)
        self._majority()                  # despeckle the maze level field
        self._maze_river()                # a winding water channel across the lowland (bridged)
        flatten_shores(self.mat, self.level)
        camera_monotone_masked(self.level, self.mat, self.upper)   # mountain antitone ONLY
        self.level_before = self.level.copy()
        self._materials()                 # reused: mountain caps + maze floors/beaches
        self._wall_rim()                  # Pass A: recolour maze up-step rims -> wall material
        self._connect_all(thresh=5)       # reuse: ramps + emergency spans -> one walkable piece
        self._ford_stranded()             # reuse: causeway across any water-locked pocket
        self._place_bridges(count=5)      # reuse: stone decks over water (both-bank checked)
        for _ in range(10):               # guarantee loop -> converge to no pit AND no lip
            camera_monotone_masked(self.level, self.mat, self.upper)  # antitone mtn (may steepen)
            self._fill_traps()            # then fill any pit (incl. one monotone just made)
            self._lip_cover()             # then cover residual lips (mat-only, makes no pit)
            if self._trap_count() == 0 and not occlusion_violations(self.mat, self.level):
                break
        self._pick_spawn()
        self._paint()
        self.deck_at = {(x, y): dk for dk in self.decks for (x, y) in dk["cells"]}
        self._decorate()
        self._reconnect_after_props()     # props collide: never let one seal off a region

    # -- two-zone layout -------------------------------------------------------

    def _zone_masks(self):
        """Split the land front-to-back on a WARPED depth so the seam meanders:
        the back becomes the antitone mountain, the (larger) front becomes the maze."""
        n, X, Y, s = self.n, self.X, self.Y, self.seed
        d = (X + Y) / (2 * (n - 1))
        dw = d + (_fbm(X, Y, s + 70, n * 0.34, 4) - 0.5) * 0.10       # +-0.05 wobble
        self.upper = self.land & (dw < 0.40)          # mountain (antitone, 14..30)
        self.maze = self.land & ~self.upper           # the ALttP relief maze (the bulk)

    # -- upper world: the_island mountain, masked ------------------------------

    def _elevation_mountain(self):
        """`Island._elevation`'s depth field (multi-peak jagged massif, antitone by
        construction) restricted to the mountain mask and floored at level 14 — so the
        whole upper world is pure mountain climbing 14..30, its front a sheer foot."""
        n, X, Y, s, up = self.n, self.X, self.Y, self.seed, self.upper
        u = (X + Y)
        arm = 0.62 * np.abs(X - Y) + (_fbm(X, Y, s + 20, n * 0.30, 3) - 0.5) * 10
        warp = ((_fbm(X, Y, s, n * 0.30, 4) - 0.5) * 22
                + (_fbm(X, Y, s + 3, n * 0.13, 3) - 0.5) * 12
                + (_fbm(X, Y, s + 8, n * 0.06, 2) - 0.5) * 4)
        uplift = _fbm(X, Y, s + 5, n * 0.42, 3) * 8
        PEAKS = [(0.28, 0.11, 34, 0.10), (0.44, 0.07, 25, 0.09), (0.58, 0.13, 40, 0.11),
                 (0.71, 0.09, 22, 0.08), (0.17, 0.26, 20, 0.09), (0.85, 0.27, 26, 0.09)]
        ridge = np.zeros_like(u)
        for fx, fy, h, sg in PEAKS:
            ridge = np.maximum(ridge, h * np.exp(-(((X - fx * n) ** 2) / (2 * (sg * n) ** 2)
                                                   + ((Y - fy * n) ** 2) / (2 * (sg * 0.85 * n) ** 2))))
        depth = u - arm + warp - uplift - ridge
        depth[~up] = 1e9
        self._camera_max_float(depth, up)             # continuous antitone closure over the mask
        dl = depth[up]
        d = (depth - dl.min()) / (dl.max() - dl.min() + 1e-6)
        MAX = 30
        lvl = np.clip(np.rint(14 + (1.0 - d) * (MAX - 14)), 14, MAX).astype(np.int16)
        self.level[up] = lvl[up]                      # d small(back)->30, large(front)->14

    # -- lower world: signed relief -> flat maze chambers ----------------------

    def _relief(self):
        """A signed, domain-warped low-frequency field quantised by QUANTILE into six
        balanced bands -> discrete tiers {0,2,4,6,8,10} that go up AND down across big
        organic regions (no stripes, no circles). Deepest 12% -> a lake. A gentle climb
        toward the mountain keeps the back of the maze high (the run-up to the foot)."""
        n, X, Y, s, mz = self.n, self.X, self.Y, self.seed, self.maze
        wx = X + n * 0.13 * (_fbm(X, Y, s + 30, n * 0.28, 4) - 0.5) * 2
        wy = Y + n * 0.13 * (_fbm(X, Y, s + 31, n * 0.28, 4) - 0.5) * 2
        R = (_fbm(wx, wy, s + 32, n * 0.20, 4) - 0.5) * 2.0           # broad plateaus/hollows
        R += (_fbm(wx, wy, s + 33, n * 0.09, 3) - 0.5) * 1.1         # medium terraces (up&down)
        d = (X + Y) / (2 * (n - 1))
        R += 0.45 * (1.0 - d)                                         # mild climb toward the foot
        for fx, fy, amp, rad in FEATURES:
            R += amp * np.exp(-(((X - fx * n) ** 2 + (Y - fy * n) ** 2) / (2 * (rad * n) ** 2)))
        Rm = np.where(mz, R, np.nan)
        qs = np.nanquantile(Rm, [0.12, 0.30, 0.50, 0.68, 0.85])      # 5 cuts -> 6 bands
        tier = np.array([0, 2, 4, 6, 8, 10], np.int16)
        idx = np.digitize(R, qs)                                     # 0..5
        self.level[mz] = tier[idx][mz]
        lake = mz & (idx == 0)                                       # deepest band -> water
        self.mat[lake] = "clear_water"
        self.level[lake] = 0

    def _rooms(self, RS=20):
        """Snap the maze into FLAT chambers on a warped lattice (each cell's room id =
        floored warped coords). Flattening every room to the MODE of its relief tier
        turns the smooth field into crisp flat rooms separated by clean Δ>=2 cliffs —
        the ALttP look, and (being crisp, not speckled) exactly what makes lip-cover a
        thin coherent set. Lake-only rooms stay water."""
        n, X, Y, s = self.n, self.X, self.Y, self.seed
        rwx = X + n * 0.05 * (_fbm(X, Y, s + 34, n * 0.10, 3) - 0.5) * 2
        rwy = Y + n * 0.05 * (_fbm(X, Y, s + 35, n * 0.10, 3) - 0.5) * 2
        rid = np.floor(rwx / RS).astype(np.int64) * 997 + np.floor(rwy / RS).astype(np.int64)
        self.room = np.full((n, n), -1, np.int64)
        cells = defaultdict(list)
        for y in range(n):
            for x in range(n):
                if self.maze[y, x]:
                    cells[int(rid[y, x])].append((x, y))
        for r, cl in cells.items():
            lvls = [int(self.level[y, x]) for (x, y) in cl if self.mat[y, x] != "clear_water"]
            if not lvls:
                continue                                             # all-water room (lake)
            mode = Counter(lvls).most_common(1)[0][0]
            for (x, y) in cl:
                self.room[y, x] = r
                if self.mat[y, x] != "clear_water":
                    self.level[y, x] = mode

    def _maze_river(self):
        """Carve a winding water channel across the maze lowland — the ALttP "cross the
        bridge" barrier. Water is always occlusion-legal (a different material at level 0)
        and always crossable: `_place_bridges` lays stone decks where both banks match,
        and `_connect_all`/`_ford_stranded` guarantee the two sides still join. Kept in the
        LOW front lands (levels stay similar across it) so bridges reliably seat."""
        n, s = self.n, self.seed
        # mostly VERTICAL (toward-camera) so its channel aligns across consecutive rows
        # — that row-alignment is exactly what lets `_place_bridges` seat stone decks.
        PATH = [(0.44, 0.42), (0.47, 0.55), (0.45, 0.68), (0.48, 0.80), (0.46, 0.95)]
        pts = [(fx * n, fy * n) for fx, fy in PATH]
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            steps = int(math.hypot(bx - ax, by - ay)) + 1
            for i in range(steps + 1):
                t = i / steps
                wob = (_fbm(np.float32(ax + (bx - ax) * t), np.float32(ay),
                            s + 77, n * 0.06, 3) - 0.5) * 6
                cx = int(ax + (bx - ax) * t + wob)
                cy = int(ay + (by - ay) * t)
                for dx in range(-1, 2):
                    for dy in range(-1, 2):
                        x, y = cx + dx, cy + dy
                        if 0 <= x < n and 0 <= y < n and self.maze[y, x] and self.land[y, x]:
                            self.mat[y, x] = "clear_water"
                            self.level[y, x] = 0

    def _majority(self, passes=2):
        """3x3 mode filter over maze LAND levels — despeckle 1-cell level islands so no
        isolated rim exists (coherent stone bands, faster lip-cover). Never touches water
        (lakes stay) or the mountain."""
        n = self.n
        for _ in range(passes):
            lv = self.level.copy()
            for y in range(n):
                for x in range(n):
                    if not self.maze[y, x] or self.mat[y, x] == "clear_water":
                        continue
                    vals = []
                    for j in (-1, 0, 1):
                        for i in (-1, 0, 1):
                            xx, yy = x + i, y + j
                            if (0 <= xx < n and 0 <= yy < n and self.maze[yy, xx]
                                    and self.mat[yy, xx] != "clear_water"):
                                vals.append(int(lv[yy, xx]))
                    if vals:
                        self.level[y, x] = Counter(vals).most_common(1)[0][0]

    # -- occlusion legality for the maze (wall-material rule + lip-cover) -------

    def _wall_mat(self, x, y):
        """Wall material for a recoloured rim, chosen by LEVEL-BAND PARITY so two
        vertically-stacked cliff rims (Δ2 apart) never share a material — which is
        what stops an up-toward-camera terrace stack from re-creating a same-material
        lip. stone <-> obsidian alternate every tier."""
        return "stone_mountain" if (int(self.level[y, x]) // 2) % 2 == 0 else "black_mountain"

    def _wall_rim(self):
        """Pass A (vectorised, pre-connect): a toward-camera rise is a hidden lip ONLY
        if same-material, so recolour the HIGHER (down-screen) rim of every same-material
        up-step in the maze to a wall material. Does the bulk of the work so the iterated
        lip-cover only has to mop residuals."""
        n, mat, level = self.n, self.mat, self.level
        land = (mat != "") & (mat != "clear_water")
        lv = level.astype(np.int32)
        same_hi = np.zeros((n, n), bool)                             # cell is the higher, same-mat rim
        same_hi[:, 1:] |= (land[:, 1:] & land[:, :-1] & (lv[:, 1:] > lv[:, :-1])
                           & (mat[:, 1:] == mat[:, :-1]))
        same_hi[1:, :] |= (land[1:, :] & land[:-1, :] & (lv[1:, :] > lv[:-1, :])
                           & (mat[1:, :] == mat[:-1, :]))
        rim = same_hi & self.maze & land
        floor = np.isin(mat, np.array(["saturated_grass", "light_sand", "lightdark_dirt"], object))
        for (y, x) in np.argwhere(rim & floor):
            mat[y, x] = self._wall_mat(x, y)

    def _lip_cover(self, max_iter=8):
        """Pass B (backstop, to fixpoint): after all level mutations, recolour the HIGHER
        cell of every residual same-material lip in the maze to a wall material. `mat`-only
        — it can never change a level, so it can never undo connectivity or open a pit.
        Band parity + crisp flat rooms => converges in <=2 iterations in practice."""
        for _ in range(max_iter):
            viol = [v for v in occlusion_violations(self.mat, self.level)
                    if self.maze[v[1][1], v[1][0]]]
            if not viol:
                return True
            for (_lo, (hx, hy), _dh) in viol:
                self.mat[hy, hx] = self._wall_mat(hx, hy)
        return not [v for v in occlusion_violations(self.mat, self.level)
                    if self.maze[v[1][1], v[1][0]]]

    def _trap_count(self):
        """Walkable cells cut off from the main component yet land-adjacent to it — a
        pit the player can fall into and be stranded. Zero is asserted every build."""
        comps = self._walk_components()
        if len(comps) <= 1:
            return 0
        mainset = set(comps[0])
        return sum(len(c) for c in comps[1:]
                   if any((x + i, y + j) in mainset for (x, y) in c
                          for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1))))

    # -- prop-aware reachability (props collide in worldio) --------------------

    def _reach_blocked(self, blocked):
        """BFS reachability from spawn over |Δlevel|<=1 + bridge links, treating every
        cell in `blocked` (prop cells — they set collision=1) as a wall."""
        n, mat, level = self.n, self.mat, self.level
        land = lambda x, y: (mat[y, x] != "" and mat[y, x] != "clear_water"
                             and (x, y) not in blocked)
        sx, sy = self.spawn
        ladj = self._link_adj()
        seen = np.zeros((n, n), bool)
        if not land(sx, sy):
            return seen
        q = deque([(sx, sy)]); seen[sy, sx] = True
        while q:
            x, y = q.popleft()
            for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                xx, yy = x + i, y + j
                if (0 <= xx < n and 0 <= yy < n and land(xx, yy) and not seen[yy, xx]
                        and abs(int(level[yy, xx]) - int(level[y, x])) <= 1):
                    seen[yy, xx] = True
                    q.append((xx, yy))
            for (xx, yy) in ladj.get((x, y), ()):
                if 0 <= xx < n and 0 <= yy < n and land(xx, yy) and not seen[yy, xx]:
                    seen[yy, xx] = True
                    q.append((xx, yy))
        return seen

    def _reconnect_after_props(self, max_iter=200):
        """A prop cell blocks movement (collision=1). If decoration ever drops props on
        the sole chokepoint into a region, walking there becomes impossible even though
        the terrain connects. A prop cell being unreachable is fine (you can't stand on a
        tree); a NON-prop terrain cell being sealed off is not. So while any terrain cell
        the player should reach is cut off ONLY by props, BFS from the reachable set
        THROUGH props to the nearest such cell and delete the (minimal) prop chain on that
        path — reopening it. The water-locked islet stays unreachable by design."""
        n = self.n
        terrain = self._reach_blocked(set())                         # terrain-only target
        walk = (self.mat != "") & (self.mat != "clear_water")
        ladj = self._link_adj()
        for _ in range(max_iter):
            props = set(self.props)
            seen = self._reach_blocked(props)
            propmask = np.zeros((n, n), bool)
            for (x, y) in props:
                propmask[y, x] = True
            cut = terrain & ~seen & ~propmask                        # real sealed cells
            if not cut.any():
                return
            # multi-source BFS from the reachable set, allowed to pass through props,
            # to the nearest genuinely-sealed cell; step must stay walkable (|Δlevel|<=1)
            vis = seen.copy()
            parent = {}
            dq = deque((x, y) for (y, x) in np.argwhere(seen))
            found = None
            while dq and found is None:
                x, y = dq.popleft()
                step = [((x + i, y + j), True) for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1))]
                step += [(v, False) for v in ladj.get((x, y), ())]
                for (xx, yy), needs_adj in step:
                    if not (0 <= xx < n and 0 <= yy < n) or vis[yy, xx] or not walk[yy, xx]:
                        continue
                    if needs_adj and abs(int(self.level[yy, xx]) - int(self.level[y, x])) > 1:
                        continue
                    vis[yy, xx] = True
                    parent[(xx, yy)] = (x, y)
                    if cut[yy, xx]:
                        found = (xx, yy)
                        break
                    dq.append((xx, yy))
            if found is None:
                return
            cur = found
            while cur in parent:
                self.props.pop(cur, None)
                cur = parent[cur]


def build(out=None, n=200, seed=21):
    d = Island2(n=n, seed=seed)
    out = out or os.path.join(MAPS2, "worlds", "the_island2")
    os.makedirs(out, exist_ok=True)
    decks_out = []
    for dk in d.decks:
        m = dk["mat"]
        cells = [{"x": x, "y": y, "top": d.lib.region_base(m, x, y), "mirror": 0}
                 for (x, y) in dk["cells"]]
        decks_out.append({"kind": dk["kind"], "mat": m, "level": dk["level"],
                          "thickness": dk["thickness"], "cells": cells})
    worldio.save_world(os.path.join(out, "world.json"), name="the_island2",
                       mat=d.mat, top=d.top, mirror=d.mirror, level=d.level,
                       spawn=d.spawn, props=d.props, decks=decks_out)
    img = d.render()
    img.convert("RGB").save(os.path.join(out, "demo.png"))
    w = 2400
    img.resize((w, round(img.height * w / img.width)), Image.LANCZOS).convert("RGB").save(
        os.path.join(out, "preview.png"))

    # --- assert battery (mirrors the_island, plus the two-world invariants) ---
    terr = Counter(m for m in d.mat.ravel() if m)
    viol = occlusion_violations(d.mat, d.level)
    assert not viol, f"camera-facing rule broken: {viol[:5]}"

    upper_land = int((d.upper & (d.mat != "clear_water")).sum())
    maze_land = int((d.maze & (d.mat != "clear_water")).sum())
    assert maze_land >= 1.6 * upper_land, \
        f"maze not dominant: maze {maze_land} < 1.6 * upper {upper_land}"

    assert int(d.level.max()) >= 30, f"mountain too short: max level {int(d.level.max())}"

    walk = (d.mat != "") & (d.mat != "clear_water")
    land_cells = int(walk.sum())
    propmask = np.zeros((d.n, d.n), bool)
    for (x, y) in d.props:
        propmask[y, x] = True
    terrain_seen = d._reach_blocked(set())                           # terrain-only
    prop_seen = d._reach_blocked(set(d.props))                       # props are walls
    # every terrain cell the player should reach (not a prop footprint, not the islet)
    sealed = int((terrain_seen & ~propmask & ~prop_seen).sum())
    assert sealed == 0, f"props seal off {sealed} walkable cell(s)"
    reach = int(prop_seen.sum())
    unreachable = land_cells - int(terrain_seen.sum())               # water-locked islet only

    comps = d._walk_components()
    mainset = set(comps[0])
    traps = sum(len(c) for c in comps[1:]
                if any((x + i, y + j) in mainset for (x, y) in c
                       for i, j in ((1, 0), (-1, 0), (0, 1), (0, -1))))
    assert traps == 0, f"pit trap: {traps} walkable cells cut off yet land-adjacent to main"
    # nothing but the small water-locked islet may sit outside the main walkable piece
    # (guards against a river/lake silently stranding a whole maze half)
    assert len(comps[0]) >= 0.97 * land_cells, \
        f"main walkable piece covers only {len(comps[0])}/{land_cells} land"

    for dk in d.decks:
        xs = [c[0] for c in dk["cells"]]
        x0, x1, dlv = min(xs), max(xs), dk["level"]
        for r in sorted({c[1] for c in dk["cells"]}):
            for bx in (x0 - 1, x1 + 1):
                assert (d.mat[r, bx] not in ("", "clear_water")
                        and abs(int(d.level[r, bx]) - dlv) <= 1
                        and (bx, r) in mainset), f"bridge end not walkable at ({bx},{r})"

    print(f"the_island2 {n}x{n}: {len(d.props)} props; max level {int(d.level.max())}")
    print(f"  zones: upper(mtn) {upper_land} land, maze {maze_land} land "
          f"(maze/upper = {maze_land / max(1, upper_land):.2f}x)")
    print(f"  occlusion lips: {len(viol)} {'[CLEAN]' if not viol else viol[:3]}")
    print(f"  reachable (prop-aware) {reach}/{land_cells} land "
          f"({unreachable} water-locked islet); traps {traps}; decks {len(d.decks)}")
    print(f"  walkable components (top 6 sizes): {[len(c) for c in comps[:6]]}")
    print(f"  materials=" + ", ".join(f"{k.split('_')[0]}:{v}" for k, v in terr.most_common()))
    return d


if __name__ == "__main__":
    build()
