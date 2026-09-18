"""Run maps2's HEAL on every published world inside the commit that deletes
scenery art — the flow agreed with the maps2 agent (their board, 2026-09-17).

Maintainer 2026-09-17: "You need a way to directly remove/replace assets from
the game when you have revoked/removed them ... so you don't have to wait on
him." The rule is theirs and lives in maps2/pipeline/heal.py (a dangling
placement is re-picked at its own cell — same piece / another state, or a
sibling of the group at the same height — or dropped and named); the TRIGGER
is ours: after the repo delete and after retired.py republished
scenery/retired.json, BEFORE the commit, for every world in
games2/config/publish.json userWorlds:

    python3 maps2/pipeline/heal.py --apply maps2/worlds3/<w>
    git add maps2/worlds3/<w>/world.json maps2/reports/<w>.json

in the SAME commit as the delete, heal's printed lines in the body. world.json
is maps2's file: claim it on our board first (pushed before the run), skip the
heal when their board or their assistant's names world.json in flight (the
world tombstones harmlessly until the next delete), and post to maps2 only on
a DROP or a traceback — a re-pick is its own record (the diff, and the entry
heal appends to maps2/reports/<w>.json for his change page).

    python3 scenery/pipeline/heal_worlds.py --check   # every published world resolves
    python3 scenery/pipeline/heal_worlds.py --dry-run # what a delete would heal now
"""
from __future__ import annotations

import datetime
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory  # noqa: E402

REPO = os.path.dirname(factory.ROOT)
HEAL = os.path.join(REPO, "maps2", "pipeline", "heal.py")
PUBLISH = os.path.join(REPO, "games2", "config", "publish.json")
BOARD = os.path.join(REPO, "coordination", "scenery.json")
PARTNER_BOARDS = ("maps2", "maps2-assistant")
IDLE = "idle — no file in scenery/ in flight"


def _git(*args, check=True):
    return subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True, check=check)


def worlds():
    try:
        with open(PUBLISH, encoding="utf-8") as f:
            return [w for w in json.load(f).get("userWorlds", []) if isinstance(w, str)]
    except (OSError, ValueError):
        return []


def world_files(w):
    return [f"maps2/worlds3/{w}/world.json", f"maps2/reports/{w}.json"]


def in_flight():
    """True when maps2 or its assistant names world.json as in flight."""
    for b in PARTNER_BOARDS:
        try:
            with open(os.path.join(REPO, "coordination", f"{b}.json"), encoding="utf-8") as f:
                cur = str(json.load(f).get("current") or "")
        except (OSError, ValueError):
            continue
        if "world.json" in cur and "IN FLIGHT" in cur.upper():
            return b
    return None


def _set_current(text):
    with open(BOARD, encoding="utf-8") as f:
        d = json.load(f)
    d["current"] = text
    d["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with open(BOARD, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2)


def claim(pieces):
    """Name world.json on our board and PUSH the claim before touching it.
    Only coordination/ is staged: the delete's own files stay for its commit."""
    _set_current("IN FLIGHT — heal after a scenery delete: maps2/worlds3/<userWorlds>/world.json + "
                 "maps2/reports/<w>.json (maps2's heal.py, the agreed flow); deleting: " + ", ".join(pieces[:8]))
    _git("add", "--", "coordination/scenery.json")
    _git("commit", "-q", "-m", "coordination: claim world.json for heal after a scenery delete", check=False)
    for _ in range(3):
        if _git("push", "-u", "origin", "HEAD:main", check=False).returncode == 0:
            return True
        _git("fetch", "origin", "main", check=False)
        _git("rebase", "origin/main", check=False)
    return False


def release():
    _set_current(IDLE)


def run(pieces, log=print):
    """Heal every published world. Returns {'files', 'lines', 'drops',
    'errors', 'changed'}; the caller stages `files` into the delete commit and
    puts `lines` in its body."""
    out = {"files": [], "lines": [], "drops": [], "errors": [], "changed": 0}
    busy = in_flight()
    if busy:
        out["lines"].append(f"heal skipped: {busy} names world.json in flight; the world tombstones "
                            f"harmlessly until the next delete")
        log("  " + out["lines"][-1])
        return out
    if not claim(pieces):
        out["lines"].append("heal skipped: could not push the world.json claim")
        log("  " + out["lines"][-1])
        return out
    try:
        for w in worlds():
            r = subprocess.run([sys.executable, HEAL, "--apply", f"maps2/worlds3/{w}"],
                               cwd=REPO, capture_output=True, text=True)
            lines = [ln for ln in (r.stdout or "").splitlines() if ln.strip()]
            out["lines"] += [f"[{w}] {ln.strip()}" for ln in lines]
            out["drops"] += [ln.strip() for ln in lines if ln.strip().startswith("DROP")]
            out["changed"] += sum(1 for ln in lines if ln.strip().startswith(("HEAL", "DROP")))
            if r.returncode != 0:
                out["errors"].append(f"[{w}] heal exited {r.returncode}: {(r.stderr or '').strip()[-600:]}")
            for f in world_files(w):
                if os.path.exists(os.path.join(REPO, f)):
                    out["files"].append(f)
        for ln in out["lines"]:
            log("  " + ln)
    finally:
        release()
    if out["drops"] or out["errors"]:
        _post_maps2(out)
    return out


def stage(files):
    if files:
        _git("add", "--", *files, check=False)
        _git("add", "--", "coordination/scenery.json", check=False)


def _post_maps2(out):
    text = ("HEAL AFTER A SCENERY DELETE — reporting as agreed, only because something dropped or raised. "
            + " | ".join(out["drops"][:12] + out["errors"][:3]))
    subprocess.run([sys.executable, os.path.join(REPO, "coordination", "board.py"),
                    "post", "scenery", "--to", "maps2", "--text", text],
                   cwd=REPO, capture_output=True, text=True)


def subject(removed_pieces, removed_states, out):
    """The agreed commit subject when heal changed the world; ours otherwise."""
    ids = ", ".join(sorted(set(removed_pieces + [s for s, _ in removed_states]))[:6])
    if out["changed"]:
        return f"maps2: retire {out['changed']} placement(s) of scenery removed by wiki verdict ({ids})"
    return None


def check():
    ok = True
    for w in worlds():
        r = subprocess.run([sys.executable, HEAL, "--check", f"maps2/worlds3/{w}"],
                           cwd=REPO, capture_output=True, text=True)
        print((r.stdout or "").strip().splitlines()[-1] if r.stdout else f"{w}: no output")
        ok &= r.returncode == 0
    print("PASS — every published world resolves" if ok else "FAIL — a published world names removed scenery; run a delete (or heal.py --apply)")
    return ok


def dry_run():
    for w in worlds():
        r = subprocess.run([sys.executable, HEAL, "--dry-run", f"maps2/worlds3/{w}"],
                           cwd=REPO, capture_output=True, text=True)
        print((r.stdout or r.stderr).strip())


if __name__ == "__main__":
    if "--check" in sys.argv:
        sys.exit(0 if check() else 1)
    dry_run()
