"""Publish `scenery/retired.json` — THE CONTRACT for art this domain has removed.

Maintainer 2026-09-17: "You need a way to directly remove/replace assets from
the game when you have revoked/removed them." A wiki rejection is a standing
order and the art goes at once (feedback.py, prune.py); the world went on
placing it (cupboard_004 x2 in August, chimney_002 x2 from 09-14) and the
game's gate stayed red until the maps agent happened to run. Nobody should wait
on anybody: this file is the JOIN point. It is derived from
config/retired_ids.json + config/retired_states.json (the records that keep the
scheduler from regenerating what he rejected), lists each retired state's
SURVIVING states so a consumer can re-state a placement instead of dropping it,
and is republished by viewer_build.build() — every tool that removes art ends
there. Consumers (maps2's retire tool, games2's gate) read it and never the
config files.

    {"schema": "scenery/retired@1", "generated_at": ...,
     "pieces": [{"id": "chimneys/chimney_002"}],
     "states": [{"piece": "chimneys/chimney_022", "state": "NOT_LIT_2",
                 "surviving": ["NOT_LIT_1", "NOT_LIT_5"]}]}

A piece listed under `pieces` has NO surviving state (the whole piece is gone);
a state listed under `states` is gone while its piece stays. `surviving` is
read from the piece's manifest at publish time, in manifest order.

    python3 scenery/pipeline/retired.py          # publish
    python3 scenery/pipeline/retired.py --check  # gate: file matches the configs
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory  # noqa: E402

OUT = os.path.join(factory.ROOT, "retired.json")
IDS = os.path.join(factory.ROOT, "config", "retired_ids.json")
STATES = os.path.join(factory.ROOT, "config", "retired_states.json")


def _load(p):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def derive():
    """GONE means the art is not there, not merely that the planner must not
    refill the slot. config/retired_ids.json also lists ids retired from the
    planner whose art still ships (chess_table_006 and _009 are retired ids,
    published pieces, and placed twice in the_game); telling a consumer to drop
    those would delete his two chess tables. So a piece is listed only when its
    manifest is absent, and a state only when its piece's manifest lacks it."""
    ids = _load(IDS)
    pieces = sorted(f"{group}/{pid}" for group, lst in ids.items() for pid in (lst or [])
                    if not factory.read_manifest(f"{group}/{pid}"))
    gone = set(pieces)
    states = []
    for rel, lst in sorted(_load(STATES).items()):
        if rel in gone:
            continue                      # the whole piece is listed already
        man = factory.read_manifest(rel)
        if not man:
            continue                      # no manifest at all: not a retired state, a missing piece the ids file does not know
        have = man.get("states") or {}
        dead = [s for s in sorted(lst or []) if s not in have]
        alive = [s for s in have if s not in set(lst or [])]
        for st in dead:
            states.append({"piece": rel, "state": st, "surviving": alive})
    return {"schema": "scenery/retired@1", "pieces": [{"id": p} for p in pieces], "states": states}


def publish(log=print):
    doc = derive()
    cur = _load(OUT)
    same = {k: v for k, v in cur.items() if k != "generated_at"} == doc
    if same:
        return False
    doc["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1)
        f.write("\n")
    log(f"  retired.json: {len(doc['pieces'])} piece(s), {len(doc['states'])} state(s)")
    return True


def stale():
    """Records that say DELETED about art that ships: retired ids with a
    manifest, retired states their manifest still carries. The maintainer read
    'retired' as 'removed' and thought his chess tables were gone (2026-09-17:
    "I love the chess-tables!") — six pieces were listed that way, none of
    them deleted. A record is a fact about the art, not a planner flag."""
    ids = _load(IDS)
    bad_ids = [(g, p) for g, l in ids.items() for p in (l or []) if factory.read_manifest(f"{g}/{p}")]
    bad_states = []
    for rel, lst in _load(STATES).items():
        man = factory.read_manifest(rel)
        if man:
            bad_states += [(rel, s) for s in (lst or []) if s in (man.get("states") or {})]
    return bad_ids, bad_states


def clean():
    """Un-list the stale records and republish. Safe: the generation phase is
    over and the loop creates only MISSING assets, so an id with a manifest is
    never re-rolled whether listed or not."""
    bad_ids, bad_states = stale()
    ids = _load(IDS)
    for g, p in bad_ids:
        ids[g] = [x for x in ids[g] if x != p]
        print(f"  un-listed {g}/{p} — its art ships")
    ids = {g: l for g, l in ids.items() if l}
    st = _load(STATES)
    for rel, s in bad_states:
        st[rel] = [x for x in st[rel] if x != s]
        print(f"  un-listed {rel} {s} — its art ships")
    st = {r: l for r, l in st.items() if l}
    for p, doc in ((IDS, ids), (STATES, st)):
        with open(p, "w") as f:          # factory.retire()'s own format, so the diff is the change
            json.dump({k: sorted(v) for k, v in sorted(doc.items()) if v}, f, indent=1)
            f.write("\n")
    publish()
    return len(bad_ids) + len(bad_states)


def check():
    cur = {k: v for k, v in _load(OUT).items() if k != "generated_at"}
    ok = cur == derive()
    bad_ids, bad_states = stale()
    for g, p in bad_ids:
        print(f"  listed as deleted, but ships: {g}/{p}")
    for rel, s in bad_states:
        print(f"  listed as deleted, but ships: {rel} {s}")
    ok = ok and not bad_ids and not bad_states
    print("PASS — retired.json matches the records and every record is about deleted art" if ok
          else "FAIL — run pipeline/retired.py --clean (stale records) or pipeline/retired.py (stale file)")
    return ok


if __name__ == "__main__":
    if "--check" in sys.argv:
        sys.exit(0 if check() else 1)
    if "--clean" in sys.argv:
        print(f"{clean()} stale record(s) removed")
        sys.exit(0)
    publish()
