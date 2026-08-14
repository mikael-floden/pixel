"""Give every window a LIGHTS_ON state — someone is home.

Windows are generated dark on purpose ("I made sure all windows was dark inside
the house just to be able to do this" — maintainer 2026-08-14), so the lit
version is a text EDIT of the existing art rather than a fresh generation:
`POST /v2/objects/{id}/states` re-renders all 8 directions of the object with
the edit applied and saves the result as a sibling object sharing `group_id`.

THE PROMPT IS THE MAINTAINER'S, VERBATIM, AND MUST NOT BE "IMPROVED".
His version is short and names only the thing that should change. Mine was
three times longer and listed the materials to preserve — "the stone", "the
woodgrain", "the paint", "the shutters" — and it FAILED outright. Image models
do not reliably honour negation: every material noun lands in the conditioning
as something to render, so a list of things not to touch is a palette to reach
for. Naming only the change is why his works.

The one automated check that survives contact with the art is the SILHOUETTE.
Frame pixels legitimately change — warm light spills onto the sill and reveal,
which is physically right and looks better — so a frame-diff threshold would
reject the good results. A changed silhouette, on the other hand, always means
the window was redrawn rather than lit.

    python3 pipeline/lights_on.py --dry-run
    python3 pipeline/lights_on.py --limit 3
    python3 pipeline/lights_on.py            # every window still missing it
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import time

import numpy as np

import factory
import viewer_build
from pixellab_client import V2_BASE, PixelLabClient, PixelLabError
from PIL import Image

# The maintainer's prompt. Do not edit.
EDIT_PROMPT = (
    "Change the window to represent lights being on inside the house. "
    "DON'T CHANGE ANYTHING ELSE. THE FRAME SHOULD BE 100% IDENTICAL. "
    "DON'T CHANGE A SINGLE PIXEL OTHER THEN TURNING THE LIGHTS ON SO THE "
    "WINDOW REPRESENTS SOMEONE IS HOME."
)
# Caps to match the domain's own vocabulary: every manifest already
# carries lights: "LIGHTS_ON" / "LIGHTS_OFF", and the state keys are the
# same two values, so they read the same everywhere (maintainer
# 2026-08-14). The DARK art is the default state and keeps the piece's
# top-level `sprite`.
STATE = "LIGHTS_ON"
STATE_OFF = "LIGHTS_OFF"
# ...but the DIRECTORY stays lowercase. Manifest keys are domain vocabulary;
# paths are paths, and every other path in this repo is lowercase.
STATE_DIR = "lights_on"
KEEP = ("south-east", "south", "south-west")
PARALLEL = 6
# Fraction of opaque pixels whose alpha may differ before we call it a redraw.
SILHOUETTE_MAX = 0.02


def windows_missing_state():
    out = []
    for pid in sorted(factory.done_by_group().get("windows", ())):
        rel = f"windows/{pid}"
        man = factory.read_manifest(rel) or {}
        have = {k.upper() for k in (man.get("states") or {})}
        if STATE in have:
            continue
        if man.get("pixellab_object_id"):
            out.append((rel, man))
    return out


def silhouette_delta(base_img, lit_img):
    """Fraction of pixels whose opacity flipped — a redraw, not a relight."""
    a = np.asarray(base_img.convert("RGBA"))[:, :, 3] > 16
    b = np.asarray(lit_img.convert("RGBA").resize(base_img.size, Image.NEAREST))[:, :, 3] > 16
    return float((a ^ b).sum()) / max(int(a.sum()), 1)


def submit(client, man):
    r = client._request("POST", f"{V2_BASE}/objects/{man['pixellab_object_id']}/states",
                        json={"edit_description": EDIT_PROMPT, "state_name": STATE})
    oid = r.get("object_id")
    if not oid:
        raise PixelLabError("no object_id returned for state")
    return oid


def finalize(client, rel, man, oid):
    """Download the lit facings, gate them, write them beside the dark ones."""
    detail = client.get_object(oid)
    rot = detail.get("rotation_urls") or {}
    size = int(man.get("size") or 64)
    base_south = Image.open(os.path.join(factory.ROOT, man["sprite"])).convert("RGBA")

    saved = {}
    for d in KEEP:
        url = rot.get(d) or (client.sprite_url(detail) if d == "south" else None)
        if not url:
            raise PixelLabError(f"{rel}: state {oid} has no {d} rotation")
        img = factory._normalize(client._download(url).convert("RGBA"), size)
        if d == "south":
            delta = silhouette_delta(base_south, img)
            if delta > SILHOUETTE_MAX:
                client.delete_object(oid)
                # KEEP writes south-east before south, so a rejection here would
                # otherwise strand a half-written state on disk — one facing of
                # art the manifest never references and nothing ever cleans up.
                shutil.rmtree(os.path.join(factory.ROOT, rel, STATE_DIR),
                              ignore_errors=True)
                raise PixelLabError(
                    f"GATE {rel}: silhouette moved {delta:.1%} (max "
                    f"{SILHOUETTE_MAX:.0%}) — the window was redrawn, not lit")
        out = f"{rel}/{STATE_DIR}/sprite.webp" if d == "south" \
            else f"{rel}/{STATE_DIR}/rotations/{d}.webp"
        factory.save_webp(img, os.path.join(factory.ROOT, out))
        saved[d] = out

    client.set_tags(oid, ["SCENERY"])
    states = dict(man.get("states") or {})
    states.setdefault(STATE_OFF, {"sprite": man["sprite"],
                                     "rotations": man.get("rotations") or {},
                                     "pixellab_object_id": man.get("pixellab_object_id")})
    # `rotations` carries all three facings INCLUDING south, matching the
    # lights_off entry exactly — a consumer switching states iterates the same
    # keys either way instead of special-casing south on one of them.
    states[STATE] = {"sprite": saved["south"],
                     "rotations": dict(saved),
                     "pixellab_object_id": oid,
                     "edit_description": EDIT_PROMPT}
    man["states"] = states
    factory.write_manifest(rel, man)
    return silhouette_delta(base_south, Image.open(os.path.join(factory.ROOT, saved["south"])))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--timeout-minutes", type=float, default=25.0)
    args = ap.parse_args()

    todo = windows_missing_state()
    if args.limit:
        todo = todo[:args.limit]
    print(f"{len(todo)} window(s) need a {STATE} state")
    if args.dry_run or not todo:
        for rel, _ in todo:
            print("  would light", rel)
        return 0

    client = PixelLabClient()
    queue = list(todo)
    flight = []            # [(rel, man, oid, submitted_at, attempts)]
    ok = failed = 0
    deadline = time.monotonic() + args.timeout_minutes * 60

    while (queue or flight) and time.monotonic() < deadline:
        while queue and len(flight) < PARALLEL:
            rel, man = queue.pop(0)
            try:
                oid = submit(client, man)
                flight.append([rel, man, oid, time.monotonic(), 1])
                print(f"» {rel} state submitted ({len(flight)} in flight)")
            except PixelLabError as e:
                failed += 1
                print(f"  x {rel}: submit failed — {e}")
        still = []
        for entry in flight:
            rel, man, oid, at, attempts = entry
            try:
                st = client.get_object(oid).get("status")
            except PixelLabError:
                still.append(entry)
                continue
            if st == "completed":
                try:
                    delta = finalize(client, rel, man, oid)
                    ok += 1
                    print(f"  = {rel} lit (silhouette moved {delta:.2%})")
                except PixelLabError as e:
                    failed += 1
                    print(f"  x {rel}: {e}")
            elif st == "failed":
                # A state job can just fail; one retry, then give up.
                if attempts < 2:
                    print(f"  ~ {rel} state failed, retrying once")
                    try:
                        entry[2] = submit(client, man)
                        entry[3] = time.monotonic()
                        entry[4] = attempts + 1
                        still.append(entry)
                        continue
                    except PixelLabError as e:
                        print(f"  x {rel}: retry submit failed — {e}")
                failed += 1
                print(f"  x {rel}: state generation failed")
            else:
                still.append(entry)
        flight = still
        if flight:
            time.sleep(10)

    for rel, *_ in flight:
        print(f"  ! {rel} still generating at cutoff")
    viewer_build.build()
    print(f"\nlit: {ok} ok, {failed} failed, {len(flight)} unfinished")
    return 0


if __name__ == "__main__":
    sys.exit(main())
