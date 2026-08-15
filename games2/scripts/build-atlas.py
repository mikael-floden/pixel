#!/usr/bin/env python3
"""build-atlas — pack each world's used tiles into lossless-WebP sheets.

WHY (maintainer 2026-08-14): a maps2 world loads its tiles as individual
files — the_island2 is 571 separate HTTP requests before the ground can draw.
The ship-set split already ensures only USED tiles exist in the image; this
packs that same set (the world's own ``paths[]`` table, which is exactly its
used set — measured across all 11 worlds) into one or a few sheets, so a world
boots with ~2 requests instead of hundreds.

THE WORK IS NEVER REPEATED (the maintainer's hardest requirement): atlases are
COMMITTED and CONTENT-ADDRESSED. Each index carries a digest over the tile
list AND every tile's bytes; this script skips a world whose digest already
matches, deploys only VERIFY the digest (scripts/check-atlas.mjs), and a
deploy never packs anything. Rebuilding is an explicit act:

    npm run atlas          # packs only what changed (digest mismatch)
    npm run atlas -- -f    # force-repack everything

SAFETY over cleverness, in repo law and habit:
- lossless=True AND exact=True — both non-default in Pillow; without the first
  you get lossy VP8 ringing on pixel-art edges, without the second libwebp
  rewrites RGB under transparent pixels (see repo CLAUDE.md).
- SELF-VERIFYING like to-webp.py: after writing a sheet it is re-decoded and
  every frame compared byte-for-byte against its source tile. A sheet that
  does not round-trip exactly is deleted and the build fails.
- If an atlas is stale or missing at runtime the client falls back to loading
  individual tiles — slower, never wrong.

Geometry: tiles are 64x64 or 64x128 (measured — nothing else exists), so
packing is two shelf bands per sheet, tall band first. Sheets cap at 2048px;
overflow spills to <world>.<n>.webp. Placement is deterministic (sorted paths)
so identical inputs give byte-identical output.
"""
import hashlib
import io
import json
import sys
from pathlib import Path

from PIL import Image

GAME_ROOT = Path(__file__).resolve().parent.parent
ASSETS_ROOT = Path(__import__("os").environ.get("ASSETS_ROOT", GAME_ROOT.parent))
WORLDS = ASSETS_ROOT / "maps2" / "worlds"
OUT = GAME_ROOT / "client" / "public" / "atlases"
SHEET_MAX = 2048
SCHEMA = "nangijala/tile-atlas@1"

FORCE = any(a in ("-f", "--force") for a in sys.argv[1:])
ONLY = [a for a in sys.argv[1:] if not a.startswith("-")]


def tileset_digest(paths: list[str]) -> str:
    """Digest of the tile LIST and every tile's BYTES — an in-place regenerated
    tile (same path, new pixels) must invalidate, or the atlas would silently
    show old art. hex16, matching the ship set's digest style."""
    h = hashlib.sha256()
    for p in paths:
        h.update(p.encode())
        h.update(b"\0")
        h.update(hashlib.sha256((ASSETS_ROOT / p).read_bytes()).digest())
    return h.hexdigest()[:16]


def pack_world(name: str) -> None:
    wj = WORLDS / name / "world.json"
    world = json.loads(wj.read_text())
    paths = sorted({p for p in world.get("paths", []) if isinstance(p, str)})
    if not paths:
        print(f"[atlas] {name}: no tile paths — skipping")
        return
    missing = [p for p in paths if not (ASSETS_ROOT / p).exists()]
    if missing:
        sys.exit(f"[atlas] {name}: {len(missing)} referenced tiles missing (e.g. {missing[0]}) — refusing")

    digest = tileset_digest(paths)
    idx_path = OUT / f"{name}.json"
    if not FORCE and idx_path.exists():
        try:
            if json.loads(idx_path.read_text()).get("tilesetDigest") == digest:
                print(f"[atlas] {name}: up to date ({digest}, {len(paths)} tiles)")
                return
        except Exception:
            pass  # unreadable index → rebuild

    # Load once; two-band shelf pack (tall 128s first, then 64s).
    imgs = {p: Image.open(ASSETS_ROOT / p).convert("RGBA") for p in paths}
    tall = [p for p in paths if imgs[p].height > 64]
    short = [p for p in paths if imgs[p].height <= 64]
    frames: dict[str, list[int]] = {}
    sheets: list[Image.Image] = []

    def new_sheet():
        sheets.append(Image.new("RGBA", (SHEET_MAX, SHEET_MAX), (0, 0, 0, 0)))
        return [0, 0, 0]  # cursor x, cursor y, current row height

    cur = new_sheet()
    used_h = [0]  # per-sheet used height, for the final crop

    def place(p: Image.Image, path: str):
        w, h = p.size
        x, y, rh = cur
        if rh and h != rh:  # band change → new row
            cur[0], cur[1], cur[2] = 0, y + rh, h
            x, y, rh = cur
        if rh == 0:
            cur[2] = rh = h
        if x + w > SHEET_MAX:  # row full → next row
            cur[0], cur[1] = 0, y + rh
            cur[2] = h
            x, y, rh = cur
        if y + h > SHEET_MAX:  # sheet full → next sheet
            cur[:] = new_sheet()
            used_h.append(0)
            x, y, rh = cur
            cur[2] = h
        si = len(sheets) - 1
        sheets[si].paste(p, (x, y))
        frames[path] = [si, x, y, w, h]
        cur[0] = x + w
        used_h[si] = max(used_h[si], y + h)

    for p in tall + short:
        place(imgs[p], p)

    OUT.mkdir(parents=True, exist_ok=True)
    sheet_files = []
    for i, sh in enumerate(sheets):
        cropped = sh.crop((0, 0, SHEET_MAX, used_h[i]))
        f = OUT / f"{name}.{i}.webp"
        # BOTH flags non-default and non-negotiable — see module docstring.
        cropped.save(f, "WEBP", lossless=True, exact=True, quality=100, method=6)
        sheet_files.append(f.name)

    # SELF-VERIFY: re-decode every sheet, compare every frame to its source.
    for i, f in enumerate(sheet_files):
        with Image.open(OUT / f) as back:
            back = back.convert("RGBA")
            for path, (si, x, y, w, h) in frames.items():
                if si != i:
                    continue
                if back.crop((x, y, x + w, y + h)).tobytes() != imgs[path].tobytes():
                    (OUT / f).unlink(missing_ok=True)
                    sys.exit(f"[atlas] {name}: {path} did not round-trip in {f} — sheet deleted, refusing")

    src_bytes = sum((ASSETS_ROOT / p).stat().st_size for p in paths)
    out_bytes = sum((OUT / f).stat().st_size for f in sheet_files)
    idx_path.write_text(
        json.dumps(
            {
                "schema": SCHEMA,
                "world": name,
                "tilesetDigest": digest,
                "tiles": len(paths),
                "sheets": sheet_files,
                "frames": frames,
            },
            separators=(",", ":"),
        )
    )
    print(
        f"[atlas] {name}: {len(paths)} tiles -> {len(sheet_files)} sheet(s), "
        f"{src_bytes / 1024:.0f}K files -> {out_bytes / 1024:.0f}K sheets, digest {digest}, verified"
    )


def main():
    names = ONLY or sorted(d.name for d in WORLDS.iterdir() if (d / "world.json").exists())
    for n in names:
        pack_world(n)
    # Orphans: an atlas whose world no longer exists confuses the prune guard.
    for f in OUT.glob("*.json"):
        if f.stem not in names and not ONLY:
            print(f"[atlas] orphan {f.name} (world gone) — removing with its sheets")
            for s in OUT.glob(f"{f.stem}.*.webp"):
                s.unlink()
            f.unlink()


if __name__ == "__main__":
    main()
