"""Recover jobs left in flight when a run was stopped, and finalize them.

Killing the runner does NOT cancel the PixelLab jobs — they are server side and
keep generating. Without this, that art is paid for and never downloaded, and
the objects sit UNTAGGED in the store (the SCENERY tag is applied at finalize),
so nothing can find them again.

Each in-flight piece is matched back to its object by the EXACT prompt the
runner submitted, so a recovered piece keeps the id, manifest and lights
promise it was planned with — no guessing from timestamps. Recovered pieces go
through the normal `finalize_piece`, so both gates still apply.

    python3 pipeline/drain.py cliff_vines/cliff_vine_124 cliff_vines/...
    python3 pipeline/drain.py --log /path/to/run.log      # infer from a log
"""

from __future__ import annotations

import argparse
import re
import sys
import time

import catalog
import factory
import loop
import viewer_build
from pixellab_client import PixelLabClient, PixelLabError


def inflight_from_log(path):
    """Pieces the log shows as submitted but never delivered or gated."""
    text = open(path).read()
    submitted = re.findall(r"» (\S+) submitted", text)
    gated = set(re.findall(r"x GATE (\S+):", text))
    delivered = set(re.findall(r"✔ (\S+)", text))
    return [s for s in submitted if s not in gated and s not in delivered]


def spec_for(cfg, rel_id):
    gid, pid = rel_id.split("/", 1)
    group = next((g for g in cfg["groups"] if g["id"] == gid), None)
    if group is None:
        return None, None
    idx = int(pid.rsplit("_", 1)[-1])
    return group, catalog.piece_spec(cfg, group, idx)


def submitted_description(cfg, spec):
    """Rebuild the exact string submit_piece sent, trim included."""
    desc = f"{spec['prompt']}, {cfg['style_base']}"
    if len(desc) > 1000:
        tail = spec.get("prompt_tail") or ""
        keep = 1000 - len(cfg["style_base"]) - len(tail) - 2
        body = spec.get("prompt_body") or spec["prompt"]
        desc = f"{body[:max(0, keep)].rstrip(' ,;—-')}{tail}, {cfg['style_base']}"
    return desc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pieces", nargs="*")
    ap.add_argument("--log")
    ap.add_argument("--wait-minutes", type=float, default=20.0)
    args = ap.parse_args()

    rel_ids = list(args.pieces)
    if args.log:
        rel_ids += inflight_from_log(args.log)
    rel_ids = [r for r in dict.fromkeys(rel_ids) if "/" in r]
    if not rel_ids:
        print("nothing to drain")
        return 0

    cfg = factory.load_config()
    client = PixelLabClient()
    done = factory.done_by_group()

    # Map submitted description -> object, over UNTAGGED objects only (a tagged
    # object was already finalized by the runner).
    untagged = {}
    for o in client.list_objects():
        if not (o.get("tags") or []):
            untagged.setdefault((o.get("prompt") or "").strip(), []).append(o)

    todo = []
    for rel in rel_ids:
        gid, pid = rel.split("/", 1)
        if pid in done.get(gid, set()):
            print(f"  · {rel} already on disk")
            continue
        group, spec = spec_for(cfg, rel)
        if spec is None:
            print(f"  ? {rel} unknown group")
            continue
        cands = untagged.get(submitted_description(cfg, spec).strip()) or []
        if not cands:
            print(f"  ? {rel} no matching object in the store")
            continue
        o = max(cands, key=lambda x: str(x.get("created_at")))
        untagged[submitted_description(cfg, spec).strip()].remove(o)
        todo.append((rel, group, spec, o["id"],
                     8 if int(spec["size"]) <= 168 else 1))

    print(f"draining {len(todo)} piece(s)")
    deadline = time.monotonic() + args.wait_minutes * 60
    saved = failed = 0
    while todo and time.monotonic() < deadline:
        still = []
        for rel, group, spec, oid, dirs in todo:
            try:
                o = client.get_object(oid)
            except PixelLabError:
                still.append((rel, group, spec, oid, dirs))
                continue
            if o.get("status") != "completed":
                still.append((rel, group, spec, oid, dirs))
                continue
            try:
                loop.finalize_piece(client, cfg, group, spec, oid, dirs, o,
                                    push=False)
                saved += 1
                print(f"  = recovered {rel}")
            except PixelLabError as e:
                failed += 1
                print(f"  x {rel}: {e}")
        todo = still
        if todo:
            time.sleep(15)
    for rel, *_ in todo:
        print(f"  ! {rel} still not finished — left in the store")
    if saved:
        viewer_build.build()
    print(f"drained: {saved} saved, {failed} gated/failed, {len(todo)} unfinished")
    return 0


if __name__ == "__main__":
    sys.exit(main())
