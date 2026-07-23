#!/usr/bin/env python3
"""Generate the composer's OWN music tracks (ElevenLabs Music, music_v1).

The composer has the same generation rights + ELEVENLABS_API_KEY as the music
domain (maintainer 2026-07-19: "free hands"). LEAN generator — one call per
track, mp3 straight out (the client decodes mp3 everywhere incl. Safari/iOS,
unlike ogg/opus) — committed under games2/composer/music/ and bundled by Vite
(see engine/titleTheme.ts). It does NOT touch the music/ domain (another
agent owns that).

Tracks:
  title  → title.mp3   the character-select login theme
  night  → night.mp3   the mystical night overworld bed (cross-faded in at night)

Run:  python games2/composer/music/pipeline/generate.py <track|all> [seconds]
Needs ELEVENLABS_API_KEY (a GitHub secret in composer-theme.yml).

CAREFUL: ElevenLabs Music REJECTS prompts that NAME real IP or artists
(2026-07-19: "Ragnarok Online / Studio Ghibli / Joe Hisaishi" tripped a
bad_prompt ToS block). Describe the STYLE and FEELING only.
"""

import os
import sys
from pathlib import Path

import requests

MUSIC_URL = "https://api.elevenlabs.io/v1/music"
MODEL_ID = "music_v1"
MUSIC_DIR = Path(__file__).resolve().parents[1]

TRACKS: dict[str, dict] = {
    # The character-select login theme: a sweeping RPG-overture + warm
    # hearth-and-home feeling, a proud singable melody, forward momentum —
    # NOT a lullaby (maintainer 2026-07-19).
    "title": {
        "out": "title.mp3",
        "seconds": 95,
        "prompt": (
            "A sweeping, nostalgic orchestral fantasy game title theme — a grand "
            "adventure about to begin and the warmth of coming home, at once. It "
            "OPENS IMMEDIATELY with the main melody already singing in the first "
            "two seconds — no silent or ambient lead-in, no abrupt start. A proud, "
            "hopeful, memorable folk melody on tin whistle, flute and fiddle, "
            "answered by warm strings and a noble French horn; harp, piano and "
            "light glimmering bells underneath. Pastoral hearth-and-home warmth "
            "with the uplifting swell of a great journey — cinematic and heartfelt, "
            "with gentle FORWARD MOMENTUM and a light walking pulse, NOT a slow "
            "lullaby. Builds to a hopeful, soaring climax, then settles for a "
            "seamless loop. Warm, magical, timeless, adventurous. Around 92 BPM, "
            "major key, rich orchestration, no heavy percussion, no vocals with "
            "words, no sound effects. A title screen that makes you want to set "
            "out on an adventure."
        ),
    },
    # The NIGHT overworld bed (maintainer 2026-07-19: "more mystical bg music
    # during night"). Cross-faded in as the sun sets, out at dawn — a looping
    # bed, so it's gentle and never fatiguing on repeat.
    "night": {
        "out": "night.mp3",
        "seconds": 95,
        "prompt": (
            "A mysterious, enchanted nocturnal theme for a moonlit magical forest "
            "at night — glowing wisps and fireflies drifting between vast ancient "
            "trees, hushed and dreamlike. Soft ethereal choir pads, gentle celesta "
            "and glass-bell shimmers, a slow distant harp, and a lone soft flute or "
            "ocarina breathing a simple, haunting, memorable melody over warm low "
            "strings. Wonder tinged with mystery and a little magic — calm, "
            "spacious, slightly otherworldly, NEVER scary or dissonant. Slow and "
            "floating, tender, a seamless gentle loop that never fatigues. "
            "Minor-tinged but hopeful, around 62 BPM, very soft dynamics, no heavy "
            "percussion, no vocals with words, no sound effects. The feeling of "
            "wandering a glowing enchanted forest under the stars."
        ),
    },
}


def compose(session: requests.Session, spec: dict, seconds: int | None) -> int:
    secs = seconds or spec["seconds"]
    length_ms = max(10_000, min(300_000, secs * 1000))
    out = MUSIC_DIR / spec["out"]
    print(f"composing {spec['out']} (~{secs}s) …")
    r = session.post(
        MUSIC_URL,
        params={"output_format": "mp3_44100_128"},
        json={"prompt": spec["prompt"], "music_length_ms": length_ms, "model_id": MODEL_ID},
        timeout=600,
    )
    if r.status_code != 200:
        print(f"ElevenLabs Music {r.status_code}: {r.text[:300]}")
        return 1
    if not r.content:
        print("ElevenLabs Music returned an empty body")
        return 1
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(r.content)
    print(f"wrote {out} ({len(r.content) / 1024:.0f} KB)")
    return 0


def main() -> int:
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        print("ELEVENLABS_API_KEY not set — refusing to run (no placeholder audio).")
        return 1
    which = sys.argv[1] if len(sys.argv) > 1 else "title"
    seconds = int(sys.argv[2]) if len(sys.argv) > 2 else None
    names = list(TRACKS) if which == "all" else [which]
    session = requests.Session()
    session.headers.update({"xi-api-key": key})
    rc = 0
    for name in names:
        spec = TRACKS.get(name)
        if not spec:
            print(f"unknown track {name!r} (have: {', '.join(TRACKS)}, or 'all')")
            rc = 1
            continue
        rc |= compose(session, spec, seconds)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
