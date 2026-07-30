#!/usr/bin/env python3
"""Export the maps agent's OWN clean-base classification for the wiki.

The maps2 pipeline (maps2/pipeline/tiles2lib.py) scores every base tile of
every tile type and paints worlds almost entirely with a small set of SOLID
"clean base" tiles (uniform top, clean cliff wall — `plain_set`/`region_base`).
The wiki marks those tiles and composes its tile-instance previews around
them, so it must use the maps agent's REAL classification — this script
imports their library (read-only) and dumps the result.

Run from the repo root whenever tiles2 gains/changes base tiles:

    python3 wiki/tools/clean-base.py

Output: wiki/clean_base.json  { format, generated_at, types: {gid: {
  plain, solid[], clean[] }}}  — tile paths relative to the repo root.
build.mjs folds it into site/data.json (missing file → no badges, no crash).
"""
import json, os, sys, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "maps2", "pipeline"))
import tiles2lib  # noqa: E402  (the maps agent's library, imported read-only)

lib = tiles2lib.TileLib() if hasattr(tiles2lib, "TileLib") else None
if lib is None:  # library entry point is the class holding .types/.base_pools
    for name in dir(tiles2lib):
        obj = getattr(tiles2lib, name)
        if isinstance(obj, type) and hasattr(obj, "base_pools"):
            lib = obj()
            break
assert lib is not None, "could not find the tiles2 library class"

def rel(p):
    """Repo-relative with forward slashes — the form every wiki id uses."""
    return os.path.relpath(os.path.abspath(p), ROOT).replace(os.sep, "/")

types = {}
for gid in sorted(lib.types):
    try:
        clean, _special = lib.base_pools(gid)
        types[gid] = {
            "plain": rel(lib.plain_tile(gid)),
            "solid": [rel(p) for p in lib.plain_set(gid)],
            "clean": [rel(p) for p in clean],
        }
    except Exception as e:  # a type with no base tiles must not kill the export
        print(f"  skip {gid}: {e}")

out = {
    "format": "pixel-wiki-clean-base@1",
    "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "source": "maps2/pipeline/tiles2lib.py base_pools()/plain_set()",
    "types": types,
}
dst = os.path.join(ROOT, "wiki", "clean_base.json")
with open(dst, "w") as f:
    json.dump(out, f, indent=2)
    f.write("\n")
print(f"wrote {dst}: {len(types)} types")
for gid, t in types.items():
    print(f"  {gid}: plain={os.path.basename(t['plain'])} solid={len(t['solid'])} clean={len(t['clean'])}")
