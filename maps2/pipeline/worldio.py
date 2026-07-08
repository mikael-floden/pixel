"""Unified, loadable world format for every maps2 world (`pixel-maps2/world@1`).

A world.json is what makes a map *playable*: it carries everything a client needs
to render and walk the map without re-running the generator —

  * geometry (tile 64px, top diamond 30px, iso steps DX/DY, 16px per level);
  * a compact `paths` table (tile PNGs, repo-relative) + per-cell `top` index and
    `mirror` flag (the exact seamless tiles the generator chose);
  * per-cell `level` (elevation, in levels) and `mat` (material id via `materials`);
  * `collision` (1 = blocked: water, void, or a prop stands there);
  * `props` (elevation/landmark tiles) with their cell + path;
  * `spawn` and world `size`.

Deliberately engine-neutral: arrays are plain JSON so any renderer (the Phaser
client in moonlight, a Python viewer, tooling) can consume it. `save_world`
interns tile + prop paths; `load_world` reconstructs numpy grids for rendering.
"""

from __future__ import annotations

import json
import os

import numpy as np

from tiles2lib import DIAMOND_H, DX, DY, LEVEL_PX

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GEOMETRY = {"tile_px": 64, "diamond_h": DIAMOND_H, "dx": DX, "dy": DY,
            "level_px": LEVEL_PX}


def _rel(p: str) -> str:
    return os.path.relpath(p, REPO)


_emission_set: set | None = None


def emissive_paths() -> set:
    """Repo-relative paths of every self-emissive tile, per tiles2's authoritative
    emission.json (`sources` = tiles with an extracted night-glow cluster)."""
    global _emission_set
    if _emission_set is None:
        _emission_set = set()
        try:
            d = json.load(open(os.path.join(REPO, "tiles2", "emission.json")))
            _emission_set = set(d.get("sources", {}).keys())
        except Exception:
            pass
    return _emission_set


def _is_emissive(rel_path: str) -> bool:
    return rel_path in emissive_paths()


def save_world(path, *, name, mat, top, mirror=None, level=None, spawn,
               props=None, water=("clear_water",), meta=None):
    """Serialize a grid world to `path`.

    mat    : 2D array of material-id strings ("" = void).
    top    : 2D array of tile PNG paths (absolute) or None (void).
    mirror : 2D bool array (flip tile horizontally) or None.
    level  : 2D int array of elevation levels or None (flat).
    spawn  : (x, y) start cell.
    props  : dict {(x, y): path} or iterable of (x, y, path).
    """
    mat = np.asarray(mat, object)
    H, W = mat.shape
    level = np.zeros((H, W), int) if level is None else np.asarray(level, int)
    mirror = np.zeros((H, W), bool) if mirror is None else np.asarray(mirror, bool)
    waterset = set(water)

    # material legend: "" -> 0, then stable order of appearance
    mats = ["" ] + sorted({m for m in mat.ravel() if m})
    matid = {m: i for i, m in enumerate(mats)}

    paths: list[str] = []
    pidx: dict[str, int] = {}

    def intern(p):
        if p is None:
            return -1
        i = pidx.get(p)
        if i is None:
            i = len(paths)
            paths.append(_rel(p))
            pidx[p] = i
        return i

    top_ix = [[intern(top[y][x] if top[y][x] is not None else None)
               for x in range(W)] for y in range(H)]

    # props -> list, interning their (taller) tiles into the same table. `levels`
    # (parsed from base_x_N; 1 otherwise) is the prop's height in elevation levels
    # — a hint for occlusion/fade logic (how tall the occluder stands).
    def _levels(path):
        b = os.path.basename(os.path.dirname(path))
        if b.startswith("base_x_"):
            try:
                return int(b.split("base_x_")[1].split("_")[0])
            except (IndexError, ValueError):
                pass
        return 1

    prop_list = []
    prop_cell = set()
    if props:
        triples = (((k[0], k[1], v) for k, v in props.items())
                   if isinstance(props, dict) else props)
        for x, y, p in triples:
            prop_list.append({"x": int(x), "y": int(y), "tile": intern(p),
                              "levels": _levels(p)})
            prop_cell.add((int(x), int(y)))

    # collision: water, void, or a prop cell blocks
    collide = [[1 if (mat[y, x] == "" or mat[y, x] in waterset
                      or (x, y) in prop_cell) else 0
                for x in range(W)] for y in range(H)]

    # a playable spawn must be walkable: if it lands on a blocked cell (e.g. the
    # ring's water hub), snap to the nearest walkable one so the player isn't stuck
    sx, sy = int(spawn[0]), int(spawn[1])
    if not (0 <= sx < W and 0 <= sy < H) or collide[sy][sx]:
        best = None
        for y in range(H):
            for x in range(W):
                if not collide[y][x]:
                    d2 = (x - sx) ** 2 + (y - sy) ** 2
                    if best is None or d2 < best[0]:
                        best = (d2, x, y)
        if best:
            sx, sy = best[1], best[2]

    doc = {
        "schema": "pixel-maps2/world@1",
        "name": name,
        "geometry": GEOMETRY,
        "size": {"w": W, "h": H},
        "spawn": [sx, sy],
        "water": list(water),
        "materials": mats,
        "paths": paths,
        "mat": [[matid[mat[y, x]] for x in range(W)] for y in range(H)],
        "level": [[int(level[y, x]) for x in range(W)] for y in range(H)],
        "top": top_ix,
        "mirror": [[int(mirror[y, x]) for x in range(W)] for y in range(H)],
        "collision": collide,
        # which entries of `paths` are self-emissive (tiles2 features.shiny) — a
        # convenience so a consumer can light emissive cells without re-reading
        # tiles2 metadata: top[y][x] indexes paths; emissive[that index] == 1.
        "emissive": [1 if _is_emissive(p) else 0 for p in paths],
        "props": prop_list,
    }
    if meta:
        doc["meta"] = meta
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    return doc


class World:
    """Lightweight loaded world for rendering/verification (numpy grids)."""

    def __init__(self, d):
        self.schema = d["schema"]
        self.name = d.get("name", "")
        self.W = d["size"]["w"]
        self.H = d["size"]["h"]
        self.n = self.W                       # square worlds (ring) use n
        self.spawn = tuple(d["spawn"])
        self.materials = d["materials"]
        self.paths = [os.path.join(REPO, p) for p in d["paths"]]
        self.top = np.array(d["top"], np.int32)
        self.mirror = np.array(d["mirror"], bool)
        self.level = np.array(d["level"], np.int16)
        matarr = np.array(d["mat"], np.int32)
        inv = {i: m for i, m in enumerate(self.materials)}
        self.mat = np.vectorize(lambda i: inv[i])(matarr).astype(object)
        self.collision = np.array(d["collision"], np.uint8)
        self.emissive = d.get("emissive", [0] * len(self.paths))
        self.props = d.get("props", [])
        self.meta = d.get("meta", {})


def load_world(path) -> World:
    return World(json.load(open(path)))
