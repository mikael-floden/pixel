"""HEAL — a shipped world never names scenery art that no longer exists.

THE FLOW THIS IS (maintainer 2026-09-17, to scenery and maps2 together: *"You
need a way to directly remove/replace assets from the game when you have
revoked/removed them ... so you don't have to wait on him"*). His wiki verdict
is a standing removal order and the scenery agent deletes on it the same day;
a world that shipped the day before still names the art. The game tombstones
the 404 and draws nothing, render3 stops dead, and the repair used to wait for
a maps2 run (chimney_002: three days). Now the SCENERY agent runs this script
in the commit that deletes the art, and the world it pushes resolves. The
rule stays maps2's — nothing in it is a judgement the caller makes.

WHAT IS DANGLING. A placement whose piece dir or scenery.json is not on disk,
whose piece or state is listed in scenery/retired.json (scenery's contract
for removed art; never its config/retired_*.json, which also list ids retired
from the planner whose art still ships), whose state is not among the piece's
states, whose sprite
(or the rotation it wears under `dir`) is not on disk, or whose piece/state is
REJECTED in live/feedback/objects.json for the facing it wears. `--check`
lists them and exits 1; the build (world3grow.run) asserts none.

WHAT HEAL DOES, at the placement's own cell and nowhere else, deterministic
from the cell (crc32, never hash(): a salted seed re-rolls the map per run):
  1. the piece survives, its state is gone   -> another surviving state of
     the SAME piece in the same family (NOT_LIT -> NOT_LIT, LIT -> LIT);
  2. the piece is gone                       -> another piece of the SAME
     GROUP with a state of that family, the facing it needs, and a drawn
     height within HEIGHT_TOL of the old one's (the old scenery.json is read
     from git, so the deleted file is not needed) — a pool weighted by how
     close the height is, never a single "best";
  3. a LIT placement with no lit art left    -> the same piece unlit, `lit`
     cleared (a dark lamp keeps the street's shape; a hole does not);
  4. nothing fits                            -> the placement is DROPPED and
     named in the output.
Chimneys go through chimneys.pick (the roof and the fire decide). `--replace
old_group/old_id=new_group/new_id` maps a dangling piece to a named successor
one-to-one (a slot re-rolled under a NEW id keeps its composition). Heal
touches ONLY dangling placements — a diff of world.json after it is exactly
those — and NEVER rebuilds (the shipped world changes in place, maintainer
2026-09-13). It appends the push to maps2/reports/<world>.json so his change
page shows every healed cell; maps2 renders and links that page on its next
run (the page law: maps2/README.md "The change page").

    python3 maps2/pipeline/heal.py --check   maps2/worlds3/the_game
    python3 maps2/pipeline/heal.py --dry-run maps2/worlds3/the_game
    python3 maps2/pipeline/heal.py --apply   maps2/worlds3/the_game
    python3 maps2/pipeline/heal.py --apply   maps2/worlds3/the_game \\
        --replace chimneys/chimney_002=chimneys/chimney_041
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import subprocess
import sys
import zlib

_HERE = os.path.dirname(os.path.abspath(__file__))
MAPS2 = os.path.dirname(_HERE)
REPO = os.path.dirname(MAPS2)
sys.path.insert(0, _HERE)

HEIGHT_TOL = 0.25        # a stand-in piece's drawn height, as a fraction of the old
_FAMILY = re.compile(r"^(.*?)(?:_\d+)?$")


# -- what exists ---------------------------------------------------------------
def _retired(cache={}):
    """(gone piece rels, {piece rel: gone state names}) from scenery/retired.json
    — THE CONTRACT scenery publishes for removed art (scenery/retired@1: a
    piece listed has no manifest; a state listed is gone while its piece
    stays). Never scenery/config/retired_*.json: those also list ids retired
    from the PLANNER whose art still ships (chess_table_006/009, placed twice
    in the_game — dropping them would delete his chess). An absent file means
    nothing listed; the disk checks still catch every deletion."""
    if not cache:
        ids, states = set(), {}
        f = os.path.join(REPO, "scenery", "retired.json")
        if os.path.isfile(f):
            d = json.load(open(f)) or {}
            ids = {r["id"] for r in d.get("pieces") or [] if r.get("id")}
            for r in d.get("states") or []:
                if r.get("piece") and r.get("state"):
                    states.setdefault(r["piece"], set()).add(r["state"])
        cache["v"] = (ids, states)
    return cache["v"]


def _verdicts(cache={}):
    if not cache:
        try:
            cache["e"] = json.load(open(os.path.join(
                REPO, "live", "feedback", "objects.json"))).get("entries", {})
        except (OSError, ValueError):
            cache["e"] = {}
    return cache["e"]


def _rejected(piece, state=None, facing=None):
    """His REJECTED verdict on the root, or on the state for the facing worn
    (keys: scenery/<piece>, scenery/<piece>#<state>#<facing>)."""
    v = _verdicts()
    keys = [f"scenery/{piece}"]
    if state:
        st = state.lower()
        keys += [f"scenery/{piece}#{st}", f"scenery/{piece}#{st}#{facing or 'south'}"]
    return any((v.get(k) or {}).get("status") == "rejected" for k in keys)


def _meta(piece, cache={}):
    """The piece's scenery.json from disk, else from git (the commit before
    the one that deleted it) so a deleted piece still tells its height and
    states; None when git never had it either."""
    if piece in cache:
        return cache[piece]
    rel = f"scenery/{piece}/scenery.json"
    f = os.path.join(REPO, rel)
    m = None
    if os.path.isfile(f):
        try:
            m = json.load(open(f))
        except ValueError:
            m = None
    else:
        for spec in ("HEAD:" + rel,):
            try:
                m = json.loads(subprocess.check_output(
                    ["git", "-C", REPO, "show", spec], stderr=subprocess.DEVNULL))
                break
            except (subprocess.CalledProcessError, ValueError):
                pass
        if m is None:
            try:
                h = subprocess.check_output(
                    ["git", "-C", REPO, "log", "-n1", "--format=%H", "--", rel],
                    stderr=subprocess.DEVNULL).decode().strip()
                if h:
                    m = json.loads(subprocess.check_output(
                        ["git", "-C", REPO, "show", f"{h}^:{rel}"], stderr=subprocess.DEVNULL))
            except (subprocess.CalledProcessError, ValueError):
                m = None
    cache[piece] = m
    return m


def _on_disk(piece):
    return os.path.isfile(os.path.join(REPO, "scenery", piece, "scenery.json"))


def _sprite_rel(meta, state, facing):
    """The art file a placement draws: the state's (or the piece's) sprite,
    or its rotation for a turned facing; None when the record has none."""
    rec = ((meta.get("states") or {}).get(state) if state else None) or meta
    if facing and facing != "south":
        return ((rec.get("rotations") or {}) or {}).get(facing)
    return rec.get("sprite")


def family(state):
    return _FAMILY.match(state).group(1) if state else ""


def _height(meta):
    p = (meta or {}).get("placement") or {}
    return p.get("world_px_height") or p.get("content_px_height")


def why_dangling(p):
    """None when the placement resolves, else the reason in a few words."""
    piece = p.get("piece") or ""
    ids, states = _retired()
    if not piece or not _on_disk(piece):
        return "piece not on disk"
    if piece in ids:
        return "piece retired (scenery/retired.json)"
    meta = _meta(piece)
    if meta is None:
        return "scenery.json unreadable"
    st, facing = p.get("state"), p.get("dir")
    if st:
        if st not in (meta.get("states") or {}):
            return f"state {st} not published"
        if st in states.get(piece, ()):
            return f"state {st} retired (scenery/retired.json)"
    if _rejected(piece, st, facing):
        return "rejected in live/feedback/objects.json"
    rel = _sprite_rel(meta, st, facing)
    if not rel:
        return f"no art for facing {facing}" if facing else "no sprite published"
    if not os.path.isfile(os.path.join(REPO, "scenery", rel)):
        return f"art file missing: {rel}"
    return None


def dangling(doc):
    """[(index, placement, why)] over the world's scenery."""
    out = []
    for i, p in enumerate(doc.get("scenery") or []):
        w = why_dangling(p)
        if w:
            out.append((i, p, w))
    return out


# -- the re-pick ---------------------------------------------------------------
def _ok_state(piece, st, facing):
    return why_dangling({"piece": piece, "state": st, "dir": facing}) is None


def _states_of(piece, fam, facing, exclude=None):
    meta = _meta(piece) or {}
    return [s for s in sorted(meta.get("states") or {})
            if family(s) == fam and s != exclude and _ok_state(piece, s, facing)]


def _rng(cell, salt):
    r = zlib.crc32(f"heal|{salt}|{cell[0]}|{cell[1]}".encode()) & 0xffffffff
    def nxt():
        nonlocal r
        r = (r * 1103515245 + 12345) & 0x7fffffff
        return r / 0x80000000
    return nxt


def _weighted(pool, rnd):
    """One of (item, weight) by weight — a pool, never a rule."""
    tot = sum(w for _, w in pool)
    if tot <= 0:
        return None
    t = rnd() * tot
    for it, w in pool:
        t -= w
        if t <= 0:
            return it
    return pool[-1][0]


def _group_pieces(group):
    d = os.path.join(REPO, "scenery", group)
    if not os.path.isdir(d):
        return []
    ids, _ = _retired()
    return [f"{group}/{n}" for n in sorted(os.listdir(d))
            if os.path.isdir(os.path.join(d, n)) and f"{group}/{n}" not in ids
            and _on_disk(f"{group}/{n}") and not _rejected(f"{group}/{n}")]


def repick(p, replace=None):
    """The healed placement (a NEW dict), or None to drop it. `replace` maps a
    piece rel to its named successor."""
    piece, st, facing = p["piece"], p.get("state"), p.get("dir")
    cell = (int(p["x"]), int(p["y"]))
    group = piece.split("/")[0]
    fam = family(st)
    rnd = _rng(cell, piece)
    q = dict(p)

    def wear(new_piece, new_state):
        q["piece"] = new_piece
        if new_state:
            q["state"] = new_state
        else:
            q.pop("state", None)
        meta = _meta(new_piece) or {}
        if q.get("hflip") and meta.get("must_be_imbplemented_with_random_hflip") is False \
                and new_piece != piece:
            q["hflip"] = False
        if q.get("lit") and family(new_state) != "LIT":
            q.pop("lit", None)
        return q

    if group == "chimneys":
        import chimneys
        np_, ns = chimneys.pick(cell, [x for x in chimneys._pieces()
                                       if x not in _retired()[0]])
        if np_ and _ok_state(np_, ns, facing):
            return wear(np_, ns)
        return None

    # a named successor first
    if replace and piece in replace:
        succ = replace[piece]
        if _on_disk(succ):
            if st and _ok_state(succ, st, facing):
                return wear(succ, st)
            sts = _states_of(succ, fam, facing) if st else []
            if sts:
                return wear(succ, sts[int(rnd() * len(sts))])
            if not st and _ok_state(succ, None, facing):
                return wear(succ, None)

    # 1. the same piece, another state of the family
    if _on_disk(piece) and piece not in _retired()[0] and not _rejected(piece):
        if st:
            sts = _states_of(piece, fam, facing, exclude=st)
            if sts:
                return wear(piece, sts[int(rnd() * len(sts))])
        elif _ok_state(piece, None, facing):
            return wear(piece, None)

    # 2. another piece of the group, near the old drawn height, as a pool
    old_h = _height(_meta(piece))
    pool = []
    for cand in _group_pieces(group):
        if cand == piece:
            continue
        h = _height(_meta(cand))
        if old_h and h:
            d = abs(h - old_h) / float(old_h)
            if d > HEIGHT_TOL:
                continue
            w = 1.0 - d / HEIGHT_TOL + 0.05
        else:
            w = 0.5
        if st:
            sts = _states_of(cand, fam, facing)
            if not sts:
                continue
            pool.append(((cand, sts), w))
        elif _ok_state(cand, None, facing):
            pool.append(((cand, [None]), w))
    pick = _weighted(pool, rnd)
    if pick:
        cand, sts = pick
        return wear(cand, sts[int(rnd() * len(sts))])

    # 3. lit art gone everywhere: the same piece, dark
    if fam == "LIT" and _on_disk(piece) and piece not in _retired()[0]:
        sts = _states_of(piece, "NOT_LIT", facing)
        if sts:
            return wear(piece, sts[int(rnd() * len(sts))])
    return None


# -- the world -----------------------------------------------------------------
def _head(short=True):
    try:
        h = subprocess.check_output(["git", "-C", REPO, "rev-parse", "HEAD"],
                                    stderr=subprocess.DEVNULL).decode().strip()
        return h[:10] if short else h
    except subprocess.CalledProcessError:
        return ""


def _log_push(world_dir, fixed, dropped):
    """Append the heal to the world's change log (maps2/reports/<world>.json)
    — one card per cell, in a player's words. `commit` reads "heal" until
    maps2 renders the page and writes the commit that carried it."""
    name = os.path.basename(os.path.normpath(world_dir))
    f = os.path.join(MAPS2, "reports", f"{name}.json")
    if not os.path.isfile(f):
        return None
    log = json.load(open(f))
    changes = []
    for was, now, cell in fixed:
        ws = f"{was[0]}" + (f" {was[1]}" if was[1] else "")
        ns = f"{now[0]}" + (f" {now[1]}" if now[1] else "")
        changes.append({
            "name": f"{was[0].split('/')[-1]} retired — now {now[0].split('/')[-1]}",
            "what": f"The scenery review retired {ws}, which stood here. The cell "
                    f"keeps a piece of the same group, {ns}, picked by the world's own "
                    f"rule; nothing else on the map moved. (No 'before' picture: the "
                    f"art it would need is the art that was deleted.)",
            "cell": [cell[0], cell[1]], "before": None})
    for was, cell in dropped:
        ws = f"{was[0]}" + (f" {was[1]}" if was[1] else "")
        changes.append({
            "name": f"{was[0].split('/')[-1]} retired — nothing stands here now",
            "what": f"The scenery review retired {ws}, which stood here, and no piece of "
                    f"its group fits the spot (same family of state, the facing it wore, "
                    f"a drawn height near the old one). The cell is empty until the "
                    f"group grows again. (No 'before' picture: the art it would need is "
                    f"the art that was deleted.)",
            "cell": [cell[0], cell[1]], "before": None})
    log.setdefault("pushes", []).append({
        "date": _dt.date.today().isoformat(), "commit": "heal", "before": _head(),
        "title": f"Retired scenery healed: {len(fixed)} re-picked, {len(dropped)} dropped "
                 f"(scenery's own delete commit, maps2/pipeline/heal.py)",
        "changes": changes})
    json.dump(log, open(f, "w"), indent=1, ensure_ascii=False)
    open(f, "a").write("\n")
    return f


def check(world_dir):
    doc = json.load(open(os.path.join(world_dir, "world.json")))
    bad = dangling(doc)
    for i, p, why in bad:
        print(f"  DANGLING .scenery[{i}] {p['piece']} {p.get('state') or ''} "
              f"{p.get('dir') or ''} at ({p['x']}, {p['y']}): {why}")
    print(f"{world_dir}: {len(bad)} dangling of {len(doc.get('scenery') or [])} placements")
    return len(bad)


def heal(world_dir, write=True, replace=None, log=True):
    path = os.path.join(world_dir, "world.json")
    doc = json.load(open(path))
    fixed, dropped, keep = [], [], []
    for i, p in enumerate(doc.get("scenery") or []):
        why = why_dangling(p)
        if not why:
            keep.append(p)
            continue
        was = (p["piece"], p.get("state"))
        cell = (int(p["x"]), int(p["y"]))
        q = repick(p, replace)
        if q is None:
            dropped.append((was, cell))
            print(f"  DROP  .scenery[{i}] {was[0]} {was[1] or ''} at {cell}: {why}, nothing fits")
            continue
        keep.append(q)
        fixed.append((was, (q["piece"], q.get("state")), cell))
        print(f"  HEAL  .scenery[{i}] {was[0]} {was[1] or ''} -> {q['piece']} "
              f"{q.get('state') or ''} at {cell}: {why}")
    print(f"{world_dir}: {len(fixed)} re-picked, {len(dropped)} dropped, "
          f"{len(keep) - len(fixed)} untouched")
    if write and (fixed or dropped):
        doc["scenery"] = keep
        left = dangling(doc)
        assert not left, f"heal left {len(left)} dangling: {left[:3]}"
        json.dump(doc, open(path, "w"), separators=(",", ":"))
        if log:
            lf = _log_push(world_dir, fixed, dropped)
            if lf:
                print(f"  logged to {os.path.relpath(lf, REPO)} (commit 'heal' until the page is rendered)")
    return fixed, dropped


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("world_dir")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--check", action="store_true", help="list dangling placements; exit 1 if any")
    g.add_argument("--dry-run", action="store_true", help="show the heal, write nothing")
    g.add_argument("--apply", action="store_true", help="heal the world in place and log it")
    ap.add_argument("--replace", action="append", default=[], metavar="OLD=NEW",
                    help="a dangling piece's named successor (group/id=group/id)")
    ap.add_argument("--no-log", action="store_true", help="do not append to the change log")
    a = ap.parse_args()
    if a.check:
        sys.exit(1 if check(a.world_dir) else 0)
    rep = {}
    for s in a.replace:
        old, _, new = s.partition("=")
        assert old and new and "/" in old and "/" in new, f"--replace wants group/id=group/id, got {s!r}"
        rep[old] = new
    heal(a.world_dir, write=a.apply, replace=rep, log=not a.no_log)


if __name__ == "__main__":
    main()
