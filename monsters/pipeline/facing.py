#!/usr/bin/env python3
"""DOES A CLIP FACE THE DIRECTION IT IS FILED UNDER? Measured, never eyeballed.

The maintainer, twice on his Plumefist and once before on his Emberdrake: "This
is S", "This is SE", "This is E" — the whole state filed one compass slot out.
The eight rotations are correct; it is the ANIMATION that lands under the wrong
name, so every clip shows the neighbour's view and the monster walks sideways
in the game.

THE MEASUREMENT IS EXACT AND COSTS NOTHING. A generated clip's frame 0 IS the
base rotation for its direction (`end_frame`/`keep_first_frame` pin it), so the
silhouette of frame 0 must match that direction's base EXACTLY. Compare it
against all eight bases — normalized to the content box so canvas size and
padding cannot matter — and a well-filed clip scores 1.000 against its own. When
it scores 1.000 against a DIFFERENT one, that is not a judgement call: the clip
is filed wrong and the tool names where it belongs.

Only the five GENERATED directions are judged. A mirrored facing (south-west,
west, north-west) is a horizontal flip, which never matches a base exactly —
it scores 0.70–0.95 against everything nearby, and reading a rotation out of
that is guesswork.

  python monsters/pipeline/facing.py check [--only id,id]
  python monsters/pipeline/facing.py fix --only <id> --state <state> [--apply]

`fix` RELABELS — it never repaints. Each clip moves to the direction it really
shows, its verdict moves with it (his yes was on the art, not on the filename)
and a note that asked for exactly this is cleared, because a relabel is acting
on it. The mirrors are rebuilt from the corrected originals, and any facing
left with no art is reported for generation rather than faked from a neighbour.

MAINTAINER'S RULE THIS OBEYS (2026-09-11, his Emberdrake): "I don't trust your
eyes to correct this. Let this be something only I can correct." The eyes are
gone — this is a pinned-frame identity, 1.000 or it is not acted on — and `fix`
runs only on a state HE has flagged, never on a sweep of its own.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "candidates")
FEEDBACK = os.path.join(os.path.dirname(ROOT), "live", "feedback", "monsters.json")
DIRS_8 = ("south", "south-east", "east", "north-east", "north",
          "north-west", "west", "south-west")
GENERATED = ("south", "south-east", "east", "north-east", "north")
MIRROR_OF = {"south-west": "south-east", "west": "east", "north-west": "north-east"}
EXACT = 0.99


def _mask(path, n=64):
    """Silhouette cropped to its content box and resampled to n×n — so the
    comparison survives a different canvas, padding or scale."""
    a = np.array(Image.open(path).convert("RGBA"))[..., 3] > 8
    ys, xs = np.nonzero(a)
    if not len(xs):
        return None
    c = a[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    return np.array(Image.fromarray(c.astype(np.uint8) * 255).resize((n, n), Image.NEAREST)) > 127


def _iou(a, b):
    u = (a | b).sum()
    return float((a & b).sum() / u) if u else 0.0


def _bases(cid):
    out = {}
    for d in DIRS_8:
        p = os.path.join(OUT, cid, "rotations", f"{d}.webp")
        if os.path.exists(p):
            m = _mask(p)
            if m is not None:
                out[d] = m
    return out


def _first_frame(cid, state, d):
    p = os.path.join(OUT, cid, "animations", state, d)
    if not os.path.isdir(p):
        return None
    fs = sorted(f for f in os.listdir(p) if f.endswith(".webp"))
    return os.path.join(p, fs[0]) if fs else None


def read(cid, state):
    """{filed direction: the direction its frame 0 is really pinned to} — only
    the generated five, and only where the match is exact."""
    bases = _bases(cid)
    if len(bases) < len(DIRS_8):
        return {}
    out = {}
    for d in GENERATED:
        f = _first_frame(cid, state, d)
        if not f:
            continue
        m = _mask(f)
        if m is None:
            continue
        best, score = max(((x, _iou(m, bases[x])) for x in bases), key=lambda t: t[1])
        if score >= EXACT:
            out[d] = best
    return out


def rotation_offset(cid):
    """{PixelLab direction: the repo direction its rotation really is}, or {}.

    The character's own eight rotations on PixelLab, against this repo's copy
    of them. On a well-mirrored candidate this is the identity. On his
    Plumefist it was a clean one-slot shift, all eight at 1.0000 — which is why
    a clip whose frame 0 comes from the CHARACTER (die, attack, anything
    unpinned) lands one slot off while a clip pinned from our file (idle, walk,
    angry) faces the way he sees it. Only an exact map is returned: if any of
    the eight is not a 1.0 match this says nothing rather than something wrong.
    Costs one character read and eight image downloads, no generation."""
    from pixellab_client import PixelLabClient
    man_p = os.path.join(OUT, cid, "candidate.json")
    if not os.path.isfile(man_p):
        return {}
    pid = json.load(open(man_p)).get("pixellab_id")
    if not pid:
        return {}
    client = PixelLabClient()
    detail = client.get_character(pid)
    urls = {d: u for d, u in (detail.get("rotation_urls") or {}).items() if u and d in DIRS_8}
    if len(urls) != len(DIRS_8):
        return {}
    imgs = dict(zip(sorted(urls), client.download_many([urls[d] for d in sorted(urls)])))
    repo = _bases(cid)
    if len(repo) != len(DIRS_8):
        return {}
    out = {}
    for d, im in imgs.items():
        if im is None:
            return {}
        a = np.array(im.convert("RGBA"))[..., 3] > 8
        ys, xs = np.nonzero(a)
        if not len(xs):
            return {}
        c = a[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        m = np.array(Image.fromarray(c.astype(np.uint8) * 255).resize((64, 64), Image.NEAREST)) > 127
        best, score = max(((x, _iou(m, repo[x])) for x in repo), key=lambda t: t[1])
        if score < EXACT:
            return {}
        out[d] = best
    return out


def check(only=None, verbose=True):
    bad = []
    for cid in sorted(os.listdir(OUT)):
        if only and cid not in only:
            continue
        adir = os.path.join(OUT, cid, "animations")
        if not os.path.isdir(adir):
            continue
        for state in sorted(os.listdir(adir)):
            if not os.path.isdir(os.path.join(adir, state)):
                continue
            truth = read(cid, state)
            wrong = {d: t for d, t in truth.items() if t != d}
            if wrong:
                bad.append((cid, state, wrong))
    if verbose:
        if bad:
            print(f"facing: {len(bad)} state(s) filed under the wrong direction")
            for cid, state, w in bad:
                print(f"  {cid} {state}: " + ", ".join(f"{d} is really {t}" for d, t in sorted(w.items())))
            print("Fix one he has flagged: facing.py fix --only <id> --state <state> --apply")
        else:
            print("facing: every generated clip is pinned to the direction it is filed under")
    return bad


FLIP = {"south": "south", "north": "north",
        "south-east": "south-west", "south-west": "south-east",
        "east": "west", "west": "east",
        "north-east": "north-west", "north-west": "north-east"}


def true_of(cid, state):
    """{the direction a clip is filed under: the direction it really shows}, all
    eight. A mirror is a flip of its original, so once the original's true
    facing is known the mirror's is that facing flipped — no separate
    measurement, which is what keeps the guesswork out of the mirrored three."""
    truth = read(cid, state)
    out = dict(truth)
    for m, o in MIRROR_OF.items():
        if o in truth:
            out[m] = FLIP[truth[o]]
    return out


def fix(cid, state, apply=False, verbose=True):
    truth = true_of(cid, state)
    # The offset says where a clip generated AS PixelLab's <d> really faces. A
    # folder that was already relabelled no longer carries PixelLab's name, so
    # the offset must never be applied to it again — run twice, it rotated a
    # corrected attack a second time and crashed halfway (2026-09-23).
    man_p0 = os.path.join(OUT, cid, "candidate.json")
    rec0 = ((json.load(open(man_p0)).get("animations") or {}).get(state) or {}) if os.path.isfile(man_p0) else {}
    done0 = {d for d, q in (rec0.get("directions") or {}).items() if q.get("relabelled_from")}
    unplaced = [d for d in GENERATED if d not in truth and d not in done0
                and os.path.isdir(os.path.join(OUT, cid, "animations", state, d))]
    if unplaced:
        # A PRO take has no pinned frame 0, so nothing in it matches a base
        # exactly. The CHARACTER's rotation offset is exact for every clip
        # generated on it, so it places what the clip itself cannot.
        off = rotation_offset(cid)
        if off:
            for d in unplaced:
                truth[d] = off[d]
            for m, o in MIRROR_OF.items():
                if o in truth and m not in truth:
                    truth[m] = FLIP[truth[o]]
            print(f"  {cid} {state}: {', '.join(unplaced)} placed by the character's rotation offset")
        else:
            print(f"  {cid} {state}: {', '.join(unplaced)} cannot be placed (unpinned, and the "
                  f"character's rotations have no exact offset) — left where they are")
    if not truth:
        print(f"  {cid} {state}: nothing measurable (no exact match on any generated facing)")
        return False
    if all(d == t for d, t in truth.items()):
        print(f"  {cid} {state}: already filed correctly")
        return False
    adir = os.path.join(OUT, cid, "animations")
    # WHICH FILE HOLDS EACH TRUE FACING. Two can claim one — the generated clip
    # and a mirror that flipped onto the same view — and the generated one wins:
    # it is pinned to the base and matched it exactly, while the mirror is a
    # flip of a clip that was itself misfiled.
    src = {}
    for d, t in truth.items():
        if t not in src or (d in GENERATED and src[t] not in GENERATED):
            src[t] = d
    # A FACING THAT ALREADY SITS CORRECTLY IS NOT OVERWRITTEN BY A MIRROR of
    # the same view: the unmeasured genuine south-west stays, the flipped
    # duplicate that also reads south-west is discarded.
    discard = []
    for t, d in list(src.items()):
        if t != d and t not in truth and os.path.isdir(os.path.join(OUT, cid, "animations", state, t)):
            discard.append(d)
            del src[t]
    missing = [d for d in DIRS_8 if d not in src and not
               (d not in truth and os.path.isdir(os.path.join(OUT, cid, "animations", state, d)))]
    rebuild = [m for m in missing if MIRROR_OF.get(m) in src]
    still = [d for d in missing if d not in rebuild]
    print(f"  {cid} {state}: " + ", ".join(f"{src[t]}->{t}" for t in DIRS_8 if t in src))
    if rebuild:
        print(f"  {cid} {state}: {', '.join(rebuild)} rebuilt by flipping "
              f"{', '.join(MIRROR_OF[m] for m in rebuild)}")
    if still:
        print(f"  {cid} {state}: NO ART for {', '.join(still)} — generate it "
              f"(`animate.py redo --state {state} --only {cid} --dirs {','.join(still)}`)")
    if not apply:
        print("  (dry run — pass --apply)")
        return True

    man_p = os.path.join(OUT, cid, "candidate.json")
    man = json.load(open(man_p))
    rec = (man.get("animations") or {}).get(state) or {}
    old_dirs = dict(rec.get("directions") or {})

    # EVERY MOVE GOES THROUGH A TEMPORARY NAME. This is a rotation — each facing
    # lands on the name of the next one — so moving in place would overwrite the
    # art still waiting to be moved.
    import shutil
    staged = {}
    for t, d in src.items():
        s_dir = os.path.join(adir, state, d)
        if os.path.isdir(s_dir):
            staged[t] = os.path.join(adir, state, f".move-{t}")
            os.rename(s_dir, staged[t])
        s_strip = os.path.join(adir, f"{state}__{d}.webp")
        if os.path.exists(s_strip):
            os.rename(s_strip, os.path.join(adir, f".move-{state}__{t}.webp"))
    # ONLY WHAT WAS MEASURED MOVES. A facing this could not place — a PRO take
    # has no pinned frame 0, so nothing matches exactly — stays exactly where it
    # is; the first version of this cleared every unmatched facing and threw
    # away three freshly generated attack clips (2026-09-23, Plumefist).
    # Cleared: every source that was staged out, every discarded duplicate,
    # and every TARGET name — whatever still sits under a target's name after
    # staging is a stale view of that facing (a mirror that lost the tie), and
    # renaming the staged art onto it fails with "directory not empty".
    moved_from = set(src.values()) | set(discard)
    clear = moved_from | set(src) | set(rebuild)
    for d in DIRS_8:
        if d not in clear:
            continue
        p = os.path.join(adir, state, d)
        if os.path.isdir(p):
            shutil.rmtree(p)
        p = os.path.join(adir, f"{state}__{d}.webp")
        if os.path.exists(p):
            os.remove(p)
    for t, p in staged.items():
        os.rename(p, os.path.join(adir, state, t))
    for d in DIRS_8:
        p = os.path.join(adir, f".move-{state}__{d}.webp")
        if os.path.exists(p):
            os.rename(p, os.path.join(adir, f"{state}__{d}.webp"))

    for m in rebuild:
        o_dir = os.path.join(adir, state, MIRROR_OF[m])
        if not os.path.isdir(o_dir):
            continue
        m_dir = os.path.join(adir, state, m)
        os.makedirs(m_dir, exist_ok=True)
        frames = []
        for n in sorted(f for f in os.listdir(o_dir) if f.endswith(".webp")):
            im = Image.open(os.path.join(o_dir, n)).convert("RGBA").transpose(Image.FLIP_LEFT_RIGHT)
            im.save(os.path.join(m_dir, n), "WEBP", lossless=True, exact=True)
            frames.append(im)
        if frames:
            w, h = frames[0].size
            strip = Image.new("RGBA", (w * len(frames), h), (0, 0, 0, 0))
            for i, im in enumerate(frames):
                strip.paste(im, (i * w, 0))
            strip.save(os.path.join(adir, f"{state}__{m}.webp"), "WEBP", lossless=True, exact=True)
        src[m] = MIRROR_OF[m]

    new_dirs = {d: q for d, q in old_dirs.items() if d not in clear}
    for t, d in src.items():
        if d in old_dirs:
            q = dict(old_dirs[d])
            q["relabelled_from"] = d
            if t in MIRROR_OF:
                q["mirrored"] = True
            new_dirs[t] = q
    rec["directions"] = {d: new_dirs[d] for d in DIRS_8 if d in new_dirs}
    man["animations"][state] = rec
    t_ = man_p + ".tmp"
    with open(t_, "w") as f:
        json.dump(man, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(t_, man_p)

    # HIS VERDICTS FOLLOW THE ART: he judged pixels, not filenames. A NOTE that
    # asked for exactly this ("This is SE") is deleted with the move, because
    # the relabel IS acting on it — an acted-on note is never carried onto art
    # that now answers it.
    fb = json.load(open(FEEDBACK))
    ent = fb["entries"]
    moved = {}
    for d, t in truth.items():
        k = f"monsters/{cid}#{state}#{d}"
        if k in ent and src.get(t) == d:
            v = dict(ent[k])
            v.pop("note", None)
            moved[f"monsters/{cid}#{state}#{t}"] = v
    for d in DIRS_8:
        if d in clear:
            ent.pop(f"monsters/{cid}#{state}#{d}", None)
    ent.update(moved)
    fb["entries"] = ent
    from datetime import datetime, timezone
    fb["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    t_ = FEEDBACK + ".tmp"
    with open(t_, "w") as f:
        json.dump(fb, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(t_, FEEDBACK)
    print(f"  {cid} {state}: relabelled, {len(moved)} verdict(s) moved with the art, "
          f"{len(DIRS_8) - len(src)} facing(s) left to generate")
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check")
    c.add_argument("--only")
    f = sub.add_parser("fix")
    f.add_argument("--only", required=True)
    f.add_argument("--state", required=True)
    f.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    if a.cmd == "check":
        check(only=set(a.only.split(",")) if a.only else None)
    else:
        fix(a.only, a.state, apply=a.apply)


if __name__ == "__main__":
    main()
