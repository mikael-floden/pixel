"""Give every STATE of a tree its own gentle-wind animation.

Maintainer, 2026-08-27, after animating one state by hand in the PixelLab UI and
liking the result: "Can you use the exact same prompt and API params to generate
an animation for all trees in this tree-group? What I mean with tree group is
what pixellab call state."

So the unit of work is a STATE, not a piece. tree_015 alone carries fourteen —
ten unlit variants and four lit — and each is a separate PixelLab object that
has to be animated on its own.

HIS PROMPT AND HIS PARAMS, UNCHANGED. WIND is his text, typed by him, and is
never edited or "improved" here — the window prompt taught this domain what
happens when an agent rewrites his wording. The params mirror his UI run
exactly:

    mode='v3'            the API default; cheaper AND better than 'pro'
    frame_count=4        his slider
    keep_first_frame     his checkbox, and the API default: the reference art
                         is stored as frame 0, so 4 frames means FIVE stored
                         and only THREE generations are billed
    enhance_prompt off   he writes the motion himself; auto-expanding it would
                         silently animate to someone else's description

NEVER PASS `directions`. Every tree is 192px, so it went down the
create-1-direction-object path, and the API returns 400 if you pass directions
for one of those; they animate their single internal direction, which comes
back labelled 'unknown'.

THE ANCHOR IS ALREADY ANIMATED AND IS NOT REGENERATED. He animated it himself
in the UI, that art is what he approved, and re-rolling it would both cost
three generations and throw away the exact thing being reproduced. It is
downloaded instead.

    python3 pipeline/animate_trees.py --piece trees/tree_015 --dry-run
    python3 pipeline/animate_trees.py --piece trees/tree_015
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import factory
import viewer_build
from pixellab_client import PixelLabClient, PixelLabError

# The maintainer's animation description, verbatim. Do not edit.
WIND = (
    "Very very gentle wind. The tree is swinging back and forth with very very "
    "subtile movements. The leaves also feel very gentle movements.\n\n"
    "You need to redraw the branches each frame in order to visualize the wind. "
    "You also need to redraw all leaves each frame to visualize that the leaves "
    "are moving.\n\n"
    "Don't just bounce the existing graphics up and down."
)
NAME = "wind"
FRAME_COUNT = 4
PARALLEL = 5          # modest on purpose: he watches the PixelLab queue


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def anim_dir(rel, state, man):
    """Where this state's frames live.

    The ANCHOR state has no directory of its own — its sprite IS the piece's
    sprite.webp — so its animation goes at the piece root, matching campfire,
    the domain's only previously animated piece.
    """
    ent = (man.get("states") or {}).get(state) or {}
    if ent.get("sprite") == man.get("sprite"):
        return os.path.join(rel, "animations", NAME)
    return os.path.join(rel, state.lower(), "animations", NAME)


def save_frames(frames, out_rel):
    """Frames as lossless WebP + a horizontal strip, campfire's layout."""
    paths = []
    for i, im in enumerate(frames):
        p = f"{out_rel}/{i:02d}.webp"
        factory.save_webp(im, os.path.join(factory.ROOT, p))
        paths.append(p)
    from PIL import Image
    w, h = frames[0].size
    strip = Image.new("RGBA", (w * len(frames), h), (0, 0, 0, 0))
    for i, im in enumerate(frames):
        strip.alpha_composite(im.convert("RGBA"), (i * w, 0))
    sp = f"{out_rel}__strip.webp"
    factory.save_webp(strip, os.path.join(factory.ROOT, sp))
    return paths, sp


def record(rel, state, group_id, paths, strip, frames):
    """Write the animation into the STATE's manifest entry (re-read first —
    workers finish out of order and must not clobber each other's writes)."""
    man = factory.read_manifest(rel) or {}
    states = dict(man.get("states") or {})
    ent = dict(states.get(state) or {})
    anims = dict(ent.get("animations") or {})
    anims[NAME] = {
        "group_id": group_id,
        "description": WIND,
        "mode": "v3",
        "frame_count": len(frames),      # 5: his 4 plus the kept original
        "generated_frames": FRAME_COUNT,
        "keep_first_frame": True,
        "frame_paths": paths,
        "strip": strip,
        "generated_at": _now(),
    }
    ent["animations"] = anims
    states[state] = ent
    man["states"] = states
    factory.write_manifest(rel, man)


def states_of(rel):
    man = factory.read_manifest(rel)
    if not man:
        raise SystemExit(f"no such piece: {rel}")
    out = []
    for s, e in sorted((man.get("states") or {}).items()):
        oid = (e or {}).get("pixellab_object_id")
        if not oid:
            continue
        have = NAME in ((e or {}).get("animations") or {})
        out.append((s, oid, have, (e or {}).get("sprite") == man.get("sprite")))
    return man, out


def one(client, rel, man, state, oid, is_anchor):
    """Animate a single state (or adopt the anchor's existing animation)."""
    try:
        if is_anchor:
            # He made this one himself; adopt it rather than pay to redo it.
            existing = (client.get_object(oid).get("animations") or [])
            if existing:
                gid = existing[0].get("animation_group_id")
                frames = client.download_object_animation(oid, gid, expected=1,
                                                          wait=180)
                if frames:
                    imgs = next(iter(frames.values()))
                    out = anim_dir(rel, state, man)
                    paths, strip = save_frames(imgs, out)
                    record(rel, state, gid, paths, strip, imgs)
                    return (state, len(imgs), "adopted his own")
        gid = client.animate_object(oid, WIND, frame_count=FRAME_COUNT)
        if not gid:
            return (state, 0, "no animation_group_id returned")
        frames = client.download_object_animation(oid, gid, expected=1, wait=600)
        if not frames:
            return (state, 0, "no frames came back")
        imgs = next(iter(frames.values()))
        out = anim_dir(rel, state, man)
        paths, strip = save_frames(imgs, out)
        record(rel, state, gid, paths, strip, imgs)
        return (state, len(imgs), "generated")
    except PixelLabError as e:
        return (state, 0, f"FAILED: {str(e)[:110]}")
    except Exception as e:                      # noqa: BLE001 - report, never abort the batch
        return (state, 0, f"ERROR: {type(e).__name__}: {str(e)[:90]}")


def main():
    ap = argparse.ArgumentParser(description="Animate every state of a tree.")
    ap.add_argument("--piece", default="trees/tree_015")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    man, sts = states_of(args.piece)
    todo = [(s, oid, anc) for s, oid, have, anc in sts if not have]
    if args.limit:
        todo = todo[:args.limit]
    billed = sum(0 if anc else 3 for _, _, anc in todo)
    print(f"{args.piece}: {len(sts)} state(s), {len(todo)} to animate")
    print(f"  ~{billed} generations (3 per state; the anchor's is already his)")
    for s, _, anc in todo:
        print(f"    {s}{'  (anchor — adopt his existing animation)' if anc else ''}")
    if args.dry_run or not todo:
        return 0

    client = PixelLabClient()
    ok = 0
    with ThreadPoolExecutor(max_workers=PARALLEL) as pool:
        futs = [pool.submit(one, client, args.piece, man, s, oid, anc)
                for s, oid, anc in todo]
        for f in futs:
            state, n, how = f.result()
            if n:
                ok += 1
                print(f"  = {state}: {n} frames ({how})")
            else:
                print(f"  x {state}: {how}")
    viewer_build.build()
    print(f"\nanimated {ok}/{len(todo)} state(s) of {args.piece}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
