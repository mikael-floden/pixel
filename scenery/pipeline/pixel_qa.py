"""Pixel-perfect QA: the agent's own zoomed review pass, made fast.

PixelLab sometimes fails to draw clean deliberate pixel art — the maintainer's
"absolute no go" (2026-08-13): broken pieces get removed WITHOUT waiting for
his review, on the agent's own judgement.

Why this is a review tool and not an automatic filter: statistical detection
was attempted honestly and FAILED. Six metrics (flat-neighbor fraction, color
density, 2x2 heterogeneity, soft-alpha fraction, near-duplicate blur ratio,
silhouette rim contrast) were calibrated on 213 maintainer-approved pieces vs
the 16 known-mush graves plus 225 rejected sprites recovered from git — every
one overlapped completely, because the Grave Seasons painterly style is
legitimately gradient-dense. What DOES separate mush from good art, proven
twice, is zoomed visual inspection. So the pipeline makes the agent's eyes
fast instead of pretending a threshold exists:

  python scenery/pipeline/pixel_qa.py --status            # what's unchecked
  python scenery/pipeline/pixel_qa.py --sheet             # zoom sheets to review
  python scenery/pipeline/pixel_qa.py --condemn trees/tree_009 ...
                                                          # delete broken pieces
  python scenery/pipeline/pixel_qa.py --pass-rest         # stamp the rest clean

Standing duty: after every generation run, the agent builds the sheet, LOOKS
at it, condemns mush (deleted from store + repo, slot re-rolls next run) and
stamps the rest. The log (config/qa_log.json) records every verdict so a
piece is inspected exactly once; pieces the maintainer already approved on
the wiki count as checked by his eyes.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
from datetime import datetime, timezone

from PIL import Image, ImageDraw, ImageFont

import factory
import feedback

QA_LOG = os.path.join(factory.ROOT, "config", "qa_log.json")


def _load_log():
    if not os.path.exists(QA_LOG):
        return {}
    with open(QA_LOG) as f:
        return json.load(f)


def _save_log(log):
    with open(QA_LOG, "w") as f:
        json.dump(log, f, indent=1, sort_keys=True)
        f.write("\n")


def _wiki_reviewed():
    """Pieces the maintainer has personally verdicted on the wiki — his eyes
    outrank this tool in both directions. STALENESS GUARD (same as
    feedback.py): a verdict older than the sprite's last commit judged the
    slot's PREVIOUS roll, so the current art is NOT reviewed."""
    out = set()
    for key, verdict in feedback.load_entries().items():
        rel = "/".join(key.split("/")[1:])
        verdict_at = feedback._parse_ts((verdict or {}).get("updated_at"))
        committed_at = feedback._sprite_committed_at(rel)
        if verdict_at and committed_at and committed_at < verdict_at:
            out.add(rel)
    return out


def unchecked():
    """Grouped pieces on disk nobody's eyes have cleared yet."""
    log, wiki = _load_log(), _wiki_reviewed()
    out = []
    for rel, meta in factory.discover():
        if "/" not in rel or rel in log or rel in wiki:
            continue
        if os.path.exists(os.path.join(factory.ROOT, rel, "sprite.webp")):
            out.append(rel)
    return out


def build_sheets(out_dir, per_sheet=48, zoom_to=220):
    """Zoomed, labeled contact sheets of every unchecked piece."""
    rels = unchecked()
    os.makedirs(out_dir, exist_ok=True)
    try:
        f = ImageFont.truetype(
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 13)
    except OSError:
        f = ImageFont.load_default()
    cols, cell_w, cell_h = 6, zoom_to + 16, zoom_to + 38
    paths = []
    for s in range(0, len(rels), per_sheet):
        chunk = rels[s:s + per_sheet]
        rows = (len(chunk) + cols - 1) // cols
        img = Image.new("RGB", (cols * cell_w + 12, rows * cell_h + 12), (40, 44, 52))
        d = ImageDraw.Draw(img)
        for i, rel in enumerate(chunk):
            x = 6 + (i % cols) * cell_w
            y = 6 + (i // cols) * cell_h
            d.rectangle([x, y, x + cell_w - 6, y + cell_h - 6], fill=(52, 57, 66))
            sp = Image.open(os.path.join(factory.ROOT, rel, "sprite.webp")).convert("RGBA")
            z = max(1, zoom_to // max(sp.size))
            if z > 1:
                sp = sp.resize((sp.width * z, sp.height * z), Image.NEAREST)
            elif max(sp.size) > zoom_to:
                r = zoom_to / max(sp.size)
                sp = sp.resize((int(sp.width * r), int(sp.height * r)), Image.NEAREST)
            img.paste(sp, (x + (cell_w - 6 - sp.width) // 2,
                           y + 4 + (zoom_to - sp.height) // 2), sp)
            d.text((x + 6, y + cell_h - 26), rel, font=f, fill=(215, 218, 224))
        p = os.path.join(out_dir, f"qa_sheet_{s // per_sheet + 1:02d}.png")
        img.save(p)
        paths.append(p)
    return rels, paths


def condemn(client, rels):
    """The agent's own removal: broken pixel art out of store + repo."""
    log = _load_log()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    gone = []
    for rel in rels:
        meta = factory.read_manifest(rel)
        if meta is None:
            print(f"  ! {rel}: not on disk, skipped")
            continue
        oid = meta.get("pixellab_object_id")
        if oid:
            try:
                client.delete_object(oid)
            except Exception as e:
                if "404" not in str(e):
                    print(f"  ! store delete failed for {rel}: {str(e)[:100]}")
        shutil.rmtree(factory.piece_dir(rel), ignore_errors=True)
        log[rel] = {"verdict": "condemned", "at": now,
                    "reason": "broken pixel art (agent visual QA)"}
        gone.append(rel)
    _save_log(log)
    return gone


def pass_rest():
    log = _load_log()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rels = unchecked()
    for rel in rels:
        log[rel] = {"verdict": "pass", "at": now}
    _save_log(log)
    return rels


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Agent visual QA for scenery pixels.")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--sheet", action="store_true")
    ap.add_argument("--out", default=os.path.join(factory.ROOT, "..", ".qa_sheets"))
    ap.add_argument("--condemn", nargs="+", metavar="REL_ID")
    ap.add_argument("--pass-rest", action="store_true")
    args = ap.parse_args()

    if args.condemn:
        from pixellab_client import PixelLabClient
        gone = condemn(PixelLabClient(), args.condemn)
        print(f"condemned {len(gone)}: {', '.join(gone)}")
        print("(rebuild viewer + commit is the caller's job — see loop.commit_push)")
    if args.pass_rest:
        rels = pass_rest()
        print(f"stamped {len(rels)} piece(s) as pass")
    if args.sheet:
        rels, paths = build_sheets(os.path.abspath(args.out))
        print(f"{len(rels)} unchecked piece(s) -> {len(paths)} sheet(s):")
        for p in paths:
            print(" ", p)
    if args.status or not any([args.sheet, args.condemn, args.pass_rest]):
        rels = unchecked()
        print(f"unchecked: {len(rels)}")
        for r in rels[:20]:
            print(" ", r)
        if len(rels) > 20:
            print(f"  … +{len(rels) - 20}")
