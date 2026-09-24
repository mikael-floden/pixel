"""Candidate monsters: design → 8-direction base on PixelLab → review folder.

This is the one place the monsters domain SPENDS generations. The flow
(maintainer 2026-09-09):

  1. The agent designs a monster in config/candidates.json (high-detail
     prompt, size, skeleton template, name, lore).
  2. `generate` creates it on PixelLab with create-character-v3 from scratch
     — the 8 rotations only, NO animations — tags it MONSTER_CANDIDATE, and
     mirrors the rotations into monsters/candidates/<id>/ with a QA verdict.
  3. The maintainer reviews the 8 directions in the wiki. Only an APPROVED
     base earns animations: "if the initial 8 directions is not perfect —
     don't even think about continuing with that monster."

What "sound" means for the base, and what this file checks by machine:
  - all 8 directions present on one square canvas               (checked)
  - 1 px/px density, not a zoomed render: `run1`, the share of same-colour
    runs that are exactly one pixel long. Measured over the 57 shipped
    monsters: 0.47–0.83; the maintainer's reference for "zoomed"
    (storm_shellback, 256px) scores 0.32. Pass ≥ 0.50, warn ≥ 0.45,
    fail below.                                                   (checked)
  - the creature fits its canvas — no clipping at the border, not a speck
    in a huge frame                                               (checked)
  - each direction actually faces its direction; no garbage text baked into
    the art — a human (or the agent looking at the sheet) decides; the
    machine cannot.                                               (sheet.webp)

Never tags anything MONSTER: that tag is the shipping roster's ground truth
and sync.py would import a base with zero animations as a broken monster.

  python monsters/pipeline/candidates.py status
  python monsters/pipeline/candidates.py generate [--only id,id] [--dry-run]
  python monsters/pipeline/candidates.py redo --only id      # new seed, old
                                                             # PixelLab record deleted
  python monsters/pipeline/candidates.py qa                  # re-verdict from disk
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
import zlib
from datetime import datetime, timezone

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mirror  # noqa: E402
from pixellab_client import DIRECTIONS_8, PixelLabClient, PixelLabError  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "config", "candidates.json")
OUT = os.path.join(ROOT, "candidates")
INDEX = os.path.join(OUT, "index.json")
FEEDBACK = os.path.join(os.path.dirname(ROOT), "live", "feedback", "monsters.json")

MAX_SIZE = 256          # v3 hard limit. Density holds through 184 and is a coin
                        # flip from ~236 (measured over the 57 shipped: Cragback 236
                        # and Magmane 252 crisp, Voltshell 256 and Voidmaw 236 zoomed)
                        # — the run1 check, not the size cap, decides a big roll.
RUN1_PASS, RUN1_WARN = 0.50, 0.45
FILL_MIN, FILL_MAX = 0.12, 0.98   # content bbox area / canvas area
MIN_USD = 5.0           # stop generating below this many credits


# --- config -----------------------------------------------------------------

def load_cfg():
    with open(CFG) as f:
        return json.load(f)


def save_cfg(cfg):
    with open(CFG, "w") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
        f.write("\n")


def cdir(cid):
    return os.path.join(OUT, cid)


def manifest_path(cid):
    return os.path.join(cdir(cid), "candidate.json")


def load_manifest(cid):
    p = manifest_path(cid)
    if os.path.exists(p):
        with open(p) as f:
            return json.load(f)
    return None


def seed_for(cid, version):
    """Deterministic: same design + same version → same seed."""
    return (zlib.crc32(f"{cid}:v{version}".encode()) & 0x7FFFFFFF) or 1


# --- QA ----------------------------------------------------------------------

def run1(img):
    """Share of same-colour runs (rows + columns, opaque pixels) that are one
    pixel long. Crisp 1 px/px art scores high; an upscaled render scores low
    because every stroke is ≥2 px wide."""
    a = np.asarray(img.convert("RGBA"))
    op = a[..., 3] > 0
    n1 = n = 0
    for arr, mask in ((a, op), (a.transpose(1, 0, 2), op.T)):
        for row, m in zip(arr, mask):
            L, prev = 0, None
            for px, o in zip(row, m):
                if not o:
                    if L:
                        n += 1; n1 += (L == 1); L = 0
                    prev = None
                    continue
                t = tuple(px)
                if t == prev:
                    L += 1
                else:
                    if L:
                        n += 1; n1 += (L == 1)
                    L, prev = 1, t
            if L:
                n += 1; n1 += (L == 1)
    return n1 / max(1, n)


def qa_rotations(rots):
    """Machine verdict over {direction: PIL}. Returns a dict with per-direction
    metrics and an overall status: pass | warn | fail, plus reasons."""
    reasons, per = [], {}
    missing = [d for d in DIRECTIONS_8 if d not in rots]
    if missing:
        reasons.append(f"missing directions: {missing}")
    sizes = {im.size for im in rots.values()}
    if len(sizes) > 1:
        reasons.append(f"canvases differ: {sorted(sizes)}")
    worst = 1.0
    # CANONICAL ORDER, never insertion order: `rots` arrives in PixelLab's order
    # from generate and in the manifest's key order from `qa`, so iterating it
    # directly rewrote all 89 manifests with identical values in a different
    # order on every qa run (measured 2026-09-21 — 89 touched, 89 equal).
    for d in [x for x in DIRECTIONS_8 if x in rots] + [x for x in rots if x not in DIRECTIONS_8]:
        im = rots[d]
        w, h = im.size
        bb = im.getbbox()
        r1 = round(run1(im), 3)
        worst = min(worst, r1)
        rec = {"run1": r1, "bbox": bb}
        if not bb:
            reasons.append(f"{d}: empty image")
        else:
            fill = ((bb[2] - bb[0]) * (bb[3] - bb[1])) / float(w * h)
            rec["fill"] = round(fill, 3)
            touches = bb[0] == 0 or bb[1] == 0 or bb[2] == w or bb[3] == h
            rec["touches_edge"] = touches
            if touches:
                reasons.append(f"{d}: content touches the canvas edge (clipped)")
            if fill < FILL_MIN:
                reasons.append(f"{d}: content fills only {fill:.0%} of the canvas")
            if fill > FILL_MAX:
                reasons.append(f"{d}: content fills {fill:.0%} — no margin")
        per[d] = rec
    status = "pass"
    if worst < RUN1_WARN:
        reasons.append(f"zoomed render: min run1 {worst:.3f} < {RUN1_WARN}")
        status = "fail"
    elif worst < RUN1_PASS:
        reasons.append(f"soft density: min run1 {worst:.3f} < {RUN1_PASS} — eyeball it")
        status = "warn"
    if missing or any("clipped" in r or "empty" in r for r in reasons):
        status = "fail"
    return {"status": status, "min_run1": round(worst, 3), "reasons": reasons, "directions": per}


# --- disk --------------------------------------------------------------------

def write_candidate(cid, design, rots, meta):
    """Rotations + 8-up sheet + manifest, all through the domain's writers."""
    d = cdir(cid)
    if os.path.isdir(d):
        shutil.rmtree(d)
    os.makedirs(os.path.join(d, "rotations"), exist_ok=True)
    order = [x for x in DIRECTIONS_8 if x in rots]
    for x in order:
        mirror._save_png(rots[x], os.path.join(d, "rotations", f"{x}.png"))
    w = max(rots[x].width for x in order)
    h = max(rots[x].height for x in order)
    sheet = Image.new("RGBA", (w * len(order), h), (0, 0, 0, 0))
    for i, x in enumerate(order):
        sheet.alpha_composite(rots[x], (i * w, 0))
    mirror._save_png(sheet, os.path.join(d, "sheet.png"))
    man = {
        "id": cid,
        "name": design["name"],
        "tier": design.get("tier"),
        "scale": design.get("scale", "standard"),
        "lore": design.get("lore"),
        "biome": design.get("biome") or [],
        "items": design.get("items") or [],
        "prompt": design["prompt"],
        "size": [w, h],
        "template_id": design.get("template_id"),
        "directions": order,
        "rotations": {x: os.path.join(cid, "rotations", x + mirror.ART_EXT) for x in order},
        "sheet": os.path.join(cid, "sheet" + mirror.ART_EXT),
        "review": "pending",
        **meta,
    }
    with open(manifest_path(cid), "w") as f:
        json.dump(man, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return man


def _feedback_entries():
    try:
        return json.load(open(FEEDBACK))["entries"]
    except (FileNotFoundError, ValueError, KeyError):
        return {}


def rebuild_index(cfg):
    """monsters/candidates/index.json — what the wiki reads. Order follows the
    design file; only generated candidates appear."""
    items = []
    for design in cfg["candidates"]:
        man = load_manifest(design["id"])
        if man:
            # design-level fields follow the CONFIG (a manifest written before
            # a field existed, or before a lore rewrite, must not pin the old value)
            for k in ("name", "tier", "scale", "lore", "biome", "items"):
                if k in design:
                    man[k] = design[k]
            man.setdefault("scale", "standard")
            row = {k: man.get(k) for k in (
                "id", "name", "tier", "lore", "biome", "items", "size", "template_id",
                "scale", "pixellab_id", "version", "sheet", "rotations", "qa", "review", "notes",
                "generated_at")}
            # HIS OWN VERDICT ON THE 8 DIRECTIONS, published for consumers that
            # cannot read live/feedback themselves. `review` above is the
            # AGENT's field (has it acted yet); this is the maintainer's. The
            # wiki builds its registry at image-build time and never opens the
            # feedback file, so without this it could only infer approval from
            # "has animations on disk" — which is false for an approved design
            # nobody has animated yet (maintainer 2026-09-21: he wants those
            # listed as monsters in the making, not as candidates).
            _fb = _feedback_entries()
            _v = (_fb.get(f"monsters/{design['id']}")
                  or _fb.get(f"monsters/candidates/{design['id']}") or {})
            row["verdict"] = (_v.get("status") or "").lower() or None
            # WHERE THIS DESIGN IS ON ITS WAY TO BEING A MONSTER, for the wiki
            # to show (maintainer 2026-09-18: "If I have approved all animations
            # and the monster the monster should be a real monster and not a
            # candidate! ... Can you make the wiki show this state").
            # `blocking` is the short human reason it is not one yet.
            try:
                import graduate as _grad
                ok, chosen, why = _grad.eligible(design["id"], _feedback_entries())
                row["graduation"] = {
                    "state": "ready" if ok else "waiting",
                    "takes": chosen,
                    "blocking": why or None,
                }
            except Exception:
                pass
            items.append(row)
    os.makedirs(OUT, exist_ok=True)
    with open(INDEX, "w") as f:
        json.dump({
            "format": "monster-candidates@1",
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "art_ext": mirror.ART_EXT,
            "directions": list(DIRECTIONS_8),
            "review_states": ["pending", "approved", "rejected"],
            "feedback_key": "monsters/candidates/<id>",
            "count": len(items),
            "candidates": items,
        }, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return items


# --- generation --------------------------------------------------------------

def generate_one(client, cfg, design, version, verbose=True, adopt=None):
    cid = design["id"]
    dflt = cfg.get("defaults", {})
    size = int(design["size"])
    if size > MAX_SIZE:
        raise PixelLabError(f"{cid}: size {size} > {MAX_SIZE} — that is the zoomed-render regime")
    seed = seed_for(cid, version)
    t0 = time.monotonic()
    # Expression by tier (maintainer 2026-09-09: what sank five rejected bases
    # was execution, not concept — a derpy face on a sound design).
    suffix = (dflt.get("style_suffix") or {}).get(design.get("tier"), "")
    if adopt:
        pl_id, usage = adopt, {"adopted": True}
    else:
        pl_id, usage = client.create_character_v3(
            description=design["prompt"].rstrip(".") + suffix, size=size,
            view=design.get("view") or dflt.get("view", "low top-down"),
            template_id=design.get("template_id") or "mannequin",
            name=design["name"], seed=seed,
            outline=design.get("outline") or dflt.get("outline"),
            detail=design.get("detail") or dflt.get("detail"),
            job_timeout=2400)
    rots = client.character_rotations(pl_id)
    if len(rots) < 8:
        # an adopted orphan still rendering (or a job that finished with holes):
        # never write a half base, and never crash the worker over it — the
        # next generate adopts it once all eight are there
        raise PixelLabError(f"{cid}: only {len(rots)}/8 rotations on {pl_id} yet — left for the next run")
    tag = dflt.get("candidate_tag", "MONSTER_CANDIDATE")
    client.set_character_tags(pl_id, [tag])
    # FILED ONE COMPASS STEP LATE, AND FIXED IN POST BEFORE HE EVER SEES IT
    # (maintainer 2026-09-21, twice — scyth_arm: "SE is S, E is SE (same
    # offset on all directions), should be fixed in postprocess", then
    # hollow_gulp). create-character-v3 sometimes returns the whole 8-set
    # rotated; postprocess measures it from the art's own mirror symmetry and
    # re-files it. Measured over 143 candidates: 18 were out.
    import postprocess as _pp
    _k = _pp.measure_direction_offset_images(rots)
    if _k:
        rots = {DIRECTIONS_8[i]: rots[DIRECTIONS_8[(i + _k) % 8]]
                for i in range(len(DIRECTIONS_8)) if DIRECTIONS_8[(i + _k) % 8] in rots}
        print(f"  {cid}: direction offset {_k} step(s) — re-filed in post")
    qa = qa_rotations(rots)
    man = write_candidate(cid, design, rots, {
        "pixellab_id": pl_id, "seed": seed, "version": version, "usage": usage,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "elapsed_s": round(time.monotonic() - t0, 1), "qa": qa,
    })
    if verbose:
        print(f"  {cid:16s} v{version} {pl_id} {len(rots)} dirs {man['size']} "
              f"qa={qa['status']} run1={qa['min_run1']} usage={usage} "
              f"{man['elapsed_s']}s", flush=True)
        for r in qa["reasons"]:
            print(f"      - {r}")
    return man


def cmd_generate(args):
    cfg = load_cfg()
    if not args.redo:
        reconcile(cfg, client=_client_or_none())
    only = set(args.only.split(",")) if args.only else None
    todo = []
    for design in cfg["candidates"]:
        if only and design["id"] not in only:
            continue
        man = load_manifest(design["id"])
        if man and len(man.get("directions") or []) == 8 and not args.redo:
            continue
        todo.append(design)
    print(f"{len(todo)} candidate(s) to generate: {[d['id'] for d in todo]}")
    if args.dry_run or not todo:
        return
    client = PixelLabClient()
    client.require_key()
    # A BASE THAT OUTLIVED OUR WAIT IS STILL FINISHED AND PAID FOR. PixelLab's
    # queue ran past 15 minutes a job (2026-09-24) and the character completed
    # after we gave up, left untagged on the account; generating again pays
    # twice. So a design with no candidate on disk first adopts an UNTAGGED
    # character on the account carrying its exact name — the newest one.
    orphans = {}
    try:
        for it in client._list_all("characters"):
            if not it.get("tags") and it.get("name"):
                prev = orphans.get(it["name"])
                if not prev or (it.get("created_at") or "") > (prev.get("created_at") or ""):
                    orphans[it["name"]] = it
    except PixelLabError as e:
        print(f"  (orphan scan skipped: {e})")
    for design in todo:
        orphan = None if args.redo else orphans.get(design["name"])
        if orphan:
            try:
                print(f"  {design['id']}: adopting finished orphan {orphan['id']} — no new generation", flush=True)
                generate_one(client, cfg, design, 1, adopt=orphan["id"])
            except PixelLabError as e:
                print(f"  {design['id']}: adopt FAILED — {e}", flush=True)
            rebuild_index(cfg)
            continue
        usd = client.usd_credits()
        if usd < args.min_usd:
            print(f"STOP: ${usd:.2f} credits left < floor ${args.min_usd:.2f}")
            break
        prev = load_manifest(design["id"])
        version = (prev.get("version", 0) + 1) if prev else 1
        if prev and args.redo and prev.get("pixellab_id"):
            try:
                client.delete_character(prev["pixellab_id"])
                print(f"  {design['id']}: deleted PixelLab {prev['pixellab_id']} (v{prev.get('version')})")
            except PixelLabError as e:
                print(f"  {design['id']}: could not delete old record: {e}")
        try:
            generate_one(client, cfg, design, version)
        except PixelLabError as e:
            print(f"  {design['id']}: FAILED — {e}", flush=True)
        rebuild_index(cfg)
    print(f"credits left: ${client.usd_credits():.2f}")


def cmd_drop(args):
    """Retire candidates for good: delete the PixelLab record and the folder,
    move the design under config `retired` with the reason (so nobody
    re-attempts it), rebuild the index."""
    cfg = load_cfg()
    ids = set(args.only.split(","))
    client = PixelLabClient()
    keep, retired = [], cfg.setdefault("retired", [])
    known = {d["id"] for d in cfg["candidates"]}
    # strays: a folder/record for a design already retired or removed from the
    # config (a worker finished it after the design was cut) — delete both.
    for cid in ids - known:
        man = load_manifest(cid)
        if man and man.get("pixellab_id"):
            try:
                client.delete_character(man["pixellab_id"])
                print(f"  {cid}: deleted PixelLab {man['pixellab_id']} (stray)")
            except PixelLabError as e:
                print(f"  {cid}: could not delete PixelLab record: {e}")
        if os.path.isdir(cdir(cid)):
            shutil.rmtree(cdir(cid))
            print(f"  {cid}: removed stray folder")
        for r in retired:
            if r["id"] == cid and not r.get("retired"):
                r["retired"] = args.reason
    for design in cfg["candidates"]:
        if design["id"] not in ids:
            keep.append(design)
            continue
        man = load_manifest(design["id"])
        if man and man.get("pixellab_id"):
            try:
                client.delete_character(man["pixellab_id"])
                print(f"  {design['id']}: deleted PixelLab {man['pixellab_id']}")
            except PixelLabError as e:
                print(f"  {design['id']}: could not delete PixelLab record: {e}")
        if os.path.isdir(cdir(design["id"])):
            shutil.rmtree(cdir(design["id"]))
        design = dict(design, retired=args.reason,
                      retired_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                      versions_tried=(man or {}).get("version"))
        retired.append(design)
        print(f"  {design['id']}: retired — {args.reason}")
    cfg["candidates"] = keep
    save_cfg(cfg)
    rebuild_index(cfg)


def cmd_status(args):
    cfg = load_cfg()
    rows = []
    for design in cfg["candidates"]:
        man = load_manifest(design["id"])
        if not man:
            rows.append((design["id"], design["name"], design["size"], "-", "not generated", ""))
            continue
        rows.append((design["id"], design["name"], f"{man['size'][0]}", f"v{man.get('version')}",
                     f"qa={man['qa']['status']} run1={man['qa']['min_run1']}", man.get("review")))
    for r in rows:
        print(f"{r[0]:16s} {r[1]:12s} {str(r[2]):>4s} {r[3]:4s} {r[4]:28s} {r[5]}")
    done = sum(1 for r in rows if r[3] != "-")
    print(f"\n{done}/{len(rows)} generated")


def _client_or_none():
    try:
        return PixelLabClient()
    except Exception:
        return None


# --- reconcile --------------------------------------------------------------

def reconcile(cfg, client=None, apply=True, verbose=True, tags=False):
    """HIS REMOVALS ARE THE GROUND TRUTH, BOTH WAYS. Run before every command
    that shows or generates candidates (maintainer 2026-09-18: "I have also
    removed a lot of candidates I don't want to see more! No dangling states in
    the wiki! ... This is something you always should check and act on").

    Three ways a candidate can be removed, all reconciled here:
      1. rejected in the wiki   -> `live/feedback/monsters.json` status rejected
      2. untagged on PixelLab   -> MONSTER_CANDIDATE gone from the record
      3. deleted on PixelLab    -> the record itself is gone
    Each one retires the design, deletes the folder and the PixelLab record, and
    rebuilds the index. THEN the verdict that caused it is deleted from the
    feedback file: a verdict pointing at a candidate that no longer exists is a
    dangling reference the wiki can still surface, and acted-on feedback is
    deleted, never kept (his rule, first given for redo notes).
    Returns (removed_ids, pruned_feedback_keys).
    """
    onDisk = {d for d in os.listdir(OUT) if os.path.isdir(os.path.join(OUT, d))}
    fb = {}
    if os.path.exists(FEEDBACK):
        fb = json.load(open(FEEDBACK))
    ent = fb.get("entries", {})

    # HE REMOVES FROM EITHER PAGE AND BOTH MEAN THE SAME THING. The candidate
    # gallery writes `monsters/candidates/<id>`; the creature page of a design
    # being animated writes `monsters/<id>` — the SAME design, one key without
    # the `candidates/` segment. Reading only the first left nine removed
    # creatures sitting in the wiki with all five states on them (2026-09-18:
    # "Still a lot of monsters in the wiki I have already removed! Clean it up").
    remove = set()
    for k, v in ent.items():
        if "#" in k or not k.startswith("monsters/"):
            continue
        if v.get("status") != "rejected":
            continue
        cid = k.split("/")[-1]
        if cid in onDisk:
            remove.add(cid)

    # The tag sweep is OPT-IN (`reconcile --tags`). A candidate being redone has
    # its old PixelLab record DELETED before the new one exists, so an automatic
    # sweep reads a mid-flight redo as a removal and retires a live design
    # (paid for 2026-09-18: frozen_tent, retired 40 seconds into its own redo).
    # Rejection in the wiki is the automatic path and the one he asked for.
    if tags and client is not None:
        try:
            alive = {}
            for it in client._list_all("characters"):
                alive[it.get("id")] = [str(t).upper() for t in (it.get("tags") or [])]
            for design in cfg["candidates"]:
                man = load_manifest(design["id"])
                pid = (man or {}).get("pixellab_id")
                if not pid or design["id"] not in onDisk:
                    continue
                if pid not in alive or "MONSTER_CANDIDATE" not in alive[pid]:
                    remove.add(design["id"])
        except PixelLabError as e:
            if verbose:
                print(f"  (tag sweep skipped: {e})")

    if remove and apply:
        ns = argparse.Namespace(only=",".join(sorted(remove)),
                                reason="removed by the maintainer (rejected in the wiki or untagged on PixelLab); reconciled automatically")
        cmd_drop(ns)
        cfg.clear(); cfg.update(load_cfg())
        onDisk -= remove

    # A KEY IS AN ADDRESS, NOT AN ID. This used to compare the bare id
    # (`seed_husk`) against the roster, so `monsters/candidates/seed_husk` —
    # a gallery card graduation had deleted — read as alive, and 751 verdicts
    # piled up at addresses the wiki could not open. verdicts.py resolves the
    # WHOLE address, and carries a verdict to where the art moved rather than
    # dropping his word on art that still ships.
    import verdicts as _v                           # noqa: E402
    pruned = _v.settle(apply=apply, verbose=False)
    if verbose:
        print(f"reconcile: {len(remove)} candidate(s) removed, "
              f"{len(pruned)} dangling verdict(s) settled")
        _v.check(verbose=True)
    # AND THE OTHER DIRECTION: a candidate whose design and all five states he
    # has approved stops being a candidate and becomes a monster, by itself
    # (maintainer 2026-09-18: "When all animations have been approved and the
    # monster has been approved I want the monster to move to be a real monster
    # automatically!"). Import here — graduate imports this module.
    if apply:
        try:
            import graduate as _grad
            _grad.run(apply=True, verbose=verbose)
        except Exception as e:                      # never block a generate on it
            print(f"  (graduation skipped: {e})")
    return sorted(remove), pruned


def cmd_qa(args):
    cfg = load_cfg()
    reconcile(cfg, client=_client_or_none())
    for design in cfg["candidates"]:
        man = load_manifest(design["id"])
        if not man:
            continue
        rots = {}
        for d, rel in man["rotations"].items():
            p = os.path.join(OUT, rel)
            if os.path.exists(p):
                rots[d] = Image.open(p).convert("RGBA")
        man["qa"] = qa_rotations(rots)
        with open(manifest_path(design["id"]), "w") as f:
            json.dump(man, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"{design['id']:16s} qa={man['qa']['status']} run1={man['qa']['min_run1']} {man['qa']['reasons']}")
    rebuild_index(cfg)


def cmd_reconcile(args):
    cfg = load_cfg()
    removed, pruned = reconcile(cfg, client=_client_or_none(), apply=not args.dry_run,
                                tags=getattr(args, 'tags', False))
    for r in removed:
        print(f"  removed {r}")
    for k in pruned:
        print(f"  pruned verdict {k}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("generate", help="create every un-generated candidate")
    g.add_argument("--only", help="comma-separated candidate ids")
    g.add_argument("--dry-run", action="store_true")
    g.add_argument("--min-usd", type=float, default=MIN_USD)
    g.set_defaults(func=cmd_generate, redo=False)
    r = sub.add_parser("redo", help="regenerate with the next seed; deletes the old PixelLab record")
    r.add_argument("--only", required=True)
    r.add_argument("--min-usd", type=float, default=MIN_USD)
    r.set_defaults(func=cmd_generate, redo=True, dry_run=False)
    d = sub.add_parser("drop", help="retire candidates: delete PixelLab record + folder, keep the design under config.retired with the reason")
    d.add_argument("--only", required=True)
    d.add_argument("--reason", required=True)
    d.set_defaults(func=cmd_drop)
    sub.add_parser("status").set_defaults(func=cmd_status)
    sub.add_parser("qa", help="re-run the machine checks from disk").set_defaults(func=cmd_qa)
    pr = sub.add_parser("reconcile", help="act on his removals: rejected in the wiki or untagged/deleted on PixelLab -> retire, delete, prune the dangling verdicts")
    pr.add_argument("--dry-run", action="store_true")
    pr.add_argument("--tags", action="store_true", help="also sweep PixelLab tags (never run while a generate/redo is in flight)")
    pr.set_defaults(func=cmd_reconcile)
    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
