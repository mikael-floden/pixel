"""Mirror ONE PixelLab item into items/<id>/.

An item is a still 48×48-ish sprite the maintainer authored in the PixelLab
create-object UI and tagged with its type (MISC, SOUL, …). PixelLab owns the
art; this repo owns the *metadata* — name, type, category, rarity, gold value,
soul power, blurb — which lives in `config/roster.json` and is stamped into
every `items/<id>/item.json` on each sync.

Mirroring is one image download per item and costs ZERO generations. Art that
has not changed upstream is skipped via If-Modified-Since (the stamp lives in
the manifest under `source.last_modified`).

Layout, one folder per item — `item.json` is the contract the game and the
wiki read:

  items/<id>/
    item.json      manifest (everything below, plus the metadata)
    sprite.webp    the item icon, lossless WebP with alpha
"""

from __future__ import annotations

import datetime
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESERVED_DIRS = {"pipeline", "config"}
# Sprites are stored as LOSSLESS WebP: pixel-identical to the PNG PixelLab
# serves (verified on all 105 sprites) at a third of the bytes, and every
# browser the game targets decodes it natively. Nothing in this domain parses
# the image bytes — consumers read the path out of the manifest/registry — so
# the format is a local decision here.
SPRITE_FILE = "sprite.webp"
LEGACY_SPRITE = "sprite.png"
CONFIG_DIR = os.path.join(ROOT, "config")
TYPES_PATH = os.path.join(CONFIG_DIR, "types.json")


# --- small helpers -----------------------------------------------------------

def _slug(s):
    return re.sub(r"[^a-z0-9]+", "_", (s or "").lower()).strip("_")


def item_dir(iid):
    return os.path.join(ROOT, iid)


def manifest_path(iid):
    return os.path.join(item_dir(iid), "item.json")


def _rel(p):
    return os.path.relpath(p, os.path.dirname(ROOT))


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()


def load_types():
    with open(TYPES_PATH) as f:
        return json.load(f)


def read_manifest(iid, default=None):
    p = manifest_path(iid)
    if not os.path.exists(p):
        return default
    try:
        with open(p) as f:
            return json.load(f)
    except ValueError:
        return default


def write_manifest(iid, data):
    os.makedirs(item_dir(iid), exist_ok=True)
    with open(manifest_path(iid), "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def iter_manifests():
    """(id, manifest) for every item folder on disk."""
    for name in sorted(os.listdir(ROOT)):
        if name.startswith(".") or name in RESERVED_DIRS:
            continue
        if not os.path.isdir(item_dir(name)):
            continue
        meta = read_manifest(name)
        if meta is not None:
            yield name, meta


# --- the mirror ---------------------------------------------------------------

def mirror(client, entry, detail=None, types=None, fresh=False):
    """Mirror one roster entry into items/<id>/. Returns (manifest, changed)."""
    iid = entry["id"]
    types = types or load_types()
    tdef = types["types"].get(entry["type"], {})
    detail = detail if detail is not None else client.get_object(entry["pixellab_id"])

    prev = read_manifest(iid) or {}
    url = client.sprite_url(detail)
    if not url:
        raise RuntimeError(f"{iid}: PixelLab object {entry['pixellab_id']} has no sprite url")

    sprite_path = os.path.join(item_dir(iid), SPRITE_FILE)
    stamp = None if (fresh or not os.path.exists(sprite_path)) \
        else (prev.get("source") or {}).get("last_modified")
    status, img, last_modified = client.conditional_download(url, if_modified=stamp)
    changed = False
    if img is not None:
        os.makedirs(item_dir(iid), exist_ok=True)
        # method=6 is the slowest/densest setting — it costs milliseconds on a
        # 48x48 icon and the result is committed once.
        img.save(sprite_path, "WEBP", lossless=True, quality=100, method=6)
        legacy = os.path.join(item_dir(iid), LEGACY_SPRITE)
        if os.path.exists(legacy):
            os.remove(legacy)
        changed = True
        size = list(img.size)
    elif status == 304 and os.path.exists(sprite_path):
        size = prev.get("size") or [detail["size"]["width"], detail["size"]["height"]]
    else:
        raise RuntimeError(f"{iid}: sprite download failed (HTTP {status}) — {url}")

    meta = {
        "id": iid,
        "name": entry.get("name") or iid.replace("_", " ").title(),
        "type": entry["type"],
        "type_label": tdef.get("label"),
        "category": entry.get("category"),
        "rarity": entry.get("rarity"),
        "value": entry.get("value"),
        "stackable": tdef.get("stackable", True),
        "max_stack": tdef.get("max_stack", 99),
        "equip_slot": tdef.get("equip_slot"),
        "sellable": tdef.get("sellable", True),
        "description": entry.get("description") or "",
        "sprite": _rel(sprite_path),
        "size": size,
        "source": {
            "store": "objects",
            "pixellab_id": entry["pixellab_id"],
            "tags": detail.get("tags") or [],
            "prompt": (detail.get("prompt") or "").strip() or None,
            "created_at": detail.get("created_at"),
            "last_modified": last_modified,
        },
        "synced_at": now_iso(),
    }
    # The maintainer's verdict from the wiki (pipeline/feedback.py). Absent =
    # unreviewed, which is the normal state of freshly made content.
    if entry.get("review"):
        meta["review"] = entry["review"]
    # No creature in the roster is what this came off yet — say what it waits
    # for instead of pretending some monster drops it.
    if entry.get("waiting_for"):
        meta["waiting_for"] = entry["waiting_for"]
    if entry["type"] == "SOUL":
        meta["soul"] = {
            "element": entry.get("category"),
            "power": entry.get("power") or "",
            "merge_into": tdef.get("merge_into", ["weapon", "armor"]),
        }
    # Keep the manifest byte-stable across no-op syncs: only bump synced_at when
    # something actually changed, so a re-sync of untouched art is an empty diff.
    compare = {k: v for k, v in meta.items() if k != "synced_at"}
    prev_compare = {k: v for k, v in prev.items() if k != "synced_at"}
    if prev and compare == prev_compare and not changed:
        return prev, False
    write_manifest(iid, meta)
    return meta, True
