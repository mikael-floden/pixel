"""Compress a mastered WAV into web/phone-friendly delivery formats.

A lossless WAV is the master, but it's far too heavy to stream on a phone (a
multi-minute music track is tens of MB). Every audio asset therefore ALSO ships:

- **`.m4a` (AAC)** — for Safari / iOS (which don't reliably play Ogg Vorbis), with
  `+faststart` so the player can begin before the whole file downloads.
- **`.ogg` (Vorbis)** — for Chrome / Firefox / Android.

Together these cover every browser; the game picks by support (`<audio>` with
`<source>` in `web_source_order`, WAV as the lossless fallback/master).

This is the canonical encoder for the whole audio stack (sounds owns it); the
music domain and composer use the same standard so the game speaks one set of
formats. Uses ffmpeg (present on CI runners; also used for decode).
"""

from __future__ import annotations

import os
import shutil
import subprocess

# Container/codec/extension for each delivery format, in `<source>` preference
# order for the web (AAC first for iOS/Safari, then Vorbis). WAV is the master.
FORMATS = {
    "m4a": {"codec": "aac", "ext": ".m4a", "extra": ["-movflags", "+faststart"]},
    "ogg": {"codec": "libvorbis", "ext": ".ogg", "extra": []},
}
WEB_SOURCE_ORDER = ["m4a", "ogg"]


def have_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def _run(args: list[str]) -> None:
    p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {p.stderr.decode()[:200]}")


def encode_wav(wav_path: str, bitrate: str = "128k", overwrite: bool = False) -> dict:
    """Write `<stem>.m4a` and `<stem>.ogg` next to `wav_path`. Returns
    {fmt: {"path": abs, "bytes": n}} for the encodings produced (skips ones that
    already exist unless `overwrite`). Raises if ffmpeg is unavailable."""
    if not have_ffmpeg():
        raise RuntimeError("ffmpeg not found — cannot encode compressed delivery formats")
    exe = shutil.which("ffmpeg")
    stem = os.path.splitext(wav_path)[0]
    out = {}
    for fmt, spec in FORMATS.items():
        dest = stem + spec["ext"]
        if os.path.exists(dest) and not overwrite:
            out[fmt] = {"path": dest, "bytes": os.path.getsize(dest)}
            continue
        _run([exe, "-hide_banner", "-loglevel", "error", "-y", "-i", wav_path,
              "-c:a", spec["codec"], "-b:a", bitrate, *spec["extra"], dest])
        out[fmt] = {"path": dest, "bytes": os.path.getsize(dest)}
    return out


def encodings_meta(wav_path: str, enc: dict) -> dict:
    """Build the manifest `delivery` block: repo-relative compressed paths + sizes
    + the web `<source>` order, with WAV noted as the lossless master."""
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(wav_path))))
    rel = lambda p: os.path.relpath(p, root)  # noqa: E731
    formats = {"wav": {"file": rel(wav_path), "bytes": os.path.getsize(wav_path),
                       "codec": "pcm_s16le", "role": "master"}}
    for fmt, info in enc.items():
        formats[fmt] = {"file": rel(info["path"]), "bytes": info["bytes"],
                        "codec": FORMATS[fmt]["codec"]}
    return {"formats": formats, "web_source_order": WEB_SOURCE_ORDER}


if __name__ == "__main__":
    import sys
    for w in sys.argv[1:]:
        print(w, encode_wav(w))
