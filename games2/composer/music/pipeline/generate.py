#!/usr/bin/env python3
"""Generate the composer's TITLE THEME for the character-select screen.

The composer has the same generation rights + ELEVENLABS_API_KEY as the music
domain (maintainer 2026-07-19: "free hands" on the theme). This is a LEAN
generator — one call to ElevenLabs Music (music_v1), mp3 straight out (the
client decodes mp3 everywhere, incl. Safari/iOS, unlike ogg/opus) — committed
under games2/composer/music/ and bundled by Vite (see engine/titleTheme.ts).
It does NOT touch the music/ domain (another agent owns that).

Run:  python games2/composer/music/pipeline/generate.py [seconds]
Needs ELEVENLABS_API_KEY (a GitHub secret in composer-theme.yml).
"""

import os
import sys
from pathlib import Path

import requests

MUSIC_URL = "https://api.elevenlabs.io/v1/music"
MODEL_ID = "music_v1"
OUT = Path(__file__).resolve().parents[1] / "title.mp3"
DEFAULT_SECONDS = 90

# The brief IS the theme. The character-select art is a bioluminescent ancient
# forest at night — glowing wisps and fairies, giant mythic trees, mushrooms,
# crystals, a starry portal — captioned "A thousand paths, one life." The
# maintainer wants a login/title theme that "makes you just want to play,"
# in the spirit of the Ragnarok Online title music. Positive, evocative, one
# clear singable melody over warm orchestral color — film-score-grade.
PROMPT = (
    "A nostalgic orchestral fantasy MMORPG title theme for an enchanted, "
    "bioluminescent ancient forest at night — glowing wisps and fireflies, "
    "vast mythic trees, a starlit portal, a world about to open. Warm strings "
    "and gentle harp and piano carry one hopeful, singable, memorable melody; "
    "a soft solo flute answers it; distant wordless choir pads and glimmering "
    "celesta/bell accents shimmer like fairy lights. A feeling of wonder, "
    "adventure, belonging and homecoming — tender, cinematic, gently swelling "
    "then settling for a seamless loop. Studio-Ghibli / Joe Hisaishi warmth "
    "and the beloved login-theme spirit of Ragnarok Online. D major, around "
    "72 BPM, soft dynamics that never fatigue on loop, no heavy percussion, "
    "no vocals with words, no sound effects. A title screen you never want to "
    "leave."
)


def main() -> int:
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        print("ELEVENLABS_API_KEY not set — refusing to run (no placeholder audio).")
        return 1
    seconds = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SECONDS
    length_ms = max(10_000, min(300_000, seconds * 1000))

    session = requests.Session()
    session.headers.update({"xi-api-key": key})
    print(f"composing title theme (~{seconds}s) …")
    r = session.post(
        MUSIC_URL,
        params={"output_format": "mp3_44100_128"},
        json={"prompt": PROMPT, "music_length_ms": length_ms, "model_id": MODEL_ID},
        timeout=600,
    )
    if r.status_code != 200:
        print(f"ElevenLabs Music {r.status_code}: {r.text[:300]}")
        return 1
    if not r.content:
        print("ElevenLabs Music returned an empty body")
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(r.content)
    print(f"wrote {OUT} ({len(r.content) / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
