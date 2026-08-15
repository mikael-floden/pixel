"""Delete and regenerate the tree variants the maintainer rejected.

His verdicts are now per state and per orientation
(`scenery/trees/tree_074#not_lit_4#south`), so a rejection names one variant
rather than the whole tree. Standing order applies at this granularity too: a
rejected variant goes from the repo AND the PixelLab store, then the slot is
regenerated with the improved prompt and the sibling-similarity gate.
"""
import json, os, shutil, subprocess, sys, time
from datetime import datetime
sys.path.insert(0, os.path.dirname(__file__))
import factory, viewer_build, tree_variants as tv
from pixellab_client import PixelLabClient, PixelLabError
from PIL import Image

FEEDBACK = os.path.join(os.path.dirname(factory.ROOT), "live", "feedback", "objects.json")


# His rejection note IS the correction. "Change the shape", "DON'T LEAN RIGHT"
# are usable instructions and feeding them straight back beats guessing.
ACTIONABLE = ("remove", "don't", "dont", "do not", "change", "should",
              "not every", "must")

# ...BUT A NOTE THAT ASKS FOR SOMETHING TO GO AWAY CANNOT BE PASSED THROUGH.
# This is the lesson he taught me on the window prompt (2026-08-14): "I dont
# mention things like 'glass panes', 'the shutters', 'the stone', 'the
# woodgrain'. Those word will get this AI to start painting." Every material
# noun in a prompt lands in the conditioning as something to RENDER, so "No
# owl in the tree" is a reliable way to get an owl. Negating BEHAVIOUR works
# ("Do not draw the same tree again"); negating a NOUN backfires.
#
# So a removal note is translated into a POSITIVE description of the end state
# — what the art SHOULD show — which implies the absence without ever naming
# the thing. Each entry below is anchored to the note that produced it, from
# his 2026-08-15 round.
REMOVAL_CUES = ("no ", "no.", "remove", "to many", "too many", "not every",
                "should not", "shouldn't", "without")

POSITIVE_REWRITES = [
    # "No door into the tree", "No door", "The hole into the tree should not be
    # here", "To many variants with hole", "To many trees with hole in the
    # middle" — ancient_tree_002 (6), owl_snag_002 (3)
    (("door", "hole", "cave", "opening", "hollow", "entrance"),
     "The trunk is solid unbroken wood the whole way round, covered in "
     "continuous bark from root to crown."),
    # "No owl in the tree thanks", "No owl" x8 — owl_snag_001
    (("owl", "bird", "animal", "creature", "face", "eyes"),
     "The tree is bare wood and branches alone, empty of anything else."),
    # "Remove the cave/nest at the bottom" (earlier round)
    (("nest", "hive", "wasp", "bee"),
     "The branches are clean and empty along their whole length."),
]

# "Wrong color palette" x2 — honey_tree_002. Not a removal; a drift. Say what
# to keep, positively.
PALETTE_NOTE = ("color", "colour", "palette", "hue")
PALETTE_FIX = ("Use exactly the same colours as the source image — the same "
               "bark tone, the same leaf tone, the same shading.")


def corrective(note):
    n = (note or "").strip()
    if not n:
        return ""
    low = n.lower()

    if any(w in low for w in PALETTE_NOTE):
        return " " + PALETTE_FIX

    # A removal request never goes back verbatim — translate it.
    if any(c in low for c in REMOVAL_CUES):
        for nouns, positive in POSITIVE_REWRITES:
            if any(x in low for x in nouns):
                return " " + positive
        # Asked to remove something we have no positive phrasing for. Saying
        # nothing is strictly better than naming it: the structural gate still
        # forces a different tree, and a wrong prompt costs a generation AND
        # produces the very thing he rejected.
        return ""

    if not any(w in low for w in ACTIONABLE):
        return ""
    return " " + (n if n.endswith((".", "!")) else n + ".")


def _ts(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _committed(relpath):
    r = subprocess.run(["git", "log", "-1", "--format=%cI", "--", relpath],
                       cwd=factory.ROOT, capture_output=True, text=True)
    return _ts(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else None


def rejected_states():
    """Rejections that still describe the art on disk.

    STALENESS IS DECIDED BY TIME, NOT BY HASH. The wiki stamps a state verdict
    with the hash of the PIECE'S sprite, not the state's own — measured
    2026-08-15, 0 of 225 recent state verdicts matched their state sprite while
    the piece sprite matched exactly. Comparing against the state hash made
    every state rejection look already-fixed, and 33 real ones were reported to
    the maintainer as "nothing needs action". A state's art is newer than the
    verdict only if its sprite was committed after it."""
    e = json.load(open(FEEDBACK)).get("entries") or {}
    out = []
    for k, v in e.items():
        if not k.startswith("scenery/trees/") or "#" not in k:
            continue
        if v.get("status") != "rejected":
            continue
        rel, state = k.split("#")[0][len("scenery/"):], k.split("#")[1].upper()
        ent = ((factory.read_manifest(rel) or {}).get("states") or {}).get(state)
        if not ent or not os.path.exists(os.path.join(factory.ROOT, ent.get("sprite", ""))):
            continue
        vt, ct = _ts(v.get("updated_at")), _committed(ent["sprite"])
        if not (vt and ct and ct < vt):
            continue                    # art regenerated since — verdict spent
        out.append((rel, state, v.get("note") or v.get("comment") or ""))
    return sorted(set(out))


def main():
    dry = "--dry-run" in sys.argv
    todo = rejected_states()
    print(f"{len(todo)} rejected variant(s)")
    for rel, st, note in todo:
        print(f"  {rel} {st}  — {note[:80]}")
    if dry or not todo:
        return 0

    client = PixelLabClient()
    cfg = factory.load_config()
    note_for = {(rel, st): corrective(note) for rel, st, note in todo}
    for (rel, st), extra in sorted(note_for.items()):
        if extra:
            print(f"  correction for {rel} {st}:{extra}")
    # 1) remove the rejected art, repo and store
    for rel, st, _ in todo:
        man = factory.read_manifest(rel) or {}
        states = man.get("states") or {}
        e = states.pop(st, None)
        if e and e.get("pixellab_object_id"):
            try:
                client.delete_object(e["pixellab_object_id"])
            except PixelLabError:
                pass
        import shutil
        shutil.rmtree(os.path.join(factory.ROOT, tv.state_dir(rel, st)), ignore_errors=True)
        man["states"] = states
        factory.write_manifest(rel, man)
    print("removed rejected art; regenerating")

    # 2) regenerate, reusing the runner's own submit/finalize path
    flight = []
    ok = fail = 0
    for rel, st, _ in todo:
        man = factory.read_manifest(rel)
        _, plan = tv.plan_for(man, cfg)
        glow = dict((s, g) for s, g in plan).get(st)
        src = Image.open(os.path.join(factory.ROOT, man["sprite"])).convert("RGBA")
        p = tv.prompt_for(st, man.get("lights"), man.get("glow_concept"), glow, 0) + note_for.get((rel, st), "")
        try:
            flight.append([rel, st, glow, tv.submit(client, man["pixellab_object_id"], p, st),
                           0, src, man])
            print(f"» {rel} {st}", flush=True)
        except PixelLabError as ex:
            fail += 1
            print(f"  x {rel} {st}: {ex}", flush=True)

    deadline = time.monotonic() + 45 * 60
    while flight and time.monotonic() < deadline:
        still = []
        for entry in flight:
            rel, st, glow, oid, attempt, src, man = entry
            try:
                status = client.get_object(oid).get("status")
            except PixelLabError:
                still.append(entry); continue
            if status not in ("completed", "failed"):
                still.append(entry); continue
            retry = status == "failed"
            if not retry:
                try:
                    d = tv.finalize(client, rel, man, st, oid, src, glow)
                    ok += 1
                    print(f"  = {rel} {st} ({d:.0%} different)", flush=True)
                except PixelLabError as ex:
                    print(f"  ~ {str(ex)[:130]}", flush=True)
                    retry = str(ex).startswith("RETRY ")
                    if not retry:
                        fail += 1
            if retry:
                nxt = attempt + 1
                if nxt >= tv.MAX_PROMPT_TRIES:
                    fail += 1
                    print(f"  x {rel} {st}: gave up after {tv.MAX_PROMPT_TRIES} prompts", flush=True)
                    continue
                p = tv.prompt_for(st, man.get("lights"), man.get("glow_concept"), glow, nxt) + note_for.get((rel, st), "")
                try:
                    entry[3] = tv.submit(client, man["pixellab_object_id"], p, st)
                    entry[4] = nxt
                    still.append(entry)
                except PixelLabError:
                    fail += 1
        flight = still
        if flight:
            time.sleep(10)
    viewer_build.build()
    # Consume the verdicts this run made stale, so regenerated art carries no
    # leftover comment or rating (maintainer: "the new graphics should have no
    # comment or approve/reject"). Committed by the caller with the art.
    try:
        import consume_verdicts
        consume_verdicts.main()
    except Exception as _e:
        print(f"  ! verdict consumption skipped: {str(_e)[:120]}")
    print(f"\nredone: {ok} ok, {fail} failed, {len(flight)} unfinished")
    return 0


if __name__ == "__main__":
    sys.exit(main())
