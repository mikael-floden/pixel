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

MAX_SIZE = 176          # density holds through 184, degrades from ~236 (measured)
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
    for d, im in rots.items():
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


def rebuild_index(cfg):
    """monsters/candidates/index.json — what the wiki reads. Order follows the
    design file; only generated candidates appear."""
    items = []
    for design in cfg["candidates"]:
        man = load_manifest(design["id"])
        if man:
            items.append({k: man.get(k) for k in (
                "id", "name", "tier", "lore", "biome", "items", "size", "template_id",
                "pixellab_id", "version", "sheet", "rotations", "qa", "review", "notes",
                "generated_at")})
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

def generate_one(client, cfg, design, version, verbose=True):
    cid = design["id"]
    dflt = cfg.get("defaults", {})
    size = int(design["size"])
    if size > MAX_SIZE:
        raise PixelLabError(f"{cid}: size {size} > {MAX_SIZE} — that is the zoomed-render regime")
    seed = seed_for(cid, version)
    t0 = time.monotonic()
    pl_id, usage = client.create_character_v3(
        description=design["prompt"], size=size,
        view=design.get("view") or dflt.get("view", "low top-down"),
        template_id=design.get("template_id") or "mannequin",
        name=design["name"], seed=seed,
        outline=design.get("outline") or dflt.get("outline"),
        detail=design.get("detail") or dflt.get("detail"))
    rots = client.character_rotations(pl_id)
    tag = dflt.get("candidate_tag", "MONSTER_CANDIDATE")
    client.set_character_tags(pl_id, [tag])
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
    for design in todo:
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


def cmd_qa(args):
    cfg = load_cfg()
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
    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
