"""Compressed delivery copies for each track — phones must not wait for a score.

The WAV stays the **master** (lossless, what analysis ran on); every track also
ships two web/mobile streaming copies (~2 MB for a 2-minute bed):

    <id>.ogg   Opus  96 kbps  — every browser

ONE SHIPPING FORMAT: OGG/OPUS. The m4a/AAC twin was dropped 2026-09-09.

It existed because Safari could not play the Ogg container. WebKit added Ogg
support for both Opus and Vorbis in Safari 18.4 — macOS 15.4, iOS 18.4,
iPadOS 18.4, visionOS 2.4, March 2025. Keeping the second encoding cost 177 MB
across music/ and sounds/, 26% of the repo's HEAD, to serve iOS 18.3 and older
— which already got NO sound effects, because the foley library has been
ogg-only for 580 of its 585 takes. A codec that protects the music on a device
with no footsteps is not a fallback, it is dead weight.

ffmpeg is resolved from PATH (CI installs it via apt) or from the pip package
`imageio-ffmpeg` (a static build, used in environments without apt). If neither
exists the track still ships WAV-only — callers log the gap rather than fail.
"""

from __future__ import annotations

import os
import shutil
import subprocess

VARIANTS = [
    {"ext": "ogg", "format": "ogg", "codec": "opus", "bitrate_kbps": 96,
     "args": ["-c:a", "libopus", "-b:a", "96k"],
     "mime": "audio/ogg; codecs=opus"},
]


def find_ffmpeg() -> str | None:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError):
        return None


def encode_variants(wav_path: str) -> list[dict]:
    """Encode `<dir>/<stem>.wav` -> `<dir>/<stem>.ogg`. Returns metadata
    entries [{file(basename), format, codec, bitrate_kbps, size_bytes, mime}]
    for every variant that encoded successfully (empty list if no ffmpeg)."""
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        print("  ! no ffmpeg found (PATH or imageio-ffmpeg) — skipping "
              "compressed copies; track ships WAV-only")
        return []
    stem = os.path.splitext(wav_path)[0]
    out = []
    for v in VARIANTS:
        dst = f"{stem}.{v['ext']}"
        try:
            subprocess.run([ffmpeg, "-y", "-v", "error", "-i", wav_path,
                            *v["args"], dst], check=True, timeout=600)
        except (subprocess.SubprocessError, OSError) as e:
            print(f"  ! {v['ext']} encode failed: {e}")
            continue
        out.append({
            "file": os.path.basename(dst),
            "format": v["format"],
            "codec": v["codec"],
            "bitrate_kbps": v["bitrate_kbps"],
            "size_bytes": os.path.getsize(dst),
            "mime": v["mime"],
        })
    return out


if __name__ == "__main__":
    import sys
    for entry in encode_variants(sys.argv[1]):
        print(entry)
