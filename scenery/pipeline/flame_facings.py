"""Extend every INDOOR/TOWN flame animation to south-west and south-east.

Maintainer, 2026-08-28: "Everything under 'Indoor' and under 'Town' should have
SW, S and SE. And fire animations in each direction of course (if this object
has a fire animation). Maybe an object gets all animations automatically when
you add more directions (I don't know)."

IT DOES NOT, and that is the finding that shapes this. Checked on torch_post_004
before writing anything: its object already carried all eight rotation_urls
while its animation group animated `south` alone. Directions and animations are
independent — the facings were free (add_facings.py just downloaded them), and
each animated direction costs three generations.

EXTEND THE GROUP, NEVER CREATE A SECOND ANIMATION. Passing the existing
`animation_group_id` with the new directions adds them to that animation, and
the API carries his description across on its own — the response comes back
with "Animate the flame only" without it being re-sent. Posting a fresh
animation instead would leave a piece with two flame animations whose wording
could drift apart.

STORAGE CHANGES SHAPE HERE. A south-only flame was stored flat as
    <state>/animations/flame/NN.webp
which cannot hold three facings. It becomes campfire's layout, the domain's
existing convention for an animated piece:
    <state>/animations/flame/<direction>/NN.webp
so the old flat frames are rewritten as they are re-downloaded.

Pieces over 168px are 1-direction and stay south-only: no other facing was ever
generated for them (see add_facings.py).

    python3 pipeline/flame_facings.py --dry-run
    python3 pipeline/flame_facings.py
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import sys
import threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

import factory
import viewer_build
from pixellab_client import PixelLabClient, PixelLabError, V2_BASE
import animate_trees as A

TYPES = ("INDOOR", "TOWN")
NAME = "flame"
WANT = ("south-east", "south-west")
ALL3 = ("south-west", "south", "south-east")
EIGHT_DIR_MAX = 168
FRAME_COUNT = 4
PARALLEL = 12

_LOCKS = defaultdict(threading.Lock)      # one per piece; see add_facings.py


def _types():
    with open(os.path.join(factory.ROOT, "config", "factory.json"),
              encoding="utf-8") as f:
        return {g["id"]: g.get("type") for g in json.load(f).get("groups", [])}


def targets():
    """[(rel, state, oid, size, group_id)] — flame animations still south-only."""
    types = _types()
    out = []
    for p in sorted(glob.glob(os.path.join(factory.ROOT, "*", "*", "scenery.json"))):
        rel = os.path.relpath(os.path.dirname(p), factory.ROOT)
        with open(p, encoding="utf-8") as f:
            man = json.load(f)
        group = rel.split("/")[0]
        if (man.get("type") or types.get(group) or "OTHER") not in TYPES:
            continue
        size = int(man.get("size") or 64)
        if size > EIGHT_DIR_MAX:
            continue
        for state, e in sorted((man.get("states") or {}).items()):
            a = ((e or {}).get("animations") or {}).get(NAME)
            oid = (e or {}).get("pixellab_object_id")
            if not a or not oid or not a.get("group_id"):
                continue
            have = set((a.get("directions") or {}) if isinstance(a.get("directions"), dict) else ())
            if all(d in have for d in ALL3):
                continue                          # already done — resumable
            out.append((rel, state, oid, size, a["group_id"]))
    return out


def one(client, rel, state, oid, size, gid):
    try:
        # Add the two missing facings to the EXISTING group.
        r = client._request("POST", f"{V2_BASE}/objects/{oid}/animations",
                            json={"animation_group_id": gid,
                                  "directions": list(WANT),
                                  "frame_count": FRAME_COUNT,
                                  "mode": "v3",
                                  "keep_first_frame": True})
        for j in (r.get("background_job_ids") or []):
            try:
                client.wait_job(j, timeout=900)
            except PixelLabError:
                pass
        frames = client.download_object_animation(oid, gid, expected=3, wait=600)
        if not frames:
            return (rel, state, 0, "no frames came back")
        man = factory.read_manifest(rel) or {}
        ent = (man.get("states") or {}).get(state) or {}
        base = A.anim_dir(rel, state, man, NAME)
        # Flat south-only frames cannot coexist with per-direction ones.
        for old in glob.glob(os.path.join(factory.ROOT, base, "*.webp")):
            os.remove(old)
        dirs = {}
        for d, imgs in frames.items():
            imgs = [factory._normalize(im.convert("RGBA"), size) for im in imgs]
            paths = []
            for i, im in enumerate(imgs):
                fp = f"{base}/{d}/{i:02d}.webp"
                factory.save_webp(im, os.path.join(factory.ROOT, fp))
                paths.append(fp)
            dirs[d] = {"frames": len(paths), "frame_paths": paths}
        with _LOCKS[rel]:
            man = factory.read_manifest(rel) or {}
            states = dict(man.get("states") or {})
            ent = dict(states.get(state) or {})
            anims = dict(ent.get("animations") or {})
            a = dict(anims.get(NAME) or {})
            a["directions"] = dirs
            a["frame_count"] = max(v["frames"] for v in dirs.values())
            a.pop("frame_paths", None)         # superseded by `directions`
            a.pop("strip", None)
            a["generated_at"] = A._now()
            anims[NAME] = a
            ent["animations"] = anims
            states[state] = ent
            man["states"] = states
            factory.write_manifest(rel, man)
        return (rel, state, len(dirs), "ok")
    except PixelLabError as e:
        return (rel, state, 0, f"FAILED: {str(e)[:100]}")
    except Exception as e:                       # noqa: BLE001
        return (rel, state, 0, f"ERROR: {type(e).__name__}: {str(e)[:90]}")


def main():
    ap = argparse.ArgumentParser(description="Flame animations in SW/S/SE.")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--min-usd", type=float, default=2.0)
    args = ap.parse_args()

    todo = targets()
    if args.limit:
        todo = todo[:args.limit]
    gens = len(todo) * 2 * 3         # two new directions, three generations each
    print(f"{len(todo)} flame state(s) to gain SE+SW "
          f"across {len({r for r, *_ in todo})} piece(s)")
    print(f"  ~{gens} generations x $0.012 = about ${gens * 0.012:.2f}")
    if args.dry_run or not todo:
        from collections import Counter
        for g, n in Counter(r.split("/")[0] for r, *_ in todo).most_common(12):
            print(f"    {g:<24} {n}")
        return 0

    client = PixelLabClient()
    ok = done = 0
    with ThreadPoolExecutor(max_workers=PARALLEL) as pool:
        futs = [pool.submit(one, client, *t) for t in todo]
        for f in as_completed(futs):
            rel, state, n, how = f.result()
            done += 1
            if n:
                ok += 1
            else:
                print(f"    x {rel} {state}: {how}")
            if done % 20 == 0:
                print(f"  = {done}/{len(todo)}")
                A.commit_push(f"scenery: flame facings ({done}/{len(todo)} states)")
    viewer_build.build()
    A.commit_push(f"scenery: flame animations in SW/S/SE for {ok} state(s)")
    print(f"\n{ok}/{len(todo)} flame state(s) now animate in three directions")
    return 0


if __name__ == "__main__":
    sys.exit(main())
