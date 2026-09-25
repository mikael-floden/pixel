#!/usr/bin/env python3
"""HIS REDO IS ACTED ON THE MOMENT HE SAVES IT — candidate OR graduated monster.

Runs from `.github/workflows/monsters-graduate.yml` on every push of
`live/feedback/monsters.json`. Before this a redo waited for an agent to wake,
and a redo on a GRADUATED monster had no code path at all (2026-09-25: his
Foxfire walk-south redo sat from 11:46 and Starfish Walker's idle NE/NW from
13:55 while the review looked finished to every sweep).

A LIVE redo is a `redo`/`rejected` verdict whose `art` stamp is the strip on
disk now. A stamp that no longer matches judged art that is gone —
`animate.py prune-feedback` owns those; re-rolling on them would throw away
fresh art for a defect in a clip that no longer exists.

- candidate: `animate.py review` (his note becomes the fail reason the ladder
  climbs from) then `animate.py redo` on the generated facing (a mirror is
  redone through its source). The candidate pipeline clears the verdict.
- graduated: ONE facing is re-rolled on PixelLab with the state's own words
  plus his note, and written onto the monster's canvas in place of the old
  one. Nothing else is touched: a sync re-saves every frame through the canvas
  fit and breaks the stamp on every approval he has (measured on Plumefist,
  40/40). His verdict on that facing is removed once the new art is on disk.

    python monsters/pipeline/redos.py            # list live redos
    python monsters/pipeline/redos.py --apply    # act on them
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone

from PIL import Image, ImageOps

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import animate as A  # noqa: E402
import candidates as cand  # noqa: E402
import mirror  # noqa: E402
from pixellab_client import PixelLabClient, PixelLabError  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROSTER = os.path.join(os.path.dirname(HERE), "config", "roster.json")
REDO = ("redo", "rejected")


def _feedback():
    try:
        return json.load(open(A.FEEDBACK))
    except (FileNotFoundError, ValueError):
        return {"entries": {}}


def live_redos():
    """{(cid, slot): {direction: note}} for every redo on art that still exists."""
    out = collections.defaultdict(dict)
    for key, v in (_feedback().get("entries") or {}).items():
        if (v.get("status") or "").lower() not in REDO or "#" not in key:
            continue
        path, _, rest = key.partition("#")
        slot, _, d = rest.partition("#")
        if not path.startswith("monsters/") or d not in A.ALL_DIRS:
            continue
        cid = path.split("/")[-1]
        now = A.strip_hash(cid, slot, d)
        if not now or (v.get("art") and v["art"].lower() != now):
            continue
        out[(cid, slot)][d] = (v.get("note") or "").strip()
    return out


def _is_candidate(cid):
    return os.path.isfile(os.path.join(cand.cdir(cid), "candidate.json"))


def _is_graduated(cid):
    return os.path.isfile(os.path.join(mirror.ROOT, cid, "monster.json"))


def redo_candidate(cid, slot, dirs):
    gen = sorted({A.MIRRORED.get(d, d) for d in dirs})
    py = [sys.executable, "-u", os.path.join(HERE, "animate.py")]
    subprocess.run(py + ["review", "--state", slot], check=False)
    r = subprocess.run(py + ["redo", "--state", slot, "--only", cid, "--dirs", ",".join(gen)], check=False)
    return r.returncode == 0


def _pixellab_name(cid, state, d):
    """PixelLab's name for our facing <d> (roster `direction_remap` maps
    PixelLab -> ours, per state or for the rotations)."""
    try:
        roster = {m["id"]: m for m in json.load(open(ROSTER))["monsters"]}
    except (FileNotFoundError, KeyError, ValueError):
        return d
    remap = (roster.get(cid) or {}).get("direction_remap") or {}
    m = remap.get(state) or remap.get("rotations") or {}
    return next((p for p, t in m.items() if t == d), d)


def _drop_verdicts(cid, slot, dirs):
    doc = _feedback()
    entries = doc.get("entries") or {}
    gone = 0
    for d in dirs:
        v = entries.get(f"monsters/{cid}#{slot}#{d}")
        if v and (v.get("status") or "").lower() != "approved":
            entries.pop(f"monsters/{cid}#{slot}#{d}")
            gone += 1
    if gone:
        doc["entries"] = entries
        doc["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        tmp = A.FEEDBACK + ".tmp"
        with open(tmp, "w") as f:
            json.dump(doc, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, A.FEEDBACK)
    return gone


def _write_facing(cid, man, slot, d, frames):
    W, H = man["size"]["width"], man["size"]["height"]
    PX, PY = man["pad"]["x"], man["pad"]["y"]
    dst = os.path.join(mirror.ROOT, cid, "animations", slot, d)
    shutil.rmtree(dst, ignore_errors=True)
    os.makedirs(dst)
    names, padded = [], []
    for i, im in enumerate(frames):
        if im.size != (W, H):
            canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            canvas.paste(im, (PX, PY))
            im = canvas
        n = f"{i:02d}{mirror.ART_EXT}"
        im.save(os.path.join(dst, n), "WEBP", lossless=True, exact=True)
        names.append(n)
        padded.append(im)
    strip = Image.new("RGBA", (W * len(padded), H), (0, 0, 0, 0))
    for i, im in enumerate(padded):
        strip.paste(im, (i * W, 0))
    strip.save(os.path.join(mirror.ROOT, cid, "animations", f"{slot}__{d}{mirror.ART_EXT}"),
               "WEBP", lossless=True, exact=True)
    return names


def redo_graduated(client, cid, slot, dirs):
    mpath = os.path.join(mirror.ROOT, cid, "monster.json")
    man = json.load(open(mpath))
    anim = (man.get("animations") or {}).get(slot)
    if not anim:
        print(f"  {cid} {slot}: no such state on the monster")
        return False
    state = A.base_state(slot)
    spec = A.STATES[state]
    pid = (man.get("source") or {}).get("pixellab_id")
    words = anim.get("action") or spec["action"]
    src = (anim.get("source_name") or "").rstrip()
    if not anim.get("action") and src and not ("custom-" + spec["action"]).startswith(src):
        print(f"  {cid} {slot}: the take was made from other words ({src!r}); asking with the state's own")
    # frame count: what the facings he is NOT redoing use (a state is one length)
    keep = collections.Counter(len(r.get("frame_paths") or []) for dd, r in anim["directions"].items()
                               if dd not in dirs and r.get("frame_paths"))
    nf = keep.most_common(1)[0][0] if keep else spec["frames"]
    if spec.get("keep_first", True):
        nf -= 1
    nf = max(4, min(16, int(nf)))
    nf += nf % 2
    nw, nh = (man.get("native_size") or man["size"])["width"], (man.get("native_size") or man["size"])["height"]
    PX, PY = man["pad"]["x"], man["pad"]["y"]
    landed = []
    for gd in sorted({A.MIRRORED.get(d, d) for d in dirs}):
        notes = [n for d, n in dirs.items() if A.MIRRORED.get(d, d) == gd and n]
        action = words + (". " + "; ".join(notes) if notes else "")
        pd = _pixellab_name(cid, state, gd)
        rolls = max((anim["directions"].get(d) or {}).get("rolls", 1) for d in dirs if A.MIRRORED.get(d, d) == gd) + 1
        end = None
        if spec.get("pin_end"):
            rot = Image.open(os.path.join(mirror.ROOT, cid, "rotations", gd + mirror.ART_EXT)).convert("RGBA")
            end = rot.crop((PX, PY, PX + nw, PY + nh))
        seed = A.seed_for(cid, slot, gd, rolls)
        try:
            job = client.animate_v3(pid, state, action, pd, frame_count=nf, end_frame=end,
                                    seed=seed, keep_first=spec.get("keep_first", True))
            print(f"  {cid:16s} {slot} {gd:11s} job {job} {nf}f roll {rolls}", flush=True)
            j = client.wait_job(job, timeout=1800)
        except PixelLabError as e:
            print(f"  {cid} {slot} {gd}: {e}", flush=True)
            continue
        group = (j.get("last_response") or {}).get("animation_group_id")
        takes = [t for t in client.animation_takes(pid, action).get(pd) or [] if t["group"] == group]
        if not takes:
            print(f"  {cid} {slot} {gd}: job finished but no take for group {str(group)[:8]}")
            continue
        urls = takes[-1]["urls"]
        frames = [f for f in client.download_many(urls) if f is not None]
        if len(frames) != len(urls):
            print(f"  {cid} {slot} {gd}: downloaded {len(frames)}/{len(urls)} frames")
            continue
        frames = [f.convert("RGBA") for f in frames]
        for d in [d for d in dirs if A.MIRRORED.get(d, d) == gd]:
            out = frames if d == gd else [ImageOps.mirror(f) for f in frames]
            names = _write_facing(cid, man, slot, d, out)
            entry = {k: v for k, v in (anim["directions"].get(d) or {}).items()
                     if k not in ("refilled_from", "from_candidate", "lm")}
            entry.update({
                "frames": len(names), "src_frames": len(names),
                "strip": f"{cid}/animations/{slot}__{d}{mirror.ART_EXT}",
                "frame_paths": [f"{cid}/animations/{slot}/{d}/{n}" for n in names],
                "sub": client.sub_id(urls[0]), "group": group, "action": action, "rolls": rolls,
                "redone_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            })
            if d != gd:
                entry["mirrored_from"] = gd
            anim["directions"][d] = entry
            landed.append(d)
            print(f"  {cid:16s} {slot} {d:11s} landed ({len(names)} frames)", flush=True)
    if not landed:
        return False
    order = A.ALL_DIRS
    anim["directions"] = {d: anim["directions"][d] for d in sorted(anim["directions"], key=order.index)}
    tmp = mpath + ".tmp"
    with open(tmp, "w") as f:
        json.dump(man, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, mpath)
    print(f"  {cid} {slot}: {_drop_verdicts(cid, slot, landed)} verdict(s) cleared with the art they judged")
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    todo = live_redos()
    if not todo:
        print("no live redos")
        return
    client = PixelLabClient() if a.apply else None
    for (cid, slot), dirs in sorted(todo.items()):
        kind = "candidate" if _is_candidate(cid) else "graduated" if _is_graduated(cid) else "unknown"
        print(f"{cid} {slot} {sorted(dirs)} ({kind})", flush=True)
        if not a.apply:
            continue
        if kind == "candidate":
            redo_candidate(cid, slot, dirs)
        elif kind == "graduated":
            redo_graduated(client, cid, slot, dirs)
    if a.apply:
        cand.rebuild_index(cand.load_cfg())


if __name__ == "__main__":
    main()
