#!/usr/bin/env python3
"""THE ALPHA BBOX OF EVERY SCENERY SPRITE, measured once at build time.

WHY IT EXISTS. A scenery hitbox (live/tuning/scenery_hitbox.json) is an ellipse
in FRAME pixels, and turning it into world cells needs the scale the art is
drawn at — `fitSprite` scales so the sprite's VISIBLE height equals the piece's
`placement.world_px_height`, which is the alpha bbox's height, not the frame's.
The client measures that in the browser; the SERVER never decodes an image, and
collision has to be server-authoritative. So the measurement is baked here and
both sides read the same numbers — the client's own runtime measurement and this
table agree by construction because they are the same definition.

Keyed by the sprite path as `scenery.json` names it ("trees/tree_075/sprite.webp"),
which is exactly what `southSprite()` hands the renderer.

Run: python3 games2/scripts/build-scenery-bbox.py [--check]
"""
import json, os, sys
from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(REPO, "scenery")
OUT = os.path.join(REPO, "games2", "config", "scenery-bbox.json")

def main() -> int:
    check = "--check" in sys.argv
    out: dict[str, list[int]] = {}
    n = 0
    for root, _dirs, files in os.walk(SRC):
        for f in files:
            if f != "sprite.webp":
                continue
            full = os.path.join(root, f)
            rel = os.path.relpath(full, SRC).replace(os.sep, "/")
            try:
                with Image.open(full) as im:
                    im = im.convert("RGBA")
                    bb = im.getbbox()          # PIL's own alpha bbox
                    if bb is None:             # fully transparent: the whole canvas
                        bb = (0, 0, im.width, im.height)
                    out[rel] = [bb[0], bb[1], bb[2], bb[3], im.width, im.height]
            except Exception as e:             # a broken file must not kill the build
                print(f"  skip {rel}: {e}", file=sys.stderr)
            n += 1
    # THE PIECE FACTS THE SERVER NEEDS BESIDE THE BBOX: how tall the art is
    # drawn (placement.world_px_height, the scale `fitSprite` fits to) and which
    # sprite each STATE uses. Folded in here so collision needs ONE file plus the
    # hitbox doc, instead of 205 scenery.json reads at room create.
    pieces: dict[str, dict] = {}
    for root, _dirs, files in os.walk(SRC):
        if "scenery.json" not in files:
            continue
        try:
            man = json.load(open(os.path.join(root, "scenery.json"), encoding="utf-8"))
        except Exception:
            continue
        pid = os.path.relpath(root, SRC).replace(os.sep, "/")
        wph = ((man.get("placement") or {}).get("world_px_height"))
        states = {}
        for k, st in (man.get("states") or {}).items():
            spr = (st or {}).get("rotations", {}).get("south") or (st or {}).get("sprite")
            if spr:
                states[k] = spr
        pieces[pid] = {"wph": wph, "sprite": man.get("sprite"), "states": states}

    doc = {
        "format": "games2-scenery-bbox@2",
        "pieces": pieces,
        "_comment": (
            "Alpha bbox per scenery sprite: [x0,y0,x1,y1,frameW,frameH] in FRAME pixels, plus "
            "each piece's world_px_height and state->sprite map. "
            "Measured by games2/scripts/build-scenery-bbox.py so the SERVER can place a "
            "scenery hitbox ellipse (live/tuning/scenery_hitbox.json, frame px from the "
            "frame centre) into world cells without decoding art. Same definition the "
            "client measures at runtime."
        ),
        "boxes": out,
    }
    body = json.dumps(doc, separators=(",", ":"), sort_keys=True)
    if check:
        cur = open(OUT, encoding="utf-8").read() if os.path.exists(OUT) else ""
        if cur.strip() != body.strip():
            print(f"scenery-bbox.json is STALE — re-run {os.path.relpath(__file__, REPO)}")
            return 1
        print(f"scenery-bbox.json is current ({len(out)} sprites)")
        return 0
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, "w", encoding="utf-8").write(body)
    print(f"{len(out)} sprites measured of {n} files -> {os.path.relpath(OUT, REPO)} ({len(body)} bytes)")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
