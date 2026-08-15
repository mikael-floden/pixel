#!/usr/bin/env python3
"""build-bodyatlas — pack character frames and monster strips into committed
lossless-WebP sheets, the way build-atlas.py already packs tiles.

WHY (measured 2026-08-15): a boot loads ~930 individual sprite files and spends
4.6 s doing it EVEN AT ZERO NETWORK LATENCY — the cost is per-file, not
bandwidth. Characters are the worst offender because every frame is its own
file: two playable characters alone are 1,201 requests (`f:<uid>:<state>:<dir>:
<n>`), and the monster roster adds ~2,200 strip requests.

THE PACKING UNIT IS (BODY, STATE), AND THAT IS THE WHOLE DESIGN.
Not one atlas per character — that would be faster to build and WRONG. The
client's loading order is tuned to the frame: boot fetches only
BOOT_ANIM_STATES (idle/walk/run/jump), the deferred batch leads with
PLAYER_URGENT_STATES (hurt/die/kick/punch/pickup), the weapon/spell states
trail, MY character leads every queue (charsMeFirst), and buildAnimations
registers each state the instant ITS OWN frames land. A per-character atlas
would drag die/kick/spell art into the boot batch and undo all of it. Per
(body, state) maps 1:1 onto those batches, so the ordering survives untouched
and each state still becomes playable independently.

It also happens to be the right granularity for BUILD TIME, which is the
maintainer's hard requirement here ("as fast or faster than before"):

1. NOT REBUILT WHEN NOT NEEDED. Every unit is content-addressed by a digest
   over its file list AND every file's bytes (plus PACKER, so a change to the
   layout logic below invalidates on purpose). An unchanged unit is skipped.
   The no-op pass is a hash of the inputs: measured ~0.2 s for 1,200 character
   frames. Deploys never build at all — they only VERIFY (check-atlas.mjs).
2. BLAZING FAST WHEN NEEDED, and the reason is a measurement, not C.
   Pillow's WebP `method` is the entire story:

       2048x2048 lossless sheet of character art
         method=0   215 ms -> 554 KB
         method=1   450 ms -> 135 KB
         method=4   430 ms -> 135 KB     <- what this script uses
         method=6  7240 ms -> 135 KB     <- 17x the time, IDENTICAL bytes

   Body art is mostly transparent, so the encoder converges long before
   method 6's extra search does anything: it costs 17x for nothing. (On DENSE
   art the trade is real — the tile sheet is 5% smaller at method 6 — which is
   why build-atlas.py documents its own choice separately.) There is no C
   extension to write here; there was just a wrong constant.
3. PARALLEL ACROSS UNITS. Units are independent, so a Pool packs them on every
   core. This is why the unit is small: one changed state is one small sheet on
   one core, not a global repack.

SAFETY, unchanged from the tile packer and from repo law:
- lossless=True AND exact=True — both non-default in Pillow. Without the first
  you get lossy VP8 ringing on every hard pixel-art edge, and lossy WOULD move
  the foot anchors, shoulder waterlines and monster contact points the game
  measures and renders with. Without the second libwebp rewrites the RGB under
  fully-transparent pixels.
- SELF-VERIFYING: every sheet is re-decoded after writing and every packed
  frame compared byte-for-byte against its source. A sheet that does not
  round-trip exactly is deleted and the build fails.
- A stale or missing atlas is never fatal at runtime: the client falls back to
  per-file loads. Slower, never wrong pixels.

    npm run bodyatlas           # packs only what changed
    npm run bodyatlas -- -f     # force-repack everything
"""
import hashlib
import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from PIL import Image

GAME_ROOT = Path(__file__).resolve().parent.parent
ASSETS_ROOT = Path(os.environ.get("ASSETS_ROOT", GAME_ROOT.parent))
PUBLIC = GAME_ROOT / "client" / "public"
OUT = PUBLIC / "atlases"
INDEX = OUT / "bodies.json"
# Build-time only (see the write site): the source lists check-atlas.mjs needs
# to recompute digests without re-deriving them from the manifests itself.
SOURCES = GAME_ROOT / "scripts" / "bodyatlas-sources.json"
SCHEMA = "nangijala/body-atlas@1"
# Bump when the PACKING LAYOUT changes: it rides in every digest, so a bump
# invalidates every unit and forces a repack. Without it a layout change would
# leave old sheets in place with matching digests — self-consistent, but not
# what the new code writes.
PACKER = 1
SHEET_W = 2048
# WebP effort. Overridable (WEBP_METHOD=6) so the trade can be RE-MEASURED
# rather than argued about — see the module docstring for the numbers behind
# the default.
WEBP_METHOD = int(os.environ.get("WEBP_METHOD", "4"))

FORCE = any(a in ("-f", "--force") for a in sys.argv[1:])
ONLY = [a for a in sys.argv[1:] if not a.startswith("-")]


def asset_path(url: str) -> Path:
    """A manifest URL (/assets/…) → its file on disk under ASSETS_ROOT."""
    return ASSETS_ROOT / url[len("/assets/") :] if url.startswith("/assets/") else ASSETS_ROOT / url


def digest_of(items: list[dict]) -> str:
    """Digest of the source LIST and every source's BYTES. Art agents repaint
    in place (same path, new pixels), so a list-only digest would happily serve
    the old art forever — the same rule the tile atlas learned.

    KEYED BY THE MANIFEST URL, NEVER THE ABSOLUTE PATH. The digest is
    recomputed by check-atlas.mjs at image-build time, where ASSETS_ROOT is
    the CURATED root (/assets) and not this checkout — an absolute path would
    hash differently there and every unit would look stale, pruning the whole
    atlas on every deploy while looking like it worked."""
    h = hashlib.sha256()
    h.update(f"{SCHEMA}/{PACKER}".encode())
    for it in items:
        h.update(it["url"].encode())
        h.update(b"\0")
        h.update(hashlib.sha256(it["path"].read_bytes()).digest())
    return h.hexdigest()[:16]


def collect_units(chars: list[dict], monsters: list[dict]) -> list[dict]:
    """Every (body, state) that has art on disk, with its items resolved.

    An item is one packable image: a character FRAME, or a monster's
    direction STRIP (already a spritesheet — packed whole, sliced back out
    with its own measured frame size, which is why stripDims travels with it).
    """
    units: list[dict] = []
    for c in chars:
        uid, root = c["uid"], c["root"]
        for state, dirs in (c.get("animations") or {}).items():
            src = (c.get("animSrc") or {}).get(state, state)
            ext = (c.get("animExt") or {}).get(state, "png")
            items = []
            for d, count in (dirs or {}).items():
                for n in range(int(count)):
                    url = f"{root}/animations/{src}/{d}/{n}.{ext}"
                    p = asset_path(url)
                    if p.exists():
                        items.append({"key": f"f:{uid}:{state}:{d}:{n}", "url": url, "path": p})
            if items:
                units.append({"unit": f"c:{uid}:{state}", "kind": "frames", "items": items})
    for m in monsters:
        mid = m["id"]
        for anim, dirs in (m.get("strips") or {}).items():
            items = []
            for d, url in (dirs or {}).items():
                if not url:
                    continue
                p = asset_path(url)
                if not p.exists():
                    continue
                dims = ((m.get("stripDims") or {}).get(anim) or {}).get(d) or {}
                items.append(
                    {
                        "key": f"msheet:{mid}:{anim}:{d}",
                        "url": url,
                        "path": p,
                        # The STRIP's own measured frame size — a monster-level
                        # size goes stale when art is repaired in place, and a
                        # wrong one bleeds frames.
                        "fw": int(dims.get("w") or m.get("frameW") or 0),
                        "fh": int(dims.get("h") or m.get("frameH") or 0),
                    }
                )
            if items:
                units.append({"unit": f"m:{mid}:{anim}", "kind": "strips", "items": items})
    return units


def pack_unit(unit: dict) -> dict:
    """Pack one unit into one sheet. Runs in a worker process, so it takes and
    returns only plain data and opens its own files."""
    name = unit["unit"]
    items = sorted(unit["items"], key=lambda i: i["key"])
    digest = digest_of(items)
    sheet_file = "b." + name.replace(":", "-").replace("/", "-") + ".webp"

    entry = {
        "digest": digest,
        "sheet": sheet_file,
        "kind": unit["kind"],
        "items": {},
    }
    # `prev`/`force` travel INSIDE the unit rather than as module globals: a
    # worker only inherits parent state under the `fork` start method, and
    # relying on that would make the skip path silently stop working (every
    # unit repacked, no error) wherever Python defaults to spawn.
    prev = unit.get("prev")
    if not unit.get("force") and prev and prev.get("digest") == digest and (OUT / prev.get("sheet", "")).exists():
        return {
            "unit": name,
            "entry": prev,
            "srcUrls": [i["url"] for i in items],
            "skipped": True,
            "bytes": 0,
            "src": 0,
        }

    imgs = [Image.open(i["path"]).convert("RGBA") for i in items]
    # Shelf pack, tallest first: rows of equal-ish height waste the least, and
    # sorting makes placement deterministic so identical inputs give identical
    # bytes.
    order = sorted(range(len(items)), key=lambda k: (-imgs[k].height, items[k]["key"]))
    place: dict[int, tuple[int, int]] = {}
    x = y = row_h = 0
    for k in order:
        w, h = imgs[k].size
        if x and x + w > SHEET_W:
            x, y, row_h = 0, y + row_h, 0
        place[k] = (x, y)
        x += w
        row_h = max(row_h, h)
    total_h = y + row_h
    sheet = Image.new("RGBA", (SHEET_W, total_h), (0, 0, 0, 0))
    for k, (px, py) in place.items():
        sheet.paste(imgs[k], (px, py))

    OUT.mkdir(parents=True, exist_ok=True)
    out_path = OUT / sheet_file
    # BOTH flags non-default and non-negotiable — see the module docstring.
    sheet.save(out_path, "WEBP", lossless=True, exact=True, quality=100, method=WEBP_METHOD)

    # SELF-VERIFY: decode what we just wrote and compare every frame.
    with Image.open(out_path) as back:
        back = back.convert("RGBA")
        for k, (px, py) in place.items():
            w, h = imgs[k].size
            if back.crop((px, py, px + w, py + h)).tobytes() != imgs[k].tobytes():
                out_path.unlink(missing_ok=True)
                raise SystemExit(f"[bodyatlas] {name}: {items[k]['key']} did not round-trip — sheet deleted, refusing")

    for k, (px, py) in place.items():
        w, h = imgs[k].size
        it = items[k]
        entry["items"][it["key"]] = (
            [px, py, w, h, it["fw"], it["fh"]] if unit["kind"] == "strips" else [px, py, w, h]
        )
    return {
        "unit": name,
        "entry": entry,
        "srcUrls": [i["url"] for i in items],
        "skipped": False,
        "bytes": out_path.stat().st_size,
        "src": sum(i["path"].stat().st_size for i in items),
    }


PREV_UNITS: dict[str, dict] = {}  # parent-process only; workers get `prev` per unit


def main() -> None:
    global PREV_UNITS
    chars = json.loads((PUBLIC / "characters.json").read_text()).get("characters", [])
    monsters = json.loads((PUBLIC / "monsters.json").read_text()).get("monsters", [])
    if INDEX.exists():
        try:
            PREV_UNITS = json.loads(INDEX.read_text()).get("units", {})
        except Exception:
            PREV_UNITS = {}  # unreadable index → rebuild everything

    units = collect_units(chars, monsters)
    if ONLY:
        units = [u for u in units if any(o in u["unit"] for o in ONLY)]
    if not units:
        print("[bodyatlas] nothing to pack")
        return
    for u in units:
        u["prev"] = PREV_UNITS.get(u["unit"])
        u["force"] = FORCE

    # Units are independent, so pack them on every core. chunksize 1: unit cost
    # varies by an order of magnitude (an 8-frame idle vs an 88-frame die), and
    # fixed chunks would strand a whole core on the long tail.
    with ProcessPoolExecutor() as pool:
        results = list(pool.map(pack_unit, units, chunksize=1))

    index = {"schema": SCHEMA, "packer": PACKER, "units": {}}
    for r in sorted(results, key=lambda r: r["unit"]):
        index["units"][r["unit"]] = r["entry"]
    # Units that no longer exist must lose their sheets, or the prune guard has
    # orphans to reason about.
    keep = {e["sheet"] for e in index["units"].values()}
    if not ONLY:
        for f in OUT.glob("b.*.webp"):
            if f.name not in keep:
                print(f"[bodyatlas] orphan {f.name} — removing")
                f.unlink()
    elif INDEX.exists():  # partial run: preserve the units we did not touch
        old = json.loads(INDEX.read_text()).get("units", {})
        for k, v in old.items():
            index["units"].setdefault(k, v)
    INDEX.write_text(json.dumps(index, separators=(",", ":"), sort_keys=True))

    # THE VERIFY SIDECAR. check-atlas.mjs must be able to recompute every
    # digest at image-build time, and re-deriving the source lists in JS would
    # duplicate collect_units — two implementations of "which files belong to
    # this unit" that drift silently. So the builder publishes the lists it
    # actually used, keyed by the stable manifest URL.
    #
    # It lives in scripts/, NOT client/public: the client never reads it, and
    # ~200 KB of source paths in the served bundle is weight every player would
    # download for nothing. The runtime image copies only client/dist, so it
    # never ships at all.
    sources = {}
    if ONLY and SOURCES.exists():
        try:
            sources = json.loads(SOURCES.read_text()).get("units", {})
        except Exception:
            sources = {}
    for r in results:
        sources[r["unit"]] = {"digest": r["entry"]["digest"], "sheet": r["entry"]["sheet"], "src": r["srcUrls"]}
    if not ONLY:
        sources = {k: v for k, v in sources.items() if k in index["units"]}
    SOURCES.write_text(
        json.dumps({"schema": SCHEMA, "packer": PACKER, "units": sources}, separators=(",", ":"), sort_keys=True)
    )

    built = [r for r in results if not r["skipped"]]
    src = sum(r["src"] for r in built)
    out = sum(r["bytes"] for r in built)
    items = sum(len(r["entry"]["items"]) for r in results)
    print(
        f"[bodyatlas] {len(units)} unit(s), {items} items: {len(built)} packed, "
        f"{len(results) - len(built)} up to date"
        + (f" — {src / 1024:.0f}K files -> {out / 1024:.0f}K sheets" if built else "")
    )


if __name__ == "__main__":
    main()
