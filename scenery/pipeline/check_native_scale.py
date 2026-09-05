"""GATE: no piece may publish a size other than its art's own.

ONE PIXEL IS ONE PIXEL (maintainer 2026-09-05). Every consumer scales a sprite
so its alpha bbox equals placement.world_px_height, so the only thing keeping
that from resampling pixel art is world_px_height being the bbox height itself.
This fails the moment it is not.

It also re-measures the character, because character_height_px was hand-set to
64 against a character the game draws 88px tall and nothing noticed for months
— the same "derive, don't ask" lesson as the backup bucket name. The constant no
longer drives any render size, but it is what world_height_m (and so the
art-is-the-wrong-size diagnostic) is read against, so a wrong one is a wrong
diagnostic. Not fatal: it reports.

    python3 scenery/pipeline/check_native_scale.py
"""
import glob, json, os, statistics, sys
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory

CHARACTERS = "characters2/humans/%s/base/*.webp"


def measured_character_px():
    heights = []
    for who in ("default_boy", "default_girl"):
        for path in sorted(glob.glob(os.path.join(factory.ROOT, "..", CHARACTERS % who))):
            with Image.open(path) as im:
                if im.size[0] > 200:      # strip sheets, not a single facing
                    continue
                box = im.convert("RGBA").getbbox()
            if box:
                heights.append(box[3] - box[1])
    return round(statistics.median(heights)) if heights else None


def main():
    bad, checked = [], 0
    for rel, man in factory.discover():
        sprite = man.get("sprite")
        path = os.path.join(factory.ROOT, sprite) if sprite else None
        if not path or not os.path.exists(path):
            continue
        with Image.open(path) as im:
            box = im.getbbox()
        if not box:
            continue
        checked += 1
        want = box[3] - box[1]
        got = (man.get("placement") or {}).get("world_px_height")
        if got != want:
            bad.append((rel, got, want))

    print(f"{checked} pieces checked; {len(bad)} not published at 1:1")
    for rel, got, want in bad[:20]:
        print(f"  {rel:<44} publishes {got}px, art is {want}px")
    if len(bad) > 20:
        print(f"  ... and {len(bad) - 20} more")

    real = measured_character_px()
    cfg = factory.load_config()
    declared = cfg["scale"]["character_height_px"]
    if real is None:
        print("character art not checked out — constant not verified")
    elif real != declared:
        print(f"NOTE: character_height_px is {declared} but the character art "
              f"measures {real}px. It sets no render size, but world_height_m "
              f"is read against it. Fix the config, then rescale.py.")
    else:
        print(f"character_height_px {declared} matches the character art")

    if bad:
        print("FAIL — run: python3 scenery/pipeline/rescale.py --write")
        return 1
    print("PASS — scenery is never resampled")
    return 0


if __name__ == "__main__":
    sys.exit(main())
