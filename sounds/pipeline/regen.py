"""Regenerate one (or all) sounds from the catalog, in place.

Because the procedural engine is deterministic per (preset, seed), this
reproduces byte-for-byte identical WAVs — handy for verifying a manifest or
re-rolling a sound after you change its seed/params in config/sounds.json.

    python pipeline/regen.py                 # (re)generate every catalog sound
    python pipeline/regen.py coin_pickup     # just one
    python pipeline/regen.py --ai coin_pickup  # force the AI engine (needs key)
"""

from __future__ import annotations

import argparse
import sys

import factory
import viewer_build


def main():
    ap = argparse.ArgumentParser(description="Regenerate catalog sounds in place.")
    ap.add_argument("ids", nargs="*", help="sound ids (default: all)")
    ap.add_argument("--ai", action="store_true", help="force the ElevenLabs engine")
    args = ap.parse_args()

    cfg = factory.load_config()
    specs = {s["id"]: s for s in factory.sound_specs(cfg)}
    targets = args.ids or list(specs)

    client = None
    if args.ai:
        from elevenlabs_client import ElevenLabsClient
        client = ElevenLabsClient()

    for sid in targets:
        spec = specs.get(sid)
        if not spec:
            print(f"  ! unknown sound id: {sid}", file=sys.stderr)
            continue
        man = factory.generate(client, cfg, spec)
        dur = (man.get("audio") or {}).get("duration_seconds", "?")
        print(f"  + {sid} [{man['engine']}] -> {man['file']} ({dur}s)")

    viewer_build.build()


if __name__ == "__main__":
    main()
