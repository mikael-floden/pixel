#!/usr/bin/env python3
"""PUT BACK A FACING HE APPROVED THAT THE MOVE TO THE ROSTER LOST.

Graduation mirrors the monster from PixelLab, and PixelLab is the source of
truth for art — except for the facings it no longer has. Two ways that happens,
both paid for:

  * the take he picked was rolled under SEVERAL action texts as the ladder
    climbed (his pebble crab's attack: four of them), and graduation deletes
    the groups it reads as unpicked — one of which was backing three facings of
    the take it kept;
  * the candidate carried a facing PixelLab never had as its own group (his
    crag troll's walk south-east), so the mirror could not reproduce it.

Either way he has already approved that art, it is in this repo, and the answer
is to put it back — not to regenerate (new pixels reset his verdict) and not to
clear the verdict (that erases the only record the art was ever there, and
leaves the game with a monster that cannot face that way).

The art is found in the candidate folder if graduation kept it, otherwise in
GIT HISTORY at the candidate path — `624c2b6809 monsters: graduation landings`
is the commit that deletes each folder, so its parent holds the last copy. It
is then padded onto the monster's own canvas (`size` vs `native_size` in its
manifest — postprocess widens frames to repair wrap-around overflow) and written
as lossless WebP, frames and strip, with the manifest entry to match.

  python monsters/pipeline/refill.py <id> <state> <direction> [...]
  python monsters/pipeline/refill.py --from-check      # every hole verdicts.py names
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _run(*args):
    return subprocess.run(args, cwd=os.path.dirname(ROOT),
                          capture_output=True, check=False)


def _candidate_frames(cid, slot, direction):
    """[(name, PIL image)] for one facing, from disk or from git history.

    Returned in frame order. The frames are the RAW PixelLab canvas — padding
    onto the monster's canvas is the caller's job and is verified byte-exact
    against a facing that is already on disk.
    """
    base = f"monsters/candidates/{cid}/animations/{slot}/{direction}"
    local = os.path.join(os.path.dirname(ROOT), base)
    if os.path.isdir(local):
        names = sorted(f for f in os.listdir(local) if f.endswith(".webp"))
        return [(n, Image.open(os.path.join(local, n)).convert("RGBA")) for n in names]
    # git history: the newest commit that still has the folder is the parent of
    # the one that deleted it.
    sha = _run("git", "log", "--all", "--format=%H", "-1", "--",
               f"{base}/00.webp").stdout.decode().strip()
    if not sha:
        return []
    for rev in (f"{sha}^", sha):
        tree = _run("git", "ls-tree", "--name-only", f"{rev}:{base}")
        if tree.returncode:
            continue
        names = sorted(n for n in tree.stdout.decode().split() if n.endswith(".webp"))
        out = []
        for n in names:
            blob = _run("git", "show", f"{rev}:{base}/{n}")
            if blob.returncode:
                return []
            import io
            out.append((n, Image.open(io.BytesIO(blob.stdout)).convert("RGBA")))
        if out:
            return out
    return []


def _slot_for(cid, state):
    """The candidate slot that became this state — graduation recorded it."""
    cfg = json.load(open(os.path.join(ROOT, "config", "candidates.json")))
    for g in cfg.get("graduated", []):
        if g["id"] == cid:
            return (g.get("takes") or {}).get(state, state)
    return state


def refill(cid, state, direction, apply=True, verbose=True):
    mpath = os.path.join(ROOT, cid, "monster.json")
    if not os.path.isfile(mpath):
        print(f"  {cid}: not a roster monster")
        return False
    man = json.load(open(mpath))
    anim = (man.get("animations") or {}).get(state)
    if not anim:
        # the whole state is missing (PixelLab no longer had it at graduation);
        # it is created here and filled facing by facing from the candidate
        anim = {"group_id": None, "source_name": f"candidates/{cid} ({_slot_for(cid, state)})",
                "directions": {}}
        man.setdefault("animations", {})[state] = anim
        man.setdefault("states", {})[state] = state
    if direction in (anim.get("directions") or {}):
        if verbose:
            print(f"  {cid} {state} {direction}: already there")
        return False
    slot = _slot_for(cid, state)
    frames = _candidate_frames(cid, slot, direction)
    if not frames:
        print(f"  {cid} {state} {direction}: NOT FOUND as {slot} on disk or in git history")
        return False
    # A TRAILING FRAME THAT REPEATS THE FIRST IS THE LOOP JOIN, and dropping it
    # is what puts the facing back in step with its siblings. It is also why the
    # facing went missing: crag troll's walk south-east landed with the join
    # (7 frames) while every other facing had 6, and a state is mirrored at one
    # frame count. Byte-identical is the test — never "close enough".
    import numpy as np
    sibling = {len(r.get("frame_paths") or []) for r in (anim.get("directions") or {}).values()}
    if (len(frames) - 1 in sibling and len(frames) > 1
            and np.array_equal(np.array(frames[-1][1]), np.array(frames[0][1]))):
        if verbose:
            print(f"  {cid} {state} {direction}: dropping the trailing loop-join frame "
                  f"({len(frames)} -> {len(frames) - 1}, matching the other facings)")
        frames = frames[:-1]
    W, H = man["size"]["width"], man["size"]["height"]
    PX, PY = man["pad"]["x"], man["pad"]["y"]
    if verbose:
        print(f"  {cid} {state} {direction}: {len(frames)} frames from {slot}, "
              f"padding {frames[0][1].size} -> {(W, H)}")
    if not apply:
        return True
    dst = os.path.join(ROOT, cid, "animations", state, direction)
    os.makedirs(dst, exist_ok=True)
    padded = []
    for n, im in frames:
        if im.size != (W, H):
            canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            canvas.paste(im, (PX, PY))
            im = canvas
        im.save(os.path.join(dst, n), "WEBP", lossless=True, exact=True)
        padded.append(im)
    strip = Image.new("RGBA", (W * len(padded), H), (0, 0, 0, 0))
    for i, im in enumerate(padded):
        strip.paste(im, (i * W, 0))
    strip.save(os.path.join(ROOT, cid, "animations", f"{state}__{direction}.webp"),
               "WEBP", lossless=True, exact=True)
    anim["directions"][direction] = {
        "frames": len(padded),
        "strip": f"{cid}/animations/{state}__{direction}.webp",
        "frame_paths": [f"{cid}/animations/{state}/{direction}/{n}" for n, _ in frames],
        "src_frames": len(padded),
        "sub": None,
        "refilled_from": f"candidates/{cid}/animations/{slot}/{direction}",
    }
    order = ("south", "south-east", "east", "north-east", "north",
             "north-west", "west", "south-west")
    anim["directions"] = {d: anim["directions"][d] for d in order if d in anim["directions"]}
    tmp = mpath + ".tmp"
    with open(tmp, "w") as f:
        json.dump(man, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, mpath)
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("facet", nargs="*", help="<id> <state> <direction>, repeatable in threes")
    ap.add_argument("--from-check", action="store_true",
                    help="refill every hole `verdicts.py check` reports")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    jobs = []
    if args.from_check:
        import verdicts
        for key, action, _t, _w in verdicts.plan():
            if action == "hole":
                path, state, direction = key.split("#")
                jobs.append((path.split("/")[-1], state, direction))
    for i in range(0, len(args.facet) - 2, 3):
        jobs.append(tuple(args.facet[i:i + 3]))
    if not jobs:
        ap.error("nothing to do")
    n = sum(bool(refill(*j, apply=not args.dry_run)) for j in jobs)
    print(f"refill: {n} of {len(jobs)} facing(s) restored"
          f"{' [dry run]' if args.dry_run else ''}")


if __name__ == "__main__":
    main()
