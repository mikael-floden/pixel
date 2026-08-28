"""Download the generated SLOPE sets into `tiles/slopes/<ground>/a<amp>_s<seed>/`.

A slope set is one ground raised into a plateau with a graded edge down to ITSELF -
generated with elevation > 0 and a self-pair description ("clean grass to clean grass").
Maintainer, 2026-08-28: "This is a special slope tile and should be saved in a location
so you know this is a slope."

WHAT THE 16 TILES ARE, and it is not what the transition sets are: a Wang corner set
whose bit means RAISED, not "the other material". Index 0 is flat ground, index 15 is
full plateau top, and the 14 between are every combination of which corners are up. One
ground, two elevations - so a world can carve arbitrary terrain shapes out of a single
material instead of needing a second one.

Generation runs on the maintainer's side (the elevation and step_slope controls live only
on the session-authenticated endpoint - see transition_jobs.py --slope). Retrieval needs
nothing but the ordinary API key and costs NOTHING, because the generation is already
paid for.

MATCHING IDS BACK TO SEEDS WITHOUT ASKING FOR A PASTE: every generation carries its
ground verbatim in the description, and a ground's seeds are run in ascending order, so
sorting that ground's tiles by creation time and zipping against its jobs recovers the
seed exactly. Checked, never assumed: a ground whose tile count does not match its job
count is reported and skipped rather than guessed at - and the run's own slope_done.txt
carries the exact mapping if a ground ever needs rescuing by hand.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pixellab_client import PixelLabClient  # noqa: E402
import transition_import as TI  # noqa: E402
import transition_jobs as TJ  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(REPO, "tiles", "slopes")


def slug(ground, amp, seed):
    return os.path.join(OUT, ground, f"a{int(round(amp * 100)):02d}_s{seed:02d}")


REPLACE = False


def run(apply=True, limit=1200):
    client = PixelLabClient()
    jobs = json.load(open(os.path.join(OUT, "jobs.json")))["jobs"]
    by_desc = {}
    for j in jobs:
        by_desc.setdefault(j["description"].strip(), []).append(j)
    # seeds ascending, which is the order the shell ran them in
    for d in by_desc:
        by_desc[d].sort(key=lambda j: j["seed"])

    rows = TI.listing(client, limit=limit)
    got = {}
    for t in rows:
        d = (t.get("description") or "").strip()
        if d in by_desc:
            got.setdefault(d, []).append(t)

    written = skipped = missing = 0
    for desc, js in sorted(by_desc.items()):
        g = js[0]["a"]
        # THE NEWEST N, because the account now holds two runs under the SAME
        # description: the first (Thickness 0%, 64x30 flat-top-only, wrong perspective)
        # and the regeneration at the house depth. Sorting ascending and zipping would
        # import the old ones. Take the most recent len(js), then restore seed order.
        allts = sorted(got.get(desc, []), key=lambda r: r.get("created_at") or "")
        ts = allts[-len(js):] if len(allts) >= len(js) else allts
        if len(ts) != len(js):
            print(f"MISMATCH {g}: {len(ts)} tiles on the account for {len(js)} jobs "
                  f"- skipped (re-run once generation finishes)")
            missing += len(js)
            continue
        for j, t in zip(js, ts):
            d = slug(g, j["amplitude"], j["seed"])
            if os.path.exists(os.path.join(d, "meta.json")) and not REPLACE:
                skipped += 1
                continue
            if not apply:
                written += 1
                continue
            try:
                imgs = client.fetch_tiles(t["id"])
            except Exception as e:
                print(f"FETCH FAIL {g} s{j['seed']}: {str(e)[:100]}")
                continue
            if len(imgs) < 16:
                print(f"INCOMPLETE {g} s{j['seed']}: {len(imgs)} tiles")
                continue
            os.makedirs(d, exist_ok=True)
            rec = client._get(f"/tiles-pro/{t['id']}")
            rules = (rec.get("tile_rules") or {}).get("tiles") or {}
            index = {}
            for i, im in enumerate(imgs):
                wid = TI.wang_id(rules.get(f"tile_{i}"), i)
                # Lossless WebP with exact=True - both flags non-default, the repo's law.
                im.convert("RGBA").save(os.path.join(d, f"tile_{wid:02d}.webp"),
                                        "WEBP", lossless=True, exact=True)
                index[wid] = f"tile_{wid:02d}.webp"
            json.dump({
                "schema": "tiles3/slopes@1", "kind": "slope_set",
                "ground": g,
                "boundary_amplitude": j["amplitude"], "boundary_seed": j["seed"],
                "elevation": j.get("elevation"), "step_slope": j.get("step_slope"),
                "tile_id": t["id"], "n_tiles": len(index),
                "complete": sorted(index) == list(range(16)),
                "size": list(imgs[0].size),
                "prompt": j["description"],
                "settings": {k: v for k, v in j.items()
                             if k not in ("a", "b", "amplitude", "seed")},
                "tiles": {str(k): v for k, v in sorted(index.items())},
                "note": ("Wang corner set on ELEVATION, not on material: the index is the "
                         "corner bitmask NW NE SW SE and a set bit means that corner is "
                         f"RAISED. Index 0 is flat {g}, index 15 is full plateau top, and "
                         "the 14 between are the partial shapes. One ground at two "
                         "heights - not a transition between two materials."),
            }, open(os.path.join(d, "meta.json"), "w"), indent=1)
            written += 1
    print(f"\nwritten {written}  already had {skipped}  unmatched {missing}")
    return written


def write_index():
    sets = []
    for mp in sorted(__import__("glob").glob(os.path.join(OUT, "*", "a*_s*", "meta.json"))):
        m = json.load(open(mp))
        m["dir"] = os.path.relpath(os.path.dirname(mp), REPO)
        sets.append(m)
    doc = {
        "schema": "tiles3/slopes@1", "kind": "slope_set",
        "_comment": [
            "SLOPE SETS: one ground raised into a plateau with a graded edge down to",
            "ITSELF. NOT a transition between two materials - the Wang bit means a",
            "corner is RAISED. Index 0 flat, index 15 full plateau top.",
            "Generated with the maintainer's web-UI settings: uneven boundary 14%,",
            "terrain height 4px, edge steepness mid-slope, thickness 0 (flat top face",
            "only), 2px classic flat top, no outline, 28 degrees.",
        ],
        "n_sets": len(sets),
        "grounds": sorted({s["ground"] for s in sets}),
        "sets": sets,
    }
    dst = os.path.join(OUT, "index.json")
    tmp = f"{dst}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(doc, f, indent=1)
    os.replace(tmp, dst)
    return doc


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=1200)
    ap.add_argument("--replace", action="store_true",
                    help="overwrite sets already on disk (the v2 regeneration)")
    a = ap.parse_args()
    REPLACE = a.replace
    globals()["REPLACE"] = a.replace
    run(apply=not a.dry_run, limit=a.limit)
    if not a.dry_run:
        d = write_index()
        print(f"index: {d['n_sets']} sets over {len(d['grounds'])} grounds")
