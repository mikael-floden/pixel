"""The world data model: the persistent, human-readable source of truth.

A world is a rectangular grid of cells. Each cell records what terrain sits
there, which variant tile to draw, its elevation level, and an optional
role/label so the designer can reason about regions ("this is the castle
courtyard", "this is a road") on later passes.

The model is deliberately plain JSON so a human can read a diff, the designer
can grow/edit it incrementally, and rendering stays a pure function of the
data. Nothing here draws pixels (see render.py) or invents design (designer.py).
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field

SCHEMA = "pixel-maps/world@1"


@dataclass
class Cell:
    # terrain category id from the tiles library (e.g. "grass", "water").
    terrain: str = "water"
    # which variant tile within that category (wraps on render).
    variant: int = 0
    # elevation level: 0 = ground/sea level. Each level raises the surface by
    # one tile-thickness (stacked 64x64 blocks), ALTTP-style terracing.
    level: int = 0
    # semantic role for the designer's later passes; does not affect rendering
    # directly but records intent ("road", "wall", "castle_floor", "beach", ...).
    role: str = "ground"
    # optional object id from the objects domain to place on this cell.
    object: str | None = None

    def to_json(self) -> dict:
        d = {"t": self.terrain, "v": self.variant, "l": self.level}
        if self.role != "ground":
            d["r"] = self.role
        if self.object:
            d["o"] = self.object
        return d

    @staticmethod
    def from_json(d: dict) -> "Cell":
        return Cell(
            terrain=d.get("t", "water"),
            variant=int(d.get("v", 0)),
            level=int(d.get("l", 0)),
            role=d.get("r", "ground"),
            object=d.get("o"),
        )


@dataclass
class Region:
    """A named design region, so later passes know a stretch of cells belongs
    together ("northern mountains", "harbor town") rather than treating the map
    as loose tiles. Purely metadata for the designer."""

    name: str
    kind: str            # plains | forest | mountains | beach | town | castle | water | snowfield
    cx: float
    cy: float
    notes: str = ""


class World:
    def __init__(self, width: int, height: int, seed: int = 1):
        self.width = width
        self.height = height
        self.seed = seed
        self.grid: list[list[Cell]] = [
            [Cell() for _ in range(width)] for _ in range(height)
        ]
        self.regions: list[Region] = []
        self.log: list[str] = []          # design history, newest last
        self.iteration = 0

    # -- access ---------------------------------------------------------------

    def in_bounds(self, x: int, y: int) -> bool:
        return 0 <= x < self.width and 0 <= y < self.height

    def at(self, x: int, y: int) -> Cell:
        return self.grid[y][x]

    def set(self, x: int, y: int, **kw) -> None:
        if not self.in_bounds(x, y):
            return
        c = self.grid[y][x]
        for k, val in kw.items():
            setattr(c, k, val)

    def cells(self):
        for y in range(self.height):
            for x in range(self.width):
                yield x, y, self.grid[y][x]

    # -- growth ---------------------------------------------------------------

    def extend(self, *, left=0, right=0, top=0, bottom=0, fill_terrain="water") -> None:
        """Grow the grid outward, filling new cells with open sea (or given
        terrain). Existing content shifts but keeps its relative layout so the
        designer can keep extending the world in any direction."""
        new_w = self.width + left + right
        new_h = self.height + top + bottom
        grid = [[Cell(terrain=fill_terrain) for _ in range(new_w)] for _ in range(new_h)]
        for y in range(self.height):
            for x in range(self.width):
                grid[y + top][x + left] = self.grid[y][x]
        self.grid = grid
        self.width, self.height = new_w, new_h
        for r in self.regions:
            r.cx += left
            r.cy += top

    # -- persistence ----------------------------------------------------------

    def to_json(self) -> dict:
        return {
            "schema": SCHEMA,
            "width": self.width,
            "height": self.height,
            "seed": self.seed,
            "iteration": self.iteration,
            "regions": [asdict(r) for r in self.regions],
            "log": self.log,
            "rows": [[c.to_json() for c in row] for row in self.grid],
        }

    def save(self, path: str) -> None:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump(self.to_json(), f, separators=(",", ":"))

    @staticmethod
    def load(path: str) -> "World":
        with open(path) as f:
            d = json.load(f)
        w = World(d["width"], d["height"], d.get("seed", 1))
        w.iteration = d.get("iteration", 0)
        w.log = d.get("log", [])
        w.regions = [Region(**r) for r in d.get("regions", [])]
        w.grid = [[Cell.from_json(c) for c in row] for row in d["rows"]]
        return w
