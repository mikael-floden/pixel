"""Rename lighting-state keys to the domain's vocabulary: LIGHTS_ON/LIGHTS_OFF.

Idempotent and path-safe: it renames the manifest KEYS only. The art stays at
its lowercase path, because manifest keys are domain vocabulary while paths are
paths. Safe to re-run while a generation pass is still writing.
"""
import sys
sys.path.insert(0, __import__('os').path.dirname(__file__))
import factory, viewer_build

RENAME = {"lights_on": "LIGHTS_ON", "lights_off": "LIGHTS_OFF"}


def main():
    n = 0
    for rel, man in factory.discover():
        states = man.get("states")
        if not states:
            continue
        new = {RENAME.get(k, k): v for k, v in states.items()}
        if new != states:
            man["states"] = {k: new[k] for k in sorted(new, reverse=True)}
            factory.write_manifest(rel, man)
            n += 1
    viewer_build.build()
    print(f"normalized state keys on {n} piece(s)")


if __name__ == "__main__":
    main()
