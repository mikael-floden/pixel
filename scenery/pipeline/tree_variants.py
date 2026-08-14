"""Fan every tree out into 7 variants using PixelLab's state mechanism.

The maintainer's reason (2026-08-14): "We have lots of different trees all
looking different. That will make a forest look dumb. We want several
versions/variants of the same tree." So a forest gets planted from several
variants of ONE tree instead of many unrelated trees.

Every tree ends with 5 NOT_LIT and 2 LIT variants. The art that exists today
counts as one of them — a dark tree is NOT_LIT_1, a lit tree is LIT_1 — so each
tree needs exactly 6 new states, generated FROM the existing object so they stay
the same tree in the same style.

THE PROMPTS ARE THE MAINTAINER'S. Short, literal, one instruction at a time:
"Keep the prompt straightforward and short. This AI is dumb. You need to be
clear as if you walk to a kid." Earlier today a longer prompt that listed the
things to preserve failed outright, because naming a thing puts it INTO the
conditioning — models do not reliably honour negation. Do not add preservation
clauses full of nouns.

Resumable: state lives on the filesystem, so an interrupted run picks up where
it stopped. Commits as it goes so the maintainer can follow along.

    python3 pipeline/tree_variants.py --dry-run
    python3 pipeline/tree_variants.py --limit 4
    python3 pipeline/tree_variants.py --max-minutes 600
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time

import numpy as np

import factory
import viewer_build
from pixellab_client import V2_BASE, PixelLabClient, PixelLabError
from PIL import Image

NOT_LIT = [f"NOT_LIT_{i}" for i in range(1, 6)]
LIT = [f"LIT_{i}" for i in range(1, 3)]
ALL_STATES = NOT_LIT + LIT
TAGS = ["SCENERY", "TREE"]
PARALLEL = 8
COMMIT_EVERY = 12
MAX_PROMPT_TRIES = 10

LEAD = "Redraw the tree in same style, but another variant of the same tree type."

# Ten rewordings of the LEAD, tried in order when a state keeps failing. The
# maintainer: "You should only give up on a generation if you have tried 10
# different prompts." Each stays short and literal; they vary how the "same
# tree, different individual" idea is put, because that is the instruction the
# model most often ignores.
LEAD_FALLBACKS = [
    LEAD,
    "Draw the same kind of tree again, but a different tree.",
    "Another tree of the same type, same art style, different shape.",
    "Same tree species, same style, but this one grew differently.",
    "Redraw this tree as a different individual of the same species.",
    "Keep the style and the species. Change the branches and the leaves.",
    "A sibling of this tree. Same type, same style, different growth.",
    "Same tree type and style. Move the branches and reshape the crown.",
    "Draw a second tree that belongs beside this one. Same type, same style.",
    "The same tree seen as a different specimen. Same style, new shape.",
]


def not_lit_clause():
    return "The tree should not glow."


def remove_glow_clause(glow):
    return f"This time the tree should not glow, so remove the {glow}."


def add_glow_clause(glow):
    return f"This time the tree should glow, {glow}."


def prompt_for(state, source_lights, source_glow, target_glow, attempt=0):
    lead = LEAD_FALLBACKS[min(attempt, len(LEAD_FALLBACKS) - 1)]
    if state.startswith("LIT"):
        return f"{lead} {add_glow_clause(target_glow)}"
    if source_lights == "LIGHTS_ON" and source_glow:
        return f"{lead} {remove_glow_clause(source_glow)}"
    return f"{lead} {not_lit_clause()}"


def plan_for(man, cfg):
    """Which states this tree still needs, and the glow text for each."""
    lights = man.get("lights")
    have = set((man.get("states") or {}).keys())
    # The existing art occupies one slot and is never regenerated.
    anchor = "LIT_1" if lights == "LIGHTS_ON" else "NOT_LIT_1"
    glow_pool = []
    for g in cfg["groups"]:
        if g["id"] == "trees":
            glow_pool = list(g.get("glow_concepts") or [])
            break
    own = man.get("glow_concept")
    # LIT_1 keeps the tree's own glow when it already has one; the other lit
    # slot gets a DIFFERENT concept so the two lit variants are not near-twins.
    others = [g for g in glow_pool if g != own] or glow_pool
    seed = factory._seed(man["id"], "glow")
    lit_glow = {
        "LIT_1": own or others[seed % len(others)],
        "LIT_2": others[(seed + 1) % len(others)],
    }
    todo = []
    for st in ALL_STATES:
        if st == anchor or st in have:
            continue
        todo.append((st, lit_glow.get(st)))
    return anchor, todo


def difference(a_img, b_img):
    """Fraction of the union's opaque pixels that differ — is this actually a
    NEW variant, or did the model hand back a near-copy? The maintainer: "You
    should check that the AI actually generated a new variant.\""""
    a = np.asarray(a_img.convert("RGBA")).astype(int)
    b = np.asarray(b_img.convert("RGBA").resize(a_img.size, Image.NEAREST)).astype(int)
    oa, ob = a[:, :, 3] > 16, b[:, :, 3] > 16
    union = oa | ob
    if union.sum() < 50:
        return 0.0
    changed = (np.abs(a[:, :, :3] - b[:, :, :3]).sum(2) > 40) | (oa ^ ob)
    return float((changed & union).sum()) / float(union.sum())


MIN_DIFFERENCE = 0.12          # below this it is the same picture again


def glow_score(img):
    """How much bright, saturated light the piece carries — used to confirm a
    LIT variant actually glows and a NOT_LIT one does not."""
    a = np.asarray(img.convert("RGBA")).astype(float)
    op = a[:, :, 3] > 16
    if op.sum() < 50:
        return 0.0
    v = a[:, :, :3].max(2)
    return float((v[op] > 200).mean())


def state_dir(rel, state):
    return f"{rel}/{state.lower()}"


def submit(client, oid, prompt, state):
    r = client._request("POST", f"{V2_BASE}/objects/{oid}/states",
                        json={"edit_description": prompt, "state_name": state})
    new = r.get("object_id")
    if not new:
        raise PixelLabError("no object_id returned")
    return new


def finalize(client, rel, man, state, new_oid, source_img):
    detail = client.get_object(new_oid)
    url = (detail.get("rotation_urls") or {}).get("south") or client.sprite_url(detail)
    if not url:
        raise PixelLabError(f"{rel}/{state}: no image on {new_oid}")
    size = int(man.get("size") or 192)
    img = factory._normalize(client._download(url).convert("RGBA"), size)

    diff = difference(source_img, img)
    if diff < MIN_DIFFERENCE:
        client.delete_object(new_oid)
        raise PixelLabError(
            f"RETRY {rel}/{state}: near-copy of the original "
            f"({diff:.0%} different, need {MIN_DIFFERENCE:.0%})")

    out = f"{state_dir(rel, state)}/sprite.webp"
    factory.save_webp(img, os.path.join(factory.ROOT, out))
    client.set_tags(new_oid, TAGS)

    # RE-READ before merging. Six states of one tree are in flight at once, and
    # each carries the manifest snapshot it was submitted with — writing that
    # stale copy back clobbers whatever its siblings finalized in the meantime.
    # Measured on the first batch: 10 of 14 generated states were missing from
    # their manifests, the art on disk but invisible to every consumer.
    fresh = factory.read_manifest(rel) or man
    states = dict(fresh.get("states") or {})
    states[state] = {"sprite": out, "pixellab_object_id": new_oid,
                     "difference_from_source": round(diff, 4),
                     "glow_score": round(glow_score(img), 4)}
    fresh["states"] = {k: states[k] for k in sorted(states)}
    factory.write_manifest(rel, fresh)
    return diff


def anchor_entry(man, anchor):
    return {"sprite": man["sprite"],
            "pixellab_object_id": man.get("pixellab_object_id"),
            "glow_score": round(glow_score(Image.open(
                os.path.join(factory.ROOT, man["sprite"]))), 4)}


def git_push(msg):
    root = os.path.dirname(factory.ROOT)
    subprocess.run(["git", "add", "-A", "scenery"], cwd=root, capture_output=True)
    subprocess.run(["git", "commit", "-q", "-m", msg], cwd=root, capture_output=True)
    subprocess.run(["git", "fetch", "origin", "main", "-q"], cwd=root, capture_output=True)
    subprocess.run(["git", "rebase", "origin/main", "-q"], cwd=root, capture_output=True)
    r = subprocess.run(["git", "push", "-u", "origin", "main"], cwd=root,
                       capture_output=True, text=True)
    return r.returncode == 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="max trees to touch")
    ap.add_argument("--max-states", type=int, default=0)
    ap.add_argument("--max-minutes", type=float, default=600.0)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    cfg = factory.load_config()
    client = PixelLabClient()
    trees = sorted(factory.done_by_group().get("trees", ()))
    if args.limit:
        trees = trees[:args.limit]

    queue = []
    for pid in trees:
        rel = f"trees/{pid}"
        man = factory.read_manifest(rel) or {}
        if not man.get("pixellab_object_id"):
            continue
        anchor, todo = plan_for(man, cfg)
        states = dict(man.get("states") or {})
        if anchor not in states:
            states[anchor] = anchor_entry(man, anchor)
            man["states"] = states
            factory.write_manifest(rel, man)
        for st, glow in todo:
            queue.append((rel, st, glow))
    if args.max_states:
        queue = queue[:args.max_states]

    print(f"{len(trees)} trees | {len(queue)} states to generate")
    if args.dry_run:
        for rel, st, glow in queue[:20]:
            man = factory.read_manifest(rel)
            print(f"  {rel} {st}: {prompt_for(st, man.get('lights'), man.get('glow_concept'), glow)}")
        return 0
    if not queue:
        return 0

    flight = []           # [rel, state, glow, oid, attempt, source_img, man]
    ok = failed = since_push = 0
    deadline = time.monotonic() + args.max_minutes * 60
    started = time.monotonic()

    while (queue or flight) and time.monotonic() < deadline:
        while queue and len(flight) < PARALLEL:
            rel, st, glow = queue.pop(0)
            man = factory.read_manifest(rel)
            src = Image.open(os.path.join(factory.ROOT, man["sprite"])).convert("RGBA")
            p = prompt_for(st, man.get("lights"), man.get("glow_concept"), glow, 0)
            try:
                oid = submit(client, man["pixellab_object_id"], p, st)
                flight.append([rel, st, glow, oid, 0, src, man])
                print(f"» {rel} {st} ({len(flight)} in flight, {len(queue)} queued)", flush=True)
            except PixelLabError as e:
                failed += 1
                print(f"  x {rel} {st}: submit — {str(e)[:150]}", flush=True)

        still = []
        for entry in flight:
            rel, st, glow, oid, attempt, src, man = entry
            try:
                status = client.get_object(oid).get("status")
            except PixelLabError:
                still.append(entry)
                continue
            if status not in ("completed", "failed"):
                still.append(entry)
                continue
            retry = status == "failed"
            if not retry:
                try:
                    d = finalize(client, rel, man, st, oid, src)
                    ok += 1
                    since_push += 1
                    mins = (time.monotonic() - started) / 60
                    print(f"  = {rel} {st} ({d:.0%} different) "
                          f"[{ok} done, {mins:.0f} min]", flush=True)
                except PixelLabError as e:
                    print(f"  ~ {str(e)[:140]}", flush=True)
                    retry = str(e).startswith("RETRY ")
                    if not retry:
                        failed += 1
            if retry:
                nxt = attempt + 1
                if nxt >= MAX_PROMPT_TRIES:
                    failed += 1
                    print(f"  x {rel} {st}: gave up after {MAX_PROMPT_TRIES} prompts",
                          flush=True)
                    continue
                shutil.rmtree(os.path.join(factory.ROOT, state_dir(rel, st)),
                              ignore_errors=True)
                p = prompt_for(st, man.get("lights"), man.get("glow_concept"), glow, nxt)
                try:
                    entry[3] = submit(client, man["pixellab_object_id"], p, st)
                    entry[4] = nxt
                    still.append(entry)
                except PixelLabError as e:
                    failed += 1
                    print(f"  x {rel} {st}: resubmit — {str(e)[:120]}", flush=True)

        flight = still
        if since_push >= COMMIT_EVERY:
            viewer_build.build()
            git_push(f"scenery: tree variants +{since_push} ({ok} generated)\n\n"
                     f"Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n"
                     f"Claude-Session: https://claude.ai/code/session_01JdiBzdgegEf8tCwqH6RWqj")
            print(f"  ^ pushed ({ok} total)", flush=True)
            since_push = 0
        if flight:
            time.sleep(10)

    viewer_build.build()
    if since_push:
        git_push(f"scenery: tree variants +{since_push} ({ok} generated)\n\n"
                 f"Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n"
                 f"Claude-Session: https://claude.ai/code/session_01JdiBzdgegEf8tCwqH6RWqj")
    print(f"\ndone: {ok} generated, {failed} failed, {len(queue) + len(flight)} left")
    return 0


if __name__ == "__main__":
    sys.exit(main())
