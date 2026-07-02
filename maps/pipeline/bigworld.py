"""Array-based world model for the MMORPG-scale map.

A world this size (512x448 = 229k cells) needs flat arrays, not Cell objects:
  terr    uint16  index into the category palette (tile category per cell)
  variant uint8   which tile within the category
  level   int8    terrain elevation 0..MAX (terraced)
  climate uint8   index into the climate palette (drives palette/roads/cliffs)

Saved as compact JSON (palette tables + row arrays of ints) so the game and
the renderer share one source of truth and diffs stay reviewable.
"""

from __future__ import annotations

import json
import os

import numpy as np


class BigWorld:
    def __init__(self, w: int, h: int, seed: int = 1):
        self.w, self.h, self.seed = w, h, seed
        self.cats: list[str] = ["water"]          # palette of category names
        self._cat_idx = {"water": 0}
        self.climates: list[str] = ["sea"]
        self._cli_idx = {"sea": 0}
        self.terr = np.zeros((h, w), dtype=np.uint16)
        self.variant = np.zeros((h, w), dtype=np.uint8)
        self.level = np.zeros((h, w), dtype=np.int8)
        self.climate = np.zeros((h, w), dtype=np.uint8)
        self.pois: list[dict] = []
        self.log: list[str] = []

    def cat(self, name: str) -> int:
        if name not in self._cat_idx:
            self._cat_idx[name] = len(self.cats)
            self.cats.append(name)
        return self._cat_idx[name]

    def cli(self, name: str) -> int:
        if name not in self._cli_idx:
            self._cli_idx[name] = len(self.climates)
            self.climates.append(name)
        return self._cli_idx[name]

    def save(self, path: str) -> None:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        d = {
            "schema": "pixel-maps/bigworld@1",
            "w": self.w, "h": self.h, "seed": self.seed,
            "categories": self.cats,
            "climates": self.climates,
            "pois": self.pois,
            "log": self.log,
            "terr": [r.tolist() for r in self.terr],
            "variant": [r.tolist() for r in self.variant],
            "level": [r.tolist() for r in self.level],
            "climate": [r.tolist() for r in self.climate],
        }
        with open(path, "w") as f:
            json.dump(d, f, separators=(",", ":"))

    @staticmethod
    def load(path: str) -> "BigWorld":
        d = json.load(open(path))
        w = BigWorld(d["w"], d["h"], d.get("seed", 1))
        w.cats = d["categories"]
        w._cat_idx = {c: i for i, c in enumerate(w.cats)}
        w.climates = d["climates"]
        w._cli_idx = {c: i for i, c in enumerate(w.climates)}
        w.pois = d.get("pois", [])
        w.log = d.get("log", [])
        w.terr = np.array(d["terr"], dtype=np.uint16)
        w.variant = np.array(d["variant"], dtype=np.uint8)
        w.level = np.array(d["level"], dtype=np.int8)
        w.climate = np.array(d["climate"], dtype=np.uint8)
        return w
