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
PARALLEL = 14         # one full piece per wave (pieces carry 13-14 states),
                      # so no half-empty tail wave doubles the wall time.
                      # Tier 3 allows 25 concurrent and the PixelLab account is
                      # SHARED with the other art domains, so this deliberately
                      # leaves 11 slots rather than taking the ceiling.


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


def tree_pieces():
    """Every TREE-type piece, in a stable order."""
    cfg_path = os.path.join(factory.ROOT, "config", "factory.json")
    with open(cfg_path, encoding="utf-8") as f:
        types = {g["id"]: g.get("type") for g in json.load(f).get("groups", [])}
    out = []
    for rel, man in factory.discover():
        if "/" not in rel:
            continue
        group = rel.split("/")[0]
        if (man.get("type") or types.get(group) or "OTHER") != "TREE":
            continue
        out.append(rel)
    return sorted(out)


def _git(*a, check=True):
    import subprocess
    return subprocess.run(["git", *a], cwd=factory.ROOT, capture_output=True,
                          text=True, check=check)


def _rebase_in_progress():
    for p in ("rebase-merge", "rebase-apply"):
        r = _git("rev-parse", "--git-path", p, check=False).stdout.strip()
        if r and os.path.exists(os.path.join(factory.ROOT, r)):
            return True
    return False


def commit_push(message):
    """Same guards as the other long runners: never commit into someone else's
    half-finished rebase, and back out of a conflicted one rather than leaving
    the tree wedged mid-run."""
    if _rebase_in_progress():
        print("  ! rebase in progress — skipping this commit, art is on disk")
        return
    _git("add", "-A", ".")
    if not _git("status", "--porcelain", "--", ".").stdout.strip():
        return
    _git("commit", "-m", message)
    for attempt in range(4):
        if _git("push", "-u", "origin", "main", check=False).returncode == 0:
            print(f"  ^ pushed: {message}")
            return
        _git("fetch", "origin", "main", check=False)
        _git("rebase", "--autostash", "origin/main", check=False)
        if _rebase_in_progress():
            _git("rebase", "--abort", check=False)
            print("  ! push rebase conflicted — will retry on the next commit")
            return
        time.sleep(2 ** attempt)
    print("  ! push failed after retries — art is committed locally")


def animate_piece(client, rel):
    """-> (done, attempted). Commits the piece when it finishes."""
    man, sts = states_of(rel)
    todo = [(s, oid, anc) for s, oid, have, anc in sts if not have]
    if not todo:
        return 0, 0
    ok = 0
    with ThreadPoolExecutor(max_workers=PARALLEL) as pool:
        futs = [pool.submit(one, client, rel, man, s, oid, anc)
                for s, oid, anc in todo]
        for f in futs:
            state, n, how = f.result()
            if n:
                ok += 1
            else:
                print(f"    x {rel} {state}: {how}")
    return ok, len(todo)


def main():
    ap = argparse.ArgumentParser(description="Animate every state of a tree.")
    ap.add_argument("--piece", default=None)
    ap.add_argument("--all-trees", action="store_true",
                    help="every TREE-type piece in the domain")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="only N pieces (with --all-trees)")
    ap.add_argument("--min-usd", type=float, default=2.0,
                    help="stop before the credit pool runs dry")
    args = ap.parse_args()

    pieces = tree_pieces() if args.all_trees else [args.piece or "trees/tree_015"]
    if args.limit:
        pieces = pieces[:args.limit]

    plan = []
    for rel in pieces:
        _, sts = states_of(rel)
        need = [(s, anc) for s, _oid, have, anc in sts if not have]
        if need:
            plan.append((rel, need))
    states = sum(len(n) for _, n in plan)
    billed = sum(0 if anc else 3 for _, n in plan for _s, anc in n)
    print(f"{len(plan)} piece(s), {states} state(s) to animate")
    print(f"  ~{billed} generations  (measured 2026-08-28: $0.0045/generation, "
          f"so about ${billed * 0.0045:.2f})")
    if args.dry_run:
        for rel, need in plan[:20]:
            print(f"    {rel}: {len(need)}")
        if len(plan) > 20:
            print(f"    … +{len(plan) - 20} more piece(s)")
        return 0
    if not plan:
        print("nothing to do — every tree state already has its wind animation")
        return 0

    client = PixelLabClient()
    done = attempted = 0
    for i, (rel, _need) in enumerate(plan, 1):
        usd = (client.balance().get("credits") or {}).get("usd", 0)
        if usd is not None and usd < args.min_usd:
            print(f"\nstopping: credits ${usd:.2f} below the ${args.min_usd:.2f} "
                  f"floor. Re-run to resume — finished states are skipped.")
            break
        o, a = animate_piece(client, rel)
        done += o
        attempted += a
        print(f"  = [{i}/{len(plan)}] {rel}: {o}/{a} states  "
              f"(total {done}/{states})")
        # COMMIT PER PIECE. This run is hours long and shares the repo with
        # other agents; art that is only on disk is art one bad rebase loses.
        commit_push(f"scenery: wind animation for {rel} ({o} state(s))")
    viewer_build.build()
    commit_push(f"scenery: wind animations — {done} state(s) across "
                f"{len(plan)} tree(s)")
    print(f"\nanimated {done}/{states} state(s) across {len(plan)} piece(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
