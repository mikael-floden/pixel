"""Delete and regenerate the tree variants the maintainer rejected.

His verdicts are now per state and per orientation
(`scenery/trees/tree_074#not_lit_4#south`), so a rejection names one variant
rather than the whole tree. Standing order applies at this granularity too: a
rejected variant goes from the repo AND the PixelLab store, then the slot is
regenerated with the improved prompt and the sibling-similarity gate.
"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(__file__))
import factory, viewer_build, tree_variants as tv
from pixellab_client import PixelLabClient, PixelLabError
from PIL import Image

FEEDBACK = os.path.join(os.path.dirname(factory.ROOT), "live", "feedback", "objects.json")


# His rejection note IS the correction. "Remove the cave/nest at the bottom",
# "Change the shape", "DON'T LEAN RIGHT" are all usable instructions, and
# feeding them straight back is far better than guessing what he meant. Notes
# that only DESCRIBE the fault ("To similar in structure", "E+A here is ugly")
# are skipped: they are already handled by the structural gate, or they are
# taste, and pasting them in would only confuse a literal model.
ACTIONABLE = ("remove", "don't", "dont", "do not", "change", "should",
              "not every", "must")


def corrective(note):
    n = (note or "").strip()
    if not n:
        return ""
    low = n.lower()
    if not any(w in low for w in ACTIONABLE):
        return ""
    return " " + (n if n.endswith((".", "!")) else n + ".")


def rejected_states():
    e = json.load(open(FEEDBACK)).get("entries") or {}
    out = []
    for k, v in e.items():
        if not k.startswith("scenery/trees/") or "#" not in k:
            continue
        if v.get("status") != "rejected":
            continue
        parts = k.split("#")
        out.append((parts[0][len("scenery/"):], parts[1].upper(),
                    v.get("note") or v.get("comment") or ""))
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
                    d = tv.finalize(client, rel, man, st, oid, src)
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
    print(f"\nredone: {ok} ok, {fail} failed, {len(flight)} unfinished")
    return 0


if __name__ == "__main__":
    sys.exit(main())
