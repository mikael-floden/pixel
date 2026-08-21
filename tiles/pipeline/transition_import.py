"""Download the generated transition sets into the repo.

The generation runs on the maintainer's side (see transition_jobs.py — the boundary
controls are only reachable with a browser session token). Retrieval is the mirror
image: it needs nothing but the ordinary API key and costs NOTHING, because the
generation is already paid for. That asymmetry is what makes the hand-off tolerable —
one paste from a human, everything else automated.

Matching ids back to jobs without asking anyone to copy 315 lines off a phone: every
generation carries its material pair verbatim in the description, and the script runs
a pair's amplitudes in a fixed order, so sorting a pair's tiles by creation time and
zipping them against that pair's jobs recovers (amplitude, seed) exactly. The result
is checked, not assumed: a pair whose tile count does not match its job count is
reported and skipped rather than guessed at.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pixellab_client import PixelLabClient  # noqa: E402
import transition_jobs as TJ  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(REPO, "tiles", "transitions")


def slug(a, b, amp, seed):
    return os.path.join(OUT, f"{a}__to__{b}", f"a{int(round(amp*100)):02d}_s{seed}")


def wang_id(rule_or_index, tile):
    """Canonical 0-15 corner index.

    tile_rules gives a mask per tile; where it is absent the tile order from
    fetch_tiles is already the wang order, which is how the API documents it.
    """
    if isinstance(rule_or_index, dict):
        m = rule_or_index.get("mask")
        if isinstance(m, int):
            return m
    return tile


def listing(client, limit=400):
    rows, seen = [], set()
    offset = 0
    while len(rows) < limit:
        # the listing caps at 50 per page (422 above that), so page through
        page = client._get(f"/tiles-pro?limit=50&offset={offset}")
        got = page.get("tiles") or []
        if not got:
            break
        for t in got:
            if t["id"] not in seen:
                seen.add(t["id"])
                rows.append(t)
        if len(got) < 50:
            break
        offset += len(got)
    return rows


def pair_of(description, by_desc):
    return by_desc.get((description or "").strip())


def run(apply=True, limit=400):
    client = PixelLabClient()
    jobs = json.load(open(os.path.join(OUT, "jobs.json")))["jobs"]
    by_desc = {}
    for j in jobs:
        by_desc.setdefault(j["description"].strip(), []).append(j)

    rows = listing(client, limit=limit)
    # group the account's tiles by the description they were generated with
    got = {}
    for t in rows:
        d = (t.get("description") or "").strip()
        if d in by_desc:
            got.setdefault(d, []).append(t)

    written = skipped = missing = 0
    for desc, js in by_desc.items():
        ts = sorted(got.get(desc, []), key=lambda r: r.get("created_at") or "")
        if len(ts) != len(js):
            print(f"MISMATCH {js[0]['a']}__to__{js[0]['b']}: "
                  f"{len(ts)} tiles for {len(js)} jobs — skipped")
            missing += len(js)
            continue
        for j, t in zip(js, ts):
            d = slug(j["a"], j["b"], j["amplitude"], j["seed"])
            if os.path.exists(os.path.join(d, "meta.json")):
                skipped += 1
                continue
            if not apply:
                written += 1
                continue
            try:
                imgs = client.fetch_tiles(t["id"])
            except Exception as e:
                print(f"FETCH FAIL {j['a']}__to__{j['b']} a{j['amplitude']}: {str(e)[:100]}")
                continue
            if len(imgs) < 16:
                print(f"INCOMPLETE {j['a']}__to__{j['b']} a{j['amplitude']}: {len(imgs)} tiles")
                continue
            os.makedirs(d, exist_ok=True)
            rec = client._get(f"/tiles-pro/{t['id']}")
            rules = (rec.get("tile_rules") or {}).get("tiles") or {}
            index = {}
            for i, im in enumerate(imgs):
                wid = wang_id(rules.get(f"tile_{i}"), i)
                # LOSSLESS WebP, the project image format; exact=True keeps the RGB
                # under fully transparent pixels. Both flags are non-default.
                im.convert("RGBA").save(os.path.join(d, f"tile_{wid:02d}.webp"),
                                        "WEBP", lossless=True, exact=True)
                index[wid] = f"tile_{wid:02d}.webp"
            json.dump({
                "lower": j["a"], "upper": j["b"],
                "boundary_amplitude": j["amplitude"], "boundary_seed": j["seed"],
                "tile_id": t["id"], "n_tiles": len(index),
                "complete": sorted(index) == list(range(16)),
                "size": list(imgs[0].size),
                "settings": {k: v for k, v in j.items()
                             if k not in ("a", "b", "amplitude", "seed")},
                "tiles": {str(k): v for k, v in sorted(index.items())},
                "note": ("Wang corner set: the index is the corner bitmask NW NE SW SE "
                         f"with a set bit meaning {j['b']}. Index 0 is all {j['a']}, "
                         "15 all the other — both directions live in this one set."),
            }, open(os.path.join(d, "meta.json"), "w"), indent=1)
            written += 1
    print(f"\nwritten {written}  already had {skipped}  unmatched {missing}")
    return written


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=400)
    a = ap.parse_args()
    run(apply=not a.dry_run, limit=a.limit)
