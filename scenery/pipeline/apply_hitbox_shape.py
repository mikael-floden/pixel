"""Publish each piece's DEFAULT hitbox shape: rect or ellipse.

WHY THE SHAPE IS IN THE OBJECT RECORD (maintainer 2026-08-30, to the wiki
agent: "town and indoor often have hitboxes that need a rect and not an
ellipse. Take a table or bookshelf ... will make it possible for me to do a
perfect hitbox on a bookshelf, bed, etc and the map-agent can then make use of
the perfect hitbox to place the furniture in a corner or against the wall").
The wiki agent's reply -- "the map agent can only use it if the shape is in the
record" -- is the contract change. Two records carry it:

  * THE HITBOX ITSELF, per box, in live/tuning/scenery_hitbox.json. That file
    belongs to the wiki; this domain only reads it. The box gains a `shape`
    field beside ax/ay/rx/ry/rot, "rect" or "ellipse", so one piece can mix
    the two if it ever needs to.
  * THE PIECE'S DEFAULT, here, published as `hitbox_shape` in viewer_data.json
    so the wiki opens a bookshelf already set to rect and maps2 has a shape to
    read even for a piece he has not hand-tuned yet.

THE RULE: rect where the footprint has flat sides and the piece is meant to sit
against a wall or in a corner -- furniture, built structures, crates, racks.
Ellipse for anything round or organic -- posts, barrels, wells, cairns, plants,
rocks. Where a group is genuinely mixed the ellipse is the safer default,
because an ellipse inside a rect footprint leaves a gap, while a rect around a
round object blocks tiles the player should be able to walk.

    python3 pipeline/apply_hitbox_shape.py --dry-run
    python3 pipeline/apply_hitbox_shape.py
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter

import factory
import viewer_build

# Flat-sided things that want a rectangle. Everything not named here defaults
# to an ellipse.
RECT_GROUPS = {
    # indoor furniture -- his own examples: table, bookshelf, bed
    "beds", "chairs_and_benches", "chess_tables", "cupboards_and_shelves",
    "hearths", "tables", "wall_hangings", "house_clutter", "rugs_and_hides",
    # built structures and boxy town props
    "aqueduct_fragments", "ruined_arches", "overgrown_archways", "flame_niches",
    "market_stalls", "offering_tables", "harvest_altars", "carts", "woodpiles",
    "fish_drying_racks", "fences", "washing_lines", "letter_boxes", "graves",
    "rusted_machines", "shipwreck_prows", "anvils", "rope_swings",
    "flower_trellises", "charcoal_kilns", "windmills",
}
# GROUP, NOT TYPE. An earlier version also keyed off `type`, which is only on
# the manifest for some pieces (viewer_build fills the rest in from the group),
# so the windows came out split 33 ellipse / 25 rect on nothing but whether a
# manifest happened to carry the field. The group is always present and is what
# the shape actually follows.
#
# Wall scenery -- windows, cliff faces -- stays ellipse here because it needs no
# floor hitbox at all: the wall does the blocking. Every one of the 359 states
# still without a hand-tuned hitbox is wall scenery, and that is why.


def default_shape(rel, meta):
    return "rect" if rel.split("/", 1)[0] in RECT_GROUPS else "ellipse"


def run(dry=False):
    changed = 0
    tally = Counter()
    for rel, meta in factory.discover():
        want = default_shape(rel, meta)
        tally[want] += 1
        if meta.get("hitbox_shape") == want:
            continue
        changed += 1
        if dry:
            continue
        man = factory.read_manifest(rel)
        man["hitbox_shape"] = want
        factory.write_manifest(rel, man)
    if not dry and changed:
        viewer_build.build()
    print(f"{changed} piece(s) {'would change' if dry else 'updated'}  "
          f"rect={tally['rect']} ellipse={tally['ellipse']}")
    return changed


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    run(dry=a.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
