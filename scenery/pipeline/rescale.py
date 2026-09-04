"""Recompute every piece's placement against the CURRENT scale constant.

Why this exists: `world_px_height` is a derived number — world_height_m turned
into pixels by character_height_px / character_height_m. It was baked into 710
manifests against character_height_px=64, and 64 was wrong: the game draws the
avatar at setScale(1) (games2 WorldScene.ts:4103), so a character's on-screen
height is its own alpha bbox — measured 88px (default_boy) and 87px
(default_girl) across all eight facings. Every piece was sized into a 64px-person
world and then stood beside an 88px person, so all scenery rendered ~27% small.
The maintainer caught it on a bed, 2026-09-04.

This rewrites only the DERIVED half of placement. `world_height_m` — the piece's
declared real height, which is a separate and still-open question for floor
pieces seen in low top-down — is never touched here.

Safe to re-run: it is a pure function of world_height_m and the config constant.
Nothing reaches the deployed game until games2 rebuilds config/scenery-bbox.json,
which is what the server actually reads.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory, viewer_build


def run(write=False):
    cfg = factory.load_config()
    sc = cfg["scale"]
    ppm = sc["character_height_px"] / sc["character_height_m"]
    changed, seen = [], 0
    for rel, man in factory.discover():
        pl = man.get("placement")
        if not pl or "world_height_m" not in pl:
            continue
        seen += 1
        old = pl.get("world_px_height")
        new = max(1, round(float(pl["world_height_m"]) * ppm))
        if new == old and pl.get("character_height_px") == sc["character_height_px"]:
            continue
        pl["world_px_height"] = new
        pl["character_height_px"] = sc["character_height_px"]
        pl["character_height_m"] = sc["character_height_m"]
        # canvas_render_px is world_px_height carried up to the whole canvas, so
        # the transparent margin the model left does not shrink the art.
        if pl.get("content_px_height") and man.get("size"):
            pl["canvas_render_px"] = max(1, round(new * man["size"] / pl["content_px_height"]))
        changed.append((rel, old, new))
        if write:
            factory.write_manifest(rel, man)
    return seen, changed


if __name__ == "__main__":
    write = "--write" in sys.argv
    seen, changed = run(write)
    print(f"{seen} pieces with a placement; {len(changed)} rescaled"
          f"{'' if write else ' (DRY RUN — pass --write)'}")
    for rel, o, n in changed[:8]:
        print(f"  {rel:<40} {o} -> {n} px")
    if write and changed:
        viewer_build.build()
        print("viewer_data.json rebuilt")
