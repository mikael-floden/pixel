"""ONE PIXEL IS ONE PIXEL. Publish every piece at its art's own size.

THE LAW (maintainer, 2026-09-05): "I want the player and scenery to be the same
scale. If the player img is 100px height and a scenery is 50px in height, then
the player should be twice as tall as the scenery in the game and in the wiki.
1 pixel is the same size. That's what I'm after."

So scenery is NEVER resampled. The game already draws the avatar at setScale(1)
(games2 WorldScene.ts:4103); scenery now matches it.

HOW, without touching three other domains' renderers: every consumer (maps2
render3, games2 fitSprite, the wiki) already scales a sprite so its alpha bbox
height equals `placement.world_px_height`. Setting world_px_height TO that alpha
bbox height makes each of those scale factors exactly 1.0 — the same contract,
now a no-op. No renderer changes, nothing to keep in sync, and no way for the
two to drift apart again.

What the old numbers cost: world_px_height used to be derived from a declared
real height and a character constant, and the constant was wrong (64px against a
character the game draws 88px tall), so everything rendered ~27% small. Worse, a
piece's art almost never matched its declared height anyway — after correcting
the constant only 21% of pieces sat within 10% of their own art size, so the
renderer was resampling pixel art by an arbitrary per-piece factor. Both faults
disappear at 1:1, because the art is now its own authority.

`declared_height_m` PRESERVES the old hand-declared real height, and
`world_height_m` now says what the piece actually reads as on screen
(content_px / (character_height_px / character_height_m)). Comparing the two is
the diagnostic for art that is drawn at the wrong size — a mushroom that reads
0.8m tall is a piece to regenerate smaller, and that is an ART decision, not a
render one.

Safe to re-run: a pure function of the art on disk.
"""
import json, os, sys
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory, viewer_build


def run(write=False):
    cfg = factory.load_config()
    sc = cfg["scale"]
    ppm = sc["character_height_px"] / sc["character_height_m"]
    changed, skipped = [], []
    for rel, man in factory.discover():
        sprite = man.get("sprite")
        path = os.path.join(factory.ROOT, sprite) if sprite else None
        if not path or not os.path.exists(path):
            skipped.append(rel)
            continue
        with Image.open(path) as im:
            box, canvas = im.getbbox(), im.size[1]
        if not box:
            skipped.append(rel)
            continue
        content = max(1, box[3] - box[1])
        pl = man.setdefault("placement", {})
        old = pl.get("world_px_height")
        # Keep the original hand-declared height once, for the art diagnostic.
        if "declared_height_m" not in pl and "world_height_m" in pl:
            pl["declared_height_m"] = pl["world_height_m"]
        pl["world_px_height"] = content
        pl["content_box"] = list(box)
        pl["content_px_height"] = content
        pl["canvas_render_px"] = canvas
        pl["character_height_px"] = sc["character_height_px"]
        pl["character_height_m"] = sc["character_height_m"]
        pl["world_height_m"] = round(content / ppm, 3)
        pl["note"] = ("DRAW AT 1:1. world_px_height IS the art's own alpha bbox "
                      "height, so the scale is 1 — never resample scenery. "
                      "world_height_m is what the art reads as beside a "
                      f"{sc['character_height_px']}px character; "
                      "declared_height_m is what it was once declared to be, "
                      "and a gap between them means the ART is the wrong size.")
        if old != content:
            changed.append((rel, old, content))
        if write:
            factory.write_manifest(rel, man)
    return changed, skipped


if __name__ == "__main__":
    write = "--write" in sys.argv
    changed, skipped = run(write)
    print(f"{len(changed)} pieces now published at their own pixel size"
          f"{'' if write else ' (DRY RUN — pass --write)'}"
          + (f"; {len(skipped)} skipped (no base art)" if skipped else ""))
    for rel, o, n in changed[:6]:
        print(f"  {rel:<42} {o} -> {n} px")
    if write:
        viewer_build.build()
        print("viewer_data.json rebuilt")
