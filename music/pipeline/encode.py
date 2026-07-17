"""Compressed delivery copies for each track — phones must not wait for a score.

The WAV stays the **master** (lossless, what analysis ran on); every track also
ships two web/mobile streaming copies (~2 MB for a 2-minute bed):

    <id>.ogg   Opus  96 kbps  — Chrome / Firefox / Android / modern Safari
    <id>.m4a   AAC  128 kbps  — universal fallback (iOS / older Safari)

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
    {"ext": "m4a", "format": "m4a", "codec": "aac", "bitrate_kbps": 128,
     "args": ["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"],
     "mime": "audio/mp4"},
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
    """Encode `<dir>/<stem>.wav` -> `<dir>/<stem>.{ogg,m4a}`. Returns metadata
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
