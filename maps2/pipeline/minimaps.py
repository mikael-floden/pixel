"""Normalize map images across ALL worlds (maintainer 2026-07-23).

Every maps2 world ships exactly ONE map-tab image, `minimap.png`: the isometric
view with all NON-MAP pixels transparent (the game draws it under the Map tab).
This backfills/refreshes it for every world FROM its committed world.json — no
world regeneration, so nothing about the terrain can change — and deletes the old
ad-hoc names (demo.png / preview.png / overview.png) that made worlds.json's
preview field inconsistent.

    python maps2/pipeline/minimaps.py                 # all worlds
    python maps2/pipeline/minimaps.py the_island2 ...  # only the named ones

`the_island2` keeps the richer minimap its own builder writes (with bridges and
props); pass --force to overwrite it from world.json too.
"""

from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

import worldio                                    # noqa: E402
from render2 import render_overview, save_minimap  # noqa: E402

MAPS2 = os.path.dirname(_HERE)
WORLDS = os.path.join(MAPS2, "worlds")
STALE = ("demo.png", "preview.png", "overview.png",
         "demo.webp", "preview.webp", "overview.webp")
# worlds whose own builder writes a richer minimap (props/decks) — don't clobber
BUILDER_OWNS = {"the_island2"}


def refresh(name: str, force: bool = False):
    d = os.path.join(WORLDS, name)
    wpath = os.path.join(d, "world.json")
    if not os.path.isfile(wpath):
        return
    if name in BUILDER_OWNS and not force and os.path.isfile(os.path.join(d, "minimap.webp")):
        print(f"{name}: keep builder minimap")
    else:
        world = worldio.load_world(wpath)
        save_minimap(d, render_overview(world, scale=0.5, transparent=True))
        print(f"{name}: minimap.webp ({world.W}x{world.H})")
    for s in STALE:                               # drop the old inconsistent names
        p = os.path.join(d, s)
        if os.path.isfile(p):
            os.remove(p)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    force = "--force" in sys.argv
    names = args or sorted(x for x in os.listdir(WORLDS)
                           if os.path.isdir(os.path.join(WORLDS, x)))
    for name in names:
        refresh(name, force=force)


if __name__ == "__main__":
    main()
