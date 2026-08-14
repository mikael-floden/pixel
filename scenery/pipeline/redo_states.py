"""Regenerate specific tree states named on the command line.

For faults that are neither "he rejected it" nor "it is too similar" — the case
this was written for is the carved-initials glow, which drew literal LETTERS on
13 trees. He hit four of them in review and rejected every one; the other nine
were sitting in his queue waiting to waste his time. Fixing the concept stops
new ones, but the art already generated has to be replaced deliberately.

    python3 pipeline/redo_states.py trees/tree_001#LIT_1 trees/tree_012#LIT_1
    python3 pipeline/redo_states.py --from-file targets.json
"""
import argparse, json, os, shutil, sys, time
sys.path.insert(0, os.path.dirname(__file__))
import factory, viewer_build, tree_variants as tv
from pixellab_client import PixelLabClient, PixelLabError
from PIL import Image


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("targets", nargs="*")
    ap.add_argument("--from-file")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--max-minutes", type=float, default=240.0)
    args = ap.parse_args()

    todo = []
    for t in args.targets:
        rel, st = t.split("#")
        todo.append((rel, st.upper()))
    if args.from_file:
        todo += [(r, s.upper()) for r, s in json.load(open(args.from_file))]
    todo = sorted(set(todo))
    print(f"{len(todo)} state(s) to regenerate")
    if args.dry_run:
        for r, s in todo:
            print("  ", r, s)
        return 0
    if not todo:
        return 0

    client = PixelLabClient()
    cfg = factory.load_config()
    # generate first, swap after — never leave a tree short (see restructure.py)
    superseded = {}
    for rel, st in todo:
        e = ((factory.read_manifest(rel) or {}).get("states") or {}).get(st) or {}
        if e.get("pixellab_object_id"):
            superseded[(rel, st)] = e["pixellab_object_id"]

    queue, flight, ok, fail, since = list(todo), [], 0, 0, 0
    deadline = time.monotonic() + args.max_minutes * 60
    while (queue or flight) and time.monotonic() < deadline:
        while queue and len(flight) < tv.PARALLEL:
            rel, st = queue.pop(0)
            man = factory.read_manifest(rel)
            _, plan = tv.plan_for(man, cfg)
            glow = dict(plan).get(st)
            if st.startswith("LIT") and not glow:
                pool = next((g.get("glow_concepts") or [] for g in cfg["groups"]
                             if g["id"] == "trees"), [])
                glow = pool[factory._seed(man["id"], st) % len(pool)] if pool else None
            src = Image.open(os.path.join(factory.ROOT, man["sprite"])).convert("RGBA")
            p = tv.prompt_for(st, man.get("lights"), man.get("glow_concept"), glow, 0)
            try:
                flight.append([rel, st, glow, tv.submit(client, man["pixellab_object_id"], p, st),
                               0, src, man])
                print(f"» {rel} {st} ({len(flight)} in flight, {len(queue)} queued)", flush=True)
            except PixelLabError as ex:
                fail += 1
                print(f"  x {rel} {st}: {str(ex)[:110]}", flush=True)
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
                    old = superseded.pop((rel, st), None)
                    if old and old != oid:
                        try:
                            client.delete_object(old)
                        except PixelLabError:
                            pass
                    ok += 1; since += 1
                    print(f"  = {rel} {st} ({d:.0%} different) [{ok}]", flush=True)
                except PixelLabError as ex:
                    print(f"  ~ {str(ex)[:120]}", flush=True)
                    retry = str(ex).startswith("RETRY ")
                    if not retry:
                        fail += 1
            if retry:
                nxt = attempt + 1
                if nxt >= len(tv.LEAD_FALLBACKS):
                    fail += 1
                    print(f"  x {rel} {st}: exhausted prompts", flush=True)
                    continue
                p = tv.prompt_for(st, man.get("lights"), man.get("glow_concept"), glow, nxt)
                try:
                    entry[3] = tv.submit(client, man["pixellab_object_id"], p, st)
                    entry[4] = nxt
                    still.append(entry)
                except PixelLabError:
                    fail += 1
        flight = still
        if since >= tv.COMMIT_EVERY:
            viewer_build.build()
            tv.git_push("scenery: regenerate tree states carrying the carved-initials glow\n\n"
                        "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n"
                        "Claude-Session: https://claude.ai/code/session_01JdiBzdgegEf8tCwqH6RWqj")
            since = 0
        if flight:
            time.sleep(10)
    viewer_build.build()
    if since:
        tv.git_push("scenery: regenerate tree states carrying the carved-initials glow\n\n"
                    "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n"
                    "Claude-Session: https://claude.ai/code/session_01JdiBzdgegEf8tCwqH6RWqj")
    print(f"\nregenerated: {ok} ok, {fail} failed, {len(queue)+len(flight)} left")
    return 0


if __name__ == "__main__":
    sys.exit(main())
