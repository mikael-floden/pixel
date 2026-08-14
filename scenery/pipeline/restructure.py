"""Find tree variants too close in STRUCTURE to the original (or to a sibling)
and regenerate them until the shape actually changes.

The maintainer, after reviewing 23 trees: "Would be nice if you run a script to
find trees that are in structure (branches, root, angle, etc) way to similar to
the original. They have to be re-generated (unless I have approved them
already). If it's hard to get the trees into a new shape and form try to change
the prompt until they change form."

ANYTHING HE HAS APPROVED IS UNTOUCHABLE, whatever it measures. His verdict
outranks the metric — the metric exists to find what he has not looked at yet.

Similarity is measured colour-blind (brightness-normalised), because a recolour
is not a new tree. Threshold 0.25 sits between the median of what he rejected
(0.196) and the median of what he approved (0.425).

    python3 pipeline/restructure.py --dry-run
    python3 pipeline/restructure.py --threshold 0.25
"""
import argparse, json, os, shutil, sys, time
sys.path.insert(0, os.path.dirname(__file__))
import factory, viewer_build, tree_variants as tv
from pixellab_client import PixelLabClient, PixelLabError
from PIL import Image

FEEDBACK = os.path.join(os.path.dirname(factory.ROOT), "live", "feedback", "objects.json")


def _verdicts():
    try:
        return json.load(open(FEEDBACK)).get("entries") or {}
    except (OSError, ValueError):
        return {}


def find(threshold):
    fb = _verdicts()
    out = []
    for pid in sorted(factory.done_by_group().get("trees", ())):
        rel = f"trees/{pid}"
        man = factory.read_manifest(rel) or {}
        states = man.get("states") or {}
        anchor = "LIT_1" if man.get("lights") == "LIGHTS_ON" else "NOT_LIT_1"
        if anchor not in states:
            continue
        imgs = {}
        for s, e in states.items():
            p = os.path.join(factory.ROOT, e.get("sprite", ""))
            if os.path.exists(p):
                imgs[s] = Image.open(p).convert("RGBA")
        if anchor not in imgs:
            continue
        for s, img in imgs.items():
            if s == anchor:
                continue                      # never regenerate the original art
            if (fb.get(f"scenery/{rel}#{s.lower()}#south") or {}).get("status") == "approved":
                continue                      # his verdict outranks the metric
            vs_src = tv.structural_difference(imgs[anchor], img)
            sib = min((tv.structural_difference(img, o)
                       for s2, o in imgs.items() if s2 != s), default=9.0)
            worst = min(vs_src, sib)
            if worst < threshold:
                out.append((rel, s, round(vs_src, 3), round(sib, 3)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--threshold", type=float, default=0.25)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--max-minutes", type=float, default=600.0)
    args = ap.parse_args()

    todo = find(args.threshold)
    if args.limit:
        todo = todo[:args.limit]
    print(f"{len(todo)} variant(s) too similar (threshold {args.threshold}), "
          f"approved ones excluded")
    if args.dry_run:
        for rel, s, a, b in todo[:40]:
            print(f"  {rel} {s:10} vs-original {a:.3f}  vs-sibling {b:.3f}")
        return 0
    if not todo:
        return 0

    client = PixelLabClient()
    cfg = factory.load_config()
    # GENERATE FIRST, SWAP AFTER. An earlier version deleted every target up
    # front "so the sibling comparison cannot match the art being replaced" --
    # but finalize already skips the state it is regenerating, so the deletion
    # bought nothing and left the maintainer looking at a wiki full of trees
    # missing most of their variants for an hour ("I can also see now that not
    # all trees has 7 states in the wiki", 2026-08-14). The old art now stays
    # until its replacement has passed the gate and overwritten it; only the
    # superseded PixelLab object is deleted, once that has happened.
    superseded = {}
    for rel, s, _, _ in todo:
        e = ((factory.read_manifest(rel) or {}).get("states") or {}).get(s) or {}
        if e.get("pixellab_object_id"):
            superseded[(rel, s)] = e["pixellab_object_id"]

    queue = list(todo)
    flight, ok, fail, since = [], 0, 0, 0
    deadline = time.monotonic() + args.max_minutes * 60
    while (queue or flight) and time.monotonic() < deadline:
        while queue and len(flight) < tv.PARALLEL:
            rel, s, _, _ = queue.pop(0)
            man = factory.read_manifest(rel)
            _, plan = tv.plan_for(man, cfg)
            glow = dict(plan).get(s)
            src = Image.open(os.path.join(factory.ROOT, man["sprite"])).convert("RGBA")
            p = tv.prompt_for(s, man.get("lights"), man.get("glow_concept"), glow, 0)
            try:
                flight.append([rel, s, glow, tv.submit(client, man["pixellab_object_id"], p, s),
                               0, src, man])
                print(f"» {rel} {s} ({len(flight)} in flight, {len(queue)} queued)", flush=True)
            except PixelLabError as ex:
                fail += 1
                print(f"  x {rel} {s}: {str(ex)[:110]}", flush=True)
        still = []
        for entry in flight:
            rel, s, glow, oid, attempt, src, man = entry
            try:
                status = client.get_object(oid).get("status")
            except PixelLabError:
                still.append(entry); continue
            if status not in ("completed", "failed"):
                still.append(entry); continue
            retry = status == "failed"
            if not retry:
                try:
                    d = tv.finalize(client, rel, man, s, oid, src, glow)
                    old_oid = superseded.pop((rel, s), None)
                    base = (factory.read_manifest(rel) or {}).get("pixellab_object_id")
                    if old_oid and old_oid != oid and old_oid != base:
                        try:
                            client.delete_object(old_oid)
                        except PixelLabError:
                            pass
                    ok += 1; since += 1
                    print(f"  = {rel} {s} reshaped ({d:.0%} different) [{ok}]", flush=True)
                except PixelLabError as ex:
                    print(f"  ~ {str(ex)[:120]}", flush=True)
                    retry = str(ex).startswith("RETRY ")
                    if not retry:
                        fail += 1
            if retry:
                nxt = attempt + 1
                if nxt >= len(tv.LEAD_FALLBACKS):
                    fail += 1
                    print(f"  x {rel} {s}: no prompt produced a new shape", flush=True)
                    continue
                p = tv.prompt_for(s, man.get("lights"), man.get("glow_concept"), glow, nxt)
                try:
                    entry[3] = tv.submit(client, man["pixellab_object_id"], p, s)
                    entry[4] = nxt
                    still.append(entry)
                except PixelLabError:
                    fail += 1
        flight = still
        if since >= tv.COMMIT_EVERY:
            viewer_build.build()
            tv.git_push(f"scenery: reshaped {since} tree variant(s) that were too "
                        f"close in structure\n\n"
                        f"Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n"
                        f"Claude-Session: https://claude.ai/code/session_01JdiBzdgegEf8tCwqH6RWqj")
            print(f"  ^ pushed ({ok} total)", flush=True)
            since = 0
        if flight:
            time.sleep(10)
    viewer_build.build()
    if since:
        tv.git_push(f"scenery: reshaped {since} tree variant(s) too close in structure\n\n"
                    f"Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n"
                    f"Claude-Session: https://claude.ai/code/session_01JdiBzdgegEf8tCwqH6RWqj")
    print(f"\nreshaped: {ok} ok, {fail} failed, {len(queue)+len(flight)} left")
    return 0


if __name__ == "__main__":
    sys.exit(main())
