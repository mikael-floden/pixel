"""Repair a duplicated SE/SW pair by mirroring the SE art into SW.

THE BUG (maintainer, 2026-09-05): "If the original 8 directions failed to
generate a correct SE and SW and instead generated SE for both, that is often
hard to get rid of and often has the consequence that all states and animations
from this scenery will have an impossible time generating a correct SW." Measured
and true: cupboard_002's anchor pair fails and all six states repeat the anchor's
numbers almost exactly.

THE FIX, AND ITS ONE RULE: "You just have to apply the mirroring on scenery that
needs it! If you apply it on scenery that doesn't need it you are the one making
SE and SW look the same." So this NEVER mirrors a facing wholesale. Each state is
tested on its own and skipped unless its SW really is a near-duplicate of its SE
— a piece can have a broken anchor and perfectly good states, and overwriting
those would create the exact fault we are repairing.

Mirroring is legitimate here because the game already flips scenery horizontally
at random (`must_be_imbplemented_with_random_hflip`), so a mirrored sprite is
nothing new on screen.

NOT SUITABLE FOR HANDED ART. A mirror reverses anything with a correct side —
carved runes and text (standing_stones, story_posts), a sundial's gnomon, a crank
on a given side. Those need the rotation regenerating instead; this tool refuses
them by name rather than trusting the caller.

CACHE SAFETY. The mirrored file is derived art, so it is NEVER written over the
stable `south-west.webp`: it goes to `south-west.<content hash>.webp`, the
manifest is repointed at the new name, and the old file stays. A stale cache then
shows the coherent old picture, never a mix — and every consumer reads rotation
paths out of the manifest, so nothing constructs the old name behind our backs.

    python3 scenery/pipeline/mirror_facing.py --dry-run <rel> [<rel> ...]
    python3 scenery/pipeline/mirror_facing.py <rel> [<rel> ...]
"""
import hashlib, io, json, os, sys
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory, viewer_build

# A mirror reverses these. Refuse by group; the fix for them is regeneration.
HANDED_GROUPS = {"standing_stones", "story_posts", "signposts", "sundials",
                 "milestones", "grave_markers"}
DUPLICATE_MAX = 6.0     # mean |RGBA| difference at 64x64 below which SW *is* SE
SILHOUETTE_MAX = 0.80   # above this the OUTLINE is its own mirror; flipping shows nothing new


def _small(path):
    return np.asarray(Image.open(path).convert("RGBA").resize((64, 64)),
                      dtype=np.float32)


def duplication(se, sw):
    """How nearly the same picture the two are. Small = the same side twice."""
    return float(np.abs(_small(sw) - _small(se)).mean())


def self_symmetry(se_path):
    """How much of the SHAPE survives a flip, as intersection-over-union of the
    opaque mask against its own mirror. 1.0 = the outline is symmetric.

    His test, and it beats the one it replaced: "After you flip it, check the
    transparent/non transparent pixel overlap. You should not focus on objects
    where the transparent pixels look kinda identical after flip. If not many
    transparent pixels changed you might be safe to not mirror it."
    (maintainer 2026-09-05)

    Measuring COLOUR instead was the bug: a barrel's wood grain differs left to
    right, so an RGBA comparison called it asymmetric and offered to mirror it
    when its outline is perfectly symmetric (IoU 1.000) and flipping shows the
    player nothing new. Scored against the 27 states he corrected by hand, this
    plus the already-different rule accounts for 26 of them; colour got 7."""
    im = Image.open(se_path).convert("RGBA")
    box = im.getbbox()
    if box:
        im = im.crop(box)
    m = np.asarray(im.resize((96, 96), Image.NEAREST))[..., 3] > 8
    f = m[:, ::-1]
    union = int((m | f).sum())
    return float((m & f).sum() / union) if union else 1.0


def _mirror_bytes(se_path):
    with Image.open(se_path) as im:
        out = im.convert("RGBA").transpose(Image.FLIP_LEFT_RIGHT)
    buf = io.BytesIO()
    out.save(buf, "WEBP", lossless=True, exact=True)
    return buf.getvalue()


def plan(rel, only=None):
    """[(state_key, se_rel, sw_rel, duplication)] for facings that need it.
    `skipped` (printed by the CLI) is what was duplicated but symmetric."""
    man = factory.read_manifest(rel)
    if man is None:
        return None, []
    jobs, skipped = [], []
    for key, rot in (man.get("states") or {}).items():
        rot = (rot or {}).get("rotations") or {}
        se, sw = rot.get("south-east"), rot.get("south-west")
        if not se or not sw:
            continue
        se_abs = os.path.join(factory.ROOT, se)
        sw_abs = os.path.join(factory.ROOT, sw)
        if not (os.path.exists(se_abs) and os.path.exists(sw_abs)):
            continue
        d = duplication(se_abs, sw_abs)
        if d >= DUPLICATE_MAX:
            continue                      # SW is already a genuinely different view
        if only is not None and key.upper() in only:
            jobs.append((key, se, sw, d))   # named by the maintainer
            continue
        sym = self_symmetry(se_abs)
        if sym > SILHOUETTE_MAX:
            skipped.append((key, d, sym))  # the outline is its own mirror: flipping shows nothing
            continue
        jobs.append((key, se, sw, d))
    return man, jobs


def apply(rel, write=False, only=None):
    """`only` = a set of STATE keys the maintainer named explicitly. His eye beats
    the heuristics, so a named state skips the shape test (waterwheel_003 LIT_2
    scored 0.802 against a 0.80 line and he had already said it needs mirroring).
    It never skips the handed-art refusal or the round-trip check."""
    if rel.split("/", 1)[0] in HANDED_GROUPS:
        return "REFUSED — handed art, a mirror reverses it; regenerate instead", []
    man, jobs = plan(rel, only)
    if man is None:
        return "no manifest", []
    if not jobs:
        return "nothing needs it", []
    done = []
    for key, se, sw, d in jobs:
        data = _mirror_bytes(os.path.join(factory.ROOT, se))
        h = hashlib.sha256(data).hexdigest()[:10]
        new_rel = "%s.%s.webp" % (sw[:-len(".webp")], h)
        new_abs = os.path.join(factory.ROOT, new_rel)
        if write:
            with open(new_abs, "wb") as f:
                f.write(data)
            # verify the mirror is the SE art and nothing else
            back = np.asarray(Image.open(new_abs).convert("RGBA").transpose(
                Image.FLIP_LEFT_RIGHT), dtype=np.int16)
            orig = np.asarray(Image.open(os.path.join(factory.ROOT, se)
                                         ).convert("RGBA"), dtype=np.int16)
            if back.shape != orig.shape or int(np.abs(back - orig).max()) != 0:
                os.remove(new_abs)
                raise SystemExit("mirror did not round-trip for %s %s" % (rel, key))
            man["states"][key]["rotations"]["south-west"] = new_rel
        done.append((key, d, new_rel))
    if write and done:
        factory.write_manifest(rel, man)
    return "ok", done


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    write = "--dry-run" not in sys.argv
    if not args:
        raise SystemExit(__doc__)
    # "group/piece#STATE" names one facing explicitly; "group/piece" lets the
    # rules decide. Both forms may be mixed on one command line.
    named = {}
    for a in args:
        rel, _, st = a.partition("#")
        named.setdefault(rel, set())
        if st:
            named[rel].add(st.upper())
    total = 0
    for rel, only in named.items():
        status, done = apply(rel, write, only or None)
        print("%-42s %s" % (rel, status))
        for key, d, new in done:
            print("    %-12s duplication %.1f -> %s" % (key, d, os.path.basename(new)))
        total += len(done)
    print("\n%d facing(s) %s" % (total, "mirrored" if write else "would be mirrored"))
    if write and total:
        viewer_build.build()
        print("viewer_data.json rebuilt")
